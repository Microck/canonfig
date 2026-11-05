import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";

import { parse as parseJsonc, type ParseError, printParseErrorCode } from "jsonc-parser";
import { Schema } from "effect";

import { type ContentDigest, ProfileId } from "../domain/brand.ts";
import { configPathIssue, configPathsOverlap } from "../domain/config-path.ts";
import { AuthoredVerificationInputSchema } from "../domain/profile.ts";
import { AgentInstallBounds, ConfigValue, LoginRequirement, ToolRecipeRef } from "../domain/resource.ts";
import { TaggedError } from "../domain/tagged-error.ts";
import { canonicalJson, sha256BytesHex, sha256Hex } from "../profile/profile-codec.ts";
import { parseMarkdownDocument } from "./frontmatter.ts";
import {
  APPEND_LOCAL_CATEGORIES,
  CAPABILITIES,
  HOOK_EVENTS,
  SURFACE_CATEGORIES,
  TARGET_IDS,
  type AgentDocument,
  type CanonicalModel,
  type CommandDocument,
  type FolderResource,
  type HarnessSettings,
  type Hook,
  type McpServer,
  type RuleDocument,
  type SettingsKey,
  type SkillFile,
  type SkillTree,
  type TargetId,
} from "./model.ts";

/**
 * Loads the Canonical Folder (`~/.canonfig/`) into the Canonical Model.
 *
 * Only the authoring allowlist is read: `canonfig.jsonc`, `AGENTS.md`,
 * `rules/`, `skills/`, `agents/`, `commands/`, `hooks/` and `files/`, plus `local/`.
 * Everything else in the folder (state, backups, logs) is machine-local and
 * never read here. Every file read must resolve inside the folder, and the
 * authored trees hold regular files and directories only.
 *
 * On a follower the authoring entries are a managed mirror: the run that
 * writes them also projects them, so it loads the mirror it is about to write
 * from memory and only `local/` from disk.
 */

/** The folder or one of its files is not valid authoring input. */
export class CanonicalFolderError extends TaggedError<CanonicalFolderError>()(
  "CanonicalFolderError",
  { path: Schema.String, message: Schema.String },
) {}

/** A `local/` item collides with a published one; the operator must choose. */
export class LocalItemCollisionError extends TaggedError<LocalItemCollisionError>()(
  "LocalItemCollisionError",
  { path: Schema.String, message: Schema.String },
) {}

const namePattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const identifier = Schema.String.check(
  Schema.isPattern(namePattern, { expected: "letters, digits, '-' or '_'" }),
);
const environmentName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u, { expected: "an environment variable name" }),
);
const SecretValueInput = Schema.Union([
  Schema.String,
  Schema.Struct({ fromEnv: environmentName, default: Schema.optional(Schema.String) }),
]);
const SecretMap = Schema.Record(Schema.String, SecretValueInput);
const ToolList = Schema.Array(Schema.NonEmptyString);
const positiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

/** Categories whose items `groups` can name, as `<category>/<name>`, plus `instructions`. */
export const GROUPABLE_CATEGORIES = [
  "rules", "skills", "agents", "commands", "hooks", "mcp", "settings", "tools", "credentials", "resources",
] as const;
const itemReference = Schema.String.check(Schema.isPattern(
  new RegExp(`^(?:instructions|(?:${GROUPABLE_CATEGORIES.join("|")})/[A-Za-z0-9][A-Za-z0-9_-]*)$`, "u"),
  { expected: "instructions or <category>/<name>, for example mcp/docs" },
));
const toolReference = Schema.String.check(
  Schema.isPattern(/^tools\/[A-Za-z0-9][A-Za-z0-9_-]*$/u, { expected: "tools/<id>" }),
);

const McpCommon = {
  enabled: Schema.optional(Schema.Boolean),
  timeoutMs: Schema.optional(positiveInteger),
  enabledTools: Schema.optional(ToolList),
  disabledTools: Schema.optional(ToolList),
  /** Tools the server needs; each is installed before the server is projected. */
  requires: Schema.optional(Schema.Array(toolReference)),
};

const McpServerInput = Schema.Union([
  Schema.Struct({
    transport: Schema.Literal("stdio"),
    command: Schema.NonEmptyString,
    args: Schema.optional(Schema.Array(Schema.String)),
    env: Schema.optional(SecretMap),
    cwd: Schema.optional(Schema.NonEmptyString),
    ...McpCommon,
  }),
  Schema.Struct({
    transport: Schema.Literals(["streamable-http", "sse"]),
    url: Schema.NonEmptyString,
    headers: Schema.optional(SecretMap),
    ...McpCommon,
  }),
]);
const McpMap = Schema.Record(identifier, McpServerInput);

const HookInput = Schema.Struct({
  id: identifier,
  event: Schema.Literals(HOOK_EVENTS),
  enabled: Schema.optional(Schema.Boolean),
  matcher: Schema.optional(Schema.Struct({
    capabilities: Schema.optional(Schema.Array(Schema.Literals(CAPABILITIES))),
    tools: Schema.optional(Schema.Array(Schema.NonEmptyString)),
    inputRegex: Schema.optional(Schema.NonEmptyString),
  })),
  run: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
  timeoutMs: Schema.optional(positiveInteger),
  onFailure: Schema.optional(Schema.Literals(["block", "warn", "ignore"])),
});

const SettingsMap = Schema.Record(Schema.String, Schema.Record(Schema.String, ConfigValue));

/**
 * A tool entry: the executable followers verify, platform recipes with exact
 * versions, and the optional login, bounded agent install and verification
 * of a `tool` Profile Resource.
 */
const ToolInput = Schema.Struct({
  executable: Schema.NonEmptyString,
  recipes: Schema.Array(ToolRecipeRef),
  login: Schema.optional(LoginRequirement),
  agentInstall: Schema.optional(AgentInstallBounds),
  verify: Schema.optional(AuthoredVerificationInputSchema),
});

/** `daily@HH:mm` or `weekly:Mon,Thu@HH:mm`, the calendars `canonfig schedule set` accepts. */
const ScheduleInput = Schema.String.check(Schema.isPattern(
  /^(?:daily|weekly:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:,(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))*)@(?:[01]\d|2[0-3]):[0-5]\d$/u,
  { expected: "daily@HH:mm or weekly:Mon,Thu@HH:mm" },
));

