import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, join, resolve, sep } from "node:path";

import { Effect, Schema } from "effect";
import { parse as parseToml } from "smol-toml";

import {
  BuildPolicy as BuildPolicySchema,
  RecipeIndexPolicy,
} from "../domain/resource.ts";
import { parseNpmPackageSpecification } from "../domain/npm-package-spec.ts";
import {
  CanonicalFolderError,
  decodeFolderConfig,
  listFolderFiles,
  readFolderConfig,
} from "../projection/folder.ts";
import { setJsoncValue } from "../synchronization/config-jsonc.ts";
import { asJson, parseJsonc, type JsonValue } from "./profile-codec.ts";
import {
  DiscoveryFilesystemError,
  DiscoveryParseError,
  InvalidDiscoveryInputError,
  type ProfileCatalogScanError,
} from "./profile-catalog.errors.ts";
import {
  buildToolCatalog,
  folderToolEntry,
  type DiscoveredPackageMetadata,
  type ExecutableCandidate,
  type DiscoveredSkill,
  type DiscoverySourceKind,
  type EvidenceLocation,
  type ToolCatalog,
  type ToolDiscoveryEvidence,
  type DiscoveryTaskBounds,
} from "./tool-catalog.ts";

export type DiscoveryFileKind =
  | "agents"
  | "tool-config"
  | "hooks"
  | "mcp"
  | "package-metadata";

export interface DiscoveryFile {
  readonly path: string;
  readonly kind?: DiscoveryFileKind | undefined;
}

export interface DiscoveryScanInput {
  readonly files: ReadonlyArray<DiscoveryFile>;
  readonly path?: string | undefined;
  readonly agentTaskBounds?: DiscoveryTaskBounds | undefined;
}

export interface DiscoveryScanResult extends ToolCatalog {
  readonly scannedPaths: ReadonlyArray<string>;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const inferFileKind = (path: string): DiscoveryFileKind => {
  const name = basename(path).toLowerCase();
  if (name === "agents.md" || name === "claude.md") return "agents";
  if (name === "package.json" || name === "cargo.toml" || name === "pyproject.toml" || name === "brewfile" || name.includes("winget")) {
    return "package-metadata";
  }
  if (name.includes("hook") || name === "settings.json") return "hooks";
  if (name.includes("mcp")) return "mcp";
  return "tool-config";
};

const readDiscoveryFile = (
  path: string,
): Effect.Effect<string, DiscoveryFilesystemError> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => new DiscoveryFilesystemError({
      path,
      operation: "read",
      reason: String(cause),
    }),
  });

/** Every executable file an invocation can resolve to, in PATH order. */
const executableMatches = async (
  executable: string,
  pathValue: string,
): Promise<ReadonlyArray<string>> => {
  const isExecutableFile = (candidate: string): Promise<boolean> =>
    access(candidate, constants.X_OK)
      .then(() => stat(candidate))
      .then((details) => details.isFile())
      // A missing or non-executable candidate means resolution continues.
      .catch(() => false);
  if (executable.includes("/") || executable.includes("\\")) {
    const absolute = resolve(executable);
    return await isExecutableFile(absolute) ? [absolute] : [];
  }
  const matches: Array<string> = [];
  for (const entry of pathValue.split(delimiter).filter((value) => value.length > 0)) {
    const candidate = join(entry, executable);
    if (!matches.includes(candidate) && await isExecutableFile(candidate)) matches.push(candidate);
  }
  return matches;
};

/**
 * Whether a word names an installed program, cached for one scan. Inline code in prose and commands
 * after a pipe count only when it does: skills and rules use inline code for plenty that is not a
 * command (`middleware`, `--modal-ease`, `mix-blend-mode: multiply`), and usage text in shell blocks
 * writes alternatives as `auto|full`. The same words recur across files, so each is looked up once.
 */
const installedLookup = (pathValue: string): ((executable: string) => Promise<boolean>) => {
  const windowsExtensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((extension) => extension.length > 0).map((extension) => extension.toLowerCase())
    : [];
  const cache = new Map<string, Promise<boolean>>();
  const lookup = async (executable: string): Promise<boolean> => {
    const names = extname(executable) === "" ? [executable, ...windowsExtensions.map((extension) => `${executable}${extension}`)] : [executable];
    for (const name of names) {
      if ((await executableMatches(name, pathValue)).length > 0) return true;
    }
    return false;
  };
  return (executable) => {
    let installed = cache.get(executable);
    if (installed === undefined) {
      installed = lookup(executable);
      cache.set(executable, installed);
    }
    return installed;
  };
};

const maximumDigestBytes = 64 * 1024 * 1024;

/**
 * `name@version` (npm) or `name==version` (uv) of the package that owns a
 * copy, read from its manifest. Nothing is executed: a copy may be a shim
 * that installs on first run, or a server that never exits.
 */
const owningPackageVersion = async (realPath: string): Promise<string | undefined> => {
  const segments = realPath.split(sep);
  const modules = segments.lastIndexOf("node_modules");
  if (modules >= 0 && modules + 1 < segments.length) {
    const depth = segments[modules + 1]!.startsWith("@") ? 3 : 2;
    const manifest = join(segments.slice(0, modules + depth).join(sep) || sep, "package.json");
    const parsed = await readFile(manifest, "utf8").then((text) => parseJsonc(text)).catch(() => undefined);
    const object = parsed === undefined ? undefined : jsonObject(parsed);
    const name = jsonString(object?.name);
    const version = jsonString(object?.version);
    return name === undefined || version === undefined ? undefined : `${name}@${version}`;
  }
  const tools = segments.lastIndexOf("tools");
  if (tools > 0 && segments[tools - 1] === "uv" && tools + 1 < segments.length) {
    const receipt = join(segments.slice(0, tools + 2).join(sep) || sep, "uv-receipt.toml");
    const parsed = await readFile(receipt, "utf8")
      .then((text) => Schema.decodeUnknownSync(Schema.MutableJson)(parseToml(text)))
      .catch(() => undefined);
    const tool = parsed === undefined ? undefined : jsonObject(jsonObject(parsed)?.tool ?? null);
    const requirements = Array.isArray(tool?.requirements) ? tool.requirements : [];
    const requirement = requirements.length === 0 ? undefined : jsonObject(requirements[0]!);
    const name = jsonString(requirement?.name);
    return name === undefined ? undefined : `${name}${jsonString(requirement?.specifier) ?? ""}`;
  }
  return undefined;
};

