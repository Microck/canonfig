// Demo state only: actions use local React state, timers, and toasts, not a backend.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  DEMO,
  APP_VERSION,
  skillSources,
  upstreamSkills,
  DEMO_SKILLS_REPO,
  HARNESS_NAMES,
  followers as seedFollowers,
  followerSelf,
  harnesses as seedHarnesses,
  itemPath,
  profile,
  machine,
  resources as seedResources,
  revisions as seedRevisions,
  secrets as seedSecrets,
  snapshots as seedSnapshots,
  type Follower,
  type Harness,
  type HarnessId,
  type ItemCategory,
  type LocalItem,
  type Resource,
  type SurfaceCategory,
} from "@/shared/data";
import type { Setup } from "@/onboarding/onboarding";
import type { Navigate, WorkspaceRoute } from "./routes";
import { ScreenContext, type ScreenGroup } from "./screen-context";
import { PAGE_TIPS } from "./page-tips";
import { SharedStateProvider, WorkspaceContext, useSharedState, useWorkspace } from "./store";
import type { Workspace, ChangeGroupsRequest, Invitation, ScannedTool, Secret, PlanItem, Run } from "./workspace-types";
import { useSimulatedAdministration } from "./simulated-administration";
import { useWorkspaceNavigation } from "./navigation-state";
import type { Schedule } from "./schedule";
import { TransitionError, useStateMachine } from "@/lib/state-machine";
import { pendingChanges, simulatedPlan, transitionPublication, transitionSimulatedFollower, type PublicationEvent, type SimulatedPublication, type SimulatedFollowerEvent, type SimulatedFollowerState } from "./simulated-state";

const READY = { loading: false, error: null };


/**
 * The demo follower's plan from revision 7 to 8: the four unpublished items on the Source, gh, Amp's first
 * AGENTS.md (installed since the last update) and one drifted skill.
 */
export const FOLLOWER_PLAN: PlanItem[] = [
  { resource: "rules/typescript", category: "rules", target: "~/.claude/rules/typescript.md", action: "write", reason: "Changed in revision 8. Writes it for each harness with rule files and links it from the others' instructions." },
  { resource: "commands/ship", category: "commands", target: "~/.claude/commands/ship.md", action: "write", reason: "New in revision 8. Writes the command for Claude Code and OpenCode." },
  { resource: "settings/claude-code", category: "settings", target: "~/.claude/settings.json", action: "merge", reason: "Sets 2 keys. Every other key in the file stays as it is." },
  { resource: "resources/ruff", category: "resources", target: "~/.config/ruff/ruff.toml", action: "merge", reason: "New in revision 8. Sets 2 keys in the file; every other key stays. Canonfig backs up their values first." },
  { resource: "tools/gh", category: "tools", target: "gh", action: "install", reason: "Not installed yet. Runs brew install gh, then checks it starts." },
  {
    resource: "instructions",
    category: "instructions",
    target: "~/.config/amp/AGENTS.md",
    action: "append",
    reason: "Amp is installed here now. Canonfig backs up the file, adds its section at the top and keeps the whole file you have as your text.",
    adoption: { retained: "# Amp on this laptop\n\nAsk the oracle before changing more than 200 lines.\n" },
  },
  {
    resource: "skills/code-review",
    category: "skills",
    target: "~/.canonfig/skills/code-review/SKILL.md",
    action: "skip-drift",
    drift: true,
    reason: "You edited this file after Canonfig applied revision 7. It stays as you left it, and the skill in your harnesses holds at revision 7.",
  },
];

/**
 * The first plan on a follower that just joined: revision 7, the one it downloaded, applied to a machine
 * Canonfig hasn't written to yet. Each harness surface it takes over is backed up first, unless backups are off.
 */
