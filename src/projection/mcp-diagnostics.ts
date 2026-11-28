import { constants as filesystemConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { win32 } from "node:path";

import { Effect, Predicate } from "effect";

import { redactText } from "../cli/redaction.ts";
import type { Platform } from "../domain/resource.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import {
  containsLiteralCredential,
  isEnvironmentReference,
  isSecretField,
} from "../secrets/credential-policy.ts";
import type { FolderMcpServer, FolderTool } from "./folder.ts";
import type { Diagnostic, RootContext } from "./harness.ts";
import { pathsFor } from "./layout-metadata.ts";
import { isMcpProxyAuthorization } from "./mcp-launcher.ts";
import { TARGET_IDS, type McpServer, type SecretValue, type StoredSecretReference, type TargetId } from "./model.ts";

/**
 * Shared non-blocking diagnostics for MCP overlays, `preserveMcp` locks, and
 * stdio MCP command availability. Used by both `canonfig sync --plan` /
 * `sync --apply` (via `projectSurfaces`) and `canonfig doctor` (via the
 * `mcp-config` probe) so CLI and GUI surface identical warnings.
 */
export interface McpDiagnosticInput {
  /** Listed harnesses in `canonfig.jsonc` minus local `excludeHarnesses`. */
  readonly harnesses: ReadonlyArray<TargetId>;
  /** Harnesses whose native MCP configuration is preserved via `local/local.jsonc`. */
  readonly preserveMcp: ReadonlySet<TargetId>;
  /** Published MCP entries from `canonfig.jsonc`, including `enabled: false`. */
  readonly publishedMcp: Readonly<Record<string, FolderMcpServer>>;
  /** Admitted local MCP entries from `local/local.jsonc` (when `local.allow` admits `mcp`). */
  readonly localMcp: Readonly<Record<string, FolderMcpServer>>;
  /** All local MCP entries in `local/local.jsonc`, even when not admitted, for plaintext secret checks. */
  readonly rawLocalMcp: Readonly<Record<string, FolderMcpServer>>;
  /** Effective enabled MCP servers after merging published and admitted local overlays, sorted by name. */
  readonly effectiveMcp: ReadonlyArray<readonly [string, McpServer]>;
  /** Declared tool entries from `canonfig.jsonc` (`tools.<id>`). */
  readonly tools: Readonly<Record<string, FolderTool>>;
}

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/u;
const WINDOWS_UNC_PATH = /^\\\\[^\\/\s]+\\[^\\/\s]+/u;
const UNIX_ROOT_PREFIX = /^\/(?:home|Users|opt|usr|etc|var|bin|sbin|lib|root|tmp|private|Library|Applications|System|Volumes|nix|snap|run)(?:\/|$)/u;
const MACOS_ONLY_PREFIX = /^\/(?:Users|Applications|Library|Volumes|System\/Library|opt\/homebrew)(?:\/|$)/u;
const LINUX_ONLY_PREFIX = /^\/(?:home|snap)(?:\/|$)/u;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
const FLAG_ASSIGNMENT = /^(--?[A-Za-z0-9][A-Za-z0-9._-]*)=(.+)$/u;
const ENV_TEMPLATE = /\$\{|\{env:|\$[A-Za-z_]/u;
const AUTH_SCHEME_LITERAL = /^(?:Bearer|Basic|Token)\s+\S+/iu;
const KNOWN_TOKEN_PREFIX = /^(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|pk_(?:live|test)_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|apify_api_[A-Za-z0-9]{10,}|npm_[A-Za-z0-9]{16,}|pypi-[A-Za-z0-9_-]{16,}|glpat-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})$/u;

const byName = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const isStoredSecret = (value: SecretValue | undefined): value is StoredSecretReference =>
  value !== undefined && !Predicate.isString(value) && "fromSecret" in value;

const isWindowsPath = (candidate: string): boolean =>
  WINDOWS_DRIVE_PATH.test(candidate) || WINDOWS_UNC_PATH.test(candidate);

const isPosixAbsolutePath = (candidate: string): boolean =>
  UNIX_ROOT_PREFIX.test(candidate);

interface FlagAssignment {
  readonly flag?: string | undefined;
  readonly candidate: string;
}

const splitFlagAssignment = (value: string): FlagAssignment => {
  const trimmed = value.trim();
  const match = FLAG_ASSIGNMENT.exec(trimmed);
  if (match === null) return { candidate: trimmed };
  return { flag: match[1]!.replace(/^-+/u, ""), candidate: match[2]! };
};

/**
 * Returns the foreign-OS path inside `value` if it clearly targets another
 * operating system than `platform`, or undefined otherwise.
 */
export const foreignOsPath = (value: string, platform: Platform): string | undefined => {
  const { candidate } = splitFlagAssignment(value);
  if (candidate.length === 0 || URL_SCHEME.test(candidate)) return undefined;
  if (platform === "windows") return isPosixAbsolutePath(candidate) ? candidate : undefined;
  if (isWindowsPath(candidate)) return candidate;
  if (platform === "linux" && MACOS_ONLY_PREFIX.test(candidate)) return candidate;
  if (platform === "macos" && LINUX_ONLY_PREFIX.test(candidate)) return candidate;
  return undefined;
};

const hasPlatformSpecificPath = (server: FolderMcpServer): boolean => {
  if (server.transport !== "stdio") return false;
  const values = [server.command, ...(server.args ?? []), ...(server.cwd === undefined ? [] : [server.cwd])];
  return values.some((value) => {
    const { candidate } = splitFlagAssignment(value);
    if (candidate.length === 0 || URL_SCHEME.test(candidate)) return false;
    return isWindowsPath(candidate) || isPosixAbsolutePath(candidate);
  });
};

/** Remote MCPs and stdio MCPs without OS-specific absolute paths are cross-platform. */
const isCrossPlatformPublishedMcp = (server: FolderMcpServer): boolean =>
  server.transport !== "stdio" || !hasPlatformSpecificPath(server);

const isPlaintextCredentialValue = (fieldName: string, rawValue: string): boolean => {
  const value = rawValue.trim();
  if (value.length === 0 || value === "[REDACTED]" || isEnvironmentReference(value)) return false;
  if (isMcpProxyAuthorization(value)) return false;
  if (AUTH_SCHEME_LITERAL.test(value)) return true;
  if (isSecretField(fieldName)) return true;
  if (KNOWN_TOKEN_PREFIX.test(value)) return true;
  return containsLiteralCredential(value);
};

const findHeaderCaseInsensitive = (
  headers: Readonly<Record<string, SecretValue>> | undefined,
  target: string,
): SecretValue | undefined => {
  if (headers === undefined) return undefined;
  if (Object.hasOwn(headers, target)) return headers[target];
  const lower = target.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
};

const droppedFromSecretFields = (
  published: FolderMcpServer,
  local: FolderMcpServer,
): { readonly kind: "env" | "headers"; readonly fields: ReadonlyArray<string> } | undefined => {
  const kind = published.transport === "stdio" ? "env" : "headers";
  const publishedMap = published.transport === "stdio" ? (published.env ?? {}) : (published.headers ?? {});
  const publishedSecrets = Object.entries(publishedMap)
    .filter((entry): entry is [string, StoredSecretReference] => isStoredSecret(entry[1]))
    .sort(([left], [right]) => byName(left, right));
  if (publishedSecrets.length === 0) return undefined;

  const dropped: Array<string> = [];
  if (published.transport === "stdio" && local.transport === "stdio") {
    const localEnv = local.env ?? {};
    for (const [field] of publishedSecrets) {
      if (!isStoredSecret(localEnv[field])) dropped.push(field);
    }
  } else if (published.transport !== "stdio" && local.transport !== "stdio") {
    for (const [field] of publishedSecrets) {
      if (!isStoredSecret(findHeaderCaseInsensitive(local.headers, field))) dropped.push(field);
    }
  } else {
    const localValues = Object.values(local.transport === "stdio" ? (local.env ?? {}) : (local.headers ?? {}));
    for (const [field, reference] of publishedSecrets) {
      const preserved = localValues.some((value) => isStoredSecret(value) && value.fromSecret === reference.fromSecret);
      if (!preserved) dropped.push(field);
    }
  }
  return dropped.length === 0 ? undefined : { kind, fields: dropped };
};

const hasInstallableRecipe = (tool: FolderTool | undefined, platform: Platform): boolean =>
  tool !== undefined
  && (tool.recipes.some((recipe) => recipe.platform === platform) || tool.agentInstall !== undefined);

const isBackedByToolsRecipe = (
  command: string,
  requires: ReadonlyArray<string> | undefined,
  tools: Readonly<Record<string, FolderTool>>,
  platform: Platform,
): boolean => {
  for (const reference of requires ?? []) {
    if (!reference.startsWith("tools/")) continue;
    if (hasInstallableRecipe(tools[reference.slice("tools/".length)], platform)) return true;
  }
  return Object.values(tools).some((tool) => tool.executable === command && hasInstallableRecipe(tool, platform));
};

const expandHomePath = (value: string, context: RootContext): string => {
  const paths = pathsFor(context.platform);
  if (value === "~") return context.home;
  if (value.startsWith("~/") || (context.platform === "windows" && value.startsWith("~\\"))) {
    return paths.join(context.home, value.slice(2));
  }
  return value;
};

const runnablePathExists = async (
  candidate: string,
  context: RootContext,
): Promise<boolean> => {
  const isRunnableFile = async (target: string): Promise<boolean> => {
    try {
      const info = await stat(target);
      if (!info.isFile()) return false;
      if (context.platform !== "windows") {
        await access(target, filesystemConstants.X_OK);
      }
      return true;
    } catch {
      return false;
    }
  };

  if (await isRunnableFile(candidate)) return true;
  if (context.platform === "windows" && win32.extname(candidate).length === 0) {
    const extensions = (context.environment("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter((extension) => extension.length > 0);
    for (const extension of extensions) {
      if (await isRunnableFile(`${candidate}${extension.toLowerCase()}`)) return true;
      if (await isRunnableFile(`${candidate}${extension.toUpperCase()}`)) return true;
    }
  }
  return false;
};

const localExecutablePathExists = async (
  command: string,
  context: RootContext,
  cwd?: string,
): Promise<boolean> => {
  const paths = pathsFor(context.platform);
  let expanded = expandHomePath(command, context);
  if (!paths.isAbsolute(expanded) && cwd !== undefined) {
    const trimmedCwd = cwd.trim();
    if (trimmedCwd.length > 0) {
      if (ENV_TEMPLATE.test(trimmedCwd)) return true;
      if (foreignOsPath(trimmedCwd, context.platform) !== undefined) return false;
      expanded = paths.resolve(expandHomePath(trimmedCwd, context), expanded);
    }
  }
  return runnablePathExists(expanded, context);
};

const serverEnvPathOverride = (
  env: Readonly<Record<string, SecretValue>> | undefined,
  platform: Platform,
): string | undefined => {
  if (env === undefined) return undefined;
  const entry = platform === "windows"
    ? Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1]
    : env.PATH;
  return Predicate.isString(entry) ? entry : undefined;
};

const bareCommandExistsOnPath = async (
  command: string,
  pathValue: string,
  context: RootContext,
): Promise<boolean> => {
  const paths = pathsFor(context.platform);
  const separator = context.platform === "windows" ? ";" : ":";
  for (const rawEntry of pathValue.split(separator)) {
    const entry = rawEntry.trim();
    if (entry.length === 0 || ENV_TEMPLATE.test(entry)) continue;
    const directory = expandHomePath(entry, context);
    if (await runnablePathExists(paths.join(directory, command), context)) return true;
  }
  return false;
};

/**
 * Inspects MCP preservation locks, local MCP overlays, and enabled stdio MCP
 * commands, returning deterministic `warning`-level diagnostics.
 */
export const diagnoseMcpConfiguration = Effect.fn("Projection.diagnoseMcpConfiguration")(function*(
  input: McpDiagnosticInput,
  context: RootContext,
): Effect.fn.Return<ReadonlyArray<Diagnostic>, never, MachineState> {
  const machine = yield* MachineState;
  const diagnostics: Array<Diagnostic> = [];

  // 1. Active preserveMcp locks
  if (input.preserveMcp.size > 0) {
    const allHarnesses = input.preserveMcp.size === TARGET_IDS.length;
    const locked = allHarnesses ? [...input.harnesses].sort(byName) : [...input.preserveMcp].sort(byName);
    const scope = allHarnesses
      ? locked.length > 0
        ? `all harnesses (${locked.join(", ")})`
        : "all harnesses"
      : locked.join(", ");
    const command = allHarnesses
      ? "canonfig local mcp project"
      : `canonfig local mcp project ${locked.map((id) => `--harness ${id}`).join(" ")}`;
    diagnostics.push({
      level: "warning",
      code: "MCP_PRESERVE_ACTIVE",
      message: `preserveMcp is active for ${scope} in local/local.jsonc; native MCP configs will not sync. Run '${command}' to resume.`,
    });
  }

  // 2. Stale disabled overlays and wrong-OS paths in admitted local MCP overlays
  const admittedLocalNames = Object.keys(input.localMcp).sort(byName);
  for (const name of admittedLocalNames) {
    const localServer = input.localMcp[name]!;
    const publishedServer = input.publishedMcp[name];

    if (
      localServer.enabled === false
      && publishedServer !== undefined
      && publishedServer.enabled !== false
      && isCrossPlatformPublishedMcp(publishedServer)
    ) {
      diagnostics.push({
        level: "warning",
        code: "MCP_OVERLAY_DISABLED",
        message: `local/local.jsonc disables published cross-platform MCP server '${name}'; remove the local override or run 'canonfig overlay remove mcp/${name}' to restore it.`,
      });
    }

    if (localServer.transport === "stdio") {
      const labeledValues: Array<readonly [string, string]> = [
        ["command", localServer.command],
        ...(localServer.args ?? []).map((arg, index): readonly [string, string] => [`args[${index}]`, arg]),
        ...(localServer.cwd === undefined ? [] : [["cwd", localServer.cwd] as const]),
      ];
      const foreignShown: Array<string> = [];
      for (const [label, value] of labeledValues) {
        const foreign = foreignOsPath(value, context.platform);
        if (foreign === undefined) continue;
        const { flag } = splitFlagAssignment(value);
        // Never echo a value attached to a secret-named CLI flag.
        const shown = flag !== undefined && isSecretField(flag) ? label : redactText(foreign);
        if (!foreignShown.includes(shown)) foreignShown.push(shown);
      }
      if (foreignShown.length > 0) {
        diagnostics.push({
          level: "warning",
          code: "MCP_OVERLAY_WRONG_OS_PATH",
          message: `local/local.jsonc MCP server '${name}' references a path for another OS (${foreignShown.join(", ")}) on ${context.platform}; update or remove the local entry.`,
        });
      }
    }

    // 3a. Local overlay dropping or replacing fromSecret bindings present in published entry
    if (localServer.enabled !== false && publishedServer !== undefined && publishedServer.enabled !== false) {
      const dropped = droppedFromSecretFields(publishedServer, localServer);
      if (dropped !== undefined) {
        diagnostics.push({
          level: "warning",
          code: "MCP_OVERLAY_DROPPED_SECRET",
          message: `local/local.jsonc overlay for MCP server '${name}' drops fromSecret binding for ${dropped.kind} field(s) ${dropped.fields.join(", ")} declared in canonfig.jsonc; restore fromSecret or remove the overlay.`,
        });
      }
    }
  }

  // 3b. Plaintext credential values in local/local.jsonc MCP headers or env (never echo values)
  for (const name of Object.keys(input.rawLocalMcp).sort(byName)) {
    const localServer = input.rawLocalMcp[name]!;
    const kind = localServer.transport === "stdio" ? "env" : "headers";
    const table = localServer.transport === "stdio" ? (localServer.env ?? {}) : (localServer.headers ?? {});
    const flagged: Array<string> = [];
    for (const [field, value] of Object.entries(table).sort(([left], [right]) => byName(left, right))) {
      if (Predicate.isString(value) && isPlaintextCredentialValue(field, value)) {
        flagged.push(`${kind}.${field}`);
      }
    }
    if (flagged.length > 0) {
      diagnostics.push({
        level: "warning",
        code: "MCP_OVERLAY_PLAINTEXT_SECRET",
        message: `local/local.jsonc MCP server '${name}' contains a literal credential in ${flagged.join(", ")}; replace it with { "fromSecret": "<name>" } or { "fromEnv": "<VAR>" }.`,
      });
    }
  }

  // 4. Dead or missing stdio MCP binaries
  for (const [name, server] of input.effectiveMcp) {
    if (server.transport !== "stdio") continue;
    if (
      server.harnesses !== undefined
      && input.harnesses.length > 0
      && !server.harnesses.some((harness) => input.harnesses.includes(harness))
    ) continue;

    const command = server.command.trim();
    if (command.length === 0 || ENV_TEMPLATE.test(command)) continue;

    const hasPathSeparator = command.includes("/") || command.includes("\\");
    if (hasPathSeparator) {
      const foreign = foreignOsPath(command, context.platform) !== undefined;
      const exists = foreign
        ? false
        : yield* Effect.promise(() => localExecutablePathExists(command, context, server.cwd));
      if (!exists) {
        diagnostics.push({
          level: "warning",
          code: "MCP_COMMAND_MISSING",
          message: `MCP server '${name}' points to '${redactText(command)}', which does not exist on this machine; update or remove the entry.`,
        });
      }
      continue;
    }

    const customPath = serverEnvPathOverride(server.env, context.platform);
    const foundOnPath = customPath !== undefined && !ENV_TEMPLATE.test(customPath)
      ? yield* Effect.promise(() => bareCommandExistsOnPath(command, customPath, context))
      : yield* Effect.gen(function*() {
        if (customPath !== undefined && (yield* Effect.promise(() => bareCommandExistsOnPath(command, customPath, context)))) {
          return true;
        }
        return yield* machine.findExecutable({ name: command }).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
      });
    if (!foundOnPath && !isBackedByToolsRecipe(command, server.requires, input.tools, context.platform)) {
      diagnostics.push({
        level: "warning",
        code: "MCP_COMMAND_MISSING",
        message: `MCP server '${name}' runs '${redactText(command)}', which is not on PATH and has no tools recipe or requires entry in canonfig.jsonc; install it or add a tools entry.`,
      });
    }
  }

  return diagnostics;
});
