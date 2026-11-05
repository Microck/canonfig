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
  DEMO,
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
  type KeptSurface,
  type LocalItem,
  type Resource,
  type Revision,
  type Snapshot,
  type SurfaceCategory,
} from "@/shared/data";
import type { Setup } from "@/onboarding/onboarding";
import { workspaceHref, type MachinesMode, type Navigate, type NavigateOptions, type ProfileTab, type WorkspaceRole, type WorkspaceRoute } from "./routes";

export type SourceView =
  | "overview"
  | "profile"
  | "machines"
  | "revisions"
  | "backups"
  | "secrets"
  | "service"
  | "agent"
  | "installers"
  | "setup"
  | "doctor"
  | "version";

export type FollowerView = "overview" | "machines" | "sync" | "schedule" | "local" | "backups" | "secrets" | "tunnel" | "agent" | "doctor" | "machine" | "version";

export type View = SourceView | FollowerView | "not-found";

/**
 * What a plan step does to a surface: replace a file or folder, write Canonfig's marked section and keep the machine's
 * own text (append-local), set owned keys, install a tool, or hold a drifted item.
 */
export type PlanAction = "write" | "append" | "merge" | "install" | "skip-drift";

export interface PlanItem {
  /** The folder item, like `skills/code-review`. */
  resource: string;
  category: ItemCategory;
  /** The main surface it writes: a harness file or folder, or the tool's command. */
  target: string;
  action: PlanAction;
  reason: string;
  /** Set once a Synchronization Run reaches this step. */
  status?: "pending" | "running" | "done";
  /**
   * You edited this item's mirror file after Canonfig last applied it. Canonfig keeps the edit, reports it
   * and holds what it projects from the item; a machine that never applied anything has nothing that could have drifted.
   */
  drift?: boolean;
  /**
   * An append-local text file Canonfig has never written here (first adoption). The whole existing file stays as this
   * machine's text, below Canonfig's section, even where it matches the Source: matching bytes don't prove who wrote
   * it. `retained` is that text byte for byte, which `sync --plan --review-local` writes to a private review.
   */
  adoption?: { retained: string };
}

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

// `source scan` reads the folder's instructions, skills, hook scripts and MCP commands and proposes one tools entry per program it finds.
export const SCANNED_TOOLS = [
  { id: "node", executable: "npx", command: "npx -y @upstash/context7-mcp@2.1.0", file: "canonfig.jsonc", where: "mcp.context7" },
  { id: "prettier", executable: "prettier", command: "prettier --write", file: "hooks/format.sh", where: "line 3" },
  { id: "ripgrep", executable: "rg", command: "rg --files", file: "skills/code-review/SKILL.md", where: "line 12" },
] as const;