/** Categories `local/` may add to, named by `local.allow`. */
export const LOCAL_CATEGORIES = ["instructions", "rules", "skills", "agents", "commands", "mcp", "settings"] as const;
type LocalCategory = (typeof LOCAL_CATEGORIES)[number];

const LocalAllow = Schema.Struct({
  allow: Schema.optional(Schema.Array(Schema.Literals(LOCAL_CATEGORIES))),
  /** Harness outputs whose machine-owned content survives every sync; see model `appendLocal`. */
  appendLocal: Schema.optional(Schema.Array(Schema.Literals(APPEND_LOCAL_CATEGORIES))),
});

/** Categories a Local Overlay can name: an item `local/` holds under a published item's name. */
export const OVERLAY_CATEGORIES = ["rules", "skills", "agents", "commands", "mcp", "settings"] as const;

/**
 * One `overlays` entry in `local/local.jsonc`:
 *
 * - an item, `<category>/<name>` (for `settings` the name is a harness id):
 *   this machine's `local/` item of that name replaces the published one;
 * - a key claim, `settings/<harness>#<key path>`: Canonfig never writes,
 *   removes or checks that key in the harness's settings file on this
 *   machine, and keeps every other key it owns there. The `#` form is the
 *   one takeover already uses for a single key (`config#model`), and the
 *   settings file is the one surface the folder authors keys into.
 */
export type OverlayEntry =
  | { readonly kind: "item"; readonly item: string }
  | { readonly kind: "claim"; readonly item: string; readonly harness: TargetId; readonly key: string };

const overlayItemPattern = new RegExp(`^(?:${OVERLAY_CATEGORIES.join("|")})/([A-Za-z0-9][A-Za-z0-9_-]*)$`, "u");
const keyClaimPattern = /^settings\/([A-Za-z0-9][A-Za-z0-9_-]*)#(.+)$/su;

/** One `overlays` entry, or why it is invalid. */
export type ParsedOverlay = OverlayEntry | { readonly kind: "invalid"; readonly reason: string };

/** Parse one `overlays` entry; the CLI and the loader both read entries through it. */
export const parseOverlay = (entry: string): ParsedOverlay => {
  const invalid = (reason: string) => ({ kind: "invalid", reason }) as const;
  const claim = keyClaimPattern.exec(entry);
  if (claim !== null) {
    const harness = TARGET_IDS.find((candidate) => candidate === claim[1]);
    if (harness === undefined) return invalid(`overlay ${entry} names unknown harness ${claim[1]!}`);
    const issue = configPathIssue(claim[2]!);
    return issue === undefined ? { kind: "claim", item: entry, harness, key: claim[2]! } : invalid(`overlay ${entry}: ${issue}`);
  }
  const item = overlayItemPattern.exec(entry);
  if (item === null) {
    return invalid(`invalid overlay ${entry}: expected rules|skills|agents|commands|mcp/<name>, settings/<harness>, or settings/<harness>#<key>`);
  }
  if (entry.startsWith("settings/") && !TARGET_IDS.some((candidate) => candidate === item[1])) {
    return invalid(`overlay ${entry} names unknown harness ${item[1]!}`);
  }
  return { kind: "item", item: entry };
};

/** A home-relative path segment list: no empty, `.` or `..` segment, no backslash or NUL. */
const relativeSegments = /^(?:[^/\\\0]+\/)*[^/\\\0]+$/u;
const ResourceTarget = Schema.String.check(Schema.isPattern(
  new RegExp(`^~/${relativeSegments.source.slice(1)}`, "u"),
  { expected: "a path under the home directory, written ~/..." },
));
const ResourceSource = Schema.String.check(Schema.isPattern(
  new RegExp(`^files/${relativeSegments.source.slice(1)}`, "u"),
  { expected: "a path under files/, for example files/gitconfig" },
));
const ResourcePolicy = Schema.Literals(["replace", "append-local"]);

/** `resources.<id>`: a file, directory or config file outside every harness. */
const ResourceInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("file"), target: ResourceTarget, source: ResourceSource, policy: Schema.optional(ResourcePolicy) }),
  Schema.Struct({ kind: Schema.Literal("directory"), target: ResourceTarget, source: ResourceSource, policy: Schema.optional(ResourcePolicy) }),
  Schema.Struct({
    kind: Schema.Literal("config"),
    target: ResourceTarget,
    format: Schema.Literals(["json", "toml", "yaml"]),
    keys: Schema.Record(Schema.String, ConfigValue),
  }),
]);
export type FolderResourceInput = Schema.Schema.Type<typeof ResourceInput>;

const CanonfigJsonc = Schema.Struct({
  version: Schema.Literal(1),
  /** The Machine Profile this folder publishes; required to publish, unused by projection. */
  profile: Schema.optional(Schema.Struct({ id: ProfileId, name: Schema.NonEmptyString })),
  harnesses: Schema.Array(Schema.Literals(TARGET_IDS)),
  mcp: Schema.optional(McpMap),
  hooks: Schema.optional(Schema.Array(HookInput)),
  settings: Schema.optional(SettingsMap),
  /** Per-harness category allowlists; checked against `harnesses` when the model is built. */
  surfaces: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.Literals(SURFACE_CATEGORIES)))),
  tools: Schema.optional(Schema.Record(identifier, ToolInput)),
  credentials: Schema.optional(Schema.Record(identifier, Schema.Struct({ reference: Schema.NonEmptyString }))),
  groups: Schema.optional(Schema.Record(identifier, Schema.Array(itemReference))),
  scheduleDefault: Schema.optional(ScheduleInput),
  local: Schema.optional(LocalAllow),
  resources: Schema.optional(Schema.Record(identifier, ResourceInput)),
});

/** `canonfig.jsonc` as authored, after schema decoding. */
export type FolderConfig = typeof CanonfigJsonc.Type;
export type FolderMcpServer = Schema.Schema.Type<typeof McpServerInput>;
export type FolderHook = Schema.Schema.Type<typeof HookInput>;
export type FolderTool = Schema.Schema.Type<typeof ToolInput>;

