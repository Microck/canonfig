import { version } from "../../../package.json";

// Shared labels and presentation types. No demo records or simulated actions.
export type Role = "source" | "follower" | "unconfigured";
/**
 * True in the public demo build (`npm run build:demo`, Vite mode "demo") and on the dev server.
 * ui/vite.config.ts selects this application's entrypoint with the same condition. Production selects
 * live-app.tsx instead, so this module and the simulated store are outside its import graph.
 * Within the demo this flag also gates the demo panel, explanatory copy and simulated page loading.
 */
export const DEMO = import.meta.env?.DEV === true || import.meta.env?.MODE === "demo";

/**
 * The authored categories of ~/.canonfig/, in the order the folder view lists them. Each item compiles to one
 * Profile Resource (src/projection/folder.ts): `instructions` is AGENTS.md, rules, skills, agents and commands
 * are files under their folders, and the rest are keys of canonfig.jsonc. `resources` are files, folders and
 * config files outside every harness (`resources.<id>`, with their content under files/).
 */
export type ItemCategory = "instructions" | "rules" | "skills" | "plugins" | "agents" | "commands" | "mcp" | "hooks" | "settings" | "tools" | "credentials" | "resources";

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
  platform?: "linux" | "macos" | "windows";
  groups: string[];
  revision?: number | null;
  state?: FollowerState;
  lastRun?: string;
  schedule?: string;
  note?: string;
  /** Plain sentence for why this machine is on an older revision, when it is. */
  behind?: string;
  /** Per-resource state for the convergence matrix. */
  resources?: Record<string, FollowerState | "excluded">;
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
  plugins: { label: "Native plugins", where: "plugins/", hint: "Harness-specific packages. Changing their files requires a new digest review before activation or publication." },
  agents: { label: "Agents", where: "agents/", hint: "Subagents, one per file, with a description, model, tools and whether they may write." },
  commands: { label: "Commands", where: "commands/", hint: "Slash commands, one per file, with a description and argument hint." },
  mcp: { label: "MCP servers", where: "canonfig.jsonc mcp", hint: "Servers each harness starts, by command or URL. Secrets stay environment variable references." },
  hooks: { label: "Hooks", where: "canonfig.jsonc hooks", hint: "Scripts in hooks/ that run on agent events, like after a file edit." },
  settings: { label: "Settings", where: "canonfig.jsonc settings", hint: "Keys set in one harness's own settings file. Every other key in that file stays as it is." },
  tools: { label: "Tools", where: "canonfig.jsonc tools", hint: "Programs Canonfig installs with a recipe per system, then checks that they run." },
  credentials: { label: "Required secrets", where: "canonfig.jsonc credentials", hint: "A token or key a machine must already have. Canonfig checks that it's there and never sends it." },
  resources: { label: "Files outside harnesses", where: "canonfig.jsonc resources", hint: "A file, folder or config file in your home folder, outside every harness. File content lives in ~/.canonfig/files/." },
};

/** Where an item lives in ~/.canonfig/: its file or folder, or its key in canonfig.jsonc. */
export function itemPath(category: ItemCategory, name: string): string {
  if (category === "instructions") return "AGENTS.md";
  if (category === "hooks") return "canonfig.jsonc hooks";
  if (category === "skills" || category === "plugins") return `${category}/${name}/`;
  if (category === "rules" || category === "agents" || category === "commands") return `${category}/${name}.md`;
  return `canonfig.jsonc ${category}.${name}`;
}

/** Categories a follower's ~/.canonfig/local/ may add to, as canonfig.jsonc `local.allow` names them (LOCAL_CATEGORIES). */
export type LocalCategory = "instructions" | "rules" | "skills" | "plugins" | "agents" | "commands" | "mcp" | "settings";
export const LOCAL_CATEGORIES: LocalCategory[] = ["instructions", "rules", "skills", "plugins", "agents", "commands", "mcp", "settings"];

/**
 * Harness outputs canonfig.jsonc `local.appendLocal` can share with every machine (APPEND_LOCAL_CATEGORIES in
 * src/projection/model.ts): Canonfig owns a marked section of each instructions file, or only the skill folders it
 * writes, and the rest stays the machine's.
 */
export type AppendLocalCategory = "instructions" | "skills";
export const APPEND_LOCAL_CATEGORIES: AppendLocalCategory[] = ["instructions", "skills"];
export const APPEND_LOCAL_LABEL: Record<AppendLocalCategory, string> = { instructions: "Instructions files", skills: "Skills folders" };