/**
 * The distinct copies behind several PATH matches, with version evidence, or
 * undefined when they are one file (a symlinked directory) or byte-identical.
 */
const distinctCandidates = async (
  matches: ReadonlyArray<string>,
): Promise<ReadonlyArray<ExecutableCandidate> | undefined> => {
  const candidates: Array<ExecutableCandidate> = [];
  for (const path of matches) {
    const realPath = await realpath(path).catch(() => path);
    if (candidates.some((candidate) => candidate.realPath === realPath)) continue;
    const details = await stat(realPath).catch(() => undefined);
    if (details === undefined) continue;
    const sha256 = details.size <= maximumDigestBytes
      ? await readFile(realPath)
        .then((bytes) => createHash("sha256").update(bytes).digest("hex"))
        .catch(() => undefined)
      : undefined;
    const packageVersion = await owningPackageVersion(realPath);
    if (
      sha256 !== undefined
      && candidates.some((candidate) =>
        candidate.sha256 === sha256 && candidate.packageVersion === packageVersion)
    ) continue;
    candidates.push({
      path,
      realPath,
      bytes: details.size,
      modifiedAt: details.mtime.toISOString(),
      sha256,
      packageVersion,
    });
  }
  return candidates.length > 1 ? candidates : undefined;
};

const tokenize = (command: string): ReadonlyArray<string> => {
  const tokens: Array<string> = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const push = (): void => {
    if (token.length > 0) tokens.push(token);
    token = "";
  };
  for (const character of command.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      push();
      continue;
    }
    token += character;
  }
  push();
  return tokens;
};

const stripEnvironmentPrefix = (tokens: ReadonlyArray<string>): ReadonlyArray<string> => {
  let index = 0;
  if (tokens[index] === "env") index += 1;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? "")) index += 1;
  return tokens.slice(index);
};

/** Shell keywords and builtins: words that start a command but are never a program to install. */
const SHELL_WORDS: Readonly<Record<string, true>> = Object.fromEntries([
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "function",
  "select", "time", "return", "exit", "export", "local", "readonly", "declare", "typeset", "set", "unset", "shift",
  "source", "eval", "exec", "builtin", "command", "cd", "pushd", "popd", "echo", "printf", "read", "test", "true",
  "false", "trap", "alias", "unalias", "let", "wait", "break", "continue", "type", "hash", "getopts", "umask", "ulimit",
].map((word) => [word, true]));

/** Functions a shell text defines (`name() {` or `function name`): calling one does not run a program. */
const shellFunctionNames = (text: string): Readonly<Record<string, true>> => Object.fromEntries(
  [...text.matchAll(/^\s*(?:function\s+([A-Za-z_][A-Za-z0-9_-]*)|([A-Za-z_][A-Za-z0-9_-]*)\s*\(\s*\))/gmu)]
    .map((match) => [match[1] ?? match[2]!, true]),
);

/** Splits a shell line on `&&`, `||`, `;` and `|` outside quotes, noting which parts follow a pipe. */
const splitShellLine = (line: string): ReadonlyArray<{ readonly text: string; readonly afterPipe: boolean }> => {
  const parts: Array<{ text: string; afterPipe: boolean }> = [];
  let current = "";
  let afterPipe = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    // Quotes and escapes follow `tokenize`: a backslash outside single quotes makes the next character literal.
    if (escaped) {
      escaped = false;
      current += character;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      current += character;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    const next = line[index + 1];
    const doubled = (character === "&" || character === "|") && next === character;
    if (doubled || character === ";" || character === "|") {
      parts.push({ text: current, afterPipe });
      current = "";
      afterPipe = character === "|" && !doubled;
      if (doubled) index += 1;
      continue;
    }
    current += character;
  }
  parts.push({ text: current, afterPipe });
  return parts;
};

/**
 * The commands in shell text, one per logical line, with the line each starts on. A trailing
 * backslash joins the next line, heredoc bodies are skipped, and a `case` arm's pattern is not a
 * command. A command counts only when its first word could name a program: it starts with a letter,
 * has no `$`, `>` or `[`, is not a shell keyword, builtin or function the text defines, and is not
 * followed by `=`. Without this, `--app "$ID" \`, `case "$1" in`, `2> err.log`, `die "msg"` and
 * `rg '(TODO|FIXME)'` became tools. `afterPipe` marks a command the caller must find installed.
 */
const shellCommands = (
  lines: ReadonlyArray<{ readonly text: string; readonly line: number }>,
  functions: Readonly<Record<string, true>>,
): ReadonlyArray<{ readonly line: number; readonly invocation: ReadonlyArray<string>; readonly executable: string; readonly afterPipe: boolean }> => {
  const commands: Array<{ line: number; invocation: ReadonlyArray<string>; executable: string; afterPipe: boolean }> = [];
  let pending = "";
  let start = 0;
  let heredoc: string | undefined;
  let caseDepth = 0;
  for (const { text, line } of lines) {
    if (heredoc !== undefined) {
      if (text.trim() === heredoc) heredoc = undefined;
      continue;
    }
    if (pending.length === 0) start = line;
    const trimmed = text.trim();
    if (trimmed.endsWith("\\")) {
      pending += `${trimmed.slice(0, -1)} `;
      continue;
    }
    let logical = `${pending}${trimmed}`;
    pending = "";
    if (logical.length === 0 || logical.startsWith("#")) continue;
    if (/^case\s/u.test(logical)) caseDepth += 1;
    if (/^esac\b/u.test(logical)) caseDepth = Math.max(0, caseDepth - 1);
    // Inside `case`, `pattern|other)` opens an arm; only what follows it can be a command.
    if (caseDepth > 0) logical = logical.replace(/^\(?[^()\s]*\)\s*/u, "");
    heredoc = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/u.exec(logical)?.[1];
    for (const part of splitShellLine(logical)) {
      const invocation = tokenize(part.text);
      const words = stripEnvironmentPrefix(invocation);
      const executable = words[0];
      if (
        executable === undefined || !/^[A-Za-z][A-Za-z0-9._+-]*$/u.test(executable)
        || SHELL_WORDS[executable] === true || functions[executable] === true || words[1]?.startsWith("=") === true
      ) continue;
      commands.push({ line: start, invocation, executable, afterPipe: part.afterPipe });
    }
  }
  return commands;
};