const LocalJsonc = Schema.Struct({
  mcp: Schema.optional(McpMap),
  settings: Schema.optional(SettingsMap),
  excludeHarnesses: Schema.optional(Schema.Array(Schema.Literals(TARGET_IDS))),
  /** Authored resources this machine never projects; `restore` adds the ones it gives back. */
  excludeResources: Schema.optional(Schema.Array(identifier)),
  /** Local Overlays and key claims; `parseOverlay` reads each entry. */
  overlays: Schema.optional(Schema.Array(Schema.String)),
  backups: Schema.optional(Schema.Boolean),
});

const RuleFrontmatter = Schema.Struct({
  description: Schema.optional(Schema.NonEmptyString),
  paths: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  activation: Schema.optional(Schema.Literals(["always", "path", "manual", "model"])),
});
const AgentFrontmatter = Schema.Struct({
  description: Schema.NonEmptyString,
  model: Schema.optional(Schema.NonEmptyString),
  tools: Schema.optional(Schema.Array(Schema.Literals(CAPABILITIES))),
  writable: Schema.optional(Schema.Boolean),
});
const CommandFrontmatter = Schema.Struct({
  description: Schema.NonEmptyString,
  argumentHint: Schema.optional(Schema.NonEmptyString),
});
const SkillFrontmatter = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
});

/** A key claim: this machine owns `key` in `harness`'s settings file. */
export interface KeyClaim {
  readonly harness: TargetId;
  readonly key: string;
}

/** Machine-local policy from `local/local.jsonc`. */
export interface LocalPolicy {
  /** Harnesses this machine never projects, even when listed. */
  readonly excludeHarnesses: ReadonlyArray<TargetId>;
  /** Authored resources this machine never projects. */
  readonly excludeResources: ReadonlyArray<string>;
  /** Settings keys this machine owns; projection neither writes nor checks them. */
  readonly claims: ReadonlyArray<KeyClaim>;
  /** False turns takeover snapshots off on this machine. */
  readonly backups: boolean;
}

/**
 * One `overlays` entry as `canonfig overlay list` reports it: an item overlay
 * with what it finds (a `local/` item, a published item, or both), or a key
 * claim. Whether a claim covers a key Canonfig writes shows in the plan.
 */
export type OverlayStatus =
  | {
    readonly kind: "item";
    readonly item: string;
    /** `local/` holds an admitted item of that name. */
    readonly local: boolean;
    /** The folder (or the mirror) publishes an item of that name. */
    readonly published: boolean;
  }
  | { readonly kind: "claim"; readonly item: string; readonly harness: TargetId; readonly key: string };

export interface LoadedFolder {
  readonly model: CanonicalModel;
  readonly local: LocalPolicy;
  /** Digest of the model, the identity a local run records as its origin. */
  readonly digest: ContentDigest;
  /** Local items `local.allow` does not admit; reported, never projected. */
  readonly ignoredLocal: ReadonlyArray<string>;
  readonly overlays: ReadonlyArray<OverlayStatus>;
}

/** An authored file: its bytes and whether its owner may execute it. */
export interface FolderFile {
  readonly content: Uint8Array;
  readonly executable: boolean;
}

/** A file's place and mode, without its bytes: what publication compiles skill files from. */
export interface ListedFile {
  /** Relative to the listed directory, forward slashes. */
  readonly path: string;
  readonly executable: boolean;
}

/** Where the loader reads authored entries from. */
interface FolderSource {
  readonly folder: string;
  /** A regular file, or undefined when absent. */
  readonly file: (path: string) => Promise<FolderFile | undefined>;
  /**
   * Whether a regular file is executable, or undefined when absent, with the
   * same checks as `file` but without reading it. Publication streams file
   * bytes itself, so listing a skill must not hold them in memory.
   */
  readonly executable: (path: string) => Promise<boolean | undefined>;
  /** A directory's entries sorted by name, or none when it is absent. */
  readonly entries: (directory: string) => Promise<ReadonlyArray<{ readonly name: string; readonly directory: boolean }>>;
}

const failure = (path: string, message: string) => new CanonicalFolderError({ path, message });

/** Decode authored frontmatter; unknown fields are errors, so typos surface. */
const decodeFrontmatter = <S extends Schema.Decoder<unknown>>(
  schema: S,
  data: Readonly<Record<string, ConfigValue>>,
  path: string,
): S["Type"] => {
  try {
    return Schema.decodeUnknownSync(schema)(data, { onExcessProperty: "error" });
  } catch (error) {
    throw failure(path, error instanceof Error ? error.message : String(error));
  }
};

const isMissing = (error: Error): boolean =>
  "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");

const byName = <Entry extends { readonly name: string }>(left: Entry, right: Entry) =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0;

/**
 * The folder on disk. Every path read must resolve inside it, and links are
 * refused, so neither `..` nor a symlink can make Canonfig read or publish
 * content from elsewhere. Containment compares real paths on both sides: the
 * folder's own path can pass through a link (macOS `/var` is `/private/var`,
 * or a home directory on another volume), and that must not reject every file.
 */
const diskSource = (folder: string): FolderSource => {
  let realFolder: Promise<string> | undefined;
  const insideFolder = async (path: string): Promise<void> => {
    realFolder ??= realpath(folder);
    const fromRoot = relative(await realFolder, await realpath(path));
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw failure(path, "resolves outside the Canonical Folder");
    }
  };
  const status = async (path: string) => {
    try {
      return await lstat(path);
    } catch (error) {
      if (error instanceof Error && isMissing(error)) return undefined;
      throw error;
    }
  };
  const regularFile = async (path: string) => {
    const found = await status(path);
    if (found === undefined) return undefined;
    if (!found.isFile()) throw failure(path, "is not a regular file; links and special files are not authoring input");
    await insideFolder(path);
    return found;
  };
  return {
    folder,
    file: async (path) => {
      const found = await regularFile(path);
      return found === undefined ? undefined : { content: await readFile(path), executable: (found.mode & 0o100) !== 0 };
    },
    executable: async (path) => {
      const found = await regularFile(path);
      return found === undefined ? undefined : (found.mode & 0o100) !== 0;
    },
    entries: async (directory) => {
      const found = await status(directory);
      if (found === undefined) return [];
      if (!found.isDirectory()) throw failure(directory, "is not a directory");
      await insideFolder(directory);
      const entries = await readdir(directory, { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory(), link: entry.isSymbolicLink() }))
        .map((entry) => {
          if (entry.link) throw failure(join(directory, entry.name), "is a link; links are not authoring input");
          return { name: entry.name, directory: entry.directory };
        })
        .sort(byName);
    },
  };
};