/** Markers around Canonfig's section of an append-local text file (src/domain/text-composition.ts). */
export const SOURCE_TEXT_START = "<!-- canonfig:source:start -->";
export const SOURCE_TEXT_END = "<!-- canonfig:source:end -->";

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
 * Places a `resources.<id>` target may not overlap, with the owner Canonfig names when it refuses one
 * (projectResources in src/projection/plan.ts): the Canonfig folder, the shared ~/.agents, and every adapter's
 * root, surfaces and never-touch paths, whether or not that harness is listed. Reduced to the outermost paths of
 * each adapter's layout with the default environment on Linux and macOS; Windows keeps some under AppData, and
 * each machine checks again with its own paths.
 */
const HARNESS_PATHS: Record<HarnessId, string[]> = {
  codex: ["~/.codex"],
  "claude-code": ["~/.claude", "~/.claude.json"],
  amp: ["~/.config/amp", "~/.local/share/amp/secrets.json", "~/.local/share/amp/threads", "~/.cache/amp"],
  "oh-my-pi": ["~/.omp/agent", "~/.omp/logs", "~/.omp/install-id"],
  pi: ["~/.pi/agent"],
  "factory-droid": ["~/.factory"],
  cursor: ["~/.cursor"],
  devin: ["~/.config/devin", "~/.devin/rules", "~/.local/share/devin"],
  opencode: ["~/.config/opencode", "~/.local/share/opencode", "~/.cache/opencode"],
  "grok-build": ["~/.grok"],
  antigravity: ["~/.gemini"],
  "copilot-cli": ["~/.copilot"],
  kimi: ["~/.kimi-code"],
  kilo: ["~/.config/kilo", "~/.local/share/kilo", "~/.local/state/kilo/daemon.json", "~/.cache/kilo"],
  hermes: ["~/.hermes"],
  qwen: ["~/.qwen"],
};
export const RESERVED_PATHS: ReadonlyArray<readonly [path: string, owner: string]> = [
  ["~/.canonfig", "the Canonical Folder"],
  ["~/.agents", "the shared agent directory"],
  ...(Object.keys(HARNESS_PATHS) as HarnessId[]).flatMap((h) => HARNESS_PATHS[h].map((path) => [path, HARNESS_NAMES[h]] as const)),
];

/** canonfig.jsonc `surfaces` categories, in the order of SURFACE_CATEGORIES in src/projection/model.ts. */
export const SURFACE_CATEGORIES = ["instructions", "rules", "skills", "plugins", "agents", "commands", "hooks", "mcp", "settings"] as const;
export type SurfaceCategory = (typeof SURFACE_CATEGORIES)[number];
export const SURFACE_NAMES: Record<SurfaceCategory, string> = {
  instructions: "AGENTS.md",
  rules: "Rules",
  skills: "Skills",
  plugins: "Native plugins",
  agents: "Subagents",
  commands: "Commands",
  hooks: "Hooks",
  mcp: "MCP servers",
  settings: "Settings",
};

/** Every category minus the ones a harness cannot take. */
const allBut = (...missing: SurfaceCategory[]): SurfaceCategory[] => SURFACE_CATEGORIES.filter((c) => !missing.includes(c));

/**
 * The categories each harness can be given, as `supportedCategories` in src/projection/plan.ts derives them from
 * the adapters. tests/projection-adapters.test.ts fails when the two disagree.
 */
export const SURFACE_SUPPORT: Record<HarnessId, SurfaceCategory[]> = {
  codex: allBut("commands"),
  "claude-code": allBut(),
  amp: allBut(),
  "oh-my-pi": allBut(),
  pi: allBut("agents"),
  "factory-droid": allBut("plugins"),
  cursor: allBut("instructions", "rules", "commands", "plugins"),
  devin: allBut("commands", "plugins"),
  opencode: allBut(),
  "grok-build": allBut("commands", "plugins"),
  antigravity: allBut("commands", "plugins"),
  "copilot-cli": allBut("commands", "plugins"),
  kimi: allBut("commands", "plugins"),
  kilo: allBut(),
  hermes: allBut("instructions", "rules", "agents", "commands", "settings", "plugins"),
  qwen: allBut(),
};

/**
 * Each harness's settings file as the adapters declare it (the config surface with `settings` in
 * src/projection/adapters): the keys Canonfig always owns there, each written as one value, and the keys the
 * harness keeps for itself (`*` matches one segment). A key claim, `settings/<harness>#<key>`, may name only a
 * harness listed here and never a reserved key. tests/projection-adapters.test.ts fails when the two disagree.
 */