interface ParsedPackageSpecification {
  readonly name: string;
  readonly version?: string | undefined;
}

const packageSpecification = (
  specification: string,
  separator: "@" | "==",
): ParsedPackageSpecification => {
  if (separator === "==") {
    const index = specification.lastIndexOf("==");
    return index > 0
      ? { name: specification.slice(0, index), version: specification.slice(index + 2) }
      : { name: specification };
  }
  const index = specification.lastIndexOf("@");
  if (index > 0) return { name: specification.slice(0, index), version: specification.slice(index + 1) };
  return { name: specification };
};

const isUnboundedPackageSpecification = (value: string): boolean =>
  value === "--"
  || /^\s*-{1,2}\S*/u.test(value)
  || /\s/u.test(value)
  || parseNpmPackageSpecification(value).kind !== "registry";

const valueAfter = (tokens: ReadonlyArray<string>, options: ReadonlyArray<string>): string | undefined => {
  for (const option of options) {
    const index = tokens.indexOf(option);
    if (index >= 0) return tokens[index + 1];
  }
  return undefined;
};

const positionalAfter = (
  tokens: ReadonlyArray<string>,
  commands: ReadonlyArray<string>,
): string | undefined => {
  const commandIndex = tokens.findIndex((token) => commands.includes(token));
  if (commandIndex < 0) return undefined;
  return tokens.slice(commandIndex + 1).find((token) => !token.startsWith("-"));
};

/** uv options whose value is the next token, so that token is not the package. */
const uvOptionsWithValues = new Set([
  "--with",
  "--with-editable",
  "--with-requirements",
  "--python",
  "-p",
  "--index",
  "--default-index",
  "--index-url",
  "--extra-index-url",
  "--constraints",
  "-c",
  "--overrides",
  "--directory",
  "--project",
  "--cache-dir",
  "--color",
  "--config-file",
]);

/**
 * The package a `uvx …`, `uv tool run …` or `uv tool install …` invocation
 * names: `--from` when given, otherwise the first positional argument.
 */
const uvToolSpecification = (tokens: ReadonlyArray<string>): string | undefined => {
  let index: number;
  if (tokens[0] === "uvx") {
    index = 1;
  } else {
    const tool = tokens.indexOf("tool");
    const subcommand = tokens[tool + 1];
    if (tool < 1 || (subcommand !== "install" && subcommand !== "run")) return undefined;
    index = tool + 2;
  }
  for (; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--from") return tokens[index + 1];
    if (token.startsWith("--from=")) return token.slice("--from=".length);
    if (!token.startsWith("-")) return token;
    if (uvOptionsWithValues.has(token)) index += 1;
  }
  return undefined;
};

/**
 * A registry requirement: a PEP 508 name with optional extras, pinned with
 * `==` (or uvx's `@`), or unpinned. URLs, paths and other sources are not
 * registry packages and yield nothing.
 */
const uvRequirement = (specification: string): ParsedPackageSpecification | undefined => {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[[A-Za-z0-9._,-]+\])?)(.*)$/u.exec(specification);
  if (match === null) return undefined;
  const name = match[1]!;
  const rest = match[2]!.trim();
  if (rest.length === 0) return { name };
  const pinned = /^(?:==|@)([A-Za-z0-9][A-Za-z0-9.+!_-]*)$/u.exec(rest);
  if (pinned !== null) return pinned[1] === "latest" ? { name } : { name, version: pinned[1] };
  // A range such as `>=1` names the package but pins nothing.
  return /^(?:[<>!~]=?|==)/u.test(rest) && !/[\s@/]/u.test(rest) ? { name } : undefined;
};

const metadataFromInvocation = (
  input: ReadonlyArray<string>,
  sourcePath: string,
): DiscoveredPackageMetadata | undefined => {
  const tokens = stripEnvironmentPrefix(input);
  const executable = tokens[0];
  if (executable === "npm" || executable === "npx") {
    if (tokens.includes("--")) return undefined;
    const specification = executable === "npx"
      ? tokens.find((token, index) => index > 0 && !token.startsWith("-"))
      : positionalAfter(tokens, ["install", "i", "add"]);
    if (specification === undefined) return undefined;
    if (isUnboundedPackageSpecification(specification)) return undefined;
    const parsed = packageSpecification(specification, "@");
    return {
      ecosystem: "npm",
      ...parsed,
      source: `${sourcePath}#npm`,
    };
  }
  if (executable === "brew") {
    const formula = positionalAfter(tokens, ["install"]);
    if (formula === undefined) return undefined;
    const parsed = packageSpecification(formula, "@");
    return {
      ecosystem: "homebrew",
      ...parsed,
      source: `${sourcePath}#homebrew`,
    };
  }
  if (executable === "winget") {
    const id = valueAfter(tokens, ["--id"]) ?? positionalAfter(tokens, ["install"]);
    if (id === undefined) return undefined;
    const version = valueAfter(tokens, ["--version", "-v"]);
    return {
      ecosystem: "winget",
      name: id,
      version,
      source: `${sourcePath}#winget`,
    };
  }
  if (executable === "uv" || executable === "uvx") {
    if (tokens.includes("--")) return undefined;
    const specification = uvToolSpecification(tokens);
    if (specification === undefined) return undefined;
    const parsed = uvRequirement(specification);
    if (parsed === undefined) return undefined;
    return {
      ecosystem: "uv",
      ...parsed,
      source: `${sourcePath}#uv`,
    };
  }
  if (executable === "cargo") {
    const crate = positionalAfter(tokens, ["install"]);
    if (crate === undefined) return undefined;
    const version = valueAfter(tokens, ["--version"]);
    return {
      ecosystem: "cargo",
      name: crate,
      version,
      source: `${sourcePath}#cargo`,
    };
  }
  return undefined;
};

const sourceKindFor = (
  fileKind: DiscoveryFileKind,
  deterministic: boolean,
): DiscoverySourceKind => {
  if (!deterministic) return "prose";
  switch (fileKind) {
    case "agents":
      return "agents";
    case "hooks":
      return "hook";
    case "mcp":
      return "mcp";
    case "package-metadata":
      return "package-metadata";
    case "tool-config":
      return "tool-config";
  }
};