/**
 * A follower's mirror: authoring entries come from `files` (keyed by path
 * relative to the folder, `/`-separated), `local/` from disk.
 */
const mirrorSource = (folder: string, files: ReadonlyMap<string, FolderFile>): FolderSource => {
  const disk = diskSource(folder);
  const key = (path: string) => relative(folder, path).split(sep).join("/");
  const local = (relativePath: string) => relativePath === "local" || relativePath.startsWith("local/");
  return {
    folder,
    file: (path) => local(key(path)) ? disk.file(path) : Promise.resolve(files.get(key(path))),
    executable: (path) => local(key(path)) ? disk.executable(path) : Promise.resolve(files.get(key(path))?.executable),
    entries: (directory) => {
      const prefix = key(directory);
      if (local(prefix)) return disk.entries(directory);
      const children = new Map<string, boolean>();
      for (const path of files.keys()) {
        if (!path.startsWith(`${prefix}/`)) continue;
        const [name, ...rest] = path.slice(prefix.length + 1).split("/");
        children.set(name!, (children.get(name!) ?? false) || rest.length > 0);
      }
      return Promise.resolve([...children].map(([name, directory]) => ({ name, directory })).sort(byName));
    },
  };
};

const decodeText = (path: string, bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw failure(path, "is not valid UTF-8");
  }
};

const readText = async (source: FolderSource, path: string): Promise<string | undefined> => {
  const file = await source.file(path);
  return file === undefined ? undefined : decodeText(path, file.content);
};

/** Parse and decode JSONC text. */
const decodeJsonc = <S extends Schema.Decoder<unknown>>(path: string, text: string, schema: S): S["Type"] => {
  const errors: Array<ParseError> = [];
  const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  const first = errors[0];
  if (first !== undefined) {
    throw failure(path, `is not valid JSONC: ${printParseErrorCode(first.error)} at offset ${first.offset}`);
  }
  try {
    return Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" });
  } catch (error) {
    throw failure(path, error instanceof Error ? error.message : String(error));
  }
};

/** Read and decode a JSONC file, or undefined when it does not exist. */
const readJsonc = async <S extends Schema.Decoder<unknown>>(
  source: FolderSource,
  path: string,
  schema: S,
): Promise<S["Type"] | undefined> => {
  const text = await readText(source, path);
  return text === undefined ? undefined : decodeJsonc(path, text, schema);
};

const documentId = (path: string, name: string): string => {
  const id = name.slice(0, -".md".length);
  if (!namePattern.test(id)) {
    throw failure(path, "file names must be letters, digits, '-' or '_' followed by .md");
  }
  return id;
};

/** Every `<id>.md` in a document directory, as frontmatter plus body. */
const loadDocuments = async <S extends Schema.Decoder<unknown>>(
  source: FolderSource,
  directory: string,
  schema: S,
) => {
  const documents: Array<{ readonly id: string; readonly path: string; readonly data: S["Type"]; readonly content: string }> = [];
  for (const entry of await source.entries(directory)) {
    const path = join(directory, entry.name);
    if (entry.directory || !entry.name.endsWith(".md")) throw failure(path, "only <id>.md documents belong here");
    const id = documentId(path, entry.name);
    const text = (await readText(source, path))!;
    let parsed;
    try {
      parsed = parseMarkdownDocument(text);
    } catch (error) {
      throw failure(path, `has invalid frontmatter: ${error instanceof Error ? error.message : String(error)}`);
    }
    documents.push({ id, path, data: decodeFrontmatter(schema, parsed.data, path), content: parsed.content });
  }
  return documents;
};

const loadRules = async (source: FolderSource, directory: string): Promise<ReadonlyArray<RuleDocument>> =>
  (await loadDocuments(source, directory, RuleFrontmatter)).map((document) => ({
    id: document.id,
    description: document.data.description,
    paths: document.data.paths ?? [],
    activation: document.data.activation,
    content: document.content,
    source: document.path,
  }));

const loadAgents = async (source: FolderSource, directory: string): Promise<ReadonlyArray<AgentDocument>> =>
  (await loadDocuments(source, directory, AgentFrontmatter)).map((document) => ({
    id: document.id,
    description: document.data.description,
    model: document.data.model ?? "inherit",
    tools: document.data.tools ?? ["read", "search"],
    writable: document.data.writable ?? false,
    content: document.content,
  }));

const loadCommands = async (source: FolderSource, directory: string): Promise<ReadonlyArray<CommandDocument>> =>
  (await loadDocuments(source, directory, CommandFrontmatter)).map((document) => ({
    id: document.id,
    description: document.data.description,
    argumentHint: document.data.argumentHint,
    content: document.content,
  }));

/** Regular files beneath a directory, relative with forward slashes, unread. */
const listFiles = async (source: FolderSource, directory: string, prefix = ""): Promise<Array<ListedFile>> => {
  const files: Array<ListedFile> = [];
  for (const entry of await source.entries(directory)) {
    const path = join(directory, entry.name);
    const relativePath = `${prefix}${entry.name}`;
    if (entry.directory) {
      files.push(...await listFiles(source, path, `${relativePath}/`));
      continue;
    }
    const executable = await source.executable(path);
    if (executable !== undefined) files.push({ path: relativePath, executable });
  }
  return files;
};

/** Regular files beneath a directory with their bytes, for projection. */
const loadFiles = async (source: FolderSource, directory: string): Promise<Array<SkillFile>> => {
  const files: Array<SkillFile> = [];
  for (const listed of await listFiles(source, directory)) {
    const file = await source.file(join(directory, ...listed.path.split("/")));
    if (file !== undefined) files.push({ path: listed.path, content: file.content, executable: file.executable });
  }
  return files;
};

/** A skill directory checked against its SKILL.md, with its files as `files` loads them. */
type LoadedSkill<File> = Omit<SkillTree, "files"> & { readonly files: ReadonlyArray<File> };

