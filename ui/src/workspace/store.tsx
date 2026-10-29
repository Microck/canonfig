// Demo state only: actions use local React state, timers, and toasts, not a backend.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { toast } from "sonner";
import {
  followers as seedFollowers,
  configKeysFor,
  followerSelf,
  machine,
  profile,
  resources as seedResources,
  revisions as seedRevisions,
  secrets as seedSecrets,
  type Follower,
  type Resource,
  type ResourceKind,
  type Revision,
} from "@/shared/data";
import type { Setup } from "@/onboarding/onboarding";
import { profilePlan } from "./profiles";
import { workspaceHref, type MachinesMode, type Navigate, type NavigateOptions, type ProfileTab, type WorkspaceRole, type WorkspaceRoute } from "./routes";

export type SourceView =
  | "overview"
  | "profile"
  | "machines"
  | "revisions"
  | "secrets"
  | "service"
  | "agent"
  | "harness"
  | "installers"
  | "setup"
  | "doctor";

export type FollowerView = "overview" | "machines" | "sync" | "schedule" | "overlays" | "secrets" | "tunnel" | "agent" | "harness" | "doctor" | "machine";

export type View = SourceView | FollowerView | "not-found";

export type PlanAction = "write" | "merge" | "install" | "skip-drift" | "keep-local";

export interface PlanItem {
  resource: string;
  kind: ResourceKind;
  target: string;
  action: PlanAction;
  reason: string;
  /** Set once a Synchronization Run reaches this step. */
  status?: "pending" | "running" | "done";
  /**
   * You edited this copy after Canonfig last applied it. Only such an item offers Keep my edit or
   * Use revision; a machine that never applied anything has nothing that could have drifted.
   */
  drift?: boolean;
}

/** A person's answer to Follower Drift: keep their edit, or take the revision's copy. */
export type DriftChoice = "keep" | "canonical";

export const FOLLOWER_PLAN: PlanItem[] = [
  { resource: "codex-agents", kind: "file", target: "~/.codex/AGENTS.md", action: "write", reason: "Content changed in revision 8" },
  { resource: "claude-settings", kind: "config", target: "~/.claude/settings.json", action: "merge", reason: "Sets 3 keys. env.EDITOR is kept on this machine, so it stays as it is." },
  { resource: "gh-cli", kind: "tool", target: "gh", action: "install", reason: "Not installed yet. Runs brew install gh, then checks it starts." },
  { resource: "claude-review-skill", kind: "skill", target: "~/.claude/skills/code-review", action: "skip-drift", drift: true, reason: "You edited SKILL.md after Canonfig applied revision 7." },
];

/**
 * The first plan on a follower that just joined: revision 7, the one it downloaded, applied to
 * a machine Canonfig hasn't touched yet. Nothing was applied before, so nothing can have drifted.
 */
export const JOINED_PLAN: PlanItem[] = [
  { resource: "claude-instructions", kind: "file", target: "~/.claude/CLAUDE.md", action: "write", reason: "Writes the copy from revision 7. Canonfig backs up the file that's there first." },
  { resource: "codex-agents", kind: "file", target: "~/.codex/AGENTS.md", action: "write", reason: "Writes the copy from revision 7. Canonfig backs up the file that's there first." },
  { resource: "claude-settings", kind: "config", target: "~/.claude/settings.json", action: "merge", reason: "Sets 3 keys and leaves the rest of the file as it is." },
  { resource: "claude-review-skill", kind: "skill", target: "~/.claude/skills/code-review", action: "write", reason: "Not on this machine yet. Writes the 3 files of the skill." },
  { resource: "gh-cli", kind: "tool", target: "gh", action: "install", reason: "Not installed yet. Runs brew install gh, then checks it starts." },
];

export interface Invitation {
  id: string;
  file: string;
  name: string;
  groups: string[];
  expires: string;
  /** Set when the invitation re-enrolls an existing follower with new groups (`enroll --replace`). */
  replaces?: string;
}

/** Opens "Change groups": for one follower, or to add machines to one group. */
export interface ChangeGroupsRequest {
  followerId?: string;
  addGroup?: string;
}

