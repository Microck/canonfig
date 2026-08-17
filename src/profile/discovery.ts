import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { basename, delimiter, extname, join, resolve } from "node:path";

import { Effect, Schema } from "effect";
import { parse as parseToml } from "smol-toml";

import { BuildPolicy as BuildPolicySchema } from "../domain/resource.ts";
import { parseNpmPackageSpecification } from "../domain/npm-package-spec.ts";
import { parseJsonc, type JsonValue } from "./profile-codec.ts";
import {
  DiscoveryFilesystemError,
  DiscoveryParseError,
  InvalidDiscoveryInputError,
  type ProfileCatalogScanError,
} from "./profile-catalog.errors.ts";
import {
  buildToolCatalog,
  type DiscoveredPackageMetadata,
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

const executablePath = async (
  executable: string,
  pathValue: string,
): Promise<string | undefined> => {
  if (executable.includes("/") || executable.includes("\\")) {
    const absolute = resolve(executable);
    try {
      await access(absolute, constants.X_OK);
      const details = await stat(absolute);
      return details.isFile() ? absolute : undefined;
    } catch {
      return undefined;
    }
  }
  for (const entry of pathValue.split(delimiter).filter((value) => value.length > 0)) {
    const candidate = join(entry, executable);
    try {
      await access(candidate, constants.X_OK);
      const details = await stat(candidate);
      if (details.isFile()) return candidate;
    } catch {
      // A missing or non-executable candidate means resolution continues.
    }
  }
  return undefined;
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
    const specification = executable === "uvx"
      ? tokens.find((token, index) => index > 0 && !token.startsWith("-"))
      : positionalAfter(tokens, ["install"]);
    if (specification === undefined) return undefined;
    if (isUnboundedPackageSpecification(specification)) return undefined;
    const parsed = packageSpecification(specification, "==");
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
  const resolvedExecutable = deterministic
    ? await executablePath(executable, context.pathValue)
    : undefined;
  return {
    sourcePath: context.sourcePath,
    location,
    kind: kindOverride ?? sourceKindFor(context.fileKind, deterministic),
    invocation: tokens,
    resolvedExecutable,
    package: packageMetadata,
    confidence: deterministic
      ? packageMetadata === undefined && resolvedExecutable === undefined ? "strong" : "deterministic"
      : "review",
    reviewStatus: deterministic ? "accepted" : "needs-review",
  };
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
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fence = /^\s*```([A-Za-z0-9_-]*)/u.exec(line);
    if (fence !== null) {
      if (fenced) {
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
      const commands = line
        .split(/\s*(?:&&|\|\||;|\|)\s*/u)
        .map(tokenize)
        .filter((tokens) => tokens.length > 0 && !tokens[0]!.startsWith("#"));
      for (const invocation of commands) {
        const record = await invocationEvidence(
          context,
          invocation,
          { kind: "line", line: index + 1 },
          true,
        );
        if (record !== undefined) evidence.push(record);
      }
      continue;
    }
    if (!fenced) {
      for (const match of line.matchAll(/`([^`\r\n]+)`/gu)) {
        const invocation = tokenize(match[1] ?? "");
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
  return { evidence, skills: [...skills.values()] };
};

const JsonObject = Schema.Record(Schema.String, Schema.MutableJson);

const jsonObject = (value: JsonValue): { readonly [key: string]: JsonValue } | undefined =>
  Schema.is(JsonObject)(value) ? value : undefined;

const jsonString = (value: JsonValue | undefined): string | undefined =>
  Schema.is(Schema.String)(value) ? value : undefined;

const JsonStringArray = Schema.Array(Schema.String);
const JsonCommandArray = Schema.Array(JsonStringArray);

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
    || !["npm", "homebrew", "winget", "uv", "cargo", "source"].includes(ecosystem)
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
  // SAFETY: ecosystem has been checked against every PackageEcosystem literal.
  const checkedEcosystem = Schema.decodeUnknownSync(
    Schema.Literals(["npm", "homebrew", "winget", "uv", "cargo", "source"]),
  )(ecosystem);
  return {
    ecosystem: checkedEcosystem,
    name,
    version: jsonString(object.version),
    source: source ?? `${sourcePath}#canonfig.tools`,
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
  if (object === undefined) return [];
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
  const tools = canonfig?.tools;
  if (Array.isArray(tools)) {
    for (let index = 0; index < tools.length; index += 1) {
      const metadata = explicitMetadata(tools[index]!, context.sourcePath);
      const tool = jsonObject(tools[index]!);
      if (metadata === undefined || tool === undefined) continue;
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
  if (object === undefined) return [];
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
    direct.push({ command: [...tokenize(commandString), ...args], field: `${path}.command`, kind });
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
  const records: Array<ToolDiscoveryEvidence> = [];
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.length === 0 || line.startsWith("#")) continue;
    const invocations = line
      .split(/\s*(?:&&|\|\||;|\|)\s*/u)
      .map(tokenize)
      .filter((tokens) => tokens.length > 0);
    for (const invocation of invocations) {
      const record = await invocationEvidence(
        context,
        invocation,
        { kind: "line", line: index + 1 },
        true,
        context.fileKind === "hooks" ? "hook" : undefined,
      );
      if (record !== undefined) records.push(record);
    }
  }
  return records;
};

const scanOne = (
  file: DiscoveryFile,
  pathValue: string,
): Effect.Effect<{
  readonly path: string;
  readonly evidence: ReadonlyArray<ToolDiscoveryEvidence>;
  readonly skills: ReadonlyArray<DiscoveredSkill>;
}, ProfileCatalogScanError> =>
  Effect.gen(function*() {
    const path = resolve(file.path);
    const text = yield* readDiscoveryFile(path);
    const fileKind = file.kind ?? inferFileKind(path);
    const context: EvidenceContext = { sourcePath: path, fileKind, pathValue };
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
  const pathValue = input.path ?? process.env.PATH ?? "";
  const files = [...input.files].sort((left, right) => compareText(resolve(left.path), resolve(right.path)));
  return Effect.forEach(files, (file) => scanOne(file, pathValue), { concurrency: 4 }).pipe(
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
