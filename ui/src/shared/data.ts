// Demo data. Shapes follow src/domain/profile.ts and the CLI's
// status, doctor, and schedule outputs for the simulated GUI.
// Nothing here talks to a real machine.

export type Role = "source" | "follower" | "unconfigured";

export type ResourceKind = "file" | "directory" | "config" | "skill" | "tool" | "credential";

export type FollowerState =
  | "converged"
  | "drift"
  | "human-action"
  | "failed"
  | "offline"
  | "never-synced";

export interface Resource {
  id: string;
  kind: ResourceKind;
  target: string;
  policy: string;
  groups: string[];
  summary: string;
  /** Uncommitted relative to the latest Profile Revision. */
  change?: "added" | "modified" | "removed";
  /** Editor metadata: the file format, Advanced settings and per-kind content. Never config keys. */
  detail: Record<string, string>;
  /**
   * Config keys Canonfig sets, by key path, each value as typed JSON text (`"zed"`, `42`, `false`).
   * Kept apart from `detail` so a key can be named anything, including Format or Verify.
   */
  keys?: Record<string, string>;
}

export interface Follower {
  id: string;
  name: string;
  platform: "linux" | "macos" | "windows";
  groups: string[];
  revision: number | null;
  state: FollowerState;
  lastRun: string;
  schedule: string;
  note?: string;
  /** Plain sentence for why this machine is on an older revision, when it is. */
  behind?: string;
  /** Per-resource state for the convergence matrix. */
  resources: Record<string, FollowerState | "excluded">;
}

export interface Revision {
  sequence: number;
  digest: string;
  publishedAt: string;
  reviewer: string;
  changes: string;
}

export const KIND_LABEL: Record<ResourceKind, { label: string; hint: string }> = {
  file: { label: "File", hint: "One file, copied exactly. For example an instructions file." },
  directory: { label: "Folder", hint: "A folder of files copied to each machine." },
  config: { label: "Settings", hint: "Only the settings you list inside a JSON, TOML or YAML file. Everything else in that file stays as it is." },
  skill: { label: "Skill", hint: "An AI agent skill: its SKILL.md and the files it uses." },
  tool: { label: "Tool", hint: "A program Canonfig installs the right way on each system, then checks that it runs." },
  credential: { label: "Required secret", hint: "A token or key the machine must already have. Canonfig checks that it's there and never sends it." },
};

/** Plain title for each Apply Policy. The real policy id stays visible next to it in small mono. */
export const POLICY_TITLE: Record<string, string> = {
  replace: "Always overwrite",
  "replace-if-unmodified": "Overwrite unless edited there",
  "append-local": "Keep local lines after ours",
  "mirror-owned": "Sync our files, leave others",
  merge: "Set only these keys",
  ensure: "Install if missing",
  "require-local": "Must already exist there",
};

export const POLICY_HINT: Record<string, string> = {
  replace: "The machine's copy always ends up exactly like yours.",
  "replace-if-unmodified": "Updated only if nobody edited it on that machine. If someone did, Canonfig leaves their edit and shows it as edited there.",
  "append-local": "Your content comes first. Lines the machine added itself stay after it.",
  "mirror-owned": "Files Canonfig placed stay in sync. Other files in the folder are left alone.",
  merge: "Only the keys you list are set. The rest of the file stays as it is.",
  ensure: "Installed if it's missing, then checked that it runs.",
  "require-local": "The machine must already have it. Canonfig checks and never sends it.",
};

/**
 * Everyday labels for Canonfig concepts that appear as section titles, nav
 * items and buttons. The Canonfig term stays one hover away (see `Term`).
 */
export const PLAIN = {
  /** Section title for the Apply Policy choice. */
  applyPolicy: "If the machine's copy is different",
  /** Local Overlay, as an action or section. */
  localOverlay: "Keep on this machine",
  /** Nav item for the follower's Local Overlays. */
  localNav: "Local settings",
  /** Unenroll. */
  unenroll: "Stop syncing this machine",
  /** Follower Groups. */
  groups: "Groups",
  /** Shown for membership of `canonfig:secrets`, with the real group name in mono beside it. */
  secretsGroup: "Can receive secrets",
} as const;

/** The group whose members may receive shared secrets. */
export const SECRETS_GROUP = "canonfig:secrets";

export const machine = {
  hostname: "atlas",
  platform: "linux" as const,
  version: "4.0.0",
  profileFile: "~/canonfig.profile.jsonc",
  endpoint: "https://127.0.0.1:17342",
  service: "running" as const,
};

export const profile = {
  id: "workstation",
  name: "Workstation",
  groups: [
    { name: "gpu", description: "Machines with a CUDA GPU" },
    { name: "canonfig:secrets", description: "May receive shared secrets" },
  ],
  scheduleDefault: "Daily at 09:00, local time",
};

