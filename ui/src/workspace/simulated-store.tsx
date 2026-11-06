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
  type Revision,
  type SurfaceCategory,
} from "@/shared/data";
import type { Setup } from "@/onboarding/onboarding";
import type { Navigate, WorkspaceRoute } from "./routes";
import { ScreenContext, type ScreenGroup } from "./screen-context";
import { PAGE_TIPS } from "./page-tips";
import { SharedStateProvider, WorkspaceContext, useSharedState, useWorkspace } from "./store";
import type { Workspace, ChangeGroupsRequest, Invitation, ScannedTool, Secret, PendingChange, ProfileEdit, PlanItem, Run, FollowerPhase } from "./workspace-types";
import { useSimulatedAdministration } from "./simulated-administration";
import { useWorkspaceNavigation } from "./navigation-state";
import type { Schedule } from "./schedule";

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
  const [resources, setResources] = useState<Resource[]>(() =>
    newSource ? [...importedItems(newSource.imported), ...(newSource.scan ? ONBOARDING_PROPOSED : [])] : seedResources,
  );
  const [proposed, setProposed] = useState<string[]>(newSource?.scan ? ONBOARDING_PROPOSED.map((r) => r.id) : []);
  const [revisions, setRevisions] = useState<Revision[]>(newSource ? [] : seedRevisions);
  const [followers, setFollowers] = useState<Follower[]>(newSource ? [] : seedFollowers);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [secrets, setSecrets] = useState<Secret[]>(newSource ? [] : seedSecrets);
  const [publishing, setPublishing] = useState(false);
  const [syncing, setSyncing] = useState<string[]>([]);
  const [profileEdits, setProfileEdits] = useState<ProfileEdit[]>([]);
  const markProfileEdit = useCallback(
    (edit: ProfileEdit) => setProfileEdits((prev) => (prev.some((e) => e.area === edit.area && e.id === edit.id) ? prev : [...prev, edit])),
    [],
  );
  const removeProfileEdit = useCallback(
    (edit: ProfileEdit) => setProfileEdits((prev) => prev.filter((e) => !(e.area === edit.area && e.id === edit.id))),
    [],
  );
  // Items carry their own change marker; group and defaults edits are recorded when Profile saves them.
  const pending = useMemo<PendingChange[]>(
    () => [...resources.flatMap((r) => (r.change ? [{ area: "item" as const, id: r.id, change: r.change, resource: r }] : [])), ...profileEdits],
    [resources, profileEdits],
  );
  const latest = revisions[0]?.sequence ?? 0;
  const nextSequence = latest + 1;
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const later = useCallback((fn: () => void, ms: number) => void timers.current.push(window.setTimeout(fn, ms)), []);
  // Delayed callbacks close over the render that started them; readResources goes through this instead. Synced after
  // each commit, which lands long before any ws.later callback runs.
  const latestResources = useRef(resources);
  const latestQueue = useRef({ pending, nextSequence });
  useEffect(() => {
    latestResources.current = resources;
    latestQueue.current = { pending, nextSequence };
  }, [resources, pending, nextSequence]);
  const readResources = useCallback(() => latestResources.current, []);
  const readQueue = useCallback(() => latestQueue.current, []);

  const publish = useCallback(
    (reviewer: string, onDone: () => void) => {
      setPublishing(true);
      later(() => {
        const seq = nextSequence;
        const mark = { added: "+", modified: "~", removed: "−" } as const;
        const summary = pending.map((c) => `${mark[c.change]}${c.area === "group" ? `group ${c.id}` : c.id}`).join(", ");
        setRevisions((prev) => [{ sequence: seq, digest: demoDigest(seq, summary), publishedAt: "Just now", reviewer, changes: summary }, ...prev]);
        setResources((prev) => prev.filter((r) => r.change !== "removed").map((r) => ({ ...r, change: undefined })));
        // Groups, the harness list and defaults went out with this revision too, so they are no longer unpublished.
        setProfileEdits([]);
        setProposed([]);
        setPublishing(false);
        onDone();
        toast.success(`Published revision ${seq}`, {
          description: `Reachable machines receive it next and apply it on their next check.${DEMO ? "\nSaved in this demo workspace." : ""}`,
        });
        // Every reachable machine fetches the revision, simulated here one after another.
        // Items paused by a local edit or waiting for a person stay that way; the revision still arrives.
        const reachable = followers.filter((f) => f.state !== "offline").map((f) => f.id);
        setSyncing(reachable);
        reachable.forEach((id, i) =>
          later(() => {
            setFollowers((prev) => prev.map((f) => (f.id === id ? { ...f, revision: seq, lastRun: "Just now" } : f)));
            setSyncing((prev) => prev.filter((x) => x !== id));
          }, 1400 + i * 1100),
        );
      }, 1600);
    },
    [nextSequence, pending, followers, later],
  );

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
  const [plan, setPlan] = useState<PlanItem[]>(() => (joined ? JOINED_PLAN : FOLLOWER_PLAN));
  const [phase, setPhase] = useState<FollowerPhase>("plan");
  const [progress, setProgress] = useState(0);
  const [interrupted, setInterrupted] = useState(!joined);
  const [runs, setRuns] = useState<Run[]>(joined ? [] : SEED_RUNS);
  const [unenrollOpen, setUnenrollOpen] = useState(false);
  const [unenrolled, setUnenrolled] = useState(false);
  const stoppedRef = useRef(false);
  const isStopped = useCallback(() => stoppedRef.current, []);
  const [humanAction, setHumanAction] = useState(false);
  const [appliedRevision, setAppliedRevision] = useState(joined ? 0 : followerSelf.revision);
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
      setExcluded((prev) => [...new Set([...prev, ...snapshot.harnesses])]);
      // `restore` runs as a journaled Synchronization Run, so it shows with the others.
      setRuns((prev) => [{ n: (prev[0]?.n ?? 0) + 1, what: `Restored snapshot ${id}`, when: "Just now", tone: "ok" }, ...prev]);
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
    setInterrupted(false);
    setRuns((prev) => prev.map((r) => (r.n === 41 ? { ...r, what: "Recovered: all 5 steps done", when: "Just now", tone: "ok" } : r)));
    toast.success("Run #41 recovered", { description: "Finished the 2 remaining steps from the journal." });
  }, []);

  const abandon = useCallback(() => {
    setInterrupted(false);
    setRuns((prev) => prev.map((r) => (r.n === 41 ? { ...r, what: "Abandoned, 3 of 5 done", tone: "muted" } : r)));
    toast("Run #41 abandoned", { description: "Its 3 finished steps stay in place.\nNothing was rolled back." });
  }, []);

  const unenroll = useCallback(() => {
    // A run in progress stops with it: no further steps run on a machine that stopped syncing.
    if (phase === "running") {
      window.clearInterval(timer.current);
      const doneSteps = Math.floor((progress / 100) * plan.length);
      setPlan((prev) => prev.map(({ status: _status, ...p }) => p));
      setPhase("plan");
      setProgress(0);
      setRuns((prev) => [{ n: (prev[0]?.n ?? 0) + 1, what: `Stopped, ${doneSteps} of ${plan.length} done`, when: "Just now", tone: "muted" }, ...prev]);
    }
    stoppedRef.current = true;
    setUnenrolled(true);
    toast(`${machineName} stopped syncing`, { description: "In the real app this screen would return to setup." });
  }, [machineName, phase, progress, plan.length]);

  const applyPlan = useCallback(() => {
    setPhase("running");
    setProgress(0);
    setPlan((prev) => prev.map((p) => ({ ...p, status: "pending" })));
    const steps = plan.length;
    // Installing gh leaves one step for a person: signing in to it. A later run that doesn't touch gh
    // leaves an earlier sign-in still waiting; only checking again clears it.
    const signInWaiting = humanAction || plan.some((p) => p.resource === "tools/gh" && p.action === "install");
    let tick = 0;
    window.clearInterval(timer.current);
    timer.current = window.setInterval(() => {
      tick += 1;
      const value = Math.min(100, tick * 4);
      setProgress(value);
      const doneSteps = Math.floor((value / 100) * steps);
      setPlan((prev) =>
        prev.map((p, i) => ({ ...p, status: i < doneSteps ? "done" : i === doneSteps ? "running" : "pending" })),
      );
      if (value >= 100) {
        window.clearInterval(timer.current);
        // The run leaves drifted items as they are, so count them as it ends: completion must not call a partial run up to date.
        const paused = plan.filter((p) => p.action === "skip-drift").length;
        const pausedText = `${paused} ${paused === 1 ? "item" : "items"} held`;
        setPhase("done");
        setAppliedRevision(targetRevision);
        setHumanAction((prev) => prev || signInWaiting);
        setRuns((prev) => [
          { n: (prev[0]?.n ?? 0) + 1, what: paused > 0 ? `Applied revision ${targetRevision}, ${pausedText}` : `Applied revision ${targetRevision}`, when: "Just now", tone: "ok" },
          ...prev,
        ]);
        if (paused > 0)
          toast(`Revision ${targetRevision} applied, ${pausedText}`, {
            description: `${paused === 1 ? "It keeps" : "They keep"} your local edit.\nSee Sync for how to settle ${paused === 1 ? "it" : "them"}.${signInWaiting ? "\nAlso sign in to the GitHub CLI." : ""}`,
          });
        else
          toast.success(`Revision ${targetRevision} applied`, {
            description: signInWaiting ? "One step needs you: sign in to the GitHub CLI." : "This machine is up to date.",
          });
      }
    }, 140);
  }, [plan, targetRevision, humanAction]);
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
      "self-update": { npmCli: null, latest: null },
    };
  if (setup?.role === "follower")
    return {
      "tunnel-up": setup.tunnel,
      // null: no schedule was ever set. With one, the readers' initial (`schedule set --default`) is what onboarding ran.
      ...(setup.schedule ? {} : { "follower-schedule": null }),
      "self-update": { npmCli: null, latest: null },
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