export const SETTINGS_FILES: Partial<Record<HarnessId, { readonly owned: string[]; readonly reserved: string[] }>> = {
  codex: { owned: ["mcp_servers"], reserved: [] },
  "claude-code": { owned: ["hooks"], reserved: [] },
  amp: { owned: ["amp\\.mcpServers"], reserved: [] },
  "oh-my-pi": { owned: [], reserved: [] },
  pi: { owned: [], reserved: [] },
  "factory-droid": { owned: [], reserved: [] },
  cursor: { owned: [], reserved: [] },
  devin: { owned: ["hooks"], reserved: [] },
  opencode: { owned: ["mcp"], reserved: ["provider"] },
  "grok-build": { owned: ["mcp_servers"], reserved: ["model.*.api_key"] },
  antigravity: { owned: [], reserved: ["trustedWorkspaces", "gcp"] },
  "copilot-cli": { owned: [], reserved: [] },
  kimi: { owned: ["hooks"], reserved: ["providers", "services.*.api_key"] },
  kilo: { owned: ["mcp"], reserved: ["provider"] },
  qwen: { owned: ["mcpServers", "hooks"], reserved: [] },
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
  files?: number;
  /** The state before Canonfig ever wrote; always kept. */
  first?: boolean;
}

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
    hint: "Someone changed a file Canonfig manages, on that machine.\nCanonfig keeps the change, reports it and holds what it writes from that file.",
    selfHint: "You changed a file Canonfig manages.\nCanonfig keeps your change, reports it and holds what it writes from that file.\nMove the change into your local folder, or ask the Source to publish it.",
  },
  "human-action": { label: "Needs you", tone: "act", term: "Human Action Required", hint: "A step only a person can do, like signing in to a tool.\nSyncing continues once it's done." },
  failed: { label: "Update failed", tone: "bad", term: "a failed Synchronization Run", hint: "The last update failed, so Canonfig put back the files and settings it had changed.\nTools it installed stay installed." },
  offline: { label: "Can't reach the Source", tone: "bad", term: "Unreachable", hint: "On its last try, this machine couldn't connect to the Source." },
  "never-synced": { label: "Not applied yet", tone: "muted", hint: "Nothing from the profile has been applied here yet." },
  excluded: { label: "Not sent to this machine", tone: "muted", term: "outside its Follower Groups", hint: "This machine isn't in a group that gets this item." },
};
/**
 * One entry of ~/.canonfig/skills-sources.json, the Source's machine-local record of where an installed skill came
 * from (TrackedSkill in src/skills/manager.ts). It is never published.
 */
export interface SkillSource {
  /** The folder item it tracks, `skills/<name>`; its directory is the item's path. */
  id: string;
  /** HTTPS Git URL or local repository path. */
  source: string;
  /** The branch, tag or commit it follows. */
  ref: string;
  /** The skill's directory inside the repository, `.` for the root. */
  subdir: string;
  /** The commit the installed copy was taken from. */
  commit: string;
  /**
   * The installed files at that commit, by path, each with a stand-in for its content. Canonfig records a digest of
   * them (`digest`); comparing the folder's files against it is how a local edit shows.
   */
  baseline: Record<string, string>;
}

/** A skill directory at one commit of an upstream repository, as `canonfig skills check` fetches it. */
export interface UpstreamSkill {
  source: string;
  subdir: string;
  /** Branches and tags that point at this commit; the commit id itself also works as a ref. */
  refs: string[];
  commit: string;
  /** SKILL.md and the other files, by path, each with a stand-in for its content. */
  files: Record<string, string>;
}
/**
 * SKILL.md as the demo compares it: the folder editor's Description and Body fields. Upstream SKILL.md files use the
 * same shape, so an unedited copy matches its upstream commit.
 */
export const skillManifest = (description: string, body: string) => `${description}\n---\n${body}`;
/** An item in a follower's ~/.canonfig/local/: AGENTS.md, a file for rules, skills, agents and commands, a key of local.jsonc otherwise. */
export interface LocalItem {
  /** `<category>/<name>`, unique within local/; `instructions` for local/AGENTS.md. */
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

/**
 * A harness output `local.appendLocal` shares with this machine that holds content of its own: text after
 * Canonfig's closing marker in an instructions file, or top-level entries Canonfig didn't write in a skills folder.
 */
export type KeptSurface =
  /** The machine's text below the closing marker, byte for byte. */
  | { category: "instructions"; target: string; text: string }
  /** The machine's own skill folders beside Canonfig's. */
  | { category: "skills"; target: string; entries: string[] };