export const resources: Resource[] = [
  {
    id: "claude-instructions",
    kind: "file",
    target: "~/.claude/CLAUDE.md",
    policy: "replace",
    groups: [],
    summary: "from .claude/CLAUDE.md",
    detail: { Source: ".claude/CLAUDE.md", Mode: "0644", Verify: "digest" },
  },
  {
    id: "codex-agents",
    kind: "file",
    target: "~/.codex/AGENTS.md",
    policy: "replace",
    groups: [],
    summary: "from .codex/AGENTS.md",
    change: "modified",
    detail: { Source: ".codex/AGENTS.md", Mode: "0644", Verify: "digest" },
  },
  {
    id: "codex-config",
    kind: "config",
    target: "~/.codex/config.toml",
    policy: "merge",
    groups: [],
    summary: "2 TOML keys",
    detail: { Format: "TOML", Verify: "digest" },
    keys: { model_reasoning_effort: '"high"', sandbox_mode: '"workspace-write"' },
  },
  {
    id: "claude-settings",
    kind: "config",
    target: "~/.claude/settings.json",
    policy: "merge",
    groups: [],
    summary: "3 JSON keys",
    change: "added",
    detail: { Format: "JSON", Verify: "digest" },
    keys: { "permissions.defaultMode": '"acceptEdits"', "env.DISABLE_TELEMETRY": '"1"', includeCoAuthoredBy: "false" },
  },
  {
    id: "claude-review-skill",
    kind: "skill",
    target: "~/.claude/skills/code-review",
    policy: "replace-if-unmodified",
    groups: [],
    summary: "3 files",
    detail: { Name: "code-review", Files: "SKILL.md, references/checklist.md, references/tone.md", Verify: "digest" },
  },
  {
    id: "shared-skills",
    kind: "directory",
    target: "~/.agents/skills",
    policy: "mirror-owned",
    groups: [],
    summary: "14 files",
    detail: { Files: "14", Mode: "0755", Verify: "digest" },
  },
  {
    id: "gh-cli",
    kind: "tool",
    target: "gh",
    policy: "ensure",
    groups: [],
    summary: "brew, apt or winget",
    detail: { macOS: "brew install gh", Linux: "apt install gh", Windows: "winget install GitHub.cli", Login: "Required: run `gh auth login`", Verify: "executable-present" },
  },
  {
    id: "context7-mcp",
    kind: "tool",
    target: "@upstash/context7-mcp",
    policy: "ensure",
    groups: [],
    summary: "MCP server via npm",
    detail: { All: "npm install -g @upstash/context7-mcp@2.1.0", Verify: "mcp-qualification" },
  },
  {
    id: "cuda-toolkit",
    kind: "tool",
    target: "nvcc",
    policy: "ensure",
    groups: ["gpu"],
    summary: "gpu group only",
    detail: { Linux: "apt install nvidia-cuda-toolkit", Verify: "executable-present" },
  },
  {
    id: "github-token",
    kind: "credential",
    target: "github-token",
    policy: "require-local",
    groups: ["canonfig:secrets"],
    summary: "local reference",
    detail: { Reference: "github-token", Verify: "credential-present" },
  },
];

const all = (state: FollowerState, except: Record<string, FollowerState | "excluded"> = {}) =>
  Object.fromEntries(resources.map((r) => [r.id, except[r.id] ?? (r.groups.includes("gpu") ? "excluded" : state)]));

export const followers: Follower[] = [
  {
    id: "f_8c21",
    name: "laptop",
    platform: "macos",
    groups: ["canonfig:secrets"],
    revision: 7,
    state: "converged",
    lastRun: "12 min ago",
    schedule: "Daily 09:00",
    resources: all("converged"),
  },
  {
    id: "f_3b90",
    name: "studio",
    platform: "macos",
    groups: [],
    revision: 7,
    state: "drift",
    lastRun: "2 h ago",
    schedule: "Daily 09:00",
    note: "Local edits to claude-review-skill",
    resources: all("converged", { "claude-review-skill": "drift", "github-token": "excluded" }),
  },
  {
    id: "f_d417",
    name: "gaming-pc",
    platform: "windows",
    groups: ["gpu"],
    revision: 7,
    state: "human-action",
    lastRun: "Yesterday",
    schedule: "Weekly Mon 08:00",
    note: "Run `gh auth login` on this machine",
    resources: { ...all("converged", { "gh-cli": "human-action", "github-token": "excluded" }), "cuda-toolkit": "converged" },
  },
  {
    id: "f_71ea",
    name: "build-box",
    platform: "linux",
    groups: ["gpu", "canonfig:secrets"],
    revision: 6,
    state: "offline",
    lastRun: "3 days ago",
    schedule: "Daily 03:00",
    note: "Tunnel down since Sat",
    behind: "On revision 6 of 7: it can't reach the Source (tunnel down since Sat).",
    resources: { ...all("converged", { "claude-settings": "never-synced" }), "cuda-toolkit": "converged" },
  },
];