const loadSkills = async <File>(
  source: FolderSource,
  directory: string,
  files: (source: FolderSource, directory: string) => Promise<ReadonlyArray<File>>,
): Promise<ReadonlyArray<LoadedSkill<File>>> => {
  const skills: Array<LoadedSkill<File>> = [];
  for (const entry of await source.entries(directory)) {
    const path = join(directory, entry.name);
    if (!entry.directory) throw failure(path, "every entry of skills/ is a skill directory");
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(entry.name)) {
      throw failure(path, "skill directory names are lowercase letters, digits and '-'");
    }
    const manifest = await readText(source, join(path, "SKILL.md"));
    if (manifest === undefined) throw failure(path, "has no SKILL.md");
    let data;
    try {
      data = parseMarkdownDocument(manifest).data;
    } catch (error) {
      throw failure(join(path, "SKILL.md"), `has invalid frontmatter: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Agent Skills frontmatter carries more fields (license, metadata, ...);
    // only the two Canonfig reads are checked here.
    let frontmatter;
    try {
      frontmatter = Schema.decodeUnknownSync(SkillFrontmatter)(data);
    } catch (error) {
      throw failure(join(path, "SKILL.md"), `needs a name and a description: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (frontmatter.name !== entry.name) {
      throw failure(join(path, "SKILL.md"), `names the skill ${frontmatter.name}, but its directory is ${entry.name}`);
    }
    skills.push({
      name: entry.name,
      description: frontmatter.description,
      files: await files(source, path),
    });
  }
  return skills;
};

const mcpServer = (input: FolderMcpServer): McpServer =>
  input.transport === "stdio"
    ? {
      transport: "stdio",
      command: input.command,
      args: input.args ?? [],
      cwd: input.cwd,
      env: input.env ?? {},
      timeoutMs: input.timeoutMs,
      enabledTools: input.enabledTools,
      disabledTools: input.disabledTools,
    }
    : {
      transport: input.transport,
      url: input.url,
      headers: input.headers ?? {},
      timeoutMs: input.timeoutMs,
      enabledTools: input.enabledTools,
      disabledTools: input.disabledTools,
    };

/**
 * The script a hook runs from the folder's `hooks/` directory, relative to
 * the folder (`hooks/format.sh`), or undefined for a command name or an
 * absolute path. Anything else is refused.
 */
export const hookScript = (hook: FolderHook, path: string): string | undefined => {
  const command = hook.run[0]!;
  if (isAbsolute(command) || !/[\\/]/u.test(command)) return undefined;
  const normalized = command.replaceAll("\\", "/");
  if (!normalized.startsWith("hooks/") || normalized.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) {
    throw failure(path, `hook command ${command} must be a command name, an absolute path, or a script under hooks/`);
  }
  return normalized;
};

/**
 * Whether a folder file should carry execute permission when it leaves this
 * machine. Windows cannot report POSIX execute bits, so an enabled hook that
 * names a script directly expresses the author's intent to run it, and that
 * intent is kept for Unix machines. A script only disabled hooks name keeps
 * its observed mode, as does every file on a Unix machine. Publication and
 * export both apply this, so a script leaves a Windows Source the same way
 * whichever path it takes.
 */
export const intendedExecutable = (
  script: string,
  observedExecutable: boolean,
  enabledScripts: ReadonlySet<string>,
  platform: NodeJS.Platform = process.platform,
): boolean => observedExecutable || (platform === "win32" && enabledScripts.has(script));

/**
 * A relative `run[0]` names a script in the folder's `hooks/` directory and
 * becomes absolute, so harnesses can run it from any working directory. A bare
 * command name is looked up on PATH when the hook runs.
 */
const loadHooks = async (
  source: FolderSource,
  inputs: ReadonlyArray<FolderHook>,
  path: string,
): Promise<ReadonlyArray<Hook>> => {
  const seen = new Set<string>();
  const hooks: Array<Hook> = [];
  for (const input of inputs) {
    if (seen.has(input.id)) throw failure(path, `hook id ${input.id} is declared twice`);
    seen.add(input.id);
    if (input.enabled === false) continue;
    const [command, ...rest] = input.run;
    const script = hookScript(input, path);
    if (script !== undefined && await source.file(join(source.folder, ...script.split("/"))) === undefined) {
      throw failure(path, `hook script ${command} does not exist`);
    }
    hooks.push({
      id: input.id,
      event: input.event,
      matcher: {
        capabilities: input.matcher?.capabilities ?? [],
        tools: input.matcher?.tools ?? [],
        inputRegex: input.matcher?.inputRegex,
      },
      run: [script === undefined ? command! : join(source.folder, ...script.split("/")), ...rest],
      timeoutMs: input.timeoutMs ?? 30_000,
      onFailure: input.onFailure ?? "warn",
    });
  }
  return hooks;
};

/** Checked `<key path>: value` entries, sorted by path; `label` names their place in the file. */
const checkedKeys = (
  keys: Readonly<Record<string, ConfigValue>>,
  label: string,
  path: string,
): ReadonlyArray<SettingsKey> => {
  const entries = Object.entries(keys).map(([key, value]) => {
    const issue = configPathIssue(key);
    if (issue !== undefined) throw failure(path, `${label} key ${key}: ${issue}`);
    return { path: key, value };
  });
  for (const [index, entry] of entries.entries()) {
    const overlap = entries.slice(index + 1).find((other) => configPathsOverlap(entry.path, other.path));
    if (overlap !== undefined) {
      throw failure(path, `${label} keys ${entry.path} and ${overlap.path} overlap`);
    }
  }
  return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
};

const settingsFor = (
  input: Readonly<Record<string, Readonly<Record<string, ConfigValue>>>> | undefined,
  path: string,
): HarnessSettings => {
  const settings: Partial<Record<TargetId, ReadonlyArray<SettingsKey>>> = {};
  for (const [harness, keys] of Object.entries(input ?? {})) {
    const target = TARGET_IDS.find((candidate) => candidate === harness);
    if (target === undefined) throw failure(path, `settings names unknown harness ${harness}`);
    settings[target] = checkedKeys(keys, `settings.${harness}`, path);
  }
  return settings;
};

type OverlayCategory = (typeof OVERLAY_CATEGORIES)[number];

/**
 * Adds local items by name. A name already published is Human Action
 * Required unless a Local Overlay names it: then this machine's item
 * replaces the published one.
 */
const addLocal = <Item>(
  published: ReadonlyArray<Item>,
  local: ReadonlyArray<Item>,
  name: (item: Item) => string,
  category: OverlayCategory,
  label: string,
  path: string,
  overlays: ReadonlySet<string>,
): ReadonlyArray<Item> => {
  const localNames = new Set(local.map(name));
  const replaced = new Set<string>();
  for (const item of published) {
    if (!localNames.has(name(item))) continue;
    if (!overlays.has(`${category}/${name(item)}`)) {
      throw new LocalItemCollisionError({
        path,
        message: `local ${label} ${name(item)} has the same name as a published one; rename or remove one of them, or let yours replace it on this machine with 'canonfig overlay set ${category}/${name(item)}'`,
      });
    }
    replaced.add(name(item));
  }
  return [...published.filter((item) => !replaced.has(name(item))), ...local];
};

/**
 * Adds local settings keys. A key that overlaps a published one is Human
 * Action Required unless `settings/<harness>` is a Local Overlay: then the
 * local key replaces every published key it overlaps, and the other
 * published keys stay.
 */
const mergeLocalSettings = (
  published: HarnessSettings,
  local: HarnessSettings,
  path: string,
  overlays: ReadonlySet<string>,
): HarnessSettings =>
  Object.fromEntries(TARGET_IDS.flatMap((harness) => {
    const localKeys = local[harness] ?? [];
    const overlaid = overlays.has(`settings/${harness}`);
    const kept = (published[harness] ?? []).filter((entry) => {
      const collision = localKeys.find((other) => configPathsOverlap(entry.path, other.path));
      if (collision === undefined) return true;
      if (overlaid) return false;
      throw new LocalItemCollisionError({
        path,
        message: `local setting ${harness} ${collision.path} overlaps published setting ${entry.path}; remove one of them, or let yours replace it on this machine with 'canonfig overlay set settings/${harness}'`,
      });
    });
    const entries = [...kept, ...localKeys]
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    return entries.length === 0 ? [] : [[harness, entries] as const];
  }));

/** A file's place, mode and content digest: what the model digest records instead of bytes. */
const fileIdentity = (file: SkillFile) => ({ path: file.path, executable: file.executable, digest: sha256BytesHex(file.content) });

/** A stable digest of everything the model holds, file content included by digest. */
const modelDigest = (model: CanonicalModel, local: LocalPolicy): ContentDigest => {
  const skills = model.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    files: skill.files.map(fileIdentity),
  }));
  const resources = model.resources.map((resource) =>
    resource.kind === "file"
      ? { ...resource, file: fileIdentity(resource.file) }
      : resource.kind === "directory"
      ? { ...resource, files: resource.files.map(fileIdentity) }
      : resource
  );
  const value = JSON.parse(JSON.stringify({ ...model, skills, resources, local }));
  return sha256Hex(canonicalJson(value));
};

