import { version } from "../../../package.json";

// Demo data. Shapes follow the Canonical Folder (src/projection/folder.ts), the harness
// report and takeover snapshots (src/projection), and the CLI's status, doctor and
// schedule outputs for the simulated GUI.
// Nothing here talks to a real machine.

/**
 * True in the public demo build (`npm run build:demo`, Vite mode "demo") and on the dev server; false in the
 * production build that `canonfig ui` will serve. It gates demo chrome only: the Demo panel (role switcher,
 * docs and GitHub links), copy that describes the demo itself, and the simulated first-visit page load.
 * Vite replaces `import.meta.env` at build time, so production drops the demo-only code.
 *
 * Both builds still run on the simulated data in this module. The loopback backend in
 * docs/adr/0001-local-browser-gui.md isn't implemented, so production has no real data path yet.
 */
export const DEMO = import.meta.env.DEV || import.meta.env.MODE === "demo";

export type Role = "source" | "follower" | "unconfigured";

/**
 * The authored categories of ~/.canonfig/, in the order the folder view lists them. Each item compiles to one
 * Profile Resource (src/projection/folder.ts): `instructions` is AGENTS.md, rules, skills, agents and commands
 * are files under their folders, and the rest are keys of canonfig.jsonc.
 */
export type ItemCategory = "instructions" | "rules" | "skills" | "agents" | "commands" | "mcp" | "hooks" | "settings" | "tools" | "credentials";

export type FollowerState =
  | "converged"
  | "drift"
  | "human-action"
  | "failed"
  | "offline"
  | "never-synced";

