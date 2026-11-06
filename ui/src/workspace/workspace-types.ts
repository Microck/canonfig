import type { FollowerLive } from "./follower-types";
import type { Dispatch, SetStateAction } from "react";
import type { AppendLocalCategory, Follower, FollowerState, Harness, HarnessId, ItemCategory, KeptSurface, LocalCategory, LocalItem, Resource, Revision, SkillSource, Snapshot, SurfaceCategory, UpstreamSkill } from "@/shared/metadata";
import type { GuiRequestError, GuiSession, GuiStatus } from "../gui-client";
import type { MachinesMode, Navigate, NavigateOptions, ProfileTab, WorkspaceRole } from "./routes";
import type { AdministrationSlice } from "./administration-types";
import type { Schedule } from "./schedule";
import type { WorkspaceBackend } from "../gui-client";
import type { GuiEnrollment, GuiInvitationDownload } from "../../../src/gui/contract/enrollment";
import type { Schema } from "effect";
import type { GuiProfileSnapshot, GuiProfileValidation, GuiProfileConfigWrite, GuiSkillCheck } from "../../../src/gui/contract/profile";
import type { GuiArchiveDownload } from "../../../src/gui/contract/synchronization";
import type { ExactDraft } from "./profile-authoring";

type SetState<T> = Dispatch<SetStateAction<T>>;

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

export type FollowerView = "overview" | "machines" | "sync" | "schedule" | "local" | "backups" | "secrets" | "tunnel" | "agent" | "installers" | "setup" | "doctor" | "machine" | "version";

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

export type Milestone = "health-check" | "schedule";
export interface Secret { name: string; updated?: string; sharedWith?: number }

export interface ScannedTool { id: string; executable: string; command: string; file: string; where: string }
export interface WorkspaceProfile {
  id: string;
  name: string;
  groups: { name: string; description: string }[];
  localAllow: LocalCategory[];
  appendLocal: AppendLocalCategory[];
}
export interface SourceMachine {
  hostname: string;
  platform?: "linux" | "macos" | "windows";
  folder: string;
  endpoint: string;
  service?: string;
}
export interface FollowerSelf {
  name: string;
  home: string;
  source: string;
  revision?: number;
  state?: FollowerState;
  local: LocalItem[];
  overlays: string[];
  kept: KeptSurface[];
}

/** A resource retains its last successful value while refresh reports loading or an error. */
export interface ResourceState {
  loading: boolean;
  error: GuiRequestError | null;
}

export interface WorkspaceCapabilities {
  invitationCancel: boolean;
  selectiveScanWrite: boolean;
  serviceRestart: boolean;
  privateReviewDelete: boolean;
  simulatedTelemetry: boolean;
  profileWrite: boolean;
  enrollmentWrite: boolean;
  followerWrite: boolean;
}

export interface OverviewSlice {
  session?: GuiSession;
  status?: GuiStatus;
  reload: () => void;
  folderPath: string;
  version: string;
  capabilities: WorkspaceCapabilities;
  overviewState: ResourceState;
  notImplemented: (member: string) => never;
  pageError?: GuiRequestError | null;
  sourceActivity: { follower?: string; revision?: number; what: string; when: string }[];
  role: WorkspaceRole;
  /** This machine's name: atlas for the Source, the name a follower joined with. */
  machineName: string;
  view: View;
  setView: (view: View) => void;
  /** Selected row or action encoded in the current URL. */
  focus: string | null;
  go: (view: View, focus?: string, options?: NavigateOptions) => void;
  navigate: Navigate;
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
  /**
   * Runs `fn` after `ms` unless the workspace closes first. The workspace lasts as long as its
   * role, so a demo operation never reports back into another role. Pages unmount on navigation
   * while these still fire, so write their results to workspace or shared state.
   */
  later: (fn: () => void, ms: number) => void;
}