interface EvidenceContext {
  readonly sourcePath: string;
  readonly fileKind: DiscoveryFileKind;
  readonly pathValue: string;
  readonly installed: (executable: string) => Promise<boolean>;
}

const invocationEvidence = async (
  context: EvidenceContext,
  invocation: ReadonlyArray<string>,
  location: EvidenceLocation,
  deterministic: boolean,
  kindOverride?: DiscoverySourceKind,
): Promise<ToolDiscoveryEvidence | undefined> => {
  const tokens = stripEnvironmentPrefix(invocation);
  const executable = tokens[0];
  if (executable === undefined || executable.length === 0) return undefined;
  const packageMetadata = deterministic
    ? metadataFromInvocation(tokens, context.sourcePath)
    : undefined;
  const matches = deterministic ? await executableMatches(executable, context.pathValue) : [];
  const resolvedExecutable = matches[0];
  // Shadowed copies matter only when the invocation is the tool itself; an
  // installer such as npm or uvx is not what the evidence identifies.
  const candidates = packageMetadata === undefined && matches.length > 1
    ? await distinctCandidates(matches)
    : undefined;
  return {
    sourcePath: context.sourcePath,
    location,
    kind: kindOverride ?? sourceKindFor(context.fileKind, deterministic),
    invocation: tokens,
    resolvedExecutable,
    candidates,
    package: packageMetadata,
    confidence: !deterministic || candidates !== undefined
      ? "review"
      : packageMetadata === undefined && resolvedExecutable === undefined ? "strong" : "deterministic",
    reviewStatus: deterministic && candidates === undefined ? "accepted" : "needs-review",
  };
};

/** Evidence for the commands in shell text; a command after a pipe counts only when it is installed. */
const shellEvidence = async (
  context: EvidenceContext,
  lines: ReadonlyArray<{ readonly text: string; readonly line: number }>,
  functions: Readonly<Record<string, true>>,
  kindOverride?: DiscoverySourceKind,
): Promise<ReadonlyArray<ToolDiscoveryEvidence>> => {
  const records: Array<ToolDiscoveryEvidence> = [];
  for (const { line, invocation, executable, afterPipe } of shellCommands(lines, functions)) {
    if (afterPipe && !(await context.installed(executable))) continue;
    const record = await invocationEvidence(context, invocation, { kind: "line", line }, true, kindOverride);
    if (record !== undefined) records.push(record);
  }
  return records;
};

