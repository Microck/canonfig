import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { parse as parseJsonc, type ParseError, printParseErrorCode } from "jsonc-parser";
import { Schema } from "effect";

import type { ContentDigest } from "../domain/brand.ts";
import { configPathIssue, configPathsOverlap } from "../domain/config-path.ts";
import { ConfigValue } from "../domain/resource.ts";
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
 */

/** The folder or one of its files is not valid authoring input. */
export class CanonicalFolderError extends TaggedError<CanonicalFolderError>()(
  "CanonicalFolderError",
  { path: Schema.String, message: Schema.String },
) {}

/** A `local/` item collides with a published one; the operator must choose. */
export class LocalOverlayCollisionError extends TaggedError<LocalOverlayCollisionError>()(
  "LocalOverlayCollisionError",
  { path: Schema.String, message: Schema.String },
) {}

const identifier = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u, { expected: "letters, digits, '-' or '_'" }),
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

const McpCommon = {
  enabled: Schema.optional(Schema.Boolean),
  timeoutMs: Schema.optional(positiveInteger),
  enabledTools: Schema.optional(ToolList),
  disabledTools: Schema.optional(ToolList),
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

/** Categories `local/` may add to, named by `local.allow`. */
export const LOCAL_CATEGORIES = ["rules", "skills", "agents", "commands", "mcp", "settings"] as const;
type LocalCategory = (typeof LOCAL_CATEGORIES)[number];

const CanonfigJsonc = Schema.Struct({
  version: Schema.Literal(1),
  harnesses: Schema.Array(Schema.Literals(TARGET_IDS)),
  mcp: Schema.optional(McpMap),
  hooks: Schema.optional(Schema.Array(HookInput)),
  settings: Schema.optional(SettingsMap),
  local: Schema.optional(Schema.Struct({
    allow: Schema.Array(Schema.Literals(LOCAL_CATEGORIES)),
  })),
});

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

/** Resolve a path inside the folder and refuse anything that leaves it through a link. */
const insideFolder = async (folder: string, path: string): Promise<void> => {
  const fromRoot = relative(folder, await realpath(path));
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw failure(path, "resolves outside the Canonical Folder");
  }
};

/** An authored regular file, or undefined when absent. Links are refused. */
const readAuthored = async (folder: string, path: string): Promise<Uint8Array | undefined> => {
  let status;
  try {
    status = await lstat(path);
  } catch (error) {
    if (error instanceof Error && isMissing(error)) return undefined;
    throw error;
  }
  if (!status.isFile()) throw failure(path, "is not a regular file; links and special files are not authoring input");
  await insideFolder(folder, path);
  return readFile(path);
};

const readText = async (folder: string, path: string): Promise<string | undefined> => {
  const bytes = await readAuthored(folder, path);
  if (bytes === undefined) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw failure(path, "is not valid UTF-8");
  }
};

/** Read and decode a JSONC file, or undefined when it does not exist. */
const readJsonc = async <S extends Schema.Decoder<unknown>>(
  folder: string,
  path: string,
  schema: S,
): Promise<S["Type"] | undefined> => {
  const text = await readText(folder, path);
  if (text === undefined) return undefined;
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

/** Directory entries, sorted, or none when the directory is absent. Links are refused. */
const listEntries = async (folder: string, directory: string) => {
  let status;
  try {
    status = await lstat(directory);
  } catch (error) {
    if (error instanceof Error && isMissing(error)) return [];
    throw error;
  }
  if (!status.isDirectory()) throw failure(directory, "is not a directory");
  await insideFolder(folder, directory);
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
};

const documentId = (path: string, name: string): string => {
  const id = name.slice(0, -".md".length);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(id)) {
    throw failure(path, "file names must be letters, digits, '-' or '_' followed by .md");
  }
  return id;
};

/** Every `<id>.md` in a document directory, as frontmatter plus body. */
const loadDocuments = async <S extends Schema.Decoder<unknown>>(
  folder: string,
  directory: string,
  schema: S,
) => {
  const documents: Array<{ readonly id: string; readonly path: string; readonly data: S["Type"]; readonly content: string }> = [];
  for (const entry of await listEntries(folder, directory)) {
    const path = join(directory, entry.name);
    if (!entry.name.endsWith(".md")) throw failure(path, "only <id>.md documents belong here");
    const id = documentId(path, entry.name);
    const text = (await readText(folder, path))!;
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

const loadRules = async (folder: string, directory: string): Promise<ReadonlyArray<RuleDocument>> =>
  (await loadDocuments(folder, directory, RuleFrontmatter)).map((document) => ({
    id: document.id,
    description: document.data.description,
    paths: document.data.paths ?? [],
    activation: document.data.activation,
    content: document.content,
    source: document.path,
  }));

const loadAgents = async (folder: string, directory: string): Promise<ReadonlyArray<AgentDocument>> =>
  (await loadDocuments(folder, directory, AgentFrontmatter)).map((document) => ({
    id: document.id,
    description: document.data.description,
    model: document.data.model ?? "inherit",
    tools: document.data.tools ?? [],
    writable: document.data.writable ?? false,
    content: document.content,
  }));

const loadCommands = async (folder: string, directory: string): Promise<ReadonlyArray<CommandDocument>> =>
  (await loadDocuments(folder, directory, CommandFrontmatter)).map((document) => ({
    id: document.id,
    description: document.data.description,
    argumentHint: document.data.argumentHint,
    content: document.content,
  }));

/** Regular files beneath a skill directory, relative with forward slashes. */
const loadSkillFiles = async (folder: string, directory: string, prefix = ""): Promise<Array<SkillFile>> => {
  const files: Array<SkillFile> = [];
  for (const entry of await listEntries(folder, directory)) {
    const path = join(directory, entry.name);
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await loadSkillFiles(folder, path, `${relativePath}/`));
      continue;
    }
    const content = await readAuthored(folder, path);
    if (content === undefined) continue;
    const status = await lstat(path);
    files.push({ path: relativePath, content, executable: (status.mode & 0o100) !== 0 });
  }
  return files;
};