export interface ProfileSlice {
  profileLive?: {
    snapshot: GuiProfileSnapshot | null;
    busy: boolean;
    error: GuiRequestError | null;
    validation: GuiProfileValidation | null;
    archive: GuiArchiveDownload | null;
    skillChecks: Record<string, GuiSkillCheck>;
    skillBusy: string | null;
    scanDone: boolean;
    revisionDetail: (ResourceState & { sequence: number; data: Schema.Json | null }) | null;
    reload: () => void;
    saveItem: (snapshot: GuiProfileSnapshot, before: Resource | undefined, next: Resource, exact?: ExactDraft, remove?: boolean) => Promise<boolean>;
    saveConfig: (snapshot: GuiProfileSnapshot, edits: typeof GuiProfileConfigWrite.Type.edits) => Promise<boolean>;
    setSecret: (name: string, value: string) => Promise<boolean>;
    removeSecret: (name: string) => Promise<boolean>;
    validate: () => Promise<boolean>;
    scan: () => Promise<boolean>;
    inspectRevision: (sequence: number) => () => void;
    trackSkill: (name: string, source: string, ref: string, subdir: string) => Promise<boolean>;
    checkSkill: (name: string) => void;
    updateSkill: (name: string) => void;
  };
  profileState: ResourceState;
  profileStates: Record<"items" | "revisions" | "skills" | "secrets", ResourceState>;
  publicationReviewer: string;
  profile: WorkspaceProfile;
  profileSchedule: Schedule | null;
  skillSources: SkillSource[];
  upstreamSkills: UpstreamSkill[];
  demoSkillsRepo: string;
  scannedTools: readonly ScannedTool[];
  toolFromScan: (tool: ScannedTool) => Resource;
  /** The Source's Machine Profile display name, as onboarding created it (canonfig.jsonc `profile.name`). */
  profileName: string;
  /** Tool ids onboarding proposed; Profile highlights them until they're published. */
  proposed: string[];
  profileTab: ProfileTab;
  publishOpen: boolean;
  setPublishOpen: SetState<boolean>;
  resources: Resource[];
  setResources: SetState<Resource[]>;
  /** Reads the folder's items when called, for a delayed callback that must see an edit saved while it waited. */
  readResources: () => Resource[];
  /** Reads the unpublished changes and the next revision number when called, like readResources. */
  readQueue: () => { pending: PendingChange[]; nextSequence: number | undefined };
  revisions: Revision[];
  /** Newest published revision, 0 before the first publish. */
  latest: number | undefined;
  secrets: Secret[];
  setSecrets: SetState<Secret[]>;
  /** Profile edits since the latest Profile Revision: items, groups, the harness list and defaults. */
  pending: PendingChange[];
  /** Records a group, harness list or defaults edit as unpublished; repeating one is a no-op. */
  markProfileEdit: (edit: ProfileEdit) => void;
  /** Withdraws a recorded edit, for example defaults saved back to their published values. */
  removeProfileEdit: (edit: ProfileEdit) => void;
  nextSequence: number | undefined;
  publishing: boolean;
  publish: (reviewer: string, onDone: () => void) => void;
  /** Harnesses listed in canonfig.jsonc: the Source edits them in Profile, a follower gets them with each revision. */
  listed: HarnessId[];
  setListed: SetState<HarnessId[]>;
  /** canonfig.jsonc `surfaces`: categories a listed harness is limited to; a harness not named gets every category. */
  surfaces: Partial<Record<HarnessId, SurfaceCategory[]>>;
  setSurfaces: SetState<Partial<Record<HarnessId, SurfaceCategory[]>>>;
  /** Simulates `canonfig export`: downloads ~/.canonfig/ and local/ as one .tar.gz with a checksum manifest, signed on the Source. */
  exportArchive: () => void;
}

export interface MachinesSlice {
  machinesState: ResourceState;
  machineStates: Record<"inventory" | "enrollment" | "setup", ResourceState>;
  enrollmentBackend?: WorkspaceBackend;
  enrollment?: GuiEnrollment;
  createInvitation?: (input: { endpoint: string; expiresInMilliseconds: number; groups: string[] }) => Promise<GuiInvitationDownload>;
  revokeFollower?: (id: string) => Promise<void>;
  sourceMachine: SourceMachine;
  followerSelf: FollowerSelf;
  selfFollower?: Follower;
  /** Where followers reach this Source, with the port chosen in onboarding. */
  endpoint: string;
  /** A follower that just finished onboarding: enrolled, revision downloaded, nothing applied. */
  justJoined: boolean;
  inviteOpen: boolean;
  setInviteOpen: SetState<boolean>;
  followers: Follower[];
  setFollowers?: SetState<Follower[]>;
  invitations: Invitation[];
  setInvitations?: SetState<Invitation[]>;
  /** Followers fetching the revision that was just published. */
  syncing: string[];
  machinesMode: MachinesMode;
  changeGroups: ChangeGroupsRequest | null;
  setChangeGroups: (req: ChangeGroupsRequest | null) => void;
}

export interface FollowerSlice {
  /** Real command evidence and digest-aware authoring; absent in the simulated provider. */
  followerLive?: FollowerLive;
  followerState: ResourceState;
  followerStates: Record<"harnesses" | "local" | "schedule" | "backups" | "overlays" | "tunnel", ResourceState>;
  followerSchedule: Schedule | null;
  tunnelUp: boolean;
  secretsRefresh: { busy: boolean; updated: string };
  serviceInstalled: boolean;
  /** Whether this follower reaches the Source through Canonfig's SSH tunnel. False: no tunnel exists. */
  tunnelConfigured: boolean;
  plan: PlanItem[];
  /** The revision the plan brings this follower to. */
  targetRevision: number | undefined;
  phase: FollowerPhase;
  progress: number | undefined;
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
  appliedRevision: number | undefined;
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
  /** Reads the stopped state when called, for delayed callbacks that would otherwise see a stale value. */
  isStopped: () => boolean;
}

/** The single store contract consumed by all workspace screens. */
export interface Workspace extends OverviewSlice, ProfileSlice, MachinesSlice, FollowerSlice {
  admin: AdministrationSlice;
}