export const JOINED_PLAN: PlanItem[] = [
  {
    resource: "instructions",
    category: "instructions",
    target: "~/.codex/AGENTS.md",
    action: "append",
    reason: "Takes over each harness's instructions file, backing it up first. Canonfig adds its section at the top and keeps the whole file you have as your text.",
    adoption: { retained: "# My notes\n\nUse pnpm in every repository.\n" },
  },
  { resource: "skills/code-review", category: "skills", target: "~/.agents/skills/code-review", action: "write", reason: "Not on this machine yet. Writes the skill's 3 files." },
  { resource: "mcp/context7", category: "mcp", target: "~/.claude.json", action: "merge", reason: "Adds the server to each harness's MCP settings. Only those keys change; Canonfig backs up their values first." },
  { resource: "settings/codex", category: "settings", target: "~/.codex/config.toml", action: "merge", reason: "Sets 2 keys and leaves the rest of the file as it is." },
  { resource: "resources/gitconfig", category: "resources", target: "~/.gitconfig", action: "write", reason: "Replaces the file with files/gitconfig. Canonfig backs up what's there first." },
  { resource: "tools/gh", category: "tools", target: "gh", action: "install", reason: "Not installed yet. Runs brew install gh, then checks it starts." },
];


// `source scan` reads the folder's instructions, skills, hook scripts and MCP commands and proposes one tools entry per program it finds.
export const SCANNED_TOOLS = [
  { id: "node", executable: "npx", command: "npx -y @upstash/context7-mcp@2.1.0", file: "canonfig.jsonc", where: "mcp.context7" },
  { id: "prettier", executable: "prettier", command: "prettier --write", file: "hooks/format.sh", where: "line 3" },
  { id: "ripgrep", executable: "rg", command: "rg --files", file: "skills/code-review/SKILL.md", where: "line 12" },
] as const;

export function toolFromScan(f: ScannedTool): Resource {
  return {
    id: `tools/${f.id}`,
    category: "tools",
    path: `canonfig.jsonc tools.${f.id}`,
    groups: [],
    summary: `found in ${f.file}`,
    change: "added",
    detail: { Executable: f.executable, Evidence: `${f.file}, ${f.where}: ${f.command}` },
  };
}

/** The categories onboarding's import offers besides instructions (src/projection/import.ts). */
const IMPORTED: ReadonlySet<string> = new Set(["rules", "skills", "agents", "commands", "mcp"]);

/**
 * Onboarding's import picks (`<harness>/instructions` or `<harness>/<category>/<name>`) as new folder items.
 * Duplicates by name were settled in onboarding, so the first pick of an id wins.
 */
function importedItems(ids: readonly string[]): Resource[] {
  const items = new Map<string, Resource>();
  for (const pick of ids) {
    const [harness, category, name] = pick.split("/");
    const from = `imported from ${HARNESS_NAMES[harness as HarnessId] ?? harness}`;
    if (category === "instructions") {
      if (!items.has("instructions")) items.set("instructions", { id: "instructions", category: "instructions", path: "AGENTS.md", groups: [], summary: from, change: "added", detail: { Body: "" } });
    } else if (name && IMPORTED.has(category) && !items.has(`${category}/${name}`)) {
      items.set(`${category}/${name}`, { id: `${category}/${name}`, category: category as ItemCategory, path: itemPath(category as ItemCategory, name), groups: [], summary: from, change: "added", detail: {} });
    }
  }
  return [...items.values()];
}



/** What onboarding's scan proposes by default: the first two tools it found in the folder. */
const ONBOARDING_PROPOSED = SCANNED_TOOLS.slice(0, 2).map(toolFromScan);

const SEED_RUNS: Run[] = [
  { n: 41, what: "Interrupted, 3 of 5 done", when: "Yesterday 21:14", tone: "bad" },
  { n: 40, what: "Applied revision 7", when: "Yesterday 08:45" },
  { n: 39, what: "No changes", when: "Oct 26" },
];


/** The demo follower's next revision; a follower that just joined starts on the one it downloaded. */
const DEMO_TARGET_REVISION = 8;
const JOINED_REVISION = 7;



/**
 * A demo stand-in for a revision's fingerprint, not a digest of real file contents: a 32-bit
 * FNV-1a hash of the sequence and change list, shown in the seeded `sha256:xxxx…yyyy` shape so
 * each published revision gets its own value.
 */