export function toolFromScan(f: (typeof SCANNED_TOOLS)[number]): Resource {
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

/** localStorage prefix for guidance state; role and item are appended (e.g. `:source:tip:profile`). */
const GUIDE_KEY = "canonfig-ui:guide";

/**
 * Where guidance preferences (seen tour, finished tour chapters, seen tips, hidden Get started) live. A browser can deny
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

/** What onboarding's scan proposes by default: the first two tools it found in the folder. */
const ONBOARDING_PROPOSED = SCANNED_TOOLS.slice(0, 2).map(toolFromScan);

const SEED_RUNS: Run[] = [
  { n: 41, what: "Interrupted, 3 of 5 done", when: "Yesterday 21:14", tone: "bad" },
  { n: 40, what: "Applied revision 7", when: "Yesterday 08:45" },
  { n: 39, what: "No changes", when: "Oct 26" },
];

/**
 * One unpublished edit to the Machine Profile. Groups, the harness list and the profile defaults are
 * canonfig.jsonc content like items, so they are reviewed and published with them and cleared by publishing.
 */
export type PendingChange =
  | { area: "item"; id: string; change: NonNullable<Resource["change"]>; resource: Resource }
  | { area: "group"; id: string; change: "added" }
  | { area: "harnesses"; id: "harnesses"; change: "modified" }
  | { area: "defaults"; id: "defaults"; change: "modified" };

/** A group, harness list or defaults edit, recorded by Profile when it saves one (see `markProfileEdit`). */
export type ProfileEdit = Exclude<PendingChange, { area: "item" }>;

export type FollowerPhase = "plan" | "running" | "done";

type SetState<T> = Dispatch<SetStateAction<T>>;

export type Secret = (typeof seedSecrets)[number];

/** The demo follower's next revision; a follower that just joined starts on the one it downloaded. */
const DEMO_TARGET_REVISION = 8;
const JOINED_REVISION = 7;

/**
 * The demo's stand-in for reading a page's data from the local Canonfig service, which the real GUI will
 * fetch over loopback. 700ms sits at the slow end of a cold read, so the skeleton is seen and its reveal
 * plays (skullet holds a skeleton back for its first 150ms), without making every first visit drag. Demo
 * only: the production build reads the same simulated data with no wait until the backend exists.
 */
const SIMULATED_LOAD_MS = 700;

/**
 * Pages whose data has loaded since the browser loaded the app, keyed like `pageKey` below. Module scope,
 * like a fetch cache, so it outlives a Demo role switch; a page left before its load finished loads again.
 */
const loadedPages = new Set<string>();

/** Everything a workspace screen can read or do. */
export interface Workspace {
  role: WorkspaceRole;
  /** This machine's name: atlas for the Source, the name a follower joined with. */
  machineName: string;
  /** The Source's Machine Profile display name, as onboarding created it (canonfig.jsonc `profile.name`). */
  profileName: string;
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
   * visit. "Take the tour" opens a picker with that short tour and a longer chapter per area.
   * What has been seen, finished or hidden is remembered per role in localStorage, or only for
   * this page load when the browser denies storage.
   */
  tourOffered: boolean;
  dismissTourOffer: () => void;
  /** The running tour: "quick" (the short first-visit tour) or a chapter id from tour-steps.tsx. */
  tour: string | null;
  /** Derived from `tour`, for everything that only needs to know the app is blocked by a tour. */
  tourOpen: boolean;
  startTour: (id: string) => void;
  /** Ends the running tour; `finished` (reached its end, not skipped) marks it done in the picker. */
  closeTour: (finished: boolean) => void;
  tourPickerOpen: boolean;
  setTourPickerOpen: (open: boolean) => void;
  /**
   * In the demo, the first visit to each page in a page load waits SIMULATED_LOAD_MS for its data, showing a
   * skeleton (Body in kit.tsx). Never while a tour runs or its picker is open: tours spotlight the pages they
   * open. Always false in production, which has no fake delay.
   */
  pageLoading: boolean;
  tourFinished: (id: string) => boolean;
  /** The page whose tip is showing, if any. Leaving that page closes it. */
  activeTip: View | null;
  openTip: (view: View) => void;
  closeTip: () => void;
  /** Takes down a tip that found no free spot without marking it seen, so its first visit can still show it. */
  withdrawTip: () => void;
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
  /** Reads the folder's items when called, for a delayed callback that must see an edit saved while it waited. */
  readResources: () => Resource[];
  /** Reads the unpublished changes and the next revision number when called, like readResources. */
  readQueue: () => { pending: PendingChange[]; nextSequence: number };
  revisions: Revision[];
  /** Newest published revision, 0 before the first publish. */
  latest: number;
  followers: Follower[];
  setFollowers: SetState<Follower[]>;
  invitations: Invitation[];
  setInvitations: SetState<Invitation[]>;
  secrets: Secret[];
  setSecrets: SetState<Secret[]>;
  /** Profile edits since the latest Profile Revision: items, groups, the harness list and defaults. */
  pending: PendingChange[];
  /** Records a group, harness list or defaults edit as unpublished; repeating one is a no-op. */
  markProfileEdit: (edit: ProfileEdit) => void;
  /** Withdraws a recorded edit, for example defaults saved back to their published values. */
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
  /** The revision the plan brings this follower to. */
  targetRevision: number;
  phase: FollowerPhase;
  progress: number;
  applyPlan: () => void;
  /** A drifted mirror file holds its item: kept, reported, and left out of every run until the edit moves or the Source publishes it. */
  driftOpen: boolean;
  interrupted: boolean;
  recover: () => void;
  abandon: () => void;
  runs: Run[];
  humanAction: boolean;
  setHumanAction: SetState<boolean>;
  /** The revision this follower last applied; 0 when it hasn't applied any yet. */
  appliedRevision: number;
  /** Harnesses listed in canonfig.jsonc: the Source edits them in Profile, a follower gets them with each revision. */
  listed: HarnessId[];
  setListed: SetState<HarnessId[]>;
  /** canonfig.jsonc `surfaces`: categories a listed harness is limited to; a harness not named gets every category. */
  surfaces: Partial<Record<HarnessId, SurfaceCategory[]>>;
  setSurfaces: SetState<Partial<Record<HarnessId, SurfaceCategory[]>>>;
  /** Harnesses excluded on this machine in ~/.canonfig/local/local.jsonc. */
  excluded: HarnessId[];
  setExcluded: SetState<HarnessId[]>;
  /** Every harness as `canonfig harnesses` reports it here, with `listed` and `excluded` from the two above. */
  harnesses: Harness[];
  /** local.jsonc `backups`: false takes over harnesses without a takeover snapshot. */
  backups: boolean;
  setBackups: SetState<boolean>;
  /** Takeover snapshots in ~/.canonfig/.backups/, oldest first. */
  snapshots: Snapshot[];
  /** Simulates `canonfig restore <snapshot>`: puts the snapshot back and excludes its harnesses here. */
  restore: (snapshot: string) => void;
  /** Simulates `canonfig export`: downloads ~/.canonfig/ and local/ as one .tar.gz with a checksum manifest, signed on the Source. */
  exportArchive: () => void;
  /** This machine's ~/.canonfig/local/ items. */
  local: LocalItem[];
  setLocal: SetState<LocalItem[]>;
  /** local.jsonc `overlays`: `<category>/<name>` items whose local version replaces the published one here, and `settings/<harness>#<key>` key claims. */
  overlays: string[];
  setOverlays: SetState<string[]>;
  /** What `local.appendLocal` keeps of this machine's own in harness files it already applied. */
  kept: KeptSurface[];
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
  // Taking or declining the tour both settle the offer for good; the tour stays one click away.
  const dismissTourOffer = () => {
    guidePrefs.set(seenKey("tour"));
    setTourOffered(false);
  };
  const [tour, setTour] = useState<string | null>(() => (new URLSearchParams(location.search).get("tour") === "1" ? "quick" : null));
  const startTour = (id: string) => {
    dismissTourOffer();
    setTour(id);
  };
  const [finishedTours, setFinishedTours] = useState<ReadonlySet<string>>(
    () => new Set(guidePrefs.keys().filter((k) => k.startsWith(seenKey("chapter:"))).map((k) => k.slice(seenKey("chapter:").length))),
  );
  const closeTour = (finished: boolean) => {
    if (finished && tour) {
      guidePrefs.set(seenKey(`chapter:${tour}`));
      setFinishedTours((prev) => new Set(prev).add(tour));
    }
    setTour(null);
  };
  const tourFinished = (id: string) => finishedTours.has(id);
  const [tourPickerOpen, setPickerOpen] = useState(false);
  // Finding the tour on your own settles the offer the same way taking it does.
  const setTourPickerOpen = (open: boolean) => {
    if (open) dismissTourOffer();
    setPickerOpen(open);
  };
  // Each page tab is its own fetch (Profile items and groups), so the key includes them; outside Profile and
  // Machines those parts stay at their defaults. A tour, or its picker about to start one, settles the load at
  // once, and pages it opens never start one.
  const pageKey = `${role}:${view}:${profileTab}:${machinesMode}`;
  const guided = tour !== null || tourPickerOpen;
  const [loadingPage, setLoadingPage] = useState<string | null>(null);
  // Started during render, like the tip reset below, so a page's first frame (the app's first one too) is
  // already its skeleton.
  const [shownPage, setShownPage] = useState<string | null>(null);
  if (shownPage !== pageKey) {
    setShownPage(pageKey);
    setLoadingPage(!DEMO || guided || loadedPages.has(pageKey) ? null : pageKey);
  } else if (guided && loadingPage !== null) {
    loadedPages.add(loadingPage);
    setLoadingPage(null);
  }
  useEffect(() => {
    if (loadingPage === null) return;
    const t = window.setTimeout(() => {
      loadedPages.add(loadingPage);
      setLoadingPage(null);
    }, SIMULATED_LOAD_MS);
    return () => window.clearTimeout(t);
  }, [loadingPage]);
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
  const withdrawTip = () => setActiveTip(null);
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

  return {
    role,
    machineName,
    profileName: newSource?.profileName ?? profile.name,
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
    tour,
    tourOpen: tour !== null,
    startTour,
    closeTour,
    tourPickerOpen,
    setTourPickerOpen,
    pageLoading: loadingPage === pageKey,
    tourFinished,
    activeTip,
    openTip,
    closeTip,
    withdrawTip,
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