/** One Synchronization Run on this follower, newest first. */
export interface Run {
  n: number;
  what: string;
  when: string;
  tone?: "ok" | "bad" | "muted";
}

// `source scan` over ~/.codex/config.toml and ~/.claude.json: one proposed tool per command found there.
export const SCANNED_TOOLS = [
  { id: "playwright-mcp", target: "npx", command: "npx @playwright/mcp@0.0.41", file: "~/.claude.json", where: "mcpServers.playwright" },
  { id: "uv", target: "uvx", command: "uvx mcp-server-fetch", file: "~/.codex/config.toml", where: "mcp_servers.fetch" },
  { id: "bun", target: "bunx", command: "bunx @modelcontextprotocol/server-memory", file: "~/.claude.json", where: "mcpServers.memory" },
] as const;

export function toolFromScan(f: (typeof SCANNED_TOOLS)[number]): Resource {
  return {
    id: f.id,
    kind: "tool",
    target: f.target,
    policy: "ensure",
    groups: [],
    summary: `found in ${f.file.split("/").pop()}`,
    change: "added",
    detail: { Command: f.command, Evidence: `${f.file}, ${f.where}`, Verify: "executable-present" },
  };
}

/** localStorage prefix for guidance state; role and item are appended (e.g. `:source:tip:profile`). */
const GUIDE_KEY = "canonfig-ui:guide";

/**
 * Where guidance preferences (seen tour, seen tips, hidden Get started) live. A browser can deny
 * localStorage, for example with blocked site data; then they are kept in memory for this page
 * load instead, so a refused preference never stops the workspace from opening. Machine state
 * is unaffected: it is demo state and never stored.
 */
const guidePrefs: { has: (key: string) => boolean; keys: () => string[]; set: (key: string) => void; remove: (key: string) => void } = (() => {
  try {
    const storage = window.localStorage;
    // Reading the property can succeed while writes throw, so probe a write as well.
    const probe = `${GUIDE_KEY}:probe`;
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return {
      has: (key) => storage.getItem(key) !== null,
      keys: () => Object.keys(storage),
      set: (key) => storage.setItem(key, "1"),
      remove: (key) => storage.removeItem(key),
    };
  } catch {
    const memory = new Set<string>();
    return {
      has: (key) => memory.has(key),
      keys: () => [...memory],
      set: (key) => void memory.add(key),
      remove: (key) => void memory.delete(key),
    };
  }
})();

/** Get started steps that can't be read from other state. */
export type Milestone = "health-check" | "schedule";

/** What onboarding's scan proposes by default: the two tools it found in both files. */
const ONBOARDING_PROPOSED = SCANNED_TOOLS.slice(0, 2).map(toolFromScan);

const SEED_RUNS: Run[] = [
  { n: 41, what: "Interrupted, 3 of 5 done", when: "Yesterday 21:14", tone: "bad" },
  { n: 40, what: "Applied revision 7", when: "Yesterday 08:45" },
  { n: 39, what: "No changes", when: "Oct 26" },
];

/** A Local Overlay claims keys of one config resource: Canonfig stops managing them on this machine. It stores no values. */
export interface Overlay {
  resource: string;
  target: string;
  keys: string[];
}

/** What this machine's config files currently hold, shown next to claimed keys as context. */
export const LOCAL_VALUES: Record<string, Record<string, string>> = {
  "codex-config": { model: '"gpt-5.5"', model_reasoning_effort: '"medium"', sandbox_mode: '"workspace-write"', approval_policy: '"on-request"' },
  "claude-settings": { "env.EDITOR": '"zed"', "permissions.defaultMode": '"acceptEdits"', "env.DISABLE_TELEMETRY": '"1"', theme: '"dark"' },
};

/**
 * Kept keys the Source also sets in that file. `canonfig sync` pauses such a file instead of picking
 * a winner. Here so a run can count what it skips, and Sync can show the same pauses.
 */
