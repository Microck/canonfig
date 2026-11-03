import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

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
  CAPABILITIES,
  HOOK_EVENTS,
  TARGET_IDS,
  type AgentDocument,
  type CanonicalModel,
  type CommandDocument,
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
 * `rules/`, `skills/`, `agents/`, `commands/` and `hooks/`, plus `local/`.
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
  "rules", "skills", "agents", "commands", "hooks", "mcp", "settings", "tools", "credentials",
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
export const LOCAL_CATEGORIES = ["rules", "skills", "agents", "commands", "mcp", "settings"] as const;
type LocalCategory = (typeof LOCAL_CATEGORIES)[number];

const LocalAllow = Schema.Struct({ allow: Schema.Array(Schema.Literals(LOCAL_CATEGORIES)) });

const CanonfigJsonc = Schema.Struct({
  version: Schema.Literal(1),
  /** The Machine Profile this folder publishes; required to publish, unused by projection. */
  profile: Schema.optional(Schema.Struct({ id: ProfileId, name: Schema.NonEmptyString })),
  harnesses: Schema.Array(Schema.Literals(TARGET_IDS)),
  mcp: Schema.optional(McpMap),
  hooks: Schema.optional(Schema.Array(HookInput)),
  settings: Schema.optional(SettingsMap),
  tools: Schema.optional(Schema.Record(identifier, ToolInput)),
  credentials: Schema.optional(Schema.Record(identifier, Schema.Struct({ reference: Schema.NonEmptyString }))),
  groups: Schema.optional(Schema.Record(identifier, Schema.Array(itemReference))),
  scheduleDefault: Schema.optional(ScheduleInput),
  local: Schema.optional(LocalAllow),
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

/** Machine-local policy from `local/local.jsonc`. */
export interface LocalPolicy {
  /** Harnesses this machine never projects, even when listed. */
  readonly excludeHarnesses: ReadonlyArray<TargetId>;
  /** False turns takeover snapshots off on this machine. */
  readonly backups: boolean;
}

export interface LoadedFolder {
  readonly model: CanonicalModel;
  readonly local: LocalPolicy;
  /** Digest of the model, the identity a local run records as its origin. */
  readonly digest: ContentDigest;
  /** Local items `local.allow` does not admit; reported, never projected. */
  readonly ignoredLocal: ReadonlyArray<string>;
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
 * content from elsewhere.
 */
const diskSource = (folder: string): FolderSource => {
  const insideFolder = async (path: string): Promise<void> => {
    const fromRoot = relative(folder, await realpath(path));
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
    tools: document.data.tools ?? [],
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

const settingsFor = (
  input: Readonly<Record<string, Readonly<Record<string, ConfigValue>>>> | undefined,
  path: string,
): HarnessSettings => {
  const settings: Partial<Record<TargetId, ReadonlyArray<SettingsKey>>> = {};
  for (const [harness, keys] of Object.entries(input ?? {})) {
    const target = TARGET_IDS.find((candidate) => candidate === harness);
    if (target === undefined) throw failure(path, `settings names unknown harness ${harness}`);
    const entries = Object.entries(keys).map(([key, value]) => {
      const issue = configPathIssue(key);
      if (issue !== undefined) throw failure(path, `settings.${harness} key ${key}: ${issue}`);
      return { path: key, value };
    });
    for (const [index, entry] of entries.entries()) {
      const overlap = entries.slice(index + 1).find((other) => configPathsOverlap(entry.path, other.path));
      if (overlap !== undefined) {
        throw failure(path, `settings.${harness} keys ${entry.path} and ${overlap.path} overlap`);
      }
    }
    settings[target] = entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  }
  return settings;
};

/** Adds local items by name; a name already published is Human Action Required. */
const addLocal = <Item>(
  published: ReadonlyArray<Item>,
  local: ReadonlyArray<Item>,
  name: (item: Item) => string,
  label: string,
  path: string,
): ReadonlyArray<Item> => {
  const names = new Set(published.map(name));
  for (const item of local) {
    if (names.has(name(item))) {
      throw new LocalItemCollisionError({
        path,
        message: `local ${label} ${name(item)} has the same name as a published one; rename or remove one of them`,
      });
    }
  }
  return [...published, ...local];
};

const mergeLocalSettings = (
  published: HarnessSettings,
  local: HarnessSettings,
  path: string,
): HarnessSettings => {
  for (const harness of TARGET_IDS) {
    for (const entry of local[harness] ?? []) {
      const collision = (published[harness] ?? []).find((other) => configPathsOverlap(entry.path, other.path));
      if (collision !== undefined) {
        throw new LocalItemCollisionError({
          path,
          message: `local setting ${harness} ${entry.path} overlaps published setting ${collision.path}; remove one of them`,
        });
      }
    }
  }
  return Object.fromEntries(TARGET_IDS.flatMap((harness) => {
    const entries = [...published[harness] ?? [], ...local[harness] ?? []]
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    return entries.length === 0 ? [] : [[harness, entries] as const];
  }));
};

/** A stable digest of everything the model holds, file content included by digest. */
const modelDigest = (model: CanonicalModel, local: LocalPolicy): ContentDigest => {
  const skills = model.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    files: skill.files.map((file) => ({
      path: file.path,
      executable: file.executable,
      digest: sha256BytesHex(file.content),
    })),
  }));
  const value = JSON.parse(JSON.stringify({ ...model, skills, local }));
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

/** Every regular file under one of the folder's directories, relative to it, `/`-separated, unread. */
export const listFolderFiles = (folder: string, directory: string): Promise<ReadonlyArray<ListedFile>> =>
  listFiles(diskSource(folder), join(folder, directory));

/** The authoring allowlist: the only top-level entries of `~/.canonfig/` that are published or mirrored. */
const AUTHORING_ENTRIES = ["canonfig.jsonc", "AGENTS.md", "rules", "skills", "agents", "commands", "hooks"] as const;

/**
 * The authoring entries a folder holds, in allowlist order: any file, and any
 * directory with something in it. An empty directory holds no item, so the
 * mirror can fill it. `follower enroll` refuses a folder with entries,
 * because on a follower those places hold the Source's mirror.
 */
export const authoredEntries = async (folder: string): Promise<ReadonlyArray<string>> => {
  const present: Array<string> = [];
  for (const name of AUTHORING_ENTRIES) {
    const path = join(folder, name);
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || (await readdir(path)).length > 0) present.push(name);
    } catch (error) {
      if (!(error instanceof Error && isMissing(error))) throw error;
    }
  }
  return present;
};

/** The resource id of a folder item reference: `mcp/docs` is `mcp:docs`. */
export const itemResourceId = (reference: string): string => reference.replace("/", ":");

/**
 * The authored items of a folder, without `local/`. Projection loads skill
 * files with their bytes; publication lists them and streams the bytes itself.
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
}

const loadAuthored = async <File>(
  source: FolderSource,
  skillFiles: (source: FolderSource, directory: string) => Promise<ReadonlyArray<File>>,
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
    skills: await loadSkills(source, join(folder, "skills"), skillFiles),
    agents: await loadAgents(source, join(folder, "agents")),
    commands: await loadCommands(source, join(folder, "commands")),
    hooks: await loadHooks(source, config.hooks ?? [], configPath),
    settings: settingsFor(config.settings, configPath),
  };
};

/** Load and check the folder's authored items, ignoring `local/`, with skill files listed but unread. */
export const loadAuthoredFolder = (folder: string): Promise<AuthoredFolder<ListedFile>> =>
  loadAuthored(diskSource(folder), listFiles);

/**
 * Load `~/.canonfig/` and its `local/` items into the Canonical Model. With
 * `mirror`, the authored entries are those files instead of the disk's.
 */
export const loadCanonicalFolder = async (
  folder: string,
  mirror?: ReadonlyMap<string, FolderFile>,
): Promise<LoadedFolder> => {
  const source = mirror === undefined ? diskSource(folder) : mirrorSource(folder, mirror);
  const authored = await loadAuthored(source, loadFiles);
  const config = authored.config;
  const localPath = join(folder, "local", "local.jsonc");
  const localConfig = (await readJsonc(source, localPath, LocalJsonc)) ?? {};
  const allow = config.local?.allow ?? [];
  const ignoredLocal: Array<string> = [];
  const localDirectory = join(folder, "local");

  const localItems = async <Item>(category: LocalCategory, load: (directory: string) => Promise<ReadonlyArray<Item>>) => {
    const items = await load(join(localDirectory, category));
    if (items.length > 0 && !allow.includes(category)) {
      ignoredLocal.push(`local/${category}/`);
      return [];
    }
    return items;
  };

  const rules = addLocal(
    authored.rules,
    await localItems("rules", (directory) => loadRules(source, directory)),
    (rule) => rule.id, "rule", localDirectory,
  );
  const skills = addLocal(
    authored.skills,
    await localItems("skills", (directory) => loadSkills(source, directory, loadFiles)),
    (skill) => skill.name, "skill", localDirectory,
  );
  const agents = addLocal(
    authored.agents,
    await localItems("agents", (directory) => loadAgents(source, directory)),
    (agent) => agent.id, "agent", localDirectory,
  );
  const commands = addLocal(
    authored.commands,
    await localItems("commands", (directory) => loadCommands(source, directory)),
    (command) => command.id, "command", localDirectory,
  );

  const publishedMcp = Object.entries(config.mcp ?? {});
  let localMcp = Object.entries(localConfig.mcp ?? {});
  if (localMcp.length > 0 && !allow.includes("mcp")) {
    ignoredLocal.push("local/local.jsonc mcp");
    localMcp = [];
  }
  const mcp = addLocal(publishedMcp, localMcp, ([name]) => name, "MCP server", localPath)
    .filter(([, server]) => server.enabled !== false)
    .map(([name, server]) => [name, mcpServer(server)] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);

  let localSettings = settingsFor(localConfig.settings, localPath);
  if (Object.keys(localSettings).length > 0 && !allow.includes("settings")) {
    ignoredLocal.push("local/local.jsonc settings");
    localSettings = {};
  }
  const settings = mergeLocalSettings(authored.settings, localSettings, localPath);

  const excluded = new Set(localConfig.excludeHarnesses ?? []);
  const listed = [...new Set(config.harnesses)];
  const model: CanonicalModel = {
    folder,
    harnesses: listed.filter((harness) => !excluded.has(harness)),
    instructions: authored.instructions,
    rules,
    skills,
    agents,
    commands,
    hooks: authored.hooks,
    mcp,
    settings,
  };
  const local: LocalPolicy = {
    excludeHarnesses: localConfig.excludeHarnesses ?? [],
    backups: localConfig.backups ?? true,
  };
  return { model, local, digest: modelDigest(model, local), ignoredLocal };
};