const loadSkills = async (folder: string, directory: string): Promise<ReadonlyArray<SkillTree>> => {
  const skills: Array<SkillTree> = [];
  for (const entry of await listEntries(folder, directory)) {
    const path = join(directory, entry.name);
    if (!entry.isDirectory()) throw failure(path, "every entry of skills/ is a skill directory");
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(entry.name)) {
      throw failure(path, "skill directory names are lowercase letters, digits and '-'");
    }
    const manifest = await readText(folder, join(path, "SKILL.md"));
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
      files: await loadSkillFiles(folder, path),
    });
  }
  return skills;
};

const mcpServer = (input: Schema.Schema.Type<typeof McpServerInput>): McpServer =>
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
 * A relative `run[0]` names a script in the folder's `hooks/` directory and
 * becomes absolute, so harnesses can run it from any working directory. A bare
 * command name is looked up on PATH when the hook runs.
 */
const resolveHookCommand = async (folder: string, command: string, path: string): Promise<string> => {
  if (isAbsolute(command) || !/[\\/]/u.test(command)) return command;
  const normalized = command.replaceAll("\\", "/");
  if (!normalized.startsWith("hooks/") || normalized.split("/").includes("..")) {
    throw failure(path, `hook command ${command} must be a command name, an absolute path, or a script under hooks/`);
  }
  const script = join(folder, ...normalized.split("/"));
  if (await readAuthored(folder, script) === undefined) throw failure(path, `hook script ${command} does not exist`);
  return script;
};

const loadHooks = async (
  folder: string,
  inputs: ReadonlyArray<Schema.Schema.Type<typeof HookInput>>,
  path: string,
): Promise<ReadonlyArray<Hook>> => {
  const seen = new Set<string>();
  const hooks: Array<Hook> = [];
  for (const input of inputs) {
    if (seen.has(input.id)) throw failure(path, `hook id ${input.id} is declared twice`);
    seen.add(input.id);
    if (input.enabled === false) continue;
    const [command, ...rest] = input.run;
    hooks.push({
      id: input.id,
      event: input.event,
      matcher: {
        capabilities: input.matcher?.capabilities ?? [],
        tools: input.matcher?.tools ?? [],
        inputRegex: input.matcher?.inputRegex,
      },
      run: [await resolveHookCommand(folder, command!, path), ...rest],
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
      throw new LocalOverlayCollisionError({
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
        throw new LocalOverlayCollisionError({
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

/** Load `~/.canonfig/` and its `local/` overlay into the Canonical Model. */
export const loadCanonicalFolder = async (folder: string): Promise<LoadedFolder> => {
  const configPath = join(folder, "canonfig.jsonc");
  const config = await readJsonc(folder, configPath, CanonfigJsonc);
  if (config === undefined) {
    throw failure(configPath, "does not exist; create it with at least {\"version\": 1, \"harnesses\": []}");
  }
  const localPath = join(folder, "local", "local.jsonc");
  const localConfig = (await readJsonc(folder, localPath, LocalJsonc)) ?? {};
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
    await loadRules(folder, join(folder, "rules")),
    await localItems("rules", (directory) => loadRules(folder, directory)),
    (rule) => rule.id, "rule", localDirectory,
  );
  const skills = addLocal(
    await loadSkills(folder, join(folder, "skills")),
    await localItems("skills", (directory) => loadSkills(folder, directory)),
    (skill) => skill.name, "skill", localDirectory,
  );
  const agents = addLocal(
    await loadAgents(folder, join(folder, "agents")),
    await localItems("agents", (directory) => loadAgents(folder, directory)),
    (agent) => agent.id, "agent", localDirectory,
  );
  const commands = addLocal(
    await loadCommands(folder, join(folder, "commands")),
    await localItems("commands", (directory) => loadCommands(folder, directory)),
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
  const settings = mergeLocalSettings(settingsFor(config.settings, configPath), localSettings, localPath);

  const excluded = new Set(localConfig.excludeHarnesses ?? []);
  const listed = [...new Set(config.harnesses)];
  const model: CanonicalModel = {
    folder,
    harnesses: listed.filter((harness) => !excluded.has(harness)),
    instructions: await readText(folder, join(folder, "AGENTS.md")),
    rules,
    skills,
    agents,
    commands,
    hooks: await loadHooks(folder, config.hooks ?? [], configPath),
    mcp,
    settings,
  };
  const local: LocalPolicy = {
    excludeHarnesses: localConfig.excludeHarnesses ?? [],
    backups: localConfig.backups ?? true,
  };
  return { model, local, digest: modelDigest(model, local), ignoredLocal };
};
