import { lstat, readdir, readFile } from "node:fs/promises";
import { join as joinNative, sep as nativeSeparator } from "node:path";

import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { Predicate, Schema } from "effect";

import { ConfigValue } from "../domain/resource.ts";
import { TaggedError } from "../domain/tagged-error.ts";
import { asJson, digestOf, sha256BytesHex, sha256Hex } from "../profile/profile-codec.ts";
import { containsLiteralCredential, isEnvironmentReference, isSecretField } from "../secrets/credential-policy.ts";
import { getConfigPath, parseConfigDocument } from "../synchronization/config-codec.ts";
import { type ConfigJson, type ConfigObject, isConfigObject } from "../synchronization/config-value.ts";
import { adapterFor } from "./adapters/index.ts";
import { emptyModel } from "./detect.ts";
import { type MarkdownDocument, markdownWithFrontmatter, parseMarkdownDocument } from "./frontmatter.ts";
import { maxImportContentBytes, SkillReader, type ImportReadLimit } from "./import-skills.ts";
import type { HarnessLayout, OwnedSurface, RootContext, SkillReadSource } from "./harness.ts";
import { TARGET_IDS, type TargetId } from "./model.ts";

/**
 * Source setup's one-time import: reads what the selected harnesses already
 * hold (instructions, rules, skills, agents, commands, MCP servers) and turns
 * it into Canonical Folder items. Native skill readers are explicit adapter
 * metadata, independent of write/takeover ownership.
 *
 * Read-only on the harness. Documents and configs refuse links; only skill
 * readers follow bounded, home-confined links and reject protected aliases.
 * MCP credential literals become `fromEnv` references before digesting.
 */

export type ImportCategory = "instructions" | "rules" | "skills" | "agents" | "commands" | "mcp";
/** `agents` is the shared ~/.agents/skills/ reader, independent of mutation ownership. */
export type ImportSource = TargetId | "agents";

export interface ImportCandidate {
  /** Opaque selection key beginning `${source}/`; distinct same-source copies have a path hash suffix. */
  readonly id: string;
  readonly source: ImportSource;
  /** Selected native readers of this item; shared roots are scanned once. */
  readonly harnesses: ReadonlyArray<TargetId>;
  readonly category: ImportCategory;
  /** AGENTS.md, a rule/agent/command id, a skill directory name or an MCP server name. */
  readonly name: string;
  /** Absolute source file, directory, or config file. */
  readonly path: string;
  /** Folder-relative destination, `canonfig.jsonc#mcp.<name>` for MCP servers. */
  readonly target: string;
  /** sha256 of canonical JSON {category, name, content}; never computed over a raw secret. */
  readonly digest: string;
  /** Literals replaced by environment references. */
  readonly secrets: ReadonlyArray<{ readonly field: string; readonly fromEnv: string }>;
  /** Dropped or converted fields, never containing a literal value. */
  readonly notes: ReadonlyArray<string>;
}

export interface ImportSkip {
  readonly source: ImportSource;
  readonly path: string;
  readonly reason: string;
}

export interface ImportScan {
  readonly candidates: ReadonlyArray<ImportCandidate>;
  readonly skipped: ReadonlyArray<ImportSkip>;
}

export type ImportContent =
  | { readonly kind: "text"; readonly content: string }
  | {
    readonly kind: "tree";
    readonly files: ReadonlyArray<{ readonly path: string; readonly content: Uint8Array; readonly executable: boolean }>;
  }
  /** The canonfig.jsonc `mcp.<name>` value, secrets already `fromEnv`. */
  | { readonly kind: "mcp"; readonly server: ConfigValue };

/** Materialized payload bytes, shared by per-item reads and whole-batch admission. */
export const importContentBytes = (content: ImportContent): number => {
  switch (content.kind) {
    case "text": return Buffer.byteLength(content.content, "utf8");
    case "tree": return content.files.reduce((bytes, file) => bytes + file.content.byteLength, 0);
    case "mcp": return Buffer.byteLength(JSON.stringify(content.server), "utf8");
  }
};

/** The source of a candidate changed or disappeared between the scan and the import. */
export class ImportChangedError extends TaggedError<ImportChangedError>()(
  "ImportChangedError",
  { path: Schema.String, message: Schema.String },
) {}

/** The requested import payload exceeds the remaining content budget, not a source change. */
export class ImportSizeLimitError extends TaggedError<ImportSizeLimitError>()(
  "ImportSizeLimitError",
  { path: Schema.String, maximumBytes: Schema.Number, message: Schema.String },
) {}

export type ImportSelection =
  | { readonly kind: "none" }
  | { readonly kind: "all" }
  | { readonly kind: "some"; readonly sources: ReadonlyArray<ImportSource>; readonly items: ReadonlyArray<string> };

export interface ImportCollision {
  readonly target: string;
  readonly candidates: ReadonlyArray<string>;
  /** True when the folder already holds different content at `target`. */
  readonly folder: boolean;
}

export interface ImportChoice {
  readonly chosen: ReadonlyArray<ImportCandidate>;
  /** Candidate ids identical to what the folder already holds. */
  readonly present: ReadonlyArray<string>;
  readonly collisions: ReadonlyArray<ImportCollision>;
  /** Requested item ids or sources that matched nothing. */
  readonly unknown: ReadonlyArray<string>;
}

const MIB = 1024 * 1024;
const MAX_FILE_BYTES = MIB;
// `~/.claude.json` keeps project history next to `mcpServers` and often
// passes 1 MiB; a config file is parsed whole anyway, so it gets a wider bound.
const MAX_CONFIG_BYTES = 16 * MIB;
const MAX_SKILL_FILES = 512;

const DOCUMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const WHOLE_REFERENCE = /^(?:\$\{(?:env:)?([A-Za-z_]\w*)\}|\{env:([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*))$/u;
const CREDENTIAL_HEADER = /^(?:authorization|cookie|proxy-authorization)$|token|key|secret/iu;
const ACTIVATIONS: ReadonlyArray<string> = ["always", "path", "manual", "model"];
/** Folder-side digest for an item that exists but cannot be read: it never equals a candidate. */
const UNREADABLE = "unreadable";

type Secret = ImportCandidate["secrets"][number];
type DocumentCategory = Exclude<ImportCategory, "skills" | "mcp">;
type Skip = { readonly kind: "skip"; readonly reason: string };
type Missing = { readonly kind: "missing" };

interface Ready {
  readonly kind: "ready";
  readonly name: string;
  readonly digest: string;
  readonly content: ImportContent;
  readonly secrets: ReadonlyArray<Secret>;
  readonly notes: ReadonlyArray<string>;
}

type Outcome = Ready | Skip | Missing | ImportReadLimit;

type Inspected =
  | Skip
  | Missing
  | { readonly kind: "file"; readonly size: number; readonly executable: boolean }
  | { readonly kind: "directory" };

/** How paths are joined and which of them may be read. */
interface ReadScope {
  readonly join: (...segments: ReadonlyArray<string>) => string;
  readonly separator: string;
  /** Ancestors strictly below this directory are checked for links; outside it none are. */
  readonly base: string;
  readonly neverTouch: ReadonlyArray<string>;
  /** The Canonical Folder, never scanned as a source. */
  readonly folder: string | undefined;
}

interface HarnessReadScope extends ReadScope {
  readonly folder: string;
  readonly configPaths: ReadonlyArray<string>;
  readonly layouts: ReadonlyArray<readonly [TargetId, HarnessLayout]>;
}

const MISSING: Missing = { kind: "missing" };
const skip = (reason: string): Skip => ({ kind: "skip", reason });

const within = (scope: ReadScope, path: string, parent: string): boolean =>
  path === parent || path.startsWith(parent.endsWith(scope.separator) ? parent : `${parent}${scope.separator}`);

const lastSegment = (scope: ReadScope, path: string): string => path.slice(path.lastIndexOf(scope.separator) + 1);

const readFailure = (error: Error): Skip | Missing => {
  const code = "code" in error && Predicate.isString(error.code) ? error.code : "unknown error";
  return code === "ENOENT" || code === "ENOTDIR" ? MISSING : skip(`cannot be read (${code})`);
};

/** lstat a path, after refusing never-touch and folder paths without touching them. */
const inspect = async (scope: ReadScope, path: string): Promise<Inspected> => {
  if (scope.neverTouch.some((protectedPath) => within(scope, path, protectedPath))) return skip("never-touch path");
  if (scope.folder !== undefined && within(scope, path, scope.folder)) return skip("inside the Canonical Folder");
  let status;
  try {
    status = await lstat(path);
  } catch (error) {
    return error instanceof Error ? readFailure(error) : skip("cannot be read");
  }
  if (status.isSymbolicLink()) return skip("is a link; links are not followed");
  if (status.isDirectory()) return { kind: "directory" };
  if (status.isFile()) return { kind: "file", size: status.size, executable: (status.mode & 0o100) !== 0 };
  return skip("is not a regular file or directory");
};

/**
 * Like `inspect`, but also refuses a path reached through a linked ancestor
 * (`~/.claude` linked to a dotfiles checkout), walking down from the base.
 */
const inspectRoot = async (scope: ReadScope, path: string): Promise<Inspected> => {
  if (within(scope, path, scope.base) && path !== scope.base) {
    const segments = path.slice(scope.base.length).split(scope.separator).filter((segment) => segment !== "");
    let current = scope.base;
    for (const segment of segments.slice(0, -1)) {
      current = scope.join(current, segment);
      const ancestor = await inspect(scope, current);
      if (ancestor.kind === "skip") return skip(`goes through ${current}, which ${ancestor.reason}`);
      if (ancestor.kind !== "directory") return MISSING;
    }
  }
  return inspect(scope, path);
};

const readBytes = async (path: string): Promise<Uint8Array | Skip | Missing> => {
  try {
    return await readFile(path);
  } catch (error) {
    return error instanceof Error ? readFailure(error) : skip("cannot be read");
  }
};

type TextRead = { readonly kind: "text"; readonly text: string } | Skip | Missing;

const readTextFile = async (scope: ReadScope, path: string, limit: number): Promise<TextRead> => {
  const status = await inspectRoot(scope, path);
  if (status.kind === "skip" || status.kind === "missing") return status;
  if (status.kind === "directory") return skip("is a directory, not a file");
  if (status.size > limit) return skip(`is larger than ${limit / MIB} MiB`);
  const bytes = await readBytes(path);
  if (!(bytes instanceof Uint8Array)) return bytes;
  try {
    return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return skip("is not valid UTF-8");
  }
};

type Listing = { readonly kind: "entries"; readonly names: ReadonlyArray<string> } | Skip | Missing;

/** Sorted entry names of a directory; the entries themselves are inspected by the caller. */
const listDirectory = async (scope: ReadScope, path: string): Promise<Listing> => {
  const status = await inspectRoot(scope, path);
  if (status.kind === "skip" || status.kind === "missing") return status;
  if (status.kind === "file") return skip("is not a directory");
  try {
    return { kind: "entries", names: (await readdir(path)).sort() };
  } catch (error) {
    return error instanceof Error ? readFailure(error) : skip("cannot be read");
  }
};

/**
 * The one digest scheme for candidates and folder items alike, so an item
 * imported earlier reads back as present. Skills digest per file.
 */
const contentDigest = (category: ImportCategory, name: string, content: ImportContent): string => {
  const digested = content.kind === "text"
    ? content.content
    : content.kind === "tree"
    ? content.files.map((file) => ({ path: file.path, executable: file.executable, digest: sha256BytesHex(file.content) }))
    : content.server;
  return digestOf(asJson({ category, name, content: digested }));
};

const ready = (
  category: ImportCategory,
  name: string,
  content: ImportContent,
  notes: ReadonlyArray<string>,
  secrets: ReadonlyArray<Secret>,
): Ready => ({ kind: "ready", name, digest: contentDigest(category, name, content), content, notes, secrets });

// Documents ---------------------------------------------------------------

/** The document id a file name carries, with the suffixes Copilot writes stripped too. */
const documentName = (category: DocumentCategory, file: string): string | Skip => {
  const suffixes = category === "rules" ? [".instructions.md", ".md"] : category === "agents" ? [".agent.md", ".md"] : [".md"];
  const suffix = suffixes.find((candidate) => file.endsWith(candidate));
  if (suffix === undefined) {
    const dot = file.lastIndexOf(".");
    return category === "agents" && dot > 0
      ? skip(`${file.slice(dot)} agents are not imported`)
      : skip(`only .md ${category} are imported`);
  }
  const id = file.slice(0, -suffix.length);
  return DOCUMENT_ID.test(id) ? id : skip("names must be letters, digits, '-' or '_'");
};

type Converted = { readonly kind: "converted"; readonly text: string; readonly notes: ReadonlyArray<string> } | Skip;

const nonEmptyText = (value: ConfigValue): string | undefined =>
  Predicate.isString(value) && value.trim() !== "" ? value.trim() : undefined;

/** A path list from a YAML list or a comma-separated string (`globs`, `applyTo`). */
const patternList = (value: ConfigValue): ReadonlyArray<string> | undefined => {
  const items = Predicate.isString(value) ? value.split(",") : Array.isArray(value) ? value : undefined;
  if (items === undefined || !items.every(Predicate.isString)) return undefined;
  return items.map((item) => item.trim()).filter((item) => item !== "");
};

const dropped = (key: string): string => `Canonfig does not copy the metadata field ${key}`;

const convertRule = (document: MarkdownDocument): Converted => {
  const notes: Array<string> = [];
  let description: string | undefined;
  const paths = new Set<string>();
  let activation: string | undefined;
  for (const [key, value] of Object.entries(document.data)) {
    const patterns = key === "paths" || key === "globs" || key === "applyTo" ? patternList(value) : undefined;
    if (key === "description" && nonEmptyText(value) !== undefined) description = nonEmptyText(value);
    else if (patterns !== undefined) for (const pattern of patterns) paths.add(pattern);
    else if (key === "activation" && Predicate.isString(value) && ACTIVATIONS.includes(value)) activation = value;
    else notes.push(dropped(key));
  }
  const kept: Array<[string, ConfigValue]> = [];
  if (description !== undefined) kept.push(["description", description]);
  if (paths.size > 0) kept.push(["paths", [...paths]]);
  if (activation !== undefined) kept.push(["activation", activation]);
  const text = kept.length > 0 ? markdownWithFrontmatter(Object.fromEntries(kept), document.content) : `${document.content}\n`;
  return { kind: "converted", text, notes };
};

const convertAgent = (document: MarkdownDocument): Converted => {
  const description = document.data.description === undefined ? undefined : nonEmptyText(document.data.description);
  if (description === undefined) return skip("has no description");
  const kept: Array<[string, ConfigValue]> = [["description", description]];
  const notes: Array<string> = [];
  for (const [key, value] of Object.entries(document.data)) {
    if (key === "description") continue;
    if (key === "model" && Predicate.isString(value) && value.trim() === "inherit") continue;
    if (key === "model" && nonEmptyText(value) !== undefined) kept.push(["model", nonEmptyText(value)!]);
    else if (key === "tools") notes.push(`${dropped(key)} because this tool names permissions differently. Review the imported agent's permissions before use.`);
    else notes.push(dropped(key));
  }
  return { kind: "converted", text: markdownWithFrontmatter(Object.fromEntries(kept), document.content), notes };
};

const convertCommand = (document: MarkdownDocument): Converted => {
  const notes: Array<string> = [];
  let description: string | undefined;
  let argumentHint: string | undefined;
  for (const [key, value] of Object.entries(document.data)) {
    if (key === "description" && nonEmptyText(value) !== undefined) description = nonEmptyText(value);
    else if ((key === "argumentHint" || key === "argument-hint") && nonEmptyText(value) !== undefined) {
      argumentHint = nonEmptyText(value);
    } else notes.push(dropped(key));
  }
  if (description === undefined) {
    // Claude commands often have no frontmatter; Canonfig requires a description.
    const firstLine = document.content.split("\n").map((line) => line.trim()).find((line) => line !== "")!;
    description = firstLine.slice(0, 120);
    notes.push("description taken from the first body line");
  }
  const kept: Array<[string, ConfigValue]> = [["description", description]];
  if (argumentHint !== undefined) kept.push(["argumentHint", argumentHint]);
  return { kind: "converted", text: markdownWithFrontmatter(Object.fromEntries(kept), document.content), notes };
};

const CONVERTERS = { rules: convertRule, agents: convertAgent, commands: convertCommand } as const;

/** One instructions, rule, agent or command file, converted to its folder form. */
const readDocument = async (scope: ReadScope, category: DocumentCategory, path: string): Promise<Outcome> => {
  const name = category === "instructions" ? "AGENTS.md" : documentName(category, lastSegment(scope, path));
  if (!Predicate.isString(name)) return name;
  const read = await readTextFile(scope, path, MAX_FILE_BYTES);
  if (read.kind !== "text") return read;
  if (category === "instructions") {
    return read.text.trim() === "" ? MISSING : ready(category, name, { kind: "text", content: read.text }, [], []);
  }
  let document;
  try {
    document = parseMarkdownDocument(read.text);
  } catch {
    return skip("has invalid frontmatter");
  }
  if (document.content === "") return skip("has no body");
  const converted = CONVERTERS[category](document);
  if (converted.kind === "skip") return converted;
  return ready(category, name, { kind: "text", content: converted.text }, converted.notes, []);
};

// Skills ------------------------------------------------------------------

type TreeFile = Extract<ImportContent, { readonly kind: "tree" }>["files"][number];

/** Collect a skill's regular files; any link, special or oversized file refuses the whole skill. */
const collectTree = async (
  scope: ReadScope,
  directory: string,
  prefix: string,
  files: Array<TreeFile>,
): Promise<string | undefined> => {
  let names;
  try {
    names = (await readdir(directory)).sort();
  } catch {
    return `${prefix || "."} cannot be listed`;
  }
  for (const name of names) {
    const path = scope.join(directory, name);
    const relativePath = `${prefix}${name}`;
    const status = await inspect(scope, path);
    if (status.kind === "missing") continue;
    if (status.kind === "skip") return `${relativePath} ${status.reason}`;
    if (status.kind === "directory") {
      const problem = await collectTree(scope, path, `${relativePath}/`, files);
      if (problem !== undefined) return problem;
      continue;
    }
    if (status.size > MAX_FILE_BYTES) return `${relativePath} is larger than 1 MiB`;
    if (files.length >= MAX_SKILL_FILES) return `has more than ${MAX_SKILL_FILES} files`;
    const bytes = await readBytes(path);
    if (!(bytes instanceof Uint8Array)) return `${relativePath} cannot be read`;
    files.push({ path: relativePath, content: bytes, executable: status.executable });
  }
  return undefined;
};

const SkillFrontmatter = Schema.Struct({ name: Schema.String, description: Schema.NonEmptyString });

const manifestProblem = (manifest: TreeFile, name: string): string | undefined => {
  let frontmatter;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(manifest.content);
    frontmatter = Schema.decodeUnknownSync(SkillFrontmatter)(parseMarkdownDocument(text).data);
  } catch {
    return "SKILL.md needs frontmatter with a name and a description";
  }
  return frontmatter.name === name ? undefined : `SKILL.md names the skill ${frontmatter.name}, but its directory is ${name}`;
};

const readSkill = async (
  scope: ReadScope,
  path: string,
  reader?: SkillReader,
  maximumBytes = maxImportContentBytes,
): Promise<Outcome> => {
  const name = lastSegment(scope, path);
  if (!SKILL_NAME.test(name)) return skip("skill directory names are lowercase letters, digits and '-'");
  let files: ReadonlyArray<TreeFile>;
  if (reader !== undefined) {
    const tree = await reader.tree(path, maximumBytes);
    if (tree.kind !== "tree") return tree;
    files = tree.files;
  } else {
    // Canonical Folder comparison retains its strict no-link policy.
    const status = await inspectRoot(scope, path);
    if (status.kind === "skip" || status.kind === "missing") return status;
    if (status.kind === "file") return skip("is not a skill directory");
    const collected: Array<TreeFile> = [];
    const problem = await collectTree(scope, path, "", collected);
    if (problem !== undefined) return skip(problem);
    files = collected;
  }
  const manifest = files.find((file) => file.path === "SKILL.md");
  if (manifest === undefined) return skip("Missing SKILL.md. Add a SKILL.md file with a name and description to import this skill.");
  const invalid = manifestProblem(manifest, name);
  if (invalid !== undefined) return skip(invalid);
  return ready("skills", name, { kind: "tree", files }, [], []);
};

/** Native flat skills become a single-file portable skill, without copying neighboring files. */
const readFlatSkill = async (
  scope: ReadScope,
  reader: SkillReader,
  path: string,
): Promise<Outcome> => {
  // Raw-source safety is independent of the remaining converted-payload budget.
  const read = await reader.bytes(path);
  if (read.kind !== "bytes") return read;
  let document;
  try {
    document = parseMarkdownDocument(new TextDecoder("utf-8", { fatal: true }).decode(read.content));
  } catch {
    return skip("flat skill is not UTF-8 Markdown with valid frontmatter");
  }
  const name = document.data.name ?? lastSegment(scope, path).slice(0, -3);
  if (!Predicate.isString(name) || !SKILL_NAME.test(name)) return skip("skill names are lowercase letters, digits and '-'");
  const description = document.data.description ?? document.content.split("\n").find((line) => line.trim() !== "")?.slice(0, 240);
  if (!Predicate.isString(description) || description.trim() === "") return skip("flat skill has no description or body");
  const content = new TextEncoder().encode(markdownWithFrontmatter({ ...document.data, name, description }, document.content));
  if (content.byteLength > MAX_FILE_BYTES) return skip("converted SKILL.md is larger than 1 MiB; shorten the skill text or description and scan again");
  return ready("skills", name, {
    kind: "tree", files: [{ path: "SKILL.md", content, executable: read.executable }],
  }, ["Converted a native flat skill to skills/<name>/SKILL.md; neighboring files are not copied."], []);
};

// MCP ---------------------------------------------------------------------

/** UPPER_SNAKE environment name for a credential whose own key is not one. */
const environmentName = (text: string): string => {
  const snake = text.replace(/[^A-Za-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").toUpperCase();
  return /^[A-Z_]/u.test(snake) ? snake : `MCP_${snake}`;
};

const stringList = (value: ConfigJson | undefined): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every(Predicate.isString) ? value : undefined;

/**
 * Decodes one native MCP entry into the canonfig.jsonc input form. Keys it
 * reads are consumed; every other key is dropped and noted by name only.
 */
class ServerDecoder {
  readonly notes: Array<string> = [];
  readonly secrets: Array<Secret> = [];
  private readonly consumed = new Set<string>();
  private readonly name: string;
  private readonly entry: ConfigObject;

  constructor(name: string, entry: ConfigObject) {
    this.name = name;
    this.entry = entry;
  }

  /** The server value, or why the whole server is refused. */
  decode(): Readonly<Record<string, ConfigValue>> | string {
    const url = ["url", "httpUrl", "serverUrl"].map((key) => this.take(key)).find(Predicate.isString);
    const fields = this.entry.command !== undefined
      ? this.stdio()
      : url !== undefined
      ? this.remote(url)
      : `MCP server ${this.name} has neither a command nor a URL`;
    if (Predicate.isString(fields)) return fields;
    // `type`/`transport` only spell the transport, which `fields` already holds.
    this.take("type");
    this.take("transport");
    const enabled = this.take("enabled");
    const disabled = this.take("disabled");
    if (enabled === false || disabled === true) fields.push(["enabled", false]);
    for (const key of Object.keys(this.entry)) if (!this.consumed.has(key)) this.notes.push(`dropped ${key}`);
    return Object.fromEntries(fields);
  }

  private take(key: string): ConfigJson | undefined {
    this.consumed.add(key);
    return this.entry[key];
  }

  private refused(): string {
    return `MCP server ${this.name} passes a literal credential in its command, arguments or URL; move it to an environment variable and scan again`;
  }

  private stdio(): Array<[string, ConfigValue]> | string {
    const command = this.take("command");
    // OpenCode and Kilo `local` servers spell the command and its arguments as one array.
    const parts = Predicate.isString(command) ? [command] : stringList(command);
    const args = this.take("args");
    const argList = args === undefined ? [] : stringList(args);
    if (parts === undefined || parts[0] === undefined || parts[0].trim() === "" || argList === undefined) {
      return `MCP server ${this.name} has a command or arguments that are not text`;
    }
    const allArgs = [...parts.slice(1), ...argList];
    if (containsLiteralCredential(parts[0]) || containsLiteralCredential(allArgs.join(" "))) return this.refused();
    const fields: Array<[string, ConfigValue]> = [["transport", "stdio"], ["command", parts[0]]];
    if (allArgs.length > 0) fields.push(["args", allArgs]);
    const env = this.secretTable("env", [this.take("env"), this.take("environment")]);
    // Codex `env_vars` forwards variables by their own name.
    const forwarded = this.take("env_vars");
    for (const variable of Array.isArray(forwarded) ? forwarded : []) {
      if (Predicate.isString(variable) && ENV_NAME.test(variable)) env.push([variable, { fromEnv: variable }]);
      else this.notes.push("dropped an env_vars entry that is not a variable name");
    }
    if (env.length > 0) fields.push(["env", Object.fromEntries(env)]);
    const cwd = this.take("cwd");
    if (Predicate.isString(cwd) && cwd.trim() !== "") fields.push(["cwd", cwd]);
    else if (cwd !== undefined) this.notes.push("dropped cwd");
    return fields;
  }

  private remote(url: string): Array<[string, ConfigValue]> | string {
    if (containsLiteralCredential(url)) return this.refused();
    const sse = this.entry.type === "sse" || this.entry.transport === "sse";
    const fields: Array<[string, ConfigValue]> = [["transport", sse ? "sse" : "streamable-http"], ["url", url]];
    const headers = this.secretTable("headers", [this.take("headers"), this.take("http_headers")]);
    // Codex `env_http_headers` maps a header to the variable holding its value.
    const fromEnvironment = this.take("env_http_headers");
    for (const [header, variable] of Object.entries(isConfigObject(fromEnvironment) ? fromEnvironment : {})) {
      if (Predicate.isString(variable) && ENV_NAME.test(variable)) headers.push([header, { fromEnv: variable }]);
      else this.notes.push(`dropped env_http_headers.${header}`);
    }
    if (headers.length > 0) fields.push(["headers", Object.fromEntries(headers)]);
    return fields;
  }

  private secretTable(field: "env" | "headers", sources: ReadonlyArray<ConfigJson | undefined>): Array<[string, ConfigValue]> {
    const entries: Array<[string, ConfigValue]> = [];
    for (const source of sources) {
      if (source === undefined) continue;
      if (!isConfigObject(source)) {
        this.notes.push(`dropped ${field} (not a table)`);
        continue;
      }
      for (const [key, value] of Object.entries(source)) {
        const converted = this.secretValue(field, key, value);
        if (converted !== undefined) entries.push([key, converted]);
      }
    }
    return entries;
  }

  private secretValue(field: "env" | "headers", key: string, value: ConfigJson): ConfigValue | undefined {
    if (!Predicate.isString(value)) {
      this.notes.push(`dropped ${field}.${key} (not text)`);
      return undefined;
    }
    const reference = WHOLE_REFERENCE.exec(value);
    if (reference !== null) return { fromEnv: (reference[1] ?? reference[2] ?? reference[3])! };
    // A reference inside a longer string (`Bearer ${TOKEN}`) carries no secret.
    if (isEnvironmentReference(value)) return value;
    const credential = isSecretField(key)
      || containsLiteralCredential(`${key}=${value}`)
      || containsLiteralCredential(value)
      || (field === "headers" && CREDENTIAL_HEADER.test(key));
    if (!credential) return value;
    const fromEnv = field === "env" && ENV_NAME.test(key) ? key : environmentName(`${this.name}_${key}`);
    this.secrets.push({ field: `${field}.${key}`, fromEnv });
    return { fromEnv };
  }
}

const decodeServer = (name: string, entry: ConfigJson): Outcome => {
  if (!DOCUMENT_ID.test(name)) return skip(`MCP server name ${name} is not letters, digits, '-' or '_'`);
  if (!isConfigObject(entry)) return skip(`MCP server ${name} is not a table`);
  const decoder = new ServerDecoder(name, entry);
  const server = decoder.decode();
  if (Predicate.isString(server)) return skip(server);
  return ready("mcp", name, { kind: "mcp", server }, decoder.notes, decoder.secrets);
};

type ConfigSurface = Extract<OwnedSurface, { readonly kind: "config" }>;
type McpRead =
  | { readonly kind: "servers"; readonly path: string; readonly servers: ReadonlyArray<readonly [string, Outcome]> }
  | (Skip & { readonly path: string })
  | Missing;

/** Every MCP server under the surface's MCP keys, from the file the harness reads. */
const readMcpSurface = async (scope: ReadScope, surface: ConfigSurface): Promise<McpRead> => {
  const keys = surface.keys.filter((key) => /mcp/iu.test(key));
  if (keys.length === 0) return MISSING;
  for (const path of [surface.target, ...surface.alternatives ?? []]) {
    const read = await readTextFile(scope, path, MAX_CONFIG_BYTES);
    if (read.kind === "missing") continue;
    if (read.kind === "skip") return { ...read, path };
    let document;
    try {
      document = parseConfigDocument(surface.format, read.text);
    } catch {
      // The parser's message can quote the file, so it is not repeated here.
      return { ...skip(`is not valid ${surface.format}`), path };
    }
    const servers = keys.flatMap((key): Array<readonly [string, Outcome]> => {
      const table = getConfigPath(document, key);
      if (table === undefined) return [];
      if (!isConfigObject(table)) return [[key, skip(`${key} is not a table of MCP servers`)]];
      return Object.entries(table).map(([name, entry]) => [name, decodeServer(name, entry)] as const);
    });
    return { kind: "servers", path, servers };
  }
  return MISSING;
};

// Scan --------------------------------------------------------------------

const harnessScope = (context: RootContext, folder: string): HarnessReadScope => {
  const model = emptyModel(folder);
  const layouts = TARGET_IDS.map((harness) => [harness, adapterFor(harness).layout(context, model)] as const);
  return {
    join: context.join,
    separator: context.join("a", "b").slice(1, -1),
    base: context.home,
    // Protect every supported harness's state, including unselected harnesses.
    neverTouch: layouts.flatMap(([, layout]) => layout.neverTouch),
    // Configs may contain credentials outside owned keys. Only skill reads
    // exclude their whole files; normal MCP import still reads owned keys.
    configPaths: layouts.flatMap(([, layout]) => layout.surfaces.flatMap((surface) =>
      surface.kind === "config" ? [surface.target, ...surface.alternatives ?? []] : [])),
    layouts,
    folder,
  };
};

const targetOf = (category: ImportCategory, name: string): string => {
  switch (category) {
    case "instructions":
      return "AGENTS.md";
    case "skills":
      return `skills/${name}`;
    case "mcp":
      return `canonfig.jsonc#mcp.${name}`;
    default:
      return `${category}/${name}.md`;
  }
};

class ScanCollector {
  readonly skipped: Array<ImportSkip> = [];
  private readonly candidates = new Map<string, Array<ImportCandidate>>();

  skip(source: ImportSource, path: string, reason: string): void {
    this.skipped.push({ source, path, reason });
  }

  record(
    source: ImportSource,
    harnesses: ReadonlyArray<TargetId>,
    category: ImportCategory,
    path: string,
    outcome: Outcome,
  ): void {
    if (outcome.kind === "missing") return;
    if (outcome.kind === "skip" || outcome.kind === "limit") return this.skip(source, path, outcome.reason);
    const id = `${source}/${category}/${outcome.name}`;
    const group = this.candidates.get(id) ?? [];
    const identical = group.find((candidate) => candidate.digest === outcome.digest);
    if (identical !== undefined) {
      const index = group.indexOf(identical);
      group[index] = {
        ...identical,
        harnesses: [...new Set([...identical.harnesses, ...harnesses])],
      };
      return;
    }
    group.push({
      id, source, harnesses, category, name: outcome.name, path, target: targetOf(category, outcome.name),
      digest: outcome.digest, secrets: outcome.secrets, notes: outcome.notes,
    });
    this.candidates.set(id, group);
  }

  result(): ImportScan {
    // Keep the short key for unambiguous items. Every competing distinct copy
    // gets a deterministic path/content key rather than silently losing a copy.
    const candidates = [...this.candidates.values()].flatMap((group) => group.length === 1 ? group : group.map((candidate) => ({
      ...candidate, id: `${candidate.id}/${sha256Hex(JSON.stringify([candidate.path, candidate.digest]))}`,
    }))).sort((left, right) => compare(left.id, right.id));
    return { candidates, skipped: this.skipped };
  }
}

// Surface ids name what a surface holds; `droids` and `prompts` are Factory's and Pi's spellings.
const SURFACE_CATEGORIES = new Map<string, DocumentCategory>([
  ["instructions", "instructions"],
  ["rules", "rules"],
  // Skills come exclusively from adapter skillSources, never from OwnedSurface.
  ["agents", "agents"],
  ["droids", "agents"],
  ["commands", "commands"],
  ["prompts", "commands"],
]);

/** Every item of a rules, agents or commands directory. */
const scanDirectory = async (
  scope: ReadScope,
  collector: ScanCollector,
  source: ImportSource,
  harnesses: ReadonlyArray<TargetId>,
  category: "rules" | "agents" | "commands",
  directory: string,
): Promise<void> => {
  const listing = await listDirectory(scope, directory);
  if (listing.kind === "missing") return;
  if (listing.kind === "skip") return collector.skip(source, directory, listing.reason);
  for (const name of listing.names) {
    const path = scope.join(directory, name);
    const outcome = await readDocument(scope, category, path);
    collector.record(source, harnesses, category, path, outcome);
  }
};

const scanSurface = async (
  scope: ReadScope,
  collector: ScanCollector,
  harness: TargetId,
  surface: OwnedSurface,
): Promise<void> => {
  if (surface.kind === "config") {
    const read = await readMcpSurface(scope, surface);
    if (read.kind === "skip") collector.skip(harness, read.path, read.reason);
    if (read.kind !== "servers") return;
    for (const [, outcome] of read.servers) collector.record(harness, [harness], "mcp", read.path, outcome);
    return;
  }
  const category = SURFACE_CATEGORIES.get(surface.id);
  if (category === undefined) return;
  if (category === "instructions") {
    if (surface.kind !== "file") return;
    return collector.record(harness, [harness], category, surface.target, await readDocument(scope, category, surface.target));
  }
  if (surface.kind !== "directory") return;
  await scanDirectory(scope, collector, harness, [harness], category, surface.target);
};

/** One shared-root traversal, retaining only readers whose discovery rules admit each item. */
const scanSkills = async (
  scope: ReadScope,
  reader: SkillReader,
  collector: ScanCollector,
  source: ImportSource,
  readers: ReadonlyArray<readonly [TargetId, SkillReadSource]>,
): Promise<void> => {
  const first = readers[0]![1];
  const discovery: SkillReadSource = {
    ...first,
    depth: Math.max(...readers.map(([, entry]) => entry.depth)),
    flat: readers.some(([, entry]) => entry.flat),
  };
  await reader.discover(discovery, async (path, depth, flat) => {
    const harnesses = readers.filter(([, entry]) => depth <= entry.depth && (!flat || entry.flat)).map(([harness]) => harness);
    if (harnesses.length === 0) return;
    const outcome = flat ? await readFlatSkill(scope, reader, path) : await readSkill(scope, path, reader);
    collector.record(source, harnesses, "skills", path, outcome);
  }, (path, reason) => collector.skip(source, path, reason));
};

/** Read-only scan of the selected harnesses for items to import into `folder`. */
export const scanImports = async (input: {
  readonly context: RootContext;
  readonly harnesses: ReadonlyArray<TargetId>;
  readonly folder: string;
}): Promise<ImportScan> => {
  const { context, folder } = input;
  const scope = harnessScope(context, folder);
  const layouts = [...new Set(input.harnesses)].map((harness) => scope.layouts.find(([id]) => id === harness)!);
  const collector = new ScanCollector();
  const reader = await SkillReader.create(context, scope.neverTouch, scope.folder, scope.configPaths);
  const shared = new Map<string, Array<readonly [TargetId, SkillReadSource]>>();
  for (const [harness, layout] of layouts) {
    for (const surface of layout.surfaces) await scanSurface(scope, collector, harness, surface);
    for (const entry of layout.skillSources) {
      if (entry.shared) {
        const readers = shared.get(entry.path) ?? [];
        readers.push([harness, entry]);
        shared.set(entry.path, readers);
      } else {
        await scanSkills(scope, reader, collector, harness, [[harness, entry]]);
      }
    }
  }
  for (const readers of shared.values()) await scanSkills(scope, reader, collector, "agents", readers);
  return collector.result();
};

// Import ------------------------------------------------------------------

const readCandidate = async (
  scope: HarnessReadScope,
  candidate: ImportCandidate,
  context: RootContext,
  maximumBytes: number,
): Promise<Outcome> => {
  if (candidate.category === "skills") {
    const reader = await SkillReader.create(context, scope.neverTouch, scope.folder, scope.configPaths);
    return candidate.path.endsWith(".md")
      ? readFlatSkill(scope, reader, candidate.path)
      : readSkill(scope, candidate.path, reader, maximumBytes);
  }
  if (candidate.category !== "mcp") return readDocument(scope, candidate.category, candidate.path);
  for (const [harness, layout] of scope.layouts) {
    if (!candidate.harnesses.includes(harness)) continue;
    for (const surface of layout.surfaces) {
      if (surface.kind !== "config" || ![surface.target, ...surface.alternatives ?? []].includes(candidate.path)) continue;
      const read = await readMcpSurface(scope, surface);
      if (read.kind === "skip" && read.path === candidate.path) return read;
      if (read.kind !== "servers" || read.path !== candidate.path) continue;
      const found = read.servers.find(([name]) => name === candidate.name);
      if (found !== undefined) return found[1];
    }
  }
  return MISSING;
};

/**
 * Re-read a candidate's source under the scan's rules and return what to
 * write. Throws ImportChangedError when the source is gone, now refused, or
 * no longer has the digest the operator reviewed, and ImportSizeLimitError
 * when its payload exceeds the remaining budget. `folder` is the approved
 * scan boundary, including when it differs from the default Canonical Folder.
 */
export const readImportContent = async (
  candidate: ImportCandidate,
  context: RootContext,
  folder: string,
  maximumBytes = maxImportContentBytes,
): Promise<ImportContent> => {
  if (folder === undefined) throw new ImportChangedError({
    path: candidate.path, message: `${candidate.id} requires the approved Canonical Folder boundary; scan again`,
  });
  const budget = Math.min(maximumBytes, maxImportContentBytes);
  const outcome = await readCandidate(harnessScope(context, folder), candidate, context, budget);
  // Converted text and sanitized MCP values can differ in size from their
  // sources. Admit the actual payload, using the same accounting as apply.
  if (outcome.kind === "limit" || (outcome.kind === "ready" && importContentBytes(outcome.content) > budget)) {
    throw new ImportSizeLimitError({
      path: candidate.path,
      maximumBytes: budget,
      message: `${candidate.id} exceeds the remaining import content budget of ${budget} bytes`,
    });
  }
  const changed = (message: string) => new ImportChangedError({ path: candidate.path, message: `${candidate.id} ${message}` });
  if (outcome.kind === "missing") throw changed("is gone; scan again");
  if (outcome.kind === "skip") throw changed(`can no longer be imported: ${outcome.reason}`);
  if (outcome.digest !== candidate.digest) throw changed("changed since the scan; scan again");
  return outcome.content;
};

// Folder ------------------------------------------------------------------

const folderDocuments = async (
  scope: ReadScope,
  folder: string,
  category: "rules" | "agents" | "commands",
  items: Map<string, string>,
): Promise<void> => {
  const listing = await listDirectory(scope, joinNative(folder, category));
  if (listing.kind !== "entries") return;
  for (const name of listing.names.filter((entry) => entry.endsWith(".md"))) {
    const read = await readTextFile(scope, joinNative(folder, category, name), MAX_FILE_BYTES);
    if (read.kind === "missing") continue;
    const id = name.slice(0, -".md".length);
    items.set(`${category}/${name}`, read.kind === "text" ? contentDigest(category, id, { kind: "text", content: read.text }) : UNREADABLE);
  }
};

const folderSkills = async (scope: ReadScope, folder: string, items: Map<string, string>): Promise<void> => {
  const listing = await listDirectory(scope, joinNative(folder, "skills"));
  if (listing.kind !== "entries") return;
  for (const name of listing.names) {
    const outcome = await readSkill(scope, joinNative(folder, "skills", name));
    if (outcome.kind !== "missing") items.set(`skills/${name}`, outcome.kind === "ready" ? outcome.digest : UNREADABLE);
  }
};

const decodeConfigValue = Schema.decodeUnknownOption(ConfigValue);

const folderMcp = async (scope: ReadScope, folder: string, items: Map<string, string>): Promise<void> => {
  const read = await readTextFile(scope, joinNative(folder, "canonfig.jsonc"), MAX_CONFIG_BYTES);
  if (read.kind !== "text") return;
  const errors: Array<ParseError> = [];
  const config = decodeConfigValue(parseJsonc(read.text, errors, { allowTrailingComma: true }));
  // An invalid canonfig.jsonc fails setup's own load; it holds no comparable items.
  if (errors.length > 0 || config._tag === "None" || !isConfigObject(config.value)) return;
  const servers = config.value.mcp;
  for (const [name, server] of Object.entries(isConfigObject(servers) ? servers : {})) {
    items.set(targetOf("mcp", name), contentDigest("mcp", name, { kind: "mcp", server }));
  }
};

/**
 * What the Canonical Folder already holds, keyed by candidate `target` and
 * digested like a candidate, so an item imported earlier reads back as
 * present. An entry that exists but cannot be read gets a digest no
 * candidate matches, so it surfaces as a folder collision.
 */
export const existingFolderItems = async (folder: string): Promise<ReadonlyMap<string, string>> => {
  const scope: ReadScope = { join: joinNative, separator: nativeSeparator, base: folder, neverTouch: [], folder: undefined };
  const items = new Map<string, string>();
  const instructions = await readTextFile(scope, joinNative(folder, "AGENTS.md"), MAX_FILE_BYTES);
  if (instructions.kind === "skip") items.set("AGENTS.md", UNREADABLE);
  if (instructions.kind === "text" && instructions.text.trim() !== "") {
    items.set("AGENTS.md", contentDigest("instructions", "AGENTS.md", { kind: "text", content: instructions.text }));
  }
  for (const category of ["rules", "agents", "commands"] as const) await folderDocuments(scope, folder, category, items);
  await folderSkills(scope, folder, items);
  await folderMcp(scope, folder, items);
  return items;
};

// Selection ---------------------------------------------------------------

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const isSelected = (candidate: ImportCandidate, selection: ImportSelection, items: ReadonlySet<string>): boolean => {
  switch (selection.kind) {
    case "none":
      return false;
    case "all":
      return true;
    case "some":
      return items.has(candidate.id) || selection.sources.some((source) =>
        source === candidate.source || (candidate.source === "agents" && candidate.harnesses.some((harness) => harness === source))
      );
  }
};

const unknownRequests = (scan: ImportScan, selection: ImportSelection): Array<string> => {
  if (selection.kind !== "some") return [];
  const ids = new Set(scan.candidates.map((candidate) => candidate.id));
  const sources = new Set<string>(scan.candidates.flatMap((candidate) => [candidate.source, ...candidate.harnesses]));
  return [...new Set([
    ...selection.items.filter((item) => !ids.has(item)),
    ...selection.sources.filter((source) => !sources.has(source)),
  ])].sort(compare);
};

/**
 * Resolve the operator's selection against the scan and the folder: items
 * already in the folder are `present`, different content at an occupied
 * target or several different selected candidates for one target is a
 * collision unless exactly one of them was named, and the rest is chosen.
 */
export const selectImports = (
  scan: ImportScan,
  existing: ReadonlyMap<string, string>,
  selection: ImportSelection,
): ImportChoice => {
  const named = new Set(selection.kind === "some" ? selection.items : []);
  const groups = new Map<string, Array<ImportCandidate>>();
  for (const candidate of scan.candidates) {
    if (!isSelected(candidate, selection, named)) continue;
    groups.set(candidate.target, [...groups.get(candidate.target) ?? [], candidate]);
  }
  const chosen: Array<ImportCandidate> = [];
  const present: Array<string> = [];
  const collisions: Array<ImportCollision> = [];
  for (const target of [...groups.keys()].sort(compare)) {
    const group = groups.get(target)!.sort((left, right) => compare(left.id, right.id));
    const held = existing.get(target);
    if (held !== undefined) {
      present.push(...group.filter((candidate) => candidate.digest === held).map((candidate) => candidate.id));
      const different = group.filter((candidate) => candidate.digest !== held).map((candidate) => candidate.id);
      if (different.length > 0) collisions.push({ target, candidates: different, folder: true });
      continue;
    }
    const namedInGroup = group.filter((candidate) => named.has(candidate.id));
    if (new Set(group.map((candidate) => candidate.digest)).size === 1) {
      chosen.push(namedInGroup[0] ?? group[0]!);
    } else if (namedInGroup.length === 1) {
      chosen.push(namedInGroup[0]!);
    } else {
      // List every scanned candidate for the target, selected or not, so the operator sees the whole choice.
      const all = scan.candidates.filter((candidate) => candidate.target === target).map((candidate) => candidate.id);
      collisions.push({ target, candidates: all.sort(compare), folder: false });
    }
  }
  return { chosen, present, collisions, unknown: unknownRequests(scan, selection) };
};