const scanMarkdown = async (
  context: EvidenceContext,
  text: string,
): Promise<{
  readonly evidence: ReadonlyArray<ToolDiscoveryEvidence>;
  readonly skills: ReadonlyArray<DiscoveredSkill>;
}> => {
  const evidence: Array<ToolDiscoveryEvidence> = [];
  const skills = new Map<string, DiscoveredSkill>();
  let fenced = false;
  let executableFence = false;
  // A shell fence is parsed whole when it closes, so continued lines and heredocs read as the shell reads them.
  let shellBlock: Array<{ text: string; line: number }> = [];
  // A function one shell block defines may be called from another block in the same document.
  const functions = shellFunctionNames(text);
  const flushShellBlock = async (): Promise<void> => {
    evidence.push(...await shellEvidence(context, shellBlock, functions));
    shellBlock = [];
  };
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fence = /^\s*```([A-Za-z0-9_-]*)/u.exec(line);
    if (fence !== null) {
      if (fenced) {
        await flushShellBlock();
        fenced = false;
        executableFence = false;
      } else {
        fenced = true;
        executableFence = ["sh", "bash", "shell", "zsh", "fish", "powershell", "pwsh", "cmd"].includes(
          (fence[1] ?? "").toLowerCase(),
        );
      }
      continue;
    }
    if (fenced && executableFence) {
      shellBlock.push({ text: line, line: index + 1 });
      continue;
    }
    if (!fenced) {
      for (const match of line.matchAll(/`([^`\r\n]+)`/gu)) {
        const invocation = tokenize(match[1] ?? "");
        const executable = stripEnvironmentPrefix(invocation)[0];
        // Unlike a shell command, inline code may name a script by path (`./run.sh`), so only characters no
        // command name or path holds rule a span out before the filesystem lookup.
        if (
          executable === undefined || !/^[A-Za-z0-9._+~/\\-]+$/u.test(executable) || SHELL_WORDS[executable] === true
          || !(await context.installed(executable))
        ) continue;
        const record = await invocationEvidence(
          context,
          invocation,
          { kind: "line", line: index + 1, column: (match.index ?? 0) + 1 },
          false,
        );
        if (record !== undefined) evidence.push(record);
      }
      for (const match of line.matchAll(/(?:^|[\s("'`])(?:\.\/)?skills\/([A-Za-z0-9._-]+)\/SKILL\.md/giu)) {
        const id = (match[1] ?? "").toLowerCase();
        if (id.length === 0) continue;
        const record: ToolDiscoveryEvidence = {
          sourcePath: context.sourcePath,
          location: { kind: "line", line: index + 1, column: (match.index ?? 0) + 1 },
          kind: "prose",
          invocation: [`skills/${id}/SKILL.md`],
          confidence: "review",
          reviewStatus: "needs-review",
        };
        skills.set(id, {
          kind: "skill",
          id,
          sourcePath: context.sourcePath,
          evidence: [record],
          reviewStatus: "needs-review",
        });
      }
    }
  }
  await flushShellBlock();
  return { evidence, skills: [...skills.values()] };
};

const JsonObject = Schema.Record(Schema.String, Schema.MutableJson);

const jsonObject = (value: JsonValue): { readonly [key: string]: JsonValue } | undefined =>
  Schema.is(JsonObject)(value) ? value : undefined;

const jsonString = (value: JsonValue | undefined): string | undefined =>
  Schema.is(Schema.String)(value) ? value : undefined;

const JsonStringArray = Schema.Array(Schema.String);
const JsonCommandArray = Schema.Array(JsonStringArray);

/**
 * Inspect enablement before commands, nested records, or credential-shaped data.
 *
 * Discovery walks schema-less configuration, so an object is either a record
 * with known fields or a dictionary keyed by names the author chose. "enabled"
 * and "disabled" are legal names for an MCP server and for an npm dependency,
 * so a nonboolean value at those keys is only a parse failure on a record that
 * declares a command or executable of its own. Everywhere else the key is an
 * ordinary child entry and the caller keeps walking it.
 */
const entryIsEnabled = (
  entry: { readonly [key: string]: JsonValue },
  strict: boolean,
): boolean => {
  if (entry.enabled === false || entry.disabled === true) return false;
  if (!strict) return true;
  for (const key of ["enabled", "disabled"]) {
    if (entry[key] !== undefined && !Schema.is(Schema.Boolean)(entry[key])) {
      // Do not include the entry, field value, or command in a parse failure.
      throw new Error("enabled and disabled fields must be booleans");
    }
  }
  return true;
};

const lineForField = (text: string, field: string): number | undefined => {
  const quoted = `"${field.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const index = text.indexOf(quoted);
  if (index < 0) return undefined;
  return text.slice(0, index).split(/\r?\n/u).length;
};

const repositoryUrl = (value: JsonValue | undefined): string | undefined => {
  const direct = jsonString(value);
  if (direct !== undefined) return direct.replace(/^git\+/u, "");
  const object = value === undefined ? undefined : jsonObject(value);
  return jsonString(object?.url)?.replace(/^git\+/u, "");
};

const supportedEcosystems = ["npm", "homebrew", "winget", "uv", "cargo", "source"];

const explicitMetadata = (
  value: JsonValue,
  sourcePath: string,
): DiscoveredPackageMetadata | undefined => {
  const object = jsonObject(value);
  if (object === undefined) return undefined;
  const ecosystem = jsonString(object.ecosystem);
  const name = jsonString(object.name);
  const source = jsonString(object.source);
  if (
    ecosystem === undefined
    || !supportedEcosystems.includes(ecosystem)
    || name === undefined
  ) {
    return undefined;
  }
  const buildCommands = Schema.is(JsonCommandArray)(object.buildCommands)
    ? object.buildCommands
    : undefined;
  const buildPolicy = Schema.is(BuildPolicySchema)(object.buildPolicy)
    ? object.buildPolicy
    : undefined;
  const indexPolicy = Schema.is(RecipeIndexPolicy)(object.indexPolicy)
    ? object.indexPolicy
    : undefined;
  // SAFETY: ecosystem has been checked against every PackageEcosystem literal.
  const checkedEcosystem = Schema.decodeUnknownSync(
    Schema.Literals(["npm", "homebrew", "winget", "uv", "cargo", "source"]),
  )(ecosystem);
  return {
    ecosystem: checkedEcosystem,
    name,
    version: jsonString(object.version),
    source: source ?? `${sourcePath}#canonfig.tools`,
    integrity: jsonString(object.integrity),
    indexPolicy,
    upstream: jsonString(object.upstream),
    buildCommands,
    buildPolicy,
  };
};

const scanPackageJson = (
  context: EvidenceContext,
  text: string,
  value: JsonValue,
): ReadonlyArray<ToolDiscoveryEvidence> => {
  const object = jsonObject(value);
  // A disabled ancestor excludes its whole subtree, including bin entries that
  // the recursive command walker never reaches.
  if (object === undefined || !entryIsEnabled(object, false)) return [];
  const records: Array<ToolDiscoveryEvidence> = [];
  const name = jsonString(object.name);
  const version = jsonString(object.version);
  const bin = object.bin;
  const upstream = repositoryUrl(object.repository) ?? (
    jsonString(object.homepage)
  );
  const binString = jsonString(bin);
  const binEntries = binString !== undefined && name !== undefined
    ? [[name, binString] as const]
    : Object.entries(bin === undefined ? {} : jsonObject(bin) ?? {})
      .filter((entry): entry is [string, string] => Schema.is(Schema.String)(entry[1]));
  for (const [executable] of binEntries) {
    const packageMetadata: DiscoveredPackageMetadata = {
      ecosystem: "npm",
      name: name ?? executable,
      version,
      source: context.sourcePath,
      upstream,
    };
    records.push({
      sourcePath: context.sourcePath,
      location: {
        kind: "field",
        field: `bin.${executable}`,
        line: lineForField(text, executable),
      },
      kind: "package-metadata",
      invocation: [executable],
      package: packageMetadata,
      upstream,
      confidence: version === undefined ? "strong" : "deterministic",
      reviewStatus: "accepted",
    });
  }
  const canonfig = object.canonfig === undefined ? undefined : jsonObject(object.canonfig);
  // canonfig owns this record, so its enablement is strict and gates every tool.
  const tools = canonfig !== undefined && entryIsEnabled(canonfig, true) ? canonfig.tools : undefined;
  if (Array.isArray(tools)) {
    for (let index = 0; index < tools.length; index += 1) {
      const tool = jsonObject(tools[index]!);
      if (tool !== undefined && !entryIsEnabled(tool, true)) continue;
      const metadata = explicitMetadata(tools[index]!, context.sourcePath);
      if (metadata === undefined) {
        // An entry the author wrote is never dropped silently: it is kept as
        // needs-review evidence naming the fields it lacks.
        const ecosystem = jsonString(tool?.ecosystem);
        const incomplete = [
          ...(tool === undefined ? ["entry (not an object)"] : []),
          ...(tool !== undefined && (ecosystem === undefined || !supportedEcosystems.includes(ecosystem))
            ? [ecosystem === undefined ? "ecosystem" : `ecosystem (unsupported: ${ecosystem})`]
            : []),
          ...(tool !== undefined && jsonString(tool.name) === undefined ? ["name"] : []),
        ];
        const upstream = jsonString(tool?.upstream);
        records.push({
          sourcePath: context.sourcePath,
          location: {
            kind: "field",
            field: `canonfig.tools[${index}]`,
            line: lineForField(text, "tools"),
          },
          kind: "package-metadata",
          invocation: [
            jsonString(tool?.executable) ?? jsonString(tool?.id) ?? jsonString(tool?.name)
              ?? `canonfig-tools-${index}`,
          ],
          incomplete,
          upstream,
          confidence: "review",
          reviewStatus: "needs-review",
        });
        continue;
      }
      if (tool === undefined) continue;
      const executable = jsonString(tool.executable) ?? metadata.name;
      records.push({
        sourcePath: context.sourcePath,
        location: {
          kind: "field",
          field: `canonfig.tools[${index}]`,
          line: lineForField(text, "tools"),
        },
        kind: "package-metadata",
        invocation: [executable],
        package: metadata,
        upstream: metadata.upstream,
        confidence: metadata.version === undefined ? "strong" : "deterministic",
        reviewStatus: "accepted",
      });
    }
  }
  return records;
};

const scanPackageLock = (
  context: EvidenceContext,
  text: string,
  value: JsonValue,
): ReadonlyArray<ToolDiscoveryEvidence> => {
  const object = jsonObject(value);
  const packages = object?.packages === undefined ? undefined : jsonObject(object.packages);
  if (packages === undefined) return [];
  const records: Array<ToolDiscoveryEvidence> = [];
  for (const [packagePath, packageValue] of Object.entries(packages).sort(([left], [right]) =>
    compareText(left, right)
  )) {
    const packageObject = jsonObject(packageValue);
    if (packageObject === undefined) continue;
    const name = jsonString(packageObject.name)
      ?? packagePath.slice(packagePath.lastIndexOf("node_modules/") + "node_modules/".length);
    const version = jsonString(packageObject.version);
    const bin = packageObject.bin;
    const binString = jsonString(bin);
    const binEntries = binString === undefined
      ? Object.entries(bin === undefined ? {} : jsonObject(bin) ?? {})
        .filter((entry): entry is [string, string] => Schema.is(Schema.String)(entry[1]))
      : [[name, binString] as const];
    for (const [executable] of binEntries) {
      const metadata: DiscoveredPackageMetadata = {
        ecosystem: "npm",
        name,
        version,
        source: jsonString(packageObject.resolved) ?? `${context.sourcePath}#packages.${packagePath}`,
        integrity: jsonString(packageObject.integrity),
      };
      records.push({
        sourcePath: context.sourcePath,
        location: {
          kind: "field",
          field: `packages.${packagePath}.bin.${executable}`,
          line: lineForField(text, executable),
        },
        kind: "package-metadata",
        invocation: [executable],
        package: metadata,
        confidence: version === undefined ? "strong" : "deterministic",
        reviewStatus: "accepted",
      });
    }
  }
  return records;
};

interface CommandField {
  readonly command: ReadonlyArray<string>;
  readonly field: string;
  readonly kind: DiscoverySourceKind;
}

const collectJsonCommands = (
  value: JsonValue,
  path: string,
  inheritedKind: DiscoverySourceKind,
): ReadonlyArray<CommandField> => {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectJsonCommands(entry, `${path}[${index}]`, inheritedKind));
  }
  const object = jsonObject(value);
  const isRecord = object?.command !== undefined || object?.executable !== undefined;
  if (object === undefined || !entryIsEnabled(object, isRecord)) return [];
  const lowered = path.toLowerCase();
  const kind: DiscoverySourceKind = lowered.includes("hook")
    ? "hook"
    : lowered.includes("mcp") || lowered.includes("server")
      ? "mcp"
      : inheritedKind;
  const commandValue = object.command;
  const args = Array.isArray(object.args)
    ? object.args.filter((entry): entry is string => Schema.is(Schema.String)(entry))
    : [];
  const direct: Array<CommandField> = [];
  const commandString = jsonString(commandValue);
  if (commandString !== undefined) {
    // MCP command is an executable, not a shell program. Preserve Windows
    // separators and spaces even when discovery runs on another platform.
    const command = kind === "mcp" ? [commandString, ...args] : [...tokenize(commandString), ...args];
    direct.push({ command, field: `${path}.command`, kind });
  } else if (Schema.is(JsonStringArray)(commandValue)) {
    direct.push({ command: commandValue, field: `${path}.command`, kind });
  }
  const executable = jsonString(object.executable);
  if (executable !== undefined && object.ecosystem === undefined) {
    direct.push({
      command: [executable, ...args],
      field: `${path}.executable`,
      kind: "executable-reference",
    });
  }
  return [
    ...direct,
    ...Object.entries(object)
      .filter(([key]) => key !== "command" && key !== "args" && key !== "executable")
      .flatMap(([key, entry]) => collectJsonCommands(entry, path.length === 0 ? key : `${path}.${key}`, kind)),
  ];
};

