import { APP_VERSION, HARNESS_NAMES, type LocalCategory, type AppendLocalCategory, type FollowerState, type Resource, type Follower, type Revision, type HarnessId, type Harness, type Snapshot } from "./metadata";
export * from "./metadata";

// Demo data. Shapes follow the Canonical Folder (src/projection/folder.ts), the harness
// report and takeover snapshots (src/projection), and the CLI's status, doctor and
// schedule outputs for the simulated GUI.
// Nothing here talks to a real machine.

/**
 * True in the public demo build (`npm run build:demo`, Vite mode "demo") and on the dev server.
 * ui/vite.config.ts selects this application's entrypoint with the same condition. Production selects
 * live-app.tsx instead, so this module and the simulated store are outside its import graph.
 * Within the demo this flag also gates the demo panel, explanatory copy and simulated page loading.
 */
export const DEMO = import.meta.env.DEV || import.meta.env.MODE === "demo";


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
  // Listed, installed since the last update and not taken over yet: the next update backs up its AGENTS.md and,
  // with instructions in local.appendLocal, keeps that whole file as this machine's text (Sync's review step).
  amp: { installed: true, listed: true, excluded: false, root: null, snapshot: null },
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
  localAllow: ["instructions", "rules", "skills", "mcp", "settings"] as LocalCategory[],
  /** canonfig.jsonc `local.appendLocal`: harness outputs every machine keeps its own content in. */
  appendLocal: ["instructions", "skills"] as AppendLocalCategory[],
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
    id: "skills/release-notes",
    category: "skills",
    path: "skills/release-notes/",
    groups: [],
    summary: "2 files",
    detail: {
      Description: "Draft release notes from merged pull requests.",
      Files: "SKILL.md, templates/notes.md",
      Body: "Group changes by area. Lead with what users notice. Skip chores and dependency bumps.",
    },
  },
  {
    id: "skills/debugging",
    category: "skills",
    path: "skills/debugging/",
    groups: [],
    summary: "SKILL.md",
    detail: {
      Description: "Find the root cause of a failing test or crash.",
      Body: "Reproduce the failure first. Change one thing at a time and write down what each run shows.",
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
  {
    id: "resources/gitconfig",
    category: "resources",
    path: "canonfig.jsonc resources.gitconfig",
    groups: [],
    summary: "~/.gitconfig, replace",
    detail: { Type: "file", Target: "~/.gitconfig", Source: "files/gitconfig", Policy: "replace" },
  },
  {
    id: "resources/ruff",
    category: "resources",
    path: "canonfig.jsonc resources.ruff",
    groups: [],
    summary: "~/.config/ruff/ruff.toml, merges 2 keys",
    change: "added",
    detail: { Type: "config", Target: "~/.config/ruff/ruff.toml", Format: "toml" },
    keys: { "line-length": "100", "lint.select": '["E", "F", "I"]' },
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

/** The only Git repository the demo can fetch from. It's made up, like everything in the demo. */
export const DEMO_SKILLS_REPO = "https://github.com/example/agent-skills.git";

/**
 * SKILL.md as the demo compares it: the folder editor's Description and Body fields. Upstream SKILL.md files use the
 * same shape, so an unedited copy matches its upstream commit.
 */
export const skillManifest = (description: string, body: string) => `${description}\n---\n${body}`;

const CODE_REVIEW_V1 = skillManifest("Review a diff for correctness, tests and clarity.", "Read the diff twice. Check each changed function against references/checklist.md.");
const RELEASE_NOTES_V12 = skillManifest("Draft release notes from merged pull requests.", "Group changes by area. Lead with what users notice.");

/**
 * What DEMO_SKILLS_REPO holds. code-review's `main` moved past the commit atlas has, so a check finds an update;
 * release-notes is pinned to tag v1.2.0, and atlas's copy was edited since; debugging matches `main` but isn't
 * tracked yet.
 */
export const upstreamSkills: UpstreamSkill[] = [
  {
    source: DEMO_SKILLS_REPO,
    subdir: "skills/code-review",
    refs: [],
    commit: "3c9e1f4a7b2d8e05c6a9f1b3d7e2c4a8f0b6d913",
    files: { "SKILL.md": CODE_REVIEW_V1, "references/checklist.md": "checklist 1", "references/tone.md": "tone 1" },
  },
  {
    source: DEMO_SKILLS_REPO,
    subdir: "skills/code-review",
    refs: ["main"],
    commit: "8f41d2c09a7e3b61f5d4c2a8e9b07f3d1c6a5e42",
    files: {
      "SKILL.md": skillManifest(
        "Review a diff for correctness, tests and clarity.",
        "Read the diff twice. Check each changed function against references/checklist.md, then look for risky input handling with references/security.md.",
      ),
      "references/checklist.md": "checklist 2",
      "references/security.md": "security 1",
    },
  },
  {
    source: DEMO_SKILLS_REPO,
    subdir: "skills/release-notes",
    refs: ["v1.2.0"],
    commit: "b7a3e9d1f04c2685e3a1d9c7f6b2e08a4d5c3f19",
    files: { "SKILL.md": RELEASE_NOTES_V12, "templates/notes.md": "template 1" },
  },
  {
    source: DEMO_SKILLS_REPO,
    subdir: "skills/debugging",
    refs: ["main"],
    commit: "e2d6b4f81a9c3075d2e8f1b6a4c9d03e7f5b2a68",
    files: { "SKILL.md": skillManifest("Find the root cause of a failing test or crash.", "Reproduce the failure first. Change one thing at a time and write down what each run shows.") },
  },
];

/** atlas's skills-sources.json. */
export const skillSources: SkillSource[] = [
  { id: "skills/code-review", source: DEMO_SKILLS_REPO, ref: "main", subdir: "skills/code-review", commit: upstreamSkills[0].commit, baseline: upstreamSkills[0].files },
  { id: "skills/release-notes", source: DEMO_SKILLS_REPO, ref: "v1.2.0", subdir: "skills/release-notes", commit: upstreamSkills[2].commit, baseline: upstreamSkills[2].files },
];

/**
 * The newest stable patch in APP_VERSION's major.minor line on the demo's npm registry. Self-update only moves
 * within that line (latestPatch in src/runtime/self-update/core.ts).
 */
export const LATEST_PATCH = APP_VERSION.replace(/\d+$/, (patch) => String(Number(patch) + 1));

/** Each demo machine's self-update opt-in: the official npm-cli.js it uses, or null before opting in. */
export const selfUpdateSeed = {
  source: { npmCli: "/home/ubuntu/.npm-global/lib/node_modules/npm/bin/npm-cli.js" as string | null },
  follower: { npmCli: null as string | null },
};

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

export const followerSelf = {
  name: "laptop",
  /** Its home folder, which rule links in instructions files name (rules are linked by absolute path). */
  home: "/Users/maria",
  source: "atlas (via SSH tunnel)",
  revision: 7,
  state: "converged" as FollowerState,
  /**
   * Its ~/.canonfig/local/. commands/standup sits outside the Source's local.allow, so projection ignores it.
   * mcp/docs shares a published server's name; the overlay below lets it replace that server here.
   */
  local: [
    { id: "instructions", category: "instructions", path: "AGENTS.md", summary: "3 lines", detail: { Body: "## On this laptop\n\nRepositories live in ~/src." } },
    { id: "skills/pdf-tools", category: "skills", path: "skills/pdf-tools/", summary: "2 files", detail: { Description: "Fill and split PDF forms.", Body: "Use the scripts in this folder." } },
    { id: "mcp/notes", category: "mcp", path: "local.jsonc mcp.notes", summary: "stdio, uvx", detail: { Transport: "stdio", Command: "uvx mcp-notes" } },
    { id: "mcp/docs", category: "mcp", path: "local.jsonc mcp.docs", summary: "streamable-http", detail: { Transport: "streamable-http", URL: "http://127.0.0.1:8411/mcp" } },
    { id: "settings/codex", category: "settings", path: "local.jsonc settings.codex", summary: "1 key", keys: { model: '"gpt-5.5"' } },
    { id: "commands/standup", category: "commands", path: "commands/standup.md", summary: "/standup", detail: { Description: "Summarize yesterday's commits." } },
  ] as LocalItem[],
  /**
   * local.jsonc `overlays`: published items this machine's local item of the same name replaces, and key claims
   * (`settings/<harness>#<key>`) that keep one key of a harness's settings file this machine's own.
   */
  overlays: ["mcp/docs", "settings/claude-code#includeCoAuthoredBy"],
  /** What appendLocal keeps of this machine's own, as of the revision it applied. */
  kept: [
    { category: "instructions", target: "~/.codex/AGENTS.md", text: "# Laptop notes\n\nUse fish, not bash.\n" },
    { category: "skills", target: "~/.agents/skills/", entries: ["homebrew-audit", "keynote-export"] },
  ] as KeptSurface[],
};