/** The harness list in `canonfig.jsonc` and this machine's exclusions in `local/local.jsonc`. */
export interface HarnessSelection {
  /** Undefined when `canonfig.jsonc` does not exist yet. */
  readonly listed: ReadonlyArray<TargetId> | undefined;
  readonly excluded: ReadonlyArray<TargetId>;
}

/**
 * Read only the harness selection, for `canonfig harnesses`, doctor and setup.
 * Both files are decoded against their full schemas, so an invalid file is
 * reported here too, but no authored document, skill or hook is loaded.
 */
export const readHarnessSelection = async (folder: string): Promise<HarnessSelection> => {
  const source = diskSource(folder);
  const config = await readJsonc(source, join(folder, "canonfig.jsonc"), CanonfigJsonc);
  const local = await readJsonc(source, join(folder, "local", "local.jsonc"), LocalJsonc);
  return {
    listed: config === undefined ? undefined : [...new Set(config.harnesses)],
    excluded: local?.excludeHarnesses ?? [],
  };
};

/** `canonfig.jsonc` as authored, or undefined when it does not exist. */
export const readFolderConfig = (folder: string): Promise<FolderConfig | undefined> =>
  readJsonc(diskSource(folder), join(folder, "canonfig.jsonc"), CanonfigJsonc);

/** Decode `canonfig.jsonc` text, for a caller that edits the file and checks the result. */
export const decodeFolderConfig = (path: string, text: string): FolderConfig => decodeJsonc(path, text, CanonfigJsonc);

/** Decode `local/local.jsonc` text, for a caller that read the bytes itself. */
export const decodeLocalConfig = (path: string, text: string): typeof LocalJsonc.Type => decodeJsonc(path, text, LocalJsonc);

/** Every regular file under one of the folder's directories, relative to it, `/`-separated, unread. */
export const listFolderFiles = (folder: string, directory: string): Promise<ReadonlyArray<ListedFile>> =>
  listFiles(diskSource(folder), join(folder, directory));

/** The authoring allowlist: the only top-level entries of `~/.canonfig/` that are published or mirrored. */
export const AUTHORING_ENTRIES = ["canonfig.jsonc", "AGENTS.md", "rules", "skills", "agents", "commands", "hooks", "files"] as const;

/**
 * Whether a path holds something: any file, and any directory with something
 * in it. Nothing beneath it is read or checked.
 */
export const holdsEntries = async (path: string): Promise<boolean> => {
  try {
    const stat = await lstat(path);
    return !stat.isDirectory() || (await readdir(path)).length > 0;
  } catch (error) {
    if (error instanceof Error && isMissing(error)) return false;
    throw error;
  }
};

/**
 * The authoring entries a folder holds, in allowlist order. An empty
 * directory holds no item, so the mirror can fill it. `follower enroll`
 * refuses a folder with entries, because on a follower those places hold the
 * Source's mirror.
 */
export const authoredEntries = async (folder: string): Promise<ReadonlyArray<string>> => {
  const present: Array<string> = [];
  for (const name of AUTHORING_ENTRIES) {
    if (await holdsEntries(join(folder, name))) present.push(name);
  }
  return present;
};

/** The resource id of a folder item reference: `mcp/docs` is `mcp:docs`. */
export const itemResourceId = (reference: string): string => reference.replace("/", ":");

/**
 * The authored items of a folder, without `local/`. Projection loads skill
 * and resource files with their bytes; publication lists them and streams
 * the bytes itself.
 */