const scanJson = async (
  context: EvidenceContext,
  text: string,
): Promise<ReadonlyArray<ToolDiscoveryEvidence>> => {
  let value: JsonValue;
  try {
    value = parseJsonc(text);
  } catch (cause) {
    throw new DiscoveryParseError({
      path: context.sourcePath,
      format: "json",
      reason: String(cause),
    });
  }
  const file = basename(context.sourcePath).toLowerCase();
  const packageRecords = file === "package.json"
    ? scanPackageJson(context, text, value)
    : file === "package-lock.json"
      ? scanPackageLock(context, text, value)
      : [];
  const commandRecords = await Promise.all(
    collectJsonCommands(value, "", sourceKindFor(context.fileKind, true))
      .map(async ({ command, field, kind }) =>
        invocationEvidence(
          context,
          command,
          { kind: "field", field },
          true,
          kind,
        )
      ),
  );
  return [...packageRecords, ...commandRecords.filter((record) => record !== undefined)];
};

const tomlString = (value: JsonValue | undefined): string | undefined =>
  jsonString(value);

const scanToml = async (
  context: EvidenceContext,
  text: string,
): Promise<ReadonlyArray<ToolDiscoveryEvidence>> => {
  let parsed: JsonValue;
  try {
    parsed = Schema.decodeUnknownSync(Schema.MutableJson)(parseToml(text));
  } catch (cause) {
    throw new DiscoveryParseError({
      path: context.sourcePath,
      format: "toml",
      reason: String(cause),
    });
  }
  const object = jsonObject(parsed);
  if (object === undefined) return [];
  const records: Array<ToolDiscoveryEvidence> = [];
  const file = basename(context.sourcePath).toLowerCase();
  if (file === "cargo.toml") {
    const packageObject = object.package === undefined ? undefined : jsonObject(object.package);
    const name = tomlString(packageObject?.name);
    if (name !== undefined) {
      const upstream = tomlString(packageObject?.repository) ?? tomlString(packageObject?.homepage);
      const version = tomlString(packageObject?.version);
      const packageMetadata: DiscoveredPackageMetadata = {
        ecosystem: "cargo",
        name,
        version,
        source: context.sourcePath,
        upstream,
      };
      records.push({
        sourcePath: context.sourcePath,
        location: { kind: "field", field: "package.name", line: lineForField(text, "name") },
        kind: "package-metadata",
        invocation: [name],
        package: packageMetadata,
        upstream,
        confidence: version === undefined ? "strong" : "deterministic",
        reviewStatus: "accepted",
      });
    }
  }
  if (file === "pyproject.toml") {
    const project = object.project === undefined ? undefined : jsonObject(object.project);
    const scripts = project?.scripts === undefined ? undefined : jsonObject(project.scripts);
    const name = tomlString(project?.name);
    for (const executable of Object.keys(scripts ?? {}).sort(compareText)) {
      const urls = project?.urls === undefined ? undefined : jsonObject(project.urls);
      const upstream = tomlString(urls?.Homepage) ?? tomlString(urls?.Repository);
      const version = tomlString(project?.version);
      const packageMetadata: DiscoveredPackageMetadata = {
        ecosystem: "uv",
        name: name ?? executable,
        version,
        source: context.sourcePath,
        upstream,
      };
      records.push({
        sourcePath: context.sourcePath,
        location: { kind: "field", field: `project.scripts.${executable}`, line: lineForField(text, executable) },
        kind: "package-metadata",
        invocation: [executable],
        package: packageMetadata,
        upstream,
        confidence: version === undefined ? "strong" : "deterministic",
        reviewStatus: "accepted",
      });
    }
  }
  const commandRecords = await Promise.all(
    collectJsonCommands(parsed, "", sourceKindFor(context.fileKind, true))
      .map(async ({ command, field, kind }) =>
        invocationEvidence(context, command, { kind: "field", field }, true, kind)
      ),
  );
  return [...records, ...commandRecords.filter((record) => record !== undefined)];
};