export const revisions: Revision[] = [
  { sequence: 7, digest: "sha256:4f1c…a09e", publishedAt: "Today 08:41", reviewer: "marcos", changes: "+1 tool, 1 file changed" },
  { sequence: 6, digest: "sha256:91de…77b2", publishedAt: "Oct 24", reviewer: "marcos", changes: "claude-review-skill updated" },
  { sequence: 5, digest: "sha256:0b3a…c4d1", publishedAt: "Oct 19", reviewer: "marcos", changes: "+gpu group, +cuda-toolkit" },
  { sequence: 4, digest: "sha256:e27f…1180", publishedAt: "Oct 11", reviewer: "marcos", changes: "codex-config keys" },
];

export const pendingChanges = resources.filter((r) => r.change);

/** The key paths a config resource declares, for suggesting keys to keep on one machine. Empty for other kinds. */
export function configKeysFor(resourceId: string): string[] {
  const resource = resources.find((r) => r.id === resourceId);
  if (resource?.kind !== "config") return [];
  return Object.keys(resource.keys ?? {});
}

export const secrets = [
  { name: "github-token", updated: "Oct 20", sharedWith: 2 },
  { name: "openai-api-key", updated: "Sep 30", sharedWith: 2 },
];

export const doctor = [
  { check: "Node.js runtime", result: "ok", detail: "v24.11.0" },
  { check: "Credential storage", result: "ok", detail: "Secret Service unlocked" },
  { check: "Native scheduler", result: "ok", detail: "systemd user manager" },
  { check: "Source service", result: "ok", detail: "Listening on 127.0.0.1:17342" },
  { check: "Linger", result: "warn", detail: "Off: service stops when you log out" },
  { check: "Configuration Agent", result: "ok", detail: "codex 0.62 found" },
] as const;

export const agentPolicy = {
  mode: "agent-propose" as "deterministic-only" | "agent-propose" | "agent-apply",
  harness: "codex",
  writablePaths: ["~/.codex", "~/.claude"],
  origins: ["https://registry.npmjs.org"],
  maxInputKb: 64,
};

export const installers = [
  { name: "npm", path: "/usr/bin/npm", status: "bound" },
  { name: "brew", path: "-", status: "not on this platform" },
  { name: "apt", path: "/usr/bin/apt-get", status: "bound" },
  { name: "winget", path: "-", status: "not on this platform" },
];

export const harnessProject = {
  path: "~/code/acme-api",
  file: ".canonfig/harness.yaml",
  targets: ["claude", "codex", "cursor", "gemini"],
  pending: 3,
};

export const followerSelf = {
  name: "laptop",
  source: "atlas (via SSH tunnel)",
  revision: 7,
  state: "converged" as FollowerState,
  overlays: [
    { resource: "codex-config", key: "model", value: '"gpt-5.5"' },
    { resource: "claude-settings", key: "env.EDITOR", value: '"zed"' },
  ],
};

export interface StateMeta {
  /** Everyday label shown in the UI. */
  label: string;
  /** Label on the follower's own screens, when it reads differently there. */
  selfLabel?: string;
  tone: "ok" | "warn" | "act" | "bad" | "muted";
  hint: string;
  /** Hint on the follower's own screens, paired with `selfLabel`. */
  selfHint?: string;
  /** What Canonfig's docs and CLI call it, for the tooltip's "Canonfig calls this …". */
  term?: string;
}

export const STATE_META: Record<FollowerState | "excluded", StateMeta> = {
  converged: { label: "Up to date", tone: "ok", term: "Convergence", hint: "Everything this machine should have matches the latest revision it got and passes its check." },
  drift: {
    label: "Edited on that machine",
    selfLabel: "You edited this",
    tone: "warn",
    term: "Follower Drift",
    hint: "Someone changed a file Canonfig manages, on that machine. Canonfig leaves the change alone until someone there decides whether to keep it.",
    selfHint: "You changed a file Canonfig manages. Canonfig leaves your change alone until you decide whether to keep it.",
  },
  "human-action": { label: "Needs you", tone: "act", term: "Human Action Required", hint: "A step only a person can do, like signing in to a tool. Syncing continues once it's done." },
  failed: { label: "Update failed", tone: "bad", term: "a failed Synchronization Run", hint: "The last update failed, so Canonfig put back the files and settings it had changed. Tools it installed stay installed." },
  offline: { label: "Can't reach the Source", tone: "bad", term: "Unreachable", hint: "On its last try, this machine couldn't connect to the Source." },
  "never-synced": { label: "Not applied yet", tone: "muted", hint: "Nothing from the profile has been applied here yet." },
  excluded: { label: "Not sent to this machine", tone: "muted", term: "outside its Follower Groups", hint: "This machine isn't in a group that gets this item." },
};