export interface AuthoredFolder<File = SkillFile> {
  readonly config: FolderConfig;
  readonly instructions?: string | undefined;
  readonly rules: ReadonlyArray<RuleDocument>;
  readonly skills: ReadonlyArray<LoadedSkill<File>>;
  readonly agents: ReadonlyArray<AgentDocument>;
  readonly commands: ReadonlyArray<CommandDocument>;
  /** Enabled hooks only, scripts resolved to absolute paths. */
  readonly hooks: ReadonlyArray<Hook>;
  /** Declared `settings.<harness>` keys, checked. */
  readonly settings: HarnessSettings;
  /** `resources.<id>`, sorted by id, with their files from `files/`. */
  readonly resources: ReadonlyArray<FolderResource<File>>;
}

/** How a loader reads authored files: listed only, or with their bytes. */
interface FileReader<File> {
  readonly tree: (source: FolderSource, directory: string) => Promise<ReadonlyArray<File>>;
  readonly file: (source: FolderSource, path: string) => Promise<File | undefined>;
}

const listing: FileReader<ListedFile> = {
  tree: listFiles,
  file: async (source, path) => {
    const executable = await source.executable(path);
    return executable === undefined ? undefined : { path: basename(path), executable };
  },
};

const loading: FileReader<SkillFile> = {
  tree: loadFiles,
  file: async (source, path) => {
    const file = await source.file(path);
    return file === undefined ? undefined : { path: basename(path), content: file.content, executable: file.executable };
  },
};

const dotSegment = (segment: string) => segment === "." || segment === "..";

/**
 * `~/a/b` and `~/a` overlap; `~/a` and `~/ab` do not. Case is ignored: a
 * folder is published to every follower, and macOS and Windows file systems
 * treat `~/.Notes` and `~/.notes` as one path.
 */
const targetsOverlap = (left: string, right: string) => {
  const [a, b] = [left.toLowerCase(), right.toLowerCase()];
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};

/**
 * `resources.<id>`: each target is a home-relative path with no `.` or `..`
 * segment, no two targets overlap, and every file source exists under
 * `files/`. An append-local file is never executable.
 */