/** One item of the Canonical Folder, as the Source authors it. */
export interface Resource {
  /** `instructions` or `<category>/<name>`, the id canonfig.jsonc `groups` names it by. */
  id: string;
  category: ItemCategory;
  /** Where it lives, relative to ~/.canonfig/: a file, a folder, or a key of canonfig.jsonc. */
  path: string;
  groups: string[];
  summary: string;
  /** Uncommitted relative to the latest Profile Revision. */
  change?: "added" | "modified" | "removed";
  /** Editor fields by label (frontmatter, canonfig.jsonc fields, recipes) plus `Body`, the markdown after the frontmatter. */
  detail: Record<string, string>;
  /**
   * Settings keys for one harness (`settings.<harness>`), by key path, each value as typed JSON text (`"zed"`, `42`,
   * `false`). Kept apart from `detail` so a key can be named anything.
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

/** Category names, what each holds, and where in ~/.canonfig/ it lives. */
export const CATEGORY_LABEL: Record<ItemCategory, { label: string; hint: string; where: string }> = {
  instructions: { label: "Instructions", where: "AGENTS.md", hint: "Global instructions every harness reads, written as its own instructions file." },
  rules: { label: "Rules", where: "rules/", hint: "One rule per file, with an optional description, paths and activation." },
  skills: { label: "Skills", where: "skills/", hint: "Agent Skills: a folder with its SKILL.md and the files it uses." },
  agents: { label: "Agents", where: "agents/", hint: "Subagents, one per file, with a description, model, tools and whether they may write." },
  commands: { label: "Commands", where: "commands/", hint: "Slash commands, one per file, with a description and argument hint." },
  mcp: { label: "MCP servers", where: "canonfig.jsonc mcp", hint: "Servers each harness starts, by command or URL. Secrets stay environment variable references." },
  hooks: { label: "Hooks", where: "canonfig.jsonc hooks", hint: "Scripts in hooks/ that run on agent events, like after a file edit." },
  settings: { label: "Settings", where: "canonfig.jsonc settings", hint: "Keys set in one harness's own settings file. Every other key in that file stays as it is." },
  tools: { label: "Tools", where: "canonfig.jsonc tools", hint: "Programs Canonfig installs with a recipe per system, then checks that they run." },
  credentials: { label: "Required secrets", where: "canonfig.jsonc credentials", hint: "A token or key a machine must already have. Canonfig checks that it's there and never sends it." },
};

/** Where an item lives in ~/.canonfig/: its file or folder, or its key in canonfig.jsonc. */
export function itemPath(category: ItemCategory, name: string): string {
  if (category === "instructions") return "AGENTS.md";
  if (category === "hooks") return "canonfig.jsonc hooks";
  if (category === "skills") return `skills/${name}/`;
  if (category === "rules" || category === "agents" || category === "commands") return `${category}/${name}.md`;
  return `canonfig.jsonc ${category}.${name}`;
}

/** Categories a follower's ~/.canonfig/local/ may add to, as canonfig.jsonc `local.allow` names them (LOCAL_CATEGORIES). */
export type LocalCategory = "rules" | "skills" | "agents" | "commands" | "mcp" | "settings";
export const LOCAL_CATEGORIES: LocalCategory[] = ["rules", "skills", "agents", "commands", "mcp", "settings"];

/**
 * Everyday labels for Canonfig concepts that appear as section titles, nav
 * items and buttons. The Canonfig term stays one hover away (see `Term`).
 */
export const PLAIN = {
  /** Nav item for the follower's local folder page. */
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

/**
 * The Canonfig version the GUI belongs to, read from the root package.json at build time so it matches
 * `canonfig --version` without a second copy to bump.
 */
export const APP_VERSION: string = version;

/** Harness ids, in the order of TARGET_IDS in src/projection/model.ts. */
export type HarnessId =
  | "codex"
  | "claude-code"
  | "amp"
  | "oh-my-pi"
  | "pi"
  | "factory-droid"
  | "cursor"
  | "devin"
  | "opencode"
  | "grok-build"
  | "antigravity"
  | "copilot-cli"
  | "kimi"
  | "kilo"
  | "hermes"
  | "qwen";

/** Display names, as each adapter in src/projection/adapters/ declares them. */
export const HARNESS_NAMES: Record<HarnessId, string> = {
  codex: "OpenAI Codex",
  "claude-code": "Claude Code",
  amp: "Amp",
  "oh-my-pi": "Oh My Pi",
  pi: "Pi Coding Agent",
  "factory-droid": "Factory Droid CLI",
  cursor: "Cursor",
  devin: "Devin CLI",
  opencode: "OpenCode",
  "grok-build": "Grok Build CLI",
  antigravity: "Google Antigravity CLI",
  "copilot-cli": "GitHub Copilot CLI",
  kimi: "Kimi Code CLI",
  kilo: "Kilo Code CLI",
  hermes: "Hermes Agent",
  qwen: "Qwen Code",
};

/**
 * One harness as `canonfig harnesses` reports it on this machine. Canonfig projects a harness that is listed
 * in canonfig.jsonc, installed here and not excluded in local/local.jsonc.
 */
export interface Harness {
  id: HarnessId;
  name: string;
  /** Its executable resolves on this machine. */
  installed: boolean;
  /** Named in canonfig.jsonc `harnesses`. */
  listed: boolean;
  /** Named in local/local.jsonc `excludeHarnesses`. */
  excluded: boolean;
  /** The root pinned at takeover, or null before Canonfig first wrote there. */
  root: string | null;
  /** The takeover snapshot holding what was there before, or null. */
  snapshot: string | null;
}

/**
 * Takeover snapshots in ~/.canonfig/.backups/, oldest first. Ids follow the folder names Canonfig writes
 * (src/projection/takeover.ts). Canonfig keeps the first one plus the 4 most recent.
 */
export interface Snapshot {
  id: string;
  harnesses: HarnessId[];
  /** Files and folders copied, counting keys.json once per harness with key-owned files. */
  files: number;
  /** The state before Canonfig ever wrote; always kept. */
  first: boolean;
}

export const snapshots: Snapshot[] = [
  { id: "2026-09-02T08-14-02-117Z", harnesses: ["codex", "claude-code"], files: 23, first: true },
  { id: "2026-10-11T09-00-41-560Z", harnesses: ["opencode"], files: 7, first: false },
  { id: "2026-10-19T09-00-12-004Z", harnesses: ["copilot-cli"], files: 4, first: false },
  { id: "2026-10-24T09-00-07-918Z", harnesses: ["oh-my-pi"], files: 9, first: false },
];

type HarnessState = Omit<Harness, "id" | "name">;
const notHere: HarnessState = { installed: false, listed: false, excluded: false, root: null, snapshot: null };
const harnessState: Partial<Record<HarnessId, HarnessState>> = {
  codex: { installed: true, listed: true, excluded: false, root: "~/.codex", snapshot: snapshots[0].id },
  "claude-code": { installed: true, listed: true, excluded: false, root: "~/.claude", snapshot: snapshots[0].id },
  opencode: { installed: true, listed: true, excluded: false, root: "~/.config/opencode", snapshot: snapshots[1].id },
  "copilot-cli": { installed: true, listed: true, excluded: false, root: "~/.copilot", snapshot: snapshots[2].id },
  // Restored from its snapshot, which excluded it on this machine.
  "oh-my-pi": { installed: true, listed: true, excluded: true, root: "~/.omp/agent", snapshot: snapshots[3].id },
  // Listed, not installed: reported as not installed, nothing projected.
  amp: { installed: false, listed: true, excluded: false, root: null, snapshot: null },
  // Installed, not listed: ignored.
  cursor: { installed: true, listed: false, excluded: false, root: null, snapshot: null },
};

/** Every harness on this demo machine, in TARGET_IDS order. */
export const harnesses: Harness[] = (Object.keys(HARNESS_NAMES) as HarnessId[]).map((id) => ({
  id,
  name: HARNESS_NAMES[id],
  ...(harnessState[id] ?? notHere),
}));

export const machine = {
  hostname: "atlas",
  platform: "linux" as const,
  folder: "~/.canonfig",
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
  /** canonfig.jsonc `local.allow`: what a follower's ~/.canonfig/local/ may add. */
  localAllow: ["rules", "skills", "mcp", "settings"] as LocalCategory[],
};

export const resources: Resource[] = [
  {
    id: "instructions",
    category: "instructions",
    path: "AGENTS.md",
    groups: [],
    summary: "38 lines",
    detail: { Body: "# Working agreements\n\n- Run the tests before you say a change works.\n- Keep diffs small and explain why, not what." },
  },
  {
    id: "rules/typescript",
    category: "rules",
    path: "rules/typescript.md",
    groups: [],
    summary: "*.ts and *.tsx files",
    change: "modified",
    detail: {
      Description: "TypeScript conventions",
      Paths: "**/*.ts, **/*.tsx",
      Activation: "path",
      Body: "Prefer type inference for locals. Never use any; use unknown and narrow it.",
    },
  },
  {
    id: "skills/code-review",
    category: "skills",
    path: "skills/code-review/",
    groups: [],
    summary: "3 files",
    detail: {
      Description: "Review a diff for correctness, tests and clarity.",
      Files: "SKILL.md, references/checklist.md, references/tone.md",
      Body: "Read the diff twice. Check each changed function against references/checklist.md.",
    },
  },
  {
    id: "agents/researcher",
    category: "agents",
    path: "agents/researcher.md",
    groups: [],
    summary: "read-only",
    detail: { Description: "Finds sources and summarizes them with links.", Model: "", Tools: "read, search, web", Writable: "false", Body: "Cite every claim. Prefer primary sources." },
  },
  {
    id: "commands/ship",
    category: "commands",
    path: "commands/ship.md",
    groups: [],
    summary: "/ship [branch]",
    change: "added",
    detail: { Description: "Run the checks, then open a pull request.", "Argument hint": "[branch]", Body: "Run the test suite and the linter. If both pass, open a pull request for $ARGUMENTS." },
  },
  {
    id: "mcp/context7",
    category: "mcp",
    path: "canonfig.jsonc mcp.context7",
    groups: [],
    summary: "stdio, npx",
    detail: { Transport: "stdio", Command: "npx", Args: "-y @upstash/context7-mcp@2.1.0" },
  },
  {
    id: "mcp/docs",
    category: "mcp",
    path: "canonfig.jsonc mcp.docs",
    groups: [],
    summary: "streamable-http",
    detail: { Transport: "streamable-http", URL: "https://docs.example.com/mcp" },
  },
  {
    id: "hooks/format",
    category: "hooks",
    path: "canonfig.jsonc hooks",
    groups: [],
    summary: "after_tool, hooks/format.sh",
    detail: { Event: "after_tool", Run: "hooks/format.sh", Capabilities: "write", "On failure": "warn" },
  },
  {
    id: "settings/codex",
    category: "settings",
    path: "canonfig.jsonc settings.codex",
    groups: [],
    summary: "2 keys",
    detail: {},
    keys: { model_reasoning_effort: '"high"', sandbox_mode: '"workspace-write"' },
  },
  {
    id: "settings/claude-code",
    category: "settings",
    path: "canonfig.jsonc settings.claude-code",
    groups: [],
    summary: "2 keys",
    change: "added",
    detail: {},
    keys: { "env.DISABLE_TELEMETRY": '"1"', includeCoAuthoredBy: "false" },
  },
  {
    id: "tools/gh",
    category: "tools",
    path: "canonfig.jsonc tools.gh",
    groups: [],
    summary: "brew, apt or winget",
    detail: { Executable: "gh", macOS: "brew install gh", Linux: "apt install gh", Windows: "winget install GitHub.cli", Login: "gh auth login" },
  },
  {
    id: "tools/cuda-toolkit",
    category: "tools",
    path: "canonfig.jsonc tools.cuda-toolkit",
    groups: ["gpu"],
    summary: "gpu group only",
    detail: { Executable: "nvcc", Linux: "apt install nvidia-cuda-toolkit" },
  },
  {
    id: "credentials/github-token",
    category: "credentials",
    path: "canonfig.jsonc credentials.github-token",
    groups: ["canonfig:secrets"],
    summary: "local reference",
    detail: { Reference: "github-token" },
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
    note: "Local edit to skills/code-review",
    resources: all("converged", { "skills/code-review": "drift", "credentials/github-token": "excluded" }),
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
    resources: { ...all("converged", { "tools/gh": "human-action", "credentials/github-token": "excluded" }), "tools/cuda-toolkit": "converged" },
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
    resources: { ...all("converged", { "agents/researcher": "never-synced" }), "tools/cuda-toolkit": "converged" },
  },
];

export const revisions: Revision[] = [
  { sequence: 7, digest: "sha256:4f1c…a09e", publishedAt: "Today 08:41", reviewer: "maria", changes: "+agents/researcher, ~instructions" },
  { sequence: 6, digest: "sha256:91de…77b2", publishedAt: "Oct 24", reviewer: "maria", changes: "~skills/code-review" },
  { sequence: 5, digest: "sha256:0b3a…c4d1", publishedAt: "Oct 19", reviewer: "maria", changes: "+gpu group, +tools/cuda-toolkit" },
  { sequence: 4, digest: "sha256:e27f…1180", publishedAt: "Oct 11", reviewer: "maria", changes: "~settings/codex" },
];

export const secrets = [
  { name: "github-token", updated: "Oct 20", sharedWith: 2 },
  { name: "openai-api-key", updated: "Sep 30", sharedWith: 2 },
];

/** One row per `canonfig doctor` probe (src/runtime/doctor.ts), plus Linger, which the Service page tracks. */
export const doctor = [
  { check: "Node.js runtime", result: "ok", detail: "v24.11.0" },
  { check: "State database", result: "ok", detail: "~/.canonfig/state.sqlite healthy" },
  { check: "Credential storage", result: "ok", detail: "Secret Service unlocked" },
  { check: "Native scheduler", result: "ok", detail: "systemd user manager" },
  { check: "Source service", result: "ok", detail: "Listening on 127.0.0.1:17342" },
  { check: "Linger", result: "warn", detail: "Off: service stops when you log out" },
  { check: "Package managers", result: "ok", detail: "npm, uv and apt found" },
  { check: "Configuration Agent", result: "ok", detail: "codex 0.62 found" },
  { check: "Harnesses", result: "ok", detail: "Every listed harness is installed" },
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

/** An item in a follower's ~/.canonfig/local/: a file for rules, skills, agents and commands, a key of local.jsonc otherwise. */
export interface LocalItem {
  /** `<category>/<name>`, unique within local/. */
  id: string;
  category: LocalCategory;
  /** Relative to ~/.canonfig/local/. */
  path: string;
  summary: string;
  /** For settings: keys by path, as typed JSON text. */
  keys?: Record<string, string>;
  /** Editor fields by label: Description and Body for files, Transport, Command or URL for MCP servers. */
  detail?: Record<string, string>;
}

export const followerSelf = {
  name: "laptop",
  source: "atlas (via SSH tunnel)",
  revision: 7,
  state: "converged" as FollowerState,
  /** Its ~/.canonfig/local/. commands/standup sits outside the Source's local.allow, so projection ignores it. */
  local: [
    { id: "skills/pdf-tools", category: "skills", path: "skills/pdf-tools/", summary: "2 files", detail: { Description: "Fill and split PDF forms.", Body: "Use the scripts in this folder." } },
    { id: "mcp/notes", category: "mcp", path: "local.jsonc mcp.notes", summary: "stdio, uvx", detail: { Transport: "stdio", Command: "uvx mcp-notes" } },
    { id: "settings/codex", category: "settings", path: "local.jsonc settings.codex", summary: "1 key", keys: { model: '"gpt-5.5"' } },
    { id: "commands/standup", category: "commands", path: "commands/standup.md", summary: "/standup", detail: { Description: "Summarize yesterday's commits." } },
  ] as LocalItem[],
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
    hint: "Someone changed a file Canonfig manages, on that machine. Canonfig keeps the change, reports it and holds what it writes from that file.",
    selfHint: "You changed a file Canonfig manages. Canonfig keeps your change, reports it and holds what it writes from that file. Move the change into your local folder, or ask the Source to publish it.",
  },
  "human-action": { label: "Needs you", tone: "act", term: "Human Action Required", hint: "A step only a person can do, like signing in to a tool. Syncing continues once it's done." },
  failed: { label: "Update failed", tone: "bad", term: "a failed Synchronization Run", hint: "The last update failed, so Canonfig put back the files and settings it had changed. Tools it installed stay installed." },
  offline: { label: "Can't reach the Source", tone: "bad", term: "Unreachable", hint: "On its last try, this machine couldn't connect to the Source." },
  "never-synced": { label: "Not applied yet", tone: "muted", hint: "Nothing from the profile has been applied here yet." },
  excluded: { label: "Not sent to this machine", tone: "muted", term: "outside its Follower Groups", hint: "This machine isn't in a group that gets this item." },
};