export function conflictsIn(resource: string, overlays: Overlay[]): string[] {
  const declared = configKeysFor(resource);
  return overlays.find((o) => o.resource === resource)?.keys.filter((k) => declared.includes(k)) ?? [];
}

/** The plan item after a drift decision, written for the revision the plan brings. */
function decideDrift(p: PlanItem, choice: DriftChoice, revision: number): PlanItem {
  return choice === "keep"
    ? { ...p, action: "keep-local", reason: "Keeping your edit. Canonfig stops flagging it until the canonical copy changes again." }
    : { ...p, action: "write", reason: `Replaces your edit with revision ${revision}. Canonfig backs up your version first.` };
}

/**
 * One unpublished edit to the Machine Profile. Groups and the profile defaults are profile
 * content like items, so they are reviewed and published with them and cleared by publishing.
 */
export type PendingChange =
  | { area: "item"; id: string; change: NonNullable<Resource["change"]>; resource: Resource }
  | { area: "group"; id: string; change: "added" }
  | { area: "defaults"; id: "defaults"; change: "modified" };

/** A group or defaults edit, recorded by Profile when it saves one (see `markProfileEdit`). */
export type ProfileEdit = Exclude<PendingChange, { area: "item" }>;

export type FollowerPhase = "plan" | "running" | "done";

type SetState<T> = Dispatch<SetStateAction<T>>;

export type Secret = (typeof seedSecrets)[number];

/** The demo follower's next revision; a follower that just joined starts on the one it downloaded. */
const DEMO_TARGET_REVISION = 8;
const JOINED_REVISION = 7;

/** Everything a workspace screen can read or do. */
export interface Workspace {
  role: WorkspaceRole;
  /** This machine's name: atlas for the Source, the name a follower joined with. */
  machineName: string;
  /** The Source's Machine Profile: its display name and file, as onboarding created them. */
  profileName: string;
  profileFile: string;
  /** Where followers reach this Source, with the port chosen in onboarding. */
  endpoint: string;
  /** A follower that just finished onboarding: enrolled, revision downloaded, nothing applied. */
  justJoined: boolean;
  /** Whether this follower reaches the Source through Canonfig's SSH tunnel. False: no tunnel exists. */
  tunnelConfigured: boolean;
  /** Tool ids onboarding proposed; Profile highlights them until they're published. */
  proposed: string[];
  view: View;
  setView: (view: View) => void;
  /** Selected row or action encoded in the current URL. */
  focus: string | null;
  go: (view: View, focus?: string, options?: NavigateOptions) => void;
  navigate: Navigate;
  profileTab: ProfileTab;
  paletteOpen: boolean;
  setPaletteOpen: SetState<boolean>;
  /**
   * Guidance for a first-time user, in three parts: a short tour that is offered (never
   * forced), a "Get started" list on Overview, and one tip per complex page on its first
   * visit. What has been seen or hidden is remembered per role in localStorage, or only for
   * this page load when the browser denies storage.
   */
  tourOffered: boolean;
  dismissTourOffer: () => void;
  tourOpen: boolean;
  setTourOpen: (open: boolean) => void;
  /** The page whose tip is showing, if any. Leaving that page closes it. */
  activeTip: View | null;
  openTip: (view: View) => void;
  closeTip: () => void;
  tipSeen: (view: View) => boolean;
  getStartedHidden: boolean;
  setGetStartedHidden: (hidden: boolean) => void;
  /** Get started steps that leave no other trace in state. */
  milestones: ReadonlySet<Milestone>;
  reach: (milestone: Milestone) => void;
  publishOpen: boolean;
  setPublishOpen: SetState<boolean>;
  inviteOpen: boolean;
  setInviteOpen: SetState<boolean>;
  resources: Resource[];
  setResources: SetState<Resource[]>;
  revisions: Revision[];
  /** Newest published revision, 0 before the first publish. */
  latest: number;
  followers: Follower[];
  setFollowers: SetState<Follower[]>;
  invitations: Invitation[];
  setInvitations: SetState<Invitation[]>;
  secrets: Secret[];
  setSecrets: SetState<Secret[]>;
  /** Profile edits since the latest Profile Revision: items, groups and defaults. */
  pending: PendingChange[];
  /** Records a group or defaults edit as unpublished; repeating one is a no-op. */
  markProfileEdit: (edit: ProfileEdit) => void;
  /** Withdraws a recorded group or defaults edit, for example defaults saved back to their published values. */
  removeProfileEdit: (edit: ProfileEdit) => void;
  nextSequence: number;
  publishing: boolean;
  publish: (reviewer: string, onDone: () => void) => void;
  /** Followers fetching the revision that was just published. */
  syncing: string[];
  machinesMode: MachinesMode;
  changeGroups: ChangeGroupsRequest | null;
  setChangeGroups: (req: ChangeGroupsRequest | null) => void;
  plan: PlanItem[];
  /** Replaces the plan, for example after selecting another profile; a run in progress stops. */
  replan: (items: PlanItem[]) => void;
  /** The revision the plan brings this follower to. */
  targetRevision: number;
  phase: FollowerPhase;
  progress: number;
  applyPlan: () => void;
  /** Decides drift on `resource`. Remembered for the session, so it survives profile switches. */
  resolveDrift: (resource: string, choice: DriftChoice) => void;
  driftOpen: boolean;
  interrupted: boolean;
  recover: () => void;
  abandon: () => void;
  runs: Run[];
  humanAction: boolean;
  setHumanAction: SetState<boolean>;
  /** The revision this follower last applied; 0 when it hasn't applied any yet. */
  appliedRevision: number;
  overlays: Overlay[];
  setOverlays: SetState<Overlay[]>;
  unenrollOpen: boolean;
  setUnenrollOpen: SetState<boolean>;
  unenrolled: boolean;
  /** Stops syncing: a run in progress stops, and the machine takes no further updates. */
  unenroll: () => void;
  /**
   * Runs `fn` after `ms` unless the workspace closes first. The workspace lasts as long as its
   * role, so a demo operation never reports back into another role. Pages unmount on navigation
   * while these still fire, so write their results to workspace or shared state.
   */
  later: (fn: () => void, ms: number) => void;
  /** Reads the stopped state when called, for delayed callbacks that would otherwise see a stale value. */
  isStopped: () => boolean;
}

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