const loadResources = async <File extends { readonly executable: boolean }>(
  source: FolderSource,
  inputs: Readonly<Record<string, FolderResourceInput>> | undefined,
  path: string,
  reader: FileReader<File>,
): Promise<ReadonlyArray<FolderResource<File>>> => {
  const resources: Array<FolderResource<File>> = [];
  for (const [id, input] of Object.entries(inputs ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const label = `resources.${id}`;
    if (input.target.slice(2).split("/").some(dotSegment)) throw failure(path, `${label}.target ${input.target} has a . or .. segment`);
    const overlap = resources.find((other) => targetsOverlap(other.target, input.target));
    if (overlap !== undefined) throw failure(path, `${label}.target ${input.target} overlaps resources.${overlap.id}.target ${overlap.target}`);
    if (input.kind === "config") {
      resources.push({ id, kind: "config", target: input.target, format: input.format, keys: checkedKeys(input.keys, label, path) });
      continue;
    }
    if (input.source.split("/").some(dotSegment)) throw failure(path, `${label}.source ${input.source} has a . or .. segment`);
    const location = join(source.folder, ...input.source.split("/"));
    const policy = input.policy ?? "replace";
    if (input.kind === "file") {
      const file = await reader.file(source, location);
      if (file === undefined) throw failure(path, `${label}.source ${input.source} does not exist`);
      if (policy === "append-local" && file.executable) {
        throw failure(path, `${label} uses append-local, which needs a text file that is not executable`);
      }
      resources.push({ id, kind: "file", target: input.target, policy, source: input.source, file });
      continue;
    }
    const files = await reader.tree(source, location);
    if (files.length === 0) throw failure(path, `${label}.source ${input.source} is not a directory holding files`);
    resources.push({ id, kind: "directory", target: input.target, policy, source: input.source, files });
  }
  return resources;
};

const loadAuthored = async <File extends { readonly executable: boolean }>(
  source: FolderSource,
  reader: FileReader<File>,
): Promise<AuthoredFolder<File>> => {
  const folder = source.folder;
  const configPath = join(folder, "canonfig.jsonc");
  const config = await readJsonc(source, configPath, CanonfigJsonc);
  if (config === undefined) {
    throw failure(configPath, "does not exist; scaffold the folder with 'canonfig setup plan --role source', or enroll this machine as a follower");
  }
  return {
    config,
    instructions: await readText(source, join(folder, "AGENTS.md")),
    rules: await loadRules(source, join(folder, "rules")),
    skills: await loadSkills(source, join(folder, "skills"), reader.tree),
    agents: await loadAgents(source, join(folder, "agents")),
    commands: await loadCommands(source, join(folder, "commands")),
    hooks: await loadHooks(source, config.hooks ?? [], configPath),
    settings: settingsFor(config.settings, configPath),
    resources: await loadResources(source, config.resources, configPath, reader),
  };
};

/** Load and check the folder's authored items, ignoring `local/`, with skill and resource files listed but unread. */
export const loadAuthoredFolder = (folder: string): Promise<AuthoredFolder<ListedFile>> =>
  loadAuthored(diskSource(folder), listing);

/** Instructions followed by this machine's own: `local/AGENTS.md` after the published text. */
const withLocalInstructions = (published: string | undefined, local: string | undefined): string | undefined => {
  if (local === undefined) return published;
  if (published === undefined) return local;
  return `${published}${published.endsWith("\n") ? "\n" : "\n\n"}${local}`;
};

/**
 * Load `~/.canonfig/` and its `local/` items into the Canonical Model. With
 * `mirror`, the authored entries are those files instead of the disk's.
 */
export const loadCanonicalFolder = async (
  folder: string,
  mirror?: ReadonlyMap<string, FolderFile>,
): Promise<LoadedFolder> => {
  const source = mirror === undefined ? diskSource(folder) : mirrorSource(folder, mirror);
  const authored = await loadAuthored(source, loading);
  const config = authored.config;
  const localPath = join(folder, "local", "local.jsonc");
  const localConfig = (await readJsonc(source, localPath, LocalJsonc)) ?? {};
  const allow = config.local?.allow ?? [];
  const ignoredLocal: Array<string> = [];
  const localDirectory = join(folder, "local");

  // A category not in `local.allow` is never decoded: it only earns the
  // ignored-local warning, so content that would not load (a skill without
  // SKILL.md, a link) cannot stop the sync. `local/` always comes from disk,
  // mirror or not, so the presence check reads the disk too.
  const localItems = async <Item>(category: LocalCategory, load: (directory: string) => Promise<ReadonlyArray<Item>>) => {
    const directory = join(localDirectory, category);
    if (allow.includes(category)) return load(directory);
    if (await holdsEntries(directory)) ignoredLocal.push(`local/${category}/`);
    return [];
  };

  const overlayEntries = [...new Set(localConfig.overlays ?? [])].sort().map((entry): OverlayEntry => {
    const parsed = parseOverlay(entry);
    if (parsed.kind === "invalid") throw failure(localPath, parsed.reason);
    return parsed;
  });
  const overlays = new Set(overlayEntries.flatMap((entry) => entry.kind === "item" ? [entry.item] : []));
  const claims = overlayEntries.flatMap((entry): ReadonlyArray<KeyClaim> =>
    entry.kind === "claim" ? [{ harness: entry.harness, key: entry.key }] : []
  );

  const localRules = await localItems("rules", (directory) => loadRules(source, directory));
  const localSkills = await localItems("skills", (directory) => loadSkills(source, directory, loadFiles));
  const localAgents = await localItems("agents", (directory) => loadAgents(source, directory));
  const localCommands = await localItems("commands", (directory) => loadCommands(source, directory));
  const rules = addLocal(authored.rules, localRules, (rule) => rule.id, "rules", "rule", localDirectory, overlays);
  const skills = addLocal(authored.skills, localSkills, (skill) => skill.name, "skills", "skill", localDirectory, overlays);
  const agents = addLocal(authored.agents, localAgents, (agent) => agent.id, "agents", "agent", localDirectory, overlays);
  const commands = addLocal(authored.commands, localCommands, (command) => command.id, "commands", "command", localDirectory, overlays);

  const localInstructionsPath = join(localDirectory, "AGENTS.md");
  let localInstructions: string | undefined;
  if (allow.includes("instructions")) localInstructions = await readText(source, localInstructionsPath);
  else if (await holdsEntries(localInstructionsPath)) ignoredLocal.push("local/AGENTS.md");

  const publishedMcp = Object.entries(config.mcp ?? {});
  let localMcp = Object.entries(localConfig.mcp ?? {});
  if (localMcp.length > 0 && !allow.includes("mcp")) {
    ignoredLocal.push("local/local.jsonc mcp");
    localMcp = [];
  }
  const mcp = addLocal(publishedMcp, localMcp, ([name]) => name, "mcp", "MCP server", localPath, overlays)
    .filter(([, server]) => server.enabled !== false)
    .map(([name, server]) => [name, mcpServer(server)] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);

  let localSettings = settingsFor(localConfig.settings, localPath);
  if (Object.keys(localSettings).length > 0 && !allow.includes("settings")) {
    ignoredLocal.push("local/local.jsonc settings");
    localSettings = {};
  }
  // A claimed key is the machine's to edit in the harness file itself; a
  // local setting for it would ask Canonfig to write the key it gave up.
  for (const claim of claims) {
    const declared = (localSettings[claim.harness] ?? []).find((entry) => configPathsOverlap(entry.path, claim.key));
    if (declared !== undefined) {
      throw failure(localPath, `local setting ${claim.harness} ${declared.path} overlaps the key claim settings/${claim.harness}#${claim.key}; remove one of them`);
    }
  }
  const settings = mergeLocalSettings(authored.settings, localSettings, localPath, overlays);

  // What each overlay finds, for `canonfig overlay list` and the plan's warnings.
  const itemsOf = (items: Readonly<Record<OverlayCategory, ReadonlyArray<string>>>) =>
    new Set(OVERLAY_CATEGORIES.flatMap((category) => items[category].map((name) => `${category}/${name}`)));
  const publishedItems = itemsOf({
    rules: authored.rules.map((rule) => rule.id),
    skills: authored.skills.map((skill) => skill.name),
    agents: authored.agents.map((agent) => agent.id),
    commands: authored.commands.map((command) => command.id),
    mcp: publishedMcp.map(([name]) => name),
    settings: Object.keys(authored.settings),
  });
  const localItemNames = itemsOf({
    rules: localRules.map((rule) => rule.id),
    skills: localSkills.map((skill) => skill.name),
    agents: localAgents.map((agent) => agent.id),
    commands: localCommands.map((command) => command.id),
    mcp: localMcp.map(([name]) => name),
    settings: Object.keys(localSettings),
  });
  const overlayStatus = overlayEntries.map((entry): OverlayStatus =>
    entry.kind === "claim"
      ? entry
      : { kind: "item", item: entry.item, local: localItemNames.has(entry.item), published: publishedItems.has(entry.item) }
  );

  const excluded = new Set(localConfig.excludeHarnesses ?? []);
  const excludedResources = new Set(localConfig.excludeResources ?? []);
  const listed = [...new Set(config.harnesses)];
  // A selection for a harness the folder does not list would silently do
  // nothing, which is almost certainly a typo: refuse it.
  for (const harness of Object.keys(config.surfaces ?? {})) {
    if (!listed.some((candidate) => candidate === harness)) {
      throw failure(join(folder, "canonfig.jsonc"), `surfaces names ${harness}, which harnesses does not list`);
    }
  }
  const model: CanonicalModel = {
    folder,
    harnesses: listed.filter((harness) => !excluded.has(harness)),
    instructions: withLocalInstructions(authored.instructions, localInstructions),
    rules,
    skills,
    agents,
    commands,
    hooks: authored.hooks,
    mcp,
    settings,
    surfaces: Object.fromEntries(
      Object.entries(config.surfaces ?? {}).map(([harness, categories]) => [harness, [...new Set(categories)].sort()]),
    ),
    appendLocal: [...new Set(config.local?.appendLocal ?? [])].sort(),
    resources: authored.resources.filter((resource) => !excludedResources.has(resource.id)),
  };
  const local: LocalPolicy = {
    excludeHarnesses: localConfig.excludeHarnesses ?? [],
    excludeResources: [...excludedResources].sort(),
    claims,
    backups: localConfig.backups ?? true,
  };
  return { model, local, digest: modelDigest(model, local), ignoredLocal, overlays: overlayStatus };
};