function demoDigest(sequence: number, summary: string): string {
  let hash = 0x811c9dc5;
  for (const ch of `${sequence}\n${summary}`) hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193);
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `sha256:${hex.slice(0, 4)}…${hex.slice(4)}`;
}

function useWorkspaceState(route: WorkspaceRoute, navigate: Navigate, setup: Setup | null): Omit<Workspace, "admin"> {
  const { role } = route;
  // Fresh out of onboarding, the workspace holds only what the person just set up.
  const newSource = role === "source" && setup?.role === "source" ? setup : null;
  const joined = role === "follower" && setup?.role === "follower" ? setup : null;
  const navigation = useWorkspaceNavigation(route, navigate, joined?.schedule);
  const [publishOpen, setPublishOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [changeGroups, setChangeGroups] = useState<ChangeGroupsRequest | null>(null);

  // Source state. A new Source has no revisions, followers or secrets yet; its folder holds only what
  // onboarding imported from its harnesses and the tools the scan proposed.
  const [initialPublication] = useState<SimulatedPublication>(() => ({
    kind: "idle", resources: newSource ? [...importedItems(newSource.imported), ...(newSource.scan ? ONBOARDING_PROPOSED : [])] : seedResources,
    edits: [], revisions: newSource ? [] : seedRevisions, deliveries: {},
  }));
  const publication = useStateMachine<SimulatedPublication, PublicationEvent>(initialPublication, transitionPublication);
  const { send: sendPublication, current: publicationCurrent } = publication;
  const { resources, revisions } = publication.state;
  const setResources = useCallback((update: Resource[] | ((items: Resource[]) => Resource[])) => { sendPublication({ kind: "resources", update }); }, [sendPublication]);
  const [proposed, setProposed] = useState<string[]>(newSource?.scan ? ONBOARDING_PROPOSED.map((r) => r.id) : []);
  const [followers, setFollowers] = useState<Follower[]>(newSource ? [] : seedFollowers);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [secrets, setSecrets] = useState<Secret[]>(newSource ? [] : seedSecrets);
  const publishing = publication.state.kind === "publishing";
  const syncing = Object.entries(publication.state.deliveries).flatMap(([id, delivery]) => delivery.kind === "delivering" ? [id] : []);
  const markProfileEdit = useCallback((edit: import("./workspace-types").ProfileEdit) => { sendPublication({ kind: "edit", edit }); }, [sendPublication]);
  const removeProfileEdit = useCallback((edit: import("./workspace-types").ProfileEdit) => { sendPublication({ kind: "withdraw-edit", edit }); }, [sendPublication]);
  const pending = useMemo(() => pendingChanges(publication.state), [publication.state]);
  const latest = revisions[0]?.sequence ?? 0;
  const nextSequence = latest + 1;
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const later = useCallback((fn: () => void, ms: number) => void timers.current.push(window.setTimeout(fn, ms)), []);
  const readResources = useCallback(() => publicationCurrent.current.resources, [publicationCurrent]);
  const readQueue = useCallback(() => ({ pending: pendingChanges(publicationCurrent.current), nextSequence: (publicationCurrent.current.revisions[0]?.sequence ?? 0) + 1 }), [publicationCurrent]);
  const generation = useRef(0);
  const publish = useCallback((reviewer: string, onDone: () => void) => {
    const started = sendPublication({ kind: "publish", reviewer, generation: ++generation.current });
    if (started.kind !== "publishing") throw new TransitionError("Demo publication", started.kind, "publish");
    later(() => {
      const seq = started.sequence;
      const mark = { added: "+", modified: "~", removed: "−" } as const;
      const summary = started.frozen.map((change) => `${mark[change.change]}${change.area === "group" ? `group ${change.id}` : change.id}`).join(", ");
      const reachable = followers.filter((follower) => follower.state !== "offline").map((follower) => follower.id);
      sendPublication({ kind: "published", generation: started.generation, revision: { sequence: seq, digest: demoDigest(seq, summary), publishedAt: "Just now", reviewer, changes: summary }, followers: reachable });
      setProposed((previous) => previous.filter((id) => !started.frozen.some((change) => change.area === "item" && change.id === id)));
      onDone();
      toast.success(`Published revision ${seq}`, { description: `Reachable machines receive it next and apply it on their next check.${DEMO ? "\nSaved in this demo workspace." : ""}` });
      reachable.forEach((id, index) => later(() => {
        try { sendPublication({ kind: "delivered", follower: id, sequence: seq, requestId: started.generation }); }
        catch (cause) {
          // A later publication owns this delivery now. Its typed refusal leaves the newer ticket intact.
          if (cause instanceof TransitionError) return;
          throw cause;
        }
        setFollowers((previous) => previous.map((follower) => follower.id === id ? { ...follower, revision: seq, lastRun: "Just now" } : follower));
      }, 1400 + index * 1100));
    }, 1600);
  }, [sendPublication, followers, later]);

  // Harness state on this machine. A machine fresh out of onboarding hasn't taken over any harness yet,
  // so it has no pinned roots and no takeover snapshots.
  const fresh = newSource !== null || joined !== null;
  const [listed, setListed] = useState<HarnessId[]>(() => newSource?.harnesses ?? seedHarnesses.filter((h) => h.listed).map((h) => h.id));
  const [surfaces, setSurfaces] = useState<Partial<Record<HarnessId, SurfaceCategory[]>>>({});
  const [excluded, setExcluded] = useState<HarnessId[]>(() => joined?.excluded ?? (newSource ? [] : seedHarnesses.filter((h) => h.excluded).map((h) => h.id)));
  const harnessRows = useMemo<Harness[]>(
    () =>
      seedHarnesses.map((h) => ({
        ...h,
        listed: listed.includes(h.id),
        excluded: excluded.includes(h.id),
        root: fresh ? null : h.root,
        snapshot: fresh ? null : h.snapshot,
      })),
    [listed, excluded, fresh],
  );
  const [backups, setBackups] = useState(true);
  const snapshots = fresh ? [] : seedSnapshots;

  // Follower state. One that just joined has downloaded revision 7 and applied nothing: no runs,
  // nothing interrupted, nothing in its local folder, and the revision's first plan.
  const machineName = joined?.name ?? (role === "source" ? machine.hostname : followerSelf.name);
  const targetRevision = joined ? JOINED_REVISION : DEMO_TARGET_REVISION;
  const [initialFollower] = useState<SimulatedFollowerState>(() => ({
    kind: "enrolled",
    run: joined ? { kind: "planned", plan: JOINED_PLAN } : { kind: "recovery-required", run: SEED_RUNS[0], plan: FOLLOWER_PLAN.map((item) => item.action === "skip-drift" ? { ...item, appliedRevision: followerSelf.revision } : item) },
    evidence: { appliedRevision: joined ? 0 : followerSelf.revision, humanAction: false, runs: joined ? [] : SEED_RUNS },
  }));
  const followerFlow = useStateMachine<SimulatedFollowerState, SimulatedFollowerEvent>(initialFollower, transitionSimulatedFollower);
  const { send: sendFollower, current: followerCurrent } = followerFlow;
  const follower = followerFlow.state;
  const evidence = follower.kind === "enrolled" ? follower.evidence : follower.lastEvidence;
  const plan = simulatedPlan(follower);
  const phase = follower.kind !== "enrolled" ? "plan" : follower.run.kind === "applying" ? "running" : follower.run.kind === "applied" ? "done" : "plan";
  const progress = follower.kind === "enrolled" && follower.run.kind === "applying" ? follower.run.progress : phase === "done" ? 100 : 0;
  const interrupted = follower.kind === "enrolled" && follower.run.kind === "recovery-required";
  const { appliedRevision, humanAction, runs } = evidence;
  const [unenrollOpen, setUnenrollOpen] = useState(false);
  const unenrolled = follower.kind === "unenrolled";
  const isStopped = useCallback(() => followerCurrent.current.kind === "unenrolled", [followerCurrent]);
  const setHumanAction: Workspace["setHumanAction"] = (next) => {
    const current = followerCurrent.current;
    const previous = current.kind === "enrolled" ? current.evidence.humanAction : current.lastEvidence.humanAction;
    const value = typeof next === "function" ? next(previous) : next;
    if (value) throw new TransitionError("Demo follower", current.kind, "create human action");
    sendFollower({ kind: "acknowledge" });
  };
  const [local, setLocal] = useState<LocalItem[]>(() => (joined ? [] : followerSelf.local));
  const [overlays, setOverlays] = useState<string[]>(() => (joined ? [] : followerSelf.overlays));
  const kept = joined ? [] : followerSelf.kept;
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearInterval(timer.current), []);

  const restore = useCallback(
    (id: string) => {
      const snapshot = seedSnapshots.find((s) => s.id === id);
      if (!snapshot) return;
      const names = snapshot.harnesses.map((h) => HARNESS_NAMES[h]).join(", ");
      // `restore` runs as a journaled Synchronization Run, so it shows with the others.
      sendFollower({ kind: "restore", snapshot: id });
      setExcluded((prev) => [...new Set([...prev, ...snapshot.harnesses])]);
      toast.success(`Restored ${names}`, {
        description: `Put back ${snapshot.files} files from ${id}.\nExcluded ${names} on this machine in ~/.canonfig/local/local.jsonc.${DEMO ? "\nSimulated in this demo; no files changed." : ""}`,
      });
    },
    [],
  );

  // Export changes nothing Canonfig manages, so unlike restore it adds no run.
  // Only the demo simulates it. Outside the demo this page has no way to
  // write the archive, so it points to the CLI instead of claiming a download.
  // On the Source the CLI signs the manifest with the Source signing key; a
  // follower's export is unsigned.
  const exportArchive = useCallback(() => {
    const signing = role === "source" ? " On the Source it signs the manifest with the Source signing key." : "";
    if (!DEMO) {
      toast("Export runs from the CLI", {
        description: `Run canonfig export on this machine. It writes ~/.canonfig/ to a .tar.gz with a manifest.json of every file's size and SHA-256.${signing}`,
      });
      return;
    }
    const name = `canonfig-export-${new Date().toISOString().replaceAll(":", "-").replace(/\.\d+Z$/u, "Z")}.tar.gz`;
    const signed = role === "source" ? "\nSigned with this Source's signing key." : "";
    toast.success("Exported the Canonfig folder", {
      description: `Downloaded ${name}, with a manifest.json of every file's size and SHA-256.${signed}\nState, backups and credentials stay on this machine.\nSimulated in this demo; no file was written.`,
    });
  }, [role]);

  const recover = useCallback(() => {
    const current = followerCurrent.current;
    const number = current.kind === "enrolled" && current.run.kind === "recovery-required" ? current.run.run.n : null;
    sendFollower({ kind: "recover" });
    toast.success(`Run #${number} recovered`, { description: "Finished the 2 remaining steps from the journal." });
  }, [sendFollower, followerCurrent]);
  const abandon = useCallback(() => {
    const current = followerCurrent.current;
    const number = current.kind === "enrolled" && current.run.kind === "recovery-required" ? current.run.run.n : null;
    sendFollower({ kind: "abandon" });
    toast(`Run #${number} abandoned`, { description: "Its 3 finished steps stay in place.\nNothing was rolled back." });
  }, [sendFollower, followerCurrent]);
  const unenroll = useCallback(() => {
    sendFollower({ kind: "unenroll" });
    window.clearInterval(timer.current);
    toast(`${machineName} stopped syncing`, { description: "In the real app this screen would return to setup." });
  }, [machineName, sendFollower]);
  const applyPlan = useCallback(() => {
    const started = sendFollower({ kind: "apply", target: targetRevision });
    if (started.kind !== "enrolled" || started.run.kind !== "applying") throw new TransitionError("Demo follower", started.kind, "apply");
    const id = started.run.id;
    let tick = 0;
    timer.current = window.setInterval(() => {
      const value = Math.min(100, ++tick * 4);
      let next: SimulatedFollowerState;
      try { next = sendFollower({ kind: "advance", id, progress: value }); }
      catch (cause) {
        if (!(cause instanceof TransitionError)) throw cause;
        window.clearInterval(timer.current);
        return;
      }
      if (value < 100) return;
      window.clearInterval(timer.current);
      if (next.kind !== "enrolled" || next.run.kind !== "applied") return;
      const held = next.run.held;
      const heldText = `${held} ${held === 1 ? "item" : "items"} held`;
      if (held) toast(`Revision ${targetRevision} applied, ${heldText}`, { description: `${held === 1 ? "It keeps" : "They keep"} your local edit.\nSee Sync for how to settle ${held === 1 ? "it" : "them"}.${next.evidence.humanAction ? "\nAlso sign in to the GitHub CLI." : ""}` });
      else toast.success(`Revision ${targetRevision} applied`, { description: next.evidence.humanAction ? "One step needs you: sign in to the GitHub CLI." : "This machine is up to date." });
    }, 140);
  }, [targetRevision, sendFollower]);
  const [profileSchedule] = useSharedState<Schedule>("profile-schedule", { cadence: "daily", days: [], time: "09:00" });
  const [followerSchedule] = useSharedState<Schedule | null>("follower-schedule", { cadence: "default", days: [], time: "09:00" });
  const [tunnelUp] = useSharedState("tunnel-up", true);
  const [secretsRefresh] = useSharedState("secrets-refresh", { busy: false, updated: "today at 08:45" });
  const [serviceInstalled] = useSharedState("service-installed", true);

  return {
    ...navigation,
    folderPath: machine.folder,
    version: APP_VERSION,
    reload: () => window.location.reload(),
    notImplemented: (member) => { throw new Error(`Unexpected unavailable demo operation: ${member}`); },
    overviewState: READY,
    profileState: READY,
    machinesState: READY,
    followerState: READY,
    profileStates: { items: READY, revisions: READY, skills: READY, secrets: READY },
    machineStates: { inventory: READY, enrollment: READY, setup: READY },
    followerStates: { harnesses: READY, local: READY, schedule: READY, backups: READY, overlays: READY, tunnel: READY },
    capabilities: { invitationCancel: true, selectiveScanWrite: true, serviceRestart: true, privateReviewDelete: true, simulatedTelemetry: true, profileWrite: true, enrollmentWrite: true, followerWrite: true },
    sourceMachine: machine,
    followerSelf,
    selfFollower: { ...seedFollowers[0], name: machineName, revision: appliedRevision === 0 ? null : appliedRevision, state: humanAction ? "human-action" : plan.some((item) => item.action === "skip-drift") ? "drift" : appliedRevision === 0 ? "never-synced" : "converged" },
    profile,
    profileSchedule,
    followerSchedule,
    tunnelUp,
    secretsRefresh,
    serviceInstalled,
    skillSources,
    upstreamSkills,
    demoSkillsRepo: DEMO_SKILLS_REPO,
    scannedTools: SCANNED_TOOLS,
    toolFromScan,
    sourceActivity: [
      { follower: "f_8c21", what: "applied revision 7", when: "12 min ago" },
      { follower: "f_3b90", what: "has a local edit to skills/code-review, kept and reported there", when: "2 h ago" },
      { revision: 7, what: "published revision 7", when: "Today 08:41" },
      { follower: "f_d417", what: "is waiting for someone to run `gh auth login`", when: "Yesterday" },
      { follower: "f_71ea", what: "stopped reaching the Source", when: "Sat" },
    ],
    publicationReviewer: "maria",
    machineName,
    profileName: newSource?.profileName ?? profile.name,
    endpoint: newSource ? `https://127.0.0.1:${newSource.port}` : machine.endpoint,
    justJoined: joined !== null,
    tunnelConfigured: joined?.tunnel ?? true,
    proposed,
    publishOpen,
    setPublishOpen,
    inviteOpen,
    setInviteOpen,
    resources,
    setResources,
    revisions,
    latest,
    followers,
    setFollowers,
    invitations,
    setInvitations,
    secrets,
    setSecrets,
    pending,
    markProfileEdit,
    removeProfileEdit,
    nextSequence,
    publishing,
    publish,
    syncing,
    changeGroups,
    setChangeGroups,
    plan,
    targetRevision,
    phase,
    progress,
    applyPlan,
    driftOpen: plan.some((p) => p.action === "skip-drift"),
    interrupted,
    recover,
    abandon,
    runs,
    humanAction,
    setHumanAction,
    appliedRevision,
    listed,
    setListed,
    surfaces,
    setSurfaces,
    excluded,
    setExcluded,
    harnesses: harnessRows,
    backups,
    setBackups,
    snapshots,
    restore,
    exportArchive,
    local,
    setLocal,
    overlays,
    setOverlays,
    kept,
    unenrollOpen,
    setUnenrollOpen,
    unenrolled,
    unenroll,
    later,
    readResources,
    readQueue,
    isStopped,
  };
}