function useWorkspaceState(route: WorkspaceRoute, navigate: Navigate, setup: Setup | null): Workspace {
  const { role, view, focus, profileTab, machinesMode } = route;
  // Fresh out of onboarding, the workspace holds only what the person just set up.
  const newSource = role === "source" && setup?.role === "source" ? setup : null;
  const joined = role === "follower" && setup?.role === "follower" ? setup : null;
  const go = useCallback((next: View, id?: string, options?: NavigateOptions) => {
    navigate(workspaceHref(role, next, { focus: id }), options);
  }, [role, navigate]);
  const setView = useCallback((next: View) => go(next), [go]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const seenKey = (what: string) => `${GUIDE_KEY}:${role}:${what}`;
  const [tourOffered, setTourOffered] = useState(() => !guidePrefs.has(seenKey("tour")));
  const [tourOpen, setTourOpenState] = useState(() => new URLSearchParams(location.search).get("tour") === "1");
  // Taking or declining the tour both settle the offer for good; the tour stays one click away.
  const dismissTourOffer = () => {
    guidePrefs.set(seenKey("tour"));
    setTourOffered(false);
  };
  const setTourOpen = (open: boolean) => {
    dismissTourOffer();
    setTourOpenState(open);
  };
  const [activeTip, setActiveTip] = useState<View | null>(null);
  const [seenTips, setSeenTips] = useState<ReadonlySet<string>>(
    () => new Set(guidePrefs.keys().filter((k) => k.startsWith(seenKey("tip:"))).map((k) => k.slice(seenKey("tip:").length))),
  );
  const openTip: (view: View) => void = setActiveTip;
  const closeTip = () => {
    if (activeTip) {
      guidePrefs.set(seenKey(`tip:${activeTip}`));
      setSeenTips((prev) => new Set(prev).add(activeTip));
    }
    setActiveTip(null);
  };
  // A tip explains one page. When the route moves on, including browser Back/Forward, which
  // bypass closeTip, leaving counts as closing it, so the next page never shows the old text.
  // Adjusted during render rather than in an effect so the stale tip never paints; marking it
  // seen is idempotent, so a repeated render does no harm.
  if (activeTip !== null && activeTip !== view) closeTip();
  const tipSeen = (v: View) => seenTips.has(v);
  const [getStartedHidden, setHidden] = useState(() => guidePrefs.has(seenKey("get-started-hidden")));
  const setGetStartedHidden = (hidden: boolean) => {
    if (hidden) guidePrefs.set(seenKey("get-started-hidden"));
    else guidePrefs.remove(seenKey("get-started-hidden"));
    setHidden(hidden);
  };
  // A schedule turned on during onboarding already settles the Get started schedule step.
  const [milestones, setMilestones] = useState<ReadonlySet<Milestone>>(() => new Set<Milestone>(joined?.schedule ? ["schedule"] : []));
  const reach = useCallback((m: Milestone) => setMilestones((prev) => (prev.has(m) ? prev : new Set(prev).add(m))), []);
  const [publishOpen, setPublishOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [changeGroups, setChangeGroups] = useState<ChangeGroupsRequest | null>(null);

  // Source state. A new Source has no revisions, followers or secrets yet; its profile holds
  // only what the scan proposed, or nothing when the scan was skipped.
  const [resources, setResources] = useState<Resource[]>(newSource ? (newSource.scan ? ONBOARDING_PROPOSED : []) : seedResources);
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

  const publish = useCallback(
    (reviewer: string, onDone: () => void) => {
      setPublishing(true);
      later(() => {
        const seq = nextSequence;
        const mark = { added: "+", modified: "~", removed: "−" } as const;
        const summary = pending.map((c) => `${mark[c.change]}${c.area === "group" ? `group ${c.id}` : c.id}`).join(", ");
        setRevisions((prev) => [{ sequence: seq, digest: demoDigest(seq, summary), publishedAt: "Just now", reviewer, changes: summary }, ...prev]);
        setResources((prev) => prev.filter((r) => r.change !== "removed").map((r) => ({ ...r, change: undefined })));
        // Groups and defaults went out with this revision too, so they are no longer unpublished.
        setProfileEdits([]);
        setProposed([]);
        setPublishing(false);
        onDone();
        toast.success(`Published revision ${seq}`, {
          description: "Saved in this demo workspace. Reachable machines receive it next and apply it on their next check.",
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

  // Follower state. One that just joined has downloaded revision 7 and applied nothing: no runs,
  // nothing interrupted, no Local Overlays, and a plan for the profile it chose.
  const machineName = joined?.name ?? (role === "source" ? machine.hostname : followerSelf.name);
  const targetRevision = joined ? JOINED_REVISION : DEMO_TARGET_REVISION;
  const [plan, setPlan] = useState<PlanItem[]>(() => (joined ? profilePlan(JOINED_PLAN, joined.profileId) : FOLLOWER_PLAN));
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
  const [overlays, setOverlays] = useState<Overlay[]>(() =>
    joined
      ? []
      : followerSelf.overlays.map((o) => ({ resource: o.resource, target: seedResources.find((r) => r.id === o.resource)?.target ?? "", keys: [o.key] })),
  );
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearInterval(timer.current), []);
  // The run's interval closes over the render that started it; completion reads this instead, so
  // a decision or Local settings change made mid-run is reflected (same pattern as guide.tsx).
  const latestRun = useRef({ plan, overlays });
  latestRun.current = { plan, overlays };

  // Drift decisions belong to the session, not to one plan: an item that leaves the plan with a
  // profile switch gets the same decision back when it returns (see `replan`).
  const decisions = useRef(new Map<string, DriftChoice>());

  const resolveDrift = useCallback(
    (resource: string, choice: DriftChoice) => {
      decisions.current.set(resource, choice);
      setPlan((prev) => prev.map((p) => (p.resource === resource && p.drift ? decideDrift(p, choice, targetRevision) : p)));
      // Keeping the edit after a run needs no apply: the run already left the file alone, so the
      // decision only stops the flag. Taking the revision reopens the plan (see useReopenSkipped).
      toast(choice === "keep" ? `Keeping your edit to ${resource}` : `Will write revision ${targetRevision} of ${resource}`, {
        description: choice === "keep" && phase === "done" ? "Recorded now. There is nothing to apply." : "Takes effect when you apply the changes.",
      });
    },
    [targetRevision, phase],
  );

  const recover = useCallback(() => {
    setInterrupted(false);
    setRuns((prev) => prev.map((r) => (r.n === 41 ? { ...r, what: "Recovered: all 5 steps done", when: "Just now", tone: "ok" } : r)));
    toast.success("Run #41 recovered", { description: "Finished the 2 remaining steps from the journal." });
  }, []);

  const abandon = useCallback(() => {
    setInterrupted(false);
    setRuns((prev) => prev.map((r) => (r.n === 41 ? { ...r, what: "Abandoned, 3 of 5 done", tone: "muted" } : r)));
    toast("Run #41 abandoned", { description: "Its 3 finished steps stay in place. Nothing was rolled back." });
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

  const replan = useCallback(
    (items: PlanItem[]) => {
      window.clearInterval(timer.current);
      setPlan(
        items.map(({ status: _status, ...p }) => {
          const choice = p.drift ? decisions.current.get(p.resource) : undefined;
          return choice ? decideDrift(p, choice, targetRevision) : p;
        }),
      );
      setPhase("plan");
      setProgress(0);
    },
    [targetRevision],
  );

  const applyPlan = useCallback(() => {
    setPhase("running");
    setProgress(0);
    setPlan((prev) => prev.map((p) => ({ ...p, status: "pending" })));
    const steps = plan.length;
    // Installing gh leaves one step for a person: signing in to it. A later run that doesn't touch gh
    // leaves an earlier sign-in still waiting; only checking again clears it.
    const signInWaiting = humanAction || plan.some((p) => p.resource === "gh-cli" && p.action === "install");
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
        // The run skips paused items, so count them as it ends: completion must not call a partial run up to date.
        const paused = latestRun.current.plan.filter((p) => p.action === "skip-drift" || conflictsIn(p.resource, latestRun.current.overlays).length > 0).length;
        const pausedText = `${paused} ${paused === 1 ? "item" : "items"} paused`;
        setPhase("done");
        setAppliedRevision(targetRevision);
        setHumanAction((prev) => prev || signInWaiting);
        setRuns((prev) => [
          { n: (prev[0]?.n ?? 0) + 1, what: paused > 0 ? `Applied revision ${targetRevision}, ${pausedText}` : `Applied revision ${targetRevision}`, when: "Just now", tone: "ok" },
          ...prev,
        ]);
        if (paused > 0)
          toast(`Revision ${targetRevision} applied, ${pausedText}`, {
            description: `Decide on ${paused === 1 ? "it" : "them"} in Sync, then apply what's left.${signInWaiting ? " Also sign in to the GitHub CLI." : ""}`,
          });
        else
          toast.success(`Revision ${targetRevision} applied`, {
            description: signInWaiting ? "One step needs you: sign in to the GitHub CLI." : "This machine is up to date.",
          });
      }
    }, 140);
  }, [plan, targetRevision, humanAction]);

  const driftOpen = plan.some((p) => p.action === "skip-drift");

  return {
    role,
    machineName,
    profileName: newSource?.profileName ?? profile.name,
    profileFile: newSource?.profileFile ?? machine.profileFile,
    endpoint: newSource ? `https://127.0.0.1:${newSource.port}` : machine.endpoint,
    justJoined: joined !== null,
    tunnelConfigured: joined?.tunnel ?? true,
    proposed,
    view,
    setView,
    paletteOpen,
    setPaletteOpen,
    tourOffered,
    dismissTourOffer,
    tourOpen,
    setTourOpen,
    activeTip,
    openTip,
    closeTip,
    tipSeen,
    getStartedHidden,
    setGetStartedHidden,
    milestones,
    reach,
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
    machinesMode,
    changeGroups,
    setChangeGroups,
    plan,
    replan,
    targetRevision,
    phase,
    progress,
    applyPlan,
    resolveDrift,
    driftOpen,
    interrupted,
    recover,
    abandon,
    runs,
    humanAction,
    setHumanAction,
    appliedRevision,
    overlays,
    setOverlays,
    unenrollOpen,
    setUnenrollOpen,
    unenrolled,
    unenroll,
    later,
    isStopped,
    focus,
    navigate,
    profileTab,
    go,
  };
}

const WorkspaceContext = createContext<Workspace | null>(null);

interface SharedStore {
  values: Readonly<Record<string, unknown>>;
  update: (key: string, fn: (prev: unknown) => unknown, initial: unknown) => void;
  /** Reads a key's current value; see `useSharedReader`. */
  read: (key: string, initial: unknown) => unknown;
}
const SharedContext = createContext<SharedStore | null>(null);

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
    };
  if (setup?.role === "follower")
    return {
      "selected-profile": setup.profileId,
      "tunnel-up": setup.tunnel,
      // null: no schedule was ever set. With one, the readers' initial (`schedule set --default`) is what onboarding ran.
      ...(setup.schedule ? {} : { "follower-schedule": null }),
    };
  return {};
}

/** `setup` is what onboarding just created; null opens the seeded demo machine for `role`. */
export function WorkspaceProvider({ route, navigate, setup = null, children }: {
  route: WorkspaceRoute;
  navigate: Navigate;
  setup?: Setup | null;
  children: ReactNode;
}) {
  const value = useWorkspaceState(route, navigate, setup);
  const [values, setValues] = useState<Readonly<Record<string, unknown>>>(() => sharedSeed(setup));
  const update = useCallback(
    (key: string, fn: (prev: unknown) => unknown, initial: unknown) => setValues((prev) => ({ ...prev, [key]: fn(key in prev ? prev[key] : initial) })),
    [],
  );
  // Delayed callbacks close over the render that started them; `read` goes through this instead,
  // so they see a value changed while they waited (same pattern as guide.tsx).
  const latest = useRef(values);
  latest.current = values;
  const read = useCallback((key: string, initial: unknown) => (key in latest.current ? latest.current[key] : initial), []);
  const shared = useMemo(() => ({ values, update, read }), [values, update, read]);
  return (
    <WorkspaceContext.Provider value={value}>
      <SharedContext.Provider value={shared}>{children}</SharedContext.Provider>
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace outside WorkspaceProvider");
  return ctx;
}

/**
 * State that must outlive the page that edits it: a saved form, a stopped tunnel, a
 * created project. Pages unmount on navigation, so plain useState loses what the user
 * saved. Values live as long as the workspace (a reload resets them, like all mock state).
 * Every reader of a key must pass the same `initial`; the first write wins over it.
 */
export function useSharedState<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const ctx = useContext(SharedContext);
  if (!ctx) throw new Error("useSharedState outside WorkspaceProvider");
  const value = (key in ctx.values ? ctx.values[key] : initial) as T;
  const { update } = ctx;
  const set = useCallback(
    (next: T | ((prev: T) => T)) => update(key, (prev) => (typeof next === "function" ? (next as (p: T) => T)(prev as T) : next), initial),
    // `initial` is only the fallback for the first write; callers pass a stable literal per key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, update],
  );
  return [value, set];
}

/**
 * Reads `key` when called rather than when rendered, like `isStopped`: for a delayed callback that
 * must see a value changed while it waited, such as a tunnel stopped during a secret refresh.
 * Pass the same `initial` as the key's `useSharedState` readers.
 */
export function useSharedReader<T>(key: string, initial: T): () => T {
  const ctx = useContext(SharedContext);
  if (!ctx) throw new Error("useSharedReader outside WorkspaceProvider");
  const { read } = ctx;
  return () => read(key, initial) as T;
}