const scanLineMetadata = (
  context: EvidenceContext,
  text: string,
): ReadonlyArray<ToolDiscoveryEvidence> => {
  const records: Array<ToolDiscoveryEvidence> = [];
  const file = basename(context.sourcePath).toLowerCase();
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (file === "brewfile") {
      const match = /^\s*brew\s+["']([^"']+)["'](?:\s*,\s*version:\s*["']([^"']+)["'])?/u.exec(line);
      if (match !== null) {
        const packageMetadata: DiscoveredPackageMetadata = {
          ecosystem: "homebrew",
          name: match[1]!,
          version: match[2],
          source: context.sourcePath,
        };
        records.push({
          sourcePath: context.sourcePath,
          location: { kind: "line", line: index + 1 },
          kind: "package-metadata",
          invocation: [match[1]!],
          package: packageMetadata,
          confidence: match[2] === undefined ? "strong" : "deterministic",
          reviewStatus: "accepted",
        });
      }
    }
    const field = /^\s*(PackageIdentifier|PackageVersion|PackageUrl):\s*(.+?)\s*$/u.exec(line);
    if (field !== null) {
      // Winget fields are assembled after all lines have been read.
      continue;
    }
  }
  if (file.includes("winget") || extname(context.sourcePath).toLowerCase() === ".yaml" || extname(context.sourcePath).toLowerCase() === ".yml") {
    const identifier = /^\s*PackageIdentifier:\s*(.+?)\s*$/mu.exec(text)?.[1];
    const version = /^\s*PackageVersion:\s*(.+?)\s*$/mu.exec(text)?.[1];
    const upstream = /^\s*PackageUrl:\s*(.+?)\s*$/mu.exec(text)?.[1];
    if (identifier !== undefined) {
      const packageMetadata: DiscoveredPackageMetadata = {
        ecosystem: "winget",
        name: identifier,
        version,
        source: context.sourcePath,
        upstream,
      };
      records.push({
        sourcePath: context.sourcePath,
        location: {
          kind: "field",
          field: "PackageIdentifier",
          line: text.slice(0, text.indexOf("PackageIdentifier")).split(/\r?\n/u).length,
        },
        kind: "package-metadata",
        invocation: [identifier],
        package: packageMetadata,
        upstream,
        confidence: version === undefined ? "strong" : "deterministic",
        reviewStatus: "accepted",
      });
    }
  }
  return records;
};

const scanShell = async (
  context: EvidenceContext,
  text: string,
): Promise<ReadonlyArray<ToolDiscoveryEvidence>> => {
  const lines = text.split(/\r?\n/u).map((line, index) => ({ text: line, line: index + 1 }));
  return shellEvidence(context, lines, shellFunctionNames(text), context.fileKind === "hooks" ? "hook" : undefined);
};

const scanOne = (
  file: DiscoveryFile,
  pathValue: string,
  installed: (executable: string) => Promise<boolean>,
): Effect.Effect<{
  readonly path: string;
  readonly evidence: ReadonlyArray<ToolDiscoveryEvidence>;
  readonly skills: ReadonlyArray<DiscoveredSkill>;
}, ProfileCatalogScanError> =>
  Effect.gen(function*() {
    const path = resolve(file.path);
    const text = yield* readDiscoveryFile(path);
    const fileKind = file.kind ?? inferFileKind(path);
    const context: EvidenceContext = { sourcePath: path, fileKind, pathValue, installed };
    if (fileKind === "agents" || extname(path).toLowerCase() === ".md") {
      const result = yield* Effect.promise(() => scanMarkdown(context, text));
      return { path, ...result };
    }
    const extension = extname(path).toLowerCase();
    if (extension === ".json" || extension === ".jsonc") {
      const evidence = yield* Effect.tryPromise({
        try: () => scanJson(context, text),
        catch: (cause) => cause instanceof DiscoveryParseError
          ? cause
          : new DiscoveryParseError({ path, format: "json", reason: String(cause) }),
      });
      return { path, evidence, skills: [] };
    }
    if (extension === ".toml") {
      const evidence = yield* Effect.tryPromise({
        try: () => scanToml(context, text),
        catch: (cause) => cause instanceof DiscoveryParseError
          ? cause
          : new DiscoveryParseError({ path, format: "toml", reason: String(cause) }),
      });
      return { path, evidence, skills: [] };
    }
    if ([".sh", ".bash", ".zsh", ".fish", ".ps1", ".cmd"].includes(extension)) {
      const evidence = yield* Effect.promise(() => scanShell(context, text));
      return { path, evidence, skills: [] };
    }
    return { path, evidence: scanLineMetadata(context, text), skills: [] };
  });