/**
 * Onboarding choices that pages read through shared keys, as those keys' first values. A seeded key
 * wins over each reader's `initial`, so every page shows what the person chose until they change it.
 */
function sharedSeed(setup: Setup | null): Record<string, unknown> {
  if (setup?.role === "source")
    return {
      "service-installed": setup.service === "service",
      // Setup just installed the service, so it started now, not at the demo's seeded time.
      "service-since": `today ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`,
      // A new Source tracks no skill upstreams and hasn't turned on Canonfig updates.
      "skill-sources": [],
      "self-update": { kind: "ready", status: { enabled: false, pending: false, platform: "linux", settings: null }, checked: null },
    };
  if (setup?.role === "follower")
    return {
      "tunnel-up": setup.tunnel,
      // null: no schedule was ever set. With one, the readers' initial (`schedule set --default`) is what onboarding ran.
      ...(setup.schedule ? {} : { "follower-schedule": null }),
      "self-update": { kind: "ready", status: { enabled: false, pending: false, platform: "darwin", settings: null }, checked: null },
    };
  return {};
}

/** `setup` is what onboarding just created; null opens the seeded demo machine for `role`. */
export function SimulatedWorkspaceProvider({ route, navigate, setup = null, children }: {
  route: WorkspaceRoute;
  navigate: Navigate;
  setup?: Setup | null;
  children: ReactNode;
}) {
  return <SharedStateProvider initial={sharedSeed(setup)}>
    <SimulatedWorkspace route={route} navigate={navigate} setup={setup}>{children}</SimulatedWorkspace>
  </SharedStateProvider>;
}

function SimulatedWorkspace({ route, navigate, setup, children }: {
  route: WorkspaceRoute;
  navigate: Navigate;
  setup: Setup | null;
  children: ReactNode;
}) {
  const workspace = useWorkspaceState(route, navigate, setup);
  const admin = useSimulatedAdministration(workspace);
  return <WorkspaceContext value={{ ...workspace, admin }}><DemoScreenContext>{children}</DemoScreenContext></WorkspaceContext>;
}

function DemoScreenContext({ children }: { children: ReactNode }) {
  const workspace = useWorkspace();
  const groups = useSharedState<ScreenGroup[]>("groups", profile.groups);
  return <ScreenContext value={{
    pageLoading: workspace.pageLoading,
    navigate: workspace.navigate,
    openHelp: PAGE_TIPS[workspace.role][workspace.view] === undefined ? undefined : () => workspace.openTip(workspace.view),
    publication: workspace.pending.length === 0 || workspace.nextSequence === undefined ? undefined : { sequence: workspace.nextSequence, open: () => workspace.setPublishOpen(true) },
    groups,
  }}>{children}</ScreenContext>;
}