export const scanDiscovery = (
  input: DiscoveryScanInput,
): Effect.Effect<DiscoveryScanResult, ProfileCatalogScanError> => {
  if (input.files.length === 0) {
    return Effect.fail(new InvalidDiscoveryInputError({ reason: "at least one discovery file is required" }));
  }
  // Without an explicit PATH, also search the running Node's folder and ~/.local/bin, where npm and uv install
  // tools: a Canonfig started by a service manager often lacks them on PATH. An explicit PATH is used as given.
  const pathValue = input.path ?? [process.env.PATH ?? "", dirname(process.execPath), join(homedir(), ".local", "bin")].join(delimiter);
  const installed = installedLookup(pathValue);
  const files = [...input.files].sort((left, right) => compareText(resolve(left.path), resolve(right.path)));
  return Effect.forEach(files, (file) => scanOne(file, pathValue, installed), { concurrency: 4 }).pipe(
    Effect.map((scans) => {
      const catalog = buildToolCatalog(
        scans.flatMap((scan) => scan.evidence),
        scans.flatMap((scan) => scan.skills),
        input.agentTaskBounds,
      );
      return {
        ...catalog,
        scannedPaths: scans.map((scan) => scan.path).sort(compareText),
      };
    }),
  );
};

export interface FolderScanInput {
  /** The Canonical Folder, `~/.canonfig/`. */
  readonly folder: string;
  /** Insert accepted tools that `canonfig.jsonc` does not declare yet. */
  readonly write: boolean;
  readonly path?: string | undefined;
}

export interface FolderScanResult extends DiscoveryScanResult {
  /** Accepted tools `--write` inserted into `canonfig.jsonc`. */
  readonly written: ReadonlyArray<string>;
  /** Accepted tools `canonfig.jsonc` already declares; their entries stay as authored. */
  readonly declared: ReadonlyArray<string>;
}

const folderFailure = (path: string, operation: "read" | "write", cause: unknown) =>
  cause instanceof CanonicalFolderError
    ? new InvalidDiscoveryInputError({ reason: `${cause.path} ${cause.message}` })
    : new DiscoveryFilesystemError({ path, operation, reason: String(cause) });

/**
 * The folder's authored files: instructions, rules, agents, commands, skills,
 * hook scripts and `canonfig.jsonc` (for MCP commands). `local/` and
 * everything machine-local are not read.
 */
const folderScanFiles = async (folder: string): Promise<ReadonlyArray<DiscoveryFile>> => {
  const files: Array<string> = [];
  for (const name of ["AGENTS.md", "canonfig.jsonc"]) {
    const found = await stat(join(folder, name)).catch(() => undefined);
    if (found?.isFile() === true) files.push(name);
  }
  for (const directory of ["rules", "agents", "commands", "skills", "hooks"]) {
    files.push(...(await listFolderFiles(folder, directory)).map((file) => `${directory}/${file.path}`));
  }
  return files.map((path) => ({ path: join(folder, ...path.split("/")) }));
};

/**
 * `canonfig source scan`: discover the tools the Canonical Folder invokes.
 * Nothing runs. With `write`, each accepted tool that `canonfig.jsonc` does
 * not declare yet is inserted under `tools`, keeping the file's comments and
 * layout; tools that need review are only reported.
 */
export const scanFolder = (
  input: FolderScanInput,
): Effect.Effect<FolderScanResult, ProfileCatalogScanError> =>
  Effect.gen(function*() {
    const configPath = join(input.folder, "canonfig.jsonc");
    const files = yield* Effect.tryPromise({
      try: () => folderScanFiles(input.folder),
      catch: (cause) => folderFailure(input.folder, "read", cause),
    });
    if (files.length === 0) {
      return yield* new InvalidDiscoveryInputError({
        reason: `${input.folder} holds no authored files; scaffold it with 'canonfig setup plan --role source'`,
      });
    }
    const result = yield* scanDiscovery({ files, path: input.path });
    const config = yield* Effect.tryPromise({
      try: () => readFolderConfig(input.folder),
      catch: (cause) => folderFailure(configPath, "read", cause),
    });
    const declaredIds = new Set(Object.keys(config?.tools ?? {}));
    const accepted = result.tools.filter((tool) => tool.reviewStatus === "accepted");
    const declared = accepted.filter((tool) => declaredIds.has(tool.id)).map((tool) => tool.id);
    const fresh = accepted.filter((tool) => !declaredIds.has(tool.id));
    if (!input.write || fresh.length === 0) return { ...result, written: [], declared };
    if (config === undefined) {
      return yield* new InvalidDiscoveryInputError({ reason: `${configPath} does not exist; --write adds tools to it` });
    }
    const text = yield* readDiscoveryFile(configPath);
    const updated = yield* Effect.try({
      try: () => {
        const edited = fresh.reduce(
          (current, tool) => setJsoncValue(current, ["tools", tool.id], Schema.decodeUnknownSync(Schema.Json)(asJson(folderToolEntry(tool)))),
          text,
        );
        // The edited file must still be a valid canonfig.jsonc.
        decodeFolderConfig(configPath, edited);
        return edited;
      },
      catch: (cause) => cause instanceof CanonicalFolderError
        ? new InvalidDiscoveryInputError({ reason: `the discovered tools would make ${cause.path} invalid: ${cause.message}` })
        : new InvalidDiscoveryInputError({ reason: `${configPath} could not be edited: ${String(cause)}` }),
    });
    yield* Effect.tryPromise({
      try: async () => {
        const temporary = `${configPath}.canonfig-scan-${process.pid}`;
        await writeFile(temporary, updated, { mode: 0o600 });
        await rename(temporary, configPath);
      },
      catch: (cause) => folderFailure(configPath, "write", cause),
    });
    return { ...result, written: fresh.map((tool) => tool.id), declared };
  });
