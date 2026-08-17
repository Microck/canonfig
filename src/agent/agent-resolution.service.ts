import {
  constants,
} from "node:fs";
import {
  access,
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  win32,
} from "node:path";

import { Context, Effect, Schema } from "effect";

import type {
  AgentTask,
  ExecutableAuthorization,
} from "../domain/synchronization.ts";
import {
  parseNpmPackageSpecification,
} from "../domain/npm-package-spec.ts";
import {
  AgentProcessError,
  AgentVerificationError,
  DeniedAgentCapabilityError,
  InvalidAgentResponseError,
  InvalidAgentTaskError,
  type AgentResolutionError,
} from "./agent-resolution.errors.ts";
import type {
  AgentActionProposal,
  AgentResolutionInput,
  AgentResolutionOutcome,
  AgentHarnessConfiguration,
  ProposedProcessAction,
  ReviewedProfileChangeProposal,
  SourceDiscoveryResolution,
} from "./agent-resolution.types.ts";
import {
  controlledEnvironment,
  redactText,
} from "./controlled-executor.ts";

export class AgentResolution extends Context.Service<AgentResolution, {
  readonly resolve: (
    input: AgentResolutionInput,
  ) => Effect.Effect<AgentResolutionOutcome, AgentResolutionError>;
  readonly proposeProfileChange: (
    resolution: SourceDiscoveryResolution,
    createdAt: string,
  ) => Effect.Effect<ReviewedProfileChangeProposal, InvalidAgentTaskError>;
}>()("canonfig/agent/AgentResolution") {}

const ProcessActionSchema = Schema.Struct({
  kind: Schema.Literal("process"),
  executable: Schema.NonEmptyString,
  arguments: Schema.Array(Schema.String),
  workingDirectory: Schema.optional(Schema.NonEmptyString),
  paths: Schema.Array(Schema.NonEmptyString),
  origins: Schema.Array(Schema.NonEmptyString),
  capabilities: Schema.Array(Schema.Literals([
    "elevation",
    "login",
    "restart",
    "reboot",
  ])),
});

const AgentActionProposalSchema = Schema.Struct({
  summary: Schema.NonEmptyString,
  actions: Schema.Array(ProcessActionSchema),
});

export const decodeAgentProposal = (
  text: string,
): Effect.Effect<AgentActionProposal, InvalidAgentResponseError> =>
  Effect.try({
    try: () => JSON.parse(text),
    catch: (cause) => new InvalidAgentResponseError({
      message: `harness response is not JSON: ${String(cause)}`,
    }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AgentActionProposalSchema)),
    Effect.mapError((cause) =>
      cause instanceof InvalidAgentResponseError
        ? cause
        : new InvalidAgentResponseError({ message: String(cause) })
    ),
  );

const safePositiveInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

export const validateAgentTask = (
  task: AgentTask,
): Effect.Effect<void, InvalidAgentTaskError> => {
  if (!safePositiveInteger(task.timeLimitSeconds)) {
    return Effect.fail(new InvalidAgentTaskError({
      task: task.id,
      message: "timeLimitSeconds must be a positive safe integer",
    }));
  }
  if (!safePositiveInteger(task.outputLimitBytes)) {
    return Effect.fail(new InvalidAgentTaskError({
      task: task.id,
      message: "outputLimitBytes must be a positive safe integer",
    }));
  }
  if (task.allowedExecutables.length === 0) {
    return Effect.fail(new InvalidAgentTaskError({
      task: task.id,
      message: "at least one executable must be allowlisted",
    }));
  }
  const unclassifiable = task.executableAuthorizations?.find((authorization) =>
    isNestedCommandLauncher(authorization.executable)
  );
  if (unclassifiable !== undefined) {
    return Effect.fail(new InvalidAgentTaskError({
      task: task.id,
      message: `${unclassifiable.executable} launches nested commands that cannot be bounded by an execution model`,
    }));
  }
  if (task.verification.command.length === 0) {
    return Effect.fail(new InvalidAgentTaskError({
      task: task.id,
      message: "verification command must not be empty",
    }));
  }
  return Effect.void;
};

export const redactAgentTask = (
  task: AgentTask,
  secrets: ReadonlyArray<string>,
): AgentTask => ({
  ...task,
  summary: redactText(task.summary, secrets),
  desiredOutcome: redactText(task.desiredOutcome, secrets),
  observedEvidence: task.observedEvidence.map((value) => redactText(value, secrets)),
  allowedPaths: task.allowedPaths.map((value) => redactText(value, secrets)),
  allowedExecutables: task.allowedExecutables.map((value) => redactText(value, secrets)),
  executableAuthorizations: task.executableAuthorizations?.map(
    (authorization) => ({
      ...authorization,
      executable: redactText(authorization.executable, secrets),
    }),
  ),
  allowedOrigins: task.allowedOrigins.map((value) => redactText(value, secrets)),
  verification: {
    command: task.verification.command.map((value) => redactText(value, secrets)),
    expectContains: task.verification.expectContains === undefined
      ? undefined
      : redactText(task.verification.expectContains, secrets),
  },
});

const hasPathSeparator = (value: string): boolean =>
  value.includes("/") || value.includes("\\");

type ProcessEnvironmentEntry = {
  readonly name: string;
  readonly value: string;
};

const environmentValue = (
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined => {
  if (process.platform !== "win32") return environment[name];
  const key = Object.keys(environment).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key === undefined ? undefined : environment[key];
};

const executableCandidates = (
  value: string,
  environmentEntries: ReadonlyArray<ProcessEnvironmentEntry>,
  workingDirectory: string,
): ReadonlyArray<string> => {
  if (isAbsolute(value) || win32.isAbsolute(value) || hasPathSeparator(value)) {
    return [resolve(workingDirectory, value)];
  }
  const environment = controlledEnvironment(environmentEntries);
  const extensions = process.platform === "win32"
    ? (environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  const path = environmentValue(environment, "PATH") ?? "";
  return path.split(delimiter).flatMap((directory) =>
    extensions.map((extension) =>
      resolve(
        workingDirectory,
        directory.length === 0 ? "." : directory,
        `${value}${extension}`,
      )
    )
  );
};

export const resolvedExecutableIdentity = async (
  value: string,
  environment: ReadonlyArray<ProcessEnvironmentEntry> = [],
  workingDirectory = process.cwd(),
): Promise<string | undefined> => {
  for (const candidate of executableCandidates(value, environment, workingDirectory)) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through PATH candidates. A missing or non-executable path is
      // never treated as equivalent to an allowlisted executable.
    }
  }
  return undefined;
};

export const executableAllowed = (
  executable: string,
  allowed: ReadonlyArray<string>,
  environment: ReadonlyArray<ProcessEnvironmentEntry> = [],
  workingDirectory = process.cwd(),
): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    const executableIdentity = await resolvedExecutableIdentity(
      executable,
      environment,
      workingDirectory,
    );
    if (executableIdentity === undefined) return false;
    for (const entry of allowed) {
      const allowedIdentity = await resolvedExecutableIdentity(
        entry,
        environment,
        workingDirectory,
      );
      if (allowedIdentity === executableIdentity) return true;
    }
    return false;
  });

const portableBasename = (value: string): string =>
  value.includes("\\") ? win32.basename(value) : basename(value);

const isWindowsPath = (value: string): boolean =>
  /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");

const pathWithin = (path: string, root: string): boolean => {
  const windows = isWindowsPath(path) || isWindowsPath(root);
  const difference = windows
    ? win32.relative(win32.resolve(root), win32.resolve(path))
    : relative(resolve(root), resolve(path));
  return difference === "" || (
    !difference.startsWith("..")
    && !(windows ? win32.isAbsolute(difference) : isAbsolute(difference))
  );
};

const pathApi = (value: string, base: string): typeof posix =>
  isWindowsPath(value) || isWindowsPath(base) || base.includes("\\")
    ? win32
    : posix;

const lexicalPath = (value: string, base: string): string => {
  const api = pathApi(value, base);
  return api.resolve(base, value);
};

const canonicalPath = async (value: string, base: string): Promise<string> => {
  const absolute = lexicalPath(value, base);
  if (isWindowsPath(absolute) && process.platform !== "win32") {
    return win32.normalize(absolute).toLowerCase();
  }
  const suffix: Array<string> = [];
  let candidate = absolute;
  while (true) {
    try {
      const canonical = await realpath(candidate);
      return suffix.reduceRight((parent, part) => join(parent, part), canonical);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return absolute;
      suffix.push(basename(candidate));
      candidate = parent;
    }
  }
};

const optionValue = (argument: string): string | undefined => {
  if (!argument.startsWith("-")) return undefined;
  const separator = argument.indexOf("=");
  return separator > 0 ? argument.slice(separator + 1) : undefined;
};

const argumentPath = (
  argument: string,
  npmPackageArgument = false,
): string | undefined => {
  const value = optionValue(argument) ?? argument;
  if (value.length === 0 || value.startsWith("-")) return undefined;
  if (normalizeOrigin(value) !== undefined) return undefined;
  if (npmPackageArgument) {
    const specification = parseNpmPackageSpecification(value);
    if (specification.kind === "remote" || specification.kind === "ambiguous") {
      return undefined;
    }
    if (specification.kind === "local") return specification.path;
    return undefined;
  }
  const optionName = argument.includes("=")
    ? argument.slice(0, argument.indexOf("=")).replace(/^-+/u, "")
    : undefined;
  const pathOption = optionName !== undefined
    && /(?:^|[-_])(?:output|path|file|dir|directory|destination|dest|target|prefix|root|cwd|config|cache|store|write)(?:$|[-_])/iu
      .test(optionName);
  return pathOption
      || posix.isAbsolute(value)
      || win32.isAbsolute(value)
      || value.startsWith(".")
      || value.startsWith("~")
      || value.includes("/")
      || value.includes("\\")
    ? value
    : undefined;
};

const argumentOrigins = (
  argument: string,
  npmPackageArgument = false,
): ReadonlyArray<string> => {
  const origins = [...argument.matchAll(/https?:\/\/[^\s"'<>]+/giu)].map((match) => match[0]);
  if (!npmPackageArgument) return origins;
  if (argument.startsWith("-") && !argument.includes("=")) return origins;
  const value = optionValue(argument) ?? argument;
  const specification = parseNpmPackageSpecification(value);
  if (specification.kind === "remote") return [...origins, specification.origin];
  if (specification.kind === "ambiguous" && /(?:\/|:|@|\+)/u.test(value)) {
    return [...origins, value];
  }
  return origins;
};

const ensureAllowedPath = (
  path: string,
  workingDirectory: string,
  taskRoots: ReadonlyArray<string>,
  harnessRoots: ReadonlyArray<string>,
): Effect.Effect<void, DeniedAgentCapabilityError> =>
  Effect.promise(async () => {
    const canonical = await canonicalPath(path, workingDirectory);
    const taskBounds = await Promise.all(taskRoots.map((root) =>
      canonicalPath(root, workingDirectory)
    ));
    const harnessBounds = await Promise.all(harnessRoots.map((root) =>
      canonicalPath(root, workingDirectory)
    ));
    return taskBounds.some((root) => pathWithin(canonical, root))
      && harnessBounds.some((root) => pathWithin(canonical, root));
  }).pipe(
    Effect.flatMap((allowed) =>
      allowed
        ? Effect.void
        : Effect.fail(new DeniedAgentCapabilityError({
          capability: "path",
          value: lexicalPath(path, workingDirectory),
        }))
    ),
  );

const hasUnsafeUrlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x20
      || (code >= 0x7f && code <= 0x9f)
      || "\"'<>\\ ".includes(character);
  });

const hasExplicitUrlCredentialOrFragment = (value: string): boolean => {
  if (value.includes("#")) return true;
  const authority = /^https?:\/\/([^/?#]*)/iu.exec(value)?.[1];
  return authority?.includes("@") ?? false;
};

const normalizeOrigin = (value: string): string | undefined => {
  if (
    value.trim() !== value
    || hasUnsafeUrlCharacter(value)
    || hasExplicitUrlCredentialOrFragment(value)
  ) return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username.length > 0
      || url.password.length > 0
      || url.hash.length > 0
    ) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
};

const ensureAllowedOrigin = (
  value: string,
  taskOrigins: ReadonlyArray<string>,
  harnessOrigins: ReadonlyArray<string>,
): Effect.Effect<void, DeniedAgentCapabilityError> => {
  const origin = normalizeOrigin(value);
  const taskAllowed = taskOrigins
    .map(normalizeOrigin)
    .filter((candidate) => candidate !== undefined);
  const harnessAllowed = harnessOrigins
    .map(normalizeOrigin)
    .filter((candidate) => candidate !== undefined);
  return origin !== undefined
      && taskAllowed.includes(origin)
      && harnessAllowed.includes(origin)
    ? Effect.void
    : Effect.fail(new DeniedAgentCapabilityError({
      capability: "network-origin",
      value,
    }));
};

const elevationExecutables = new Set(["sudo", "doas", "pkexec", "runas"]);
const loginExecutables = new Set(["login", "logon", "su"]);
const rebootExecutables = new Set(["reboot", "shutdown"]);
type PrivilegedCapability = "elevation" | "login" | "restart" | "reboot";

type InterpreterKind = "node" | "python" | "posix-shell" | "powershell";
const posixShellExecutables = new Set([
  "ash",
  "bash",
  "dash",
  "fish",
  "ksh",
  "nu",
  "sh",
  "zsh",
]);

const interpreterKind = (value: string): InterpreterKind | undefined => {
  const command = portableBasename(value)
    .toLowerCase()
    .replace(/\.(?:cmd|exe)$/u, "");
  if (command === "node" || command === "nodejs") return "node";
  if (/^(?:python|pypy)(?:\d+(?:\.\d+)*)?$/u.test(command) || command === "py") {
    return "python";
  }
  if (posixShellExecutables.has(command)) {
    return "posix-shell";
  }
  if (command === "powershell" || command === "pwsh") return "powershell";
  return undefined;
};

/**
 * Executables that run a nested command not derivable from their argv: the
 * descendant is selected by an argument, read from a Makefile or project
 * manifest, or embedded in program text. Neither a leaf nor a bounded
 * script-file classification can bound such a descendant, so these are denied
 * before any allowlist comparison and no configuration can authorize them.
 * This closes the nested-command bypass reported through `xargs`, `find`,
 * `awk`, `perl`, `make`, `npx`, and related wrappers and launchers.
 *
 * Package-manager operations are classified separately below. A registry
 * origin does not bound lifecycle scripts, project configuration, plugins, or
 * installers, so a package manager is a leaf only for structurally recognized
 * non-executing operations or when its canonical script-disable option is
 * present. Runner forms that select a command to execute (`npx`, `uvx`,
 * `make`, `go run`, ...) do not qualify.
 * Recognized script-file interpreters (`interpreterKind`) keep the bounded
 * script-file model. Every other executable still requires an explicit
 * matching classification from both the task and the harness.
 */
const nestedCommandLaunchers = new Set([
  // argument dispatch: a later argument names the command to run
  "at",
  "batch",
  "cmd",
  "command",
  "env",
  "exec",
  "flock",
  "ltrace",
  "nice",
  "nohup",
  "open",
  "osascript",
  "parallel",
  "perf",
  "screen",
  "script",
  "ssh",
  "stdbuf",
  "strace",
  "systemd-run",
  "time",
  "timeout",
  "tmux",
  "valgrind",
  "watch",
  "wmic",
  "xargs",
  // runners: an argument selects a package, target, file, or task to execute
  "bazel",
  "bazelisk",
  "buck",
  "bunx",
  "bundle",
  "cargo",
  "compose",
  "deno",
  "docker",
  "docker-compose",
  "dotnet",
  "go",
  "gmake",
  "gradle",
  "helm",
  "java",
  "javaw",
  "jshell",
  "just",
  "kubectl",
  "mage",
  "make",
  "mix",
  "mvn",
  "nerdctl",
  "ninja",
  "npx",
  "pipx",
  "pnpx",
  "podman",
  "qjs",
  "rake",
  "task",
  "tsx",
  "uvx",
  // program-text interpreters outside the bounded script-file model
  "awk",
  "ccl",
  "cscript",
  "clisp",
  "erl",
  "escript",
  "expect",
  "gawk",
  "groovy",
  "guile",
  "julia",
  "lua",
  "luajit",
  "mawk",
  "mshta",
  "perl",
  "php",
  "racket",
  "regsvr32",
  "rscript",
  "ruby",
  "rundll32",
  "sbcl",
  "swipl",
  "tclsh",
  "wish",
  "wscript",
  // tools with exec predicates, hooks, filters, or command escapes
  "fd",
  "find",
  "git",
  "hg",
  "sqlite3",
  "svn",
  "tar",
  // elevation and session wrappers; capability derivation gates these too
  "doas",
  "login",
  "logon",
  "pkexec",
  "runas",
  "su",
  "sudo",
]);

/** True when the executable runs nested commands that argv cannot bound. */
export const isNestedCommandLauncher = (value: string): boolean =>
  nestedCommandLaunchers.has(
    portableBasename(value).toLowerCase().replace(/\.(?:cmd|exe|bat|com|ps1)$/u, ""),
  );

type PackageManagerPolicy =
  | {
    readonly kind: "scripts-disabled";
    readonly arguments: ReadonlyArray<string>;
  }
  | { readonly kind: "non-executing" }
  | { readonly kind: "denied" };

const packageManagerName = (value: string): string => {
  const name = portableBasename(value)
    .toLowerCase()
    .replace(/\.(?:cmd|exe|bat|com|ps1)$/u, "")
    .replace(/^(npm)-cli\.js$/u, "$1")
    .replace(/^(pnpm)\.(?:cjs|js)$/u, "$1")
    .replace(/^(yarn)\.js$/u, "$1");
  return /^pip(?:3(?:\.\d+(?:\.\d+)*)?|-3(?:\.\d+(?:\.\d+)*)?)?$/u.test(name)
    ? "pip"
    : name;
};

const argumentsBeforeSeparator = (
  arguments_: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined => {
  const separator = arguments_.indexOf("--");
  return separator === -1 ? arguments_ : undefined;
};

const firstCommandIndex = (
  arguments_: ReadonlyArray<string>,
  optionsWithValues: ReadonlySet<string>,
): number | undefined => {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (!argument.startsWith("-") || argument === "-") return index;
    const option = argument.split("=", 1)[0]!.toLowerCase();
    if (
      !argument.includes("=")
      && (
        optionsWithValues.has(option)
        || /^--@[^:]+:registry$/iu.test(option)
      )
    ) {
      index += 1;
      if (index >= arguments_.length) return undefined;
    }
  }
  return undefined;
};

const hasEnabledOption = (
  arguments_: ReadonlyArray<string>,
  option: string,
): boolean =>
  arguments_.some((argument) =>
    argument.split("=", 1)[0]!.toLowerCase() === option.toLowerCase()
      && (
        !argument.includes("=")
        || argument.slice(argument.indexOf("=") + 1).toLowerCase() === "true"
      )
  );

const hasDisabledOption = (
  arguments_: ReadonlyArray<string>,
  option: string,
): boolean => arguments_.some((argument) => {
  const separator = argument.indexOf("=");
  return separator > 0
    && argument.slice(0, separator).toLowerCase() === option.toLowerCase()
    && argument.slice(separator + 1).toLowerCase() !== "true";
});

const hasSeparateOptionValue = (
  arguments_: ReadonlyArray<string>,
  option: string,
): boolean => arguments_.some((argument, index) =>
  argument.toLowerCase() === option.toLowerCase()
    && arguments_[index + 1] !== undefined
);

const hasOnlyBinaryAll = (
  arguments_: ReadonlyArray<string>,
): boolean => arguments_.some((argument, index) => {
  const separator = argument.indexOf("=");
  const name = (separator > 0 ? argument.slice(0, separator) : argument).toLowerCase();
  if (name !== "--only-binary") return false;
  const value = separator > 0 ? argument.slice(separator + 1) : arguments_[index + 1];
  return value?.toLowerCase() === ":all:";
});

const hasNonCanonicalBinaryOption = (
  arguments_: ReadonlyArray<string>,
): boolean => arguments_.some((argument, index) => {
  const separator = argument.indexOf("=");
  const name = (separator > 0 ? argument.slice(0, separator) : argument).toLowerCase();
  if (name === "--no-binary") return true;
  if (name !== "--only-binary") return false;
  const value = separator > 0 ? argument.slice(separator + 1) : arguments_[index + 1];
  return value?.toLowerCase() !== ":all:";
});

interface RegistryOption {
  readonly index: number;
  readonly value: string | undefined;
  readonly consumesNext: boolean;
}

const registryOptions = (
  manager: string,
  arguments_: ReadonlyArray<string>,
): ReadonlyArray<RegistryOption> => {
  const options = new Set(
    manager === "uv"
      ? ["--default-index", "--index-url", "--extra-index-url", "--index"]
      : manager === "pip"
      ? [
        "-i",
        "--index-url",
        "--extra-index-url",
        "-f",
        "--find-links",
      ]
      : ["--registry"],
  );
  const result: Array<RegistryOption> = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    const separator = argument.indexOf("=");
    const name = (separator > 0 ? argument.slice(0, separator) : argument)
      .toLowerCase();
    const scoped = manager !== "uv"
      && /^--@[^:]+:registry$/u.test(name);
    if (!options.has(name) && !scoped) continue;
    const inline = separator > 0 ? argument.slice(separator + 1) : undefined;
    const separate = inline === undefined && arguments_[index + 1] !== undefined;
    result.push({
      index,
      value: inline ?? (separate ? arguments_[index + 1] : undefined),
      consumesNext: separate,
    });
    if (separate) index += 1;
  }
  return result;
};

const untrustedPackageConfigOption = (
  manager: string,
  argument: string,
): boolean => {
  const name = argument.split("=", 1)[0]!.toLowerCase();
  if (manager === "npm" || manager === "pnpm") {
    return new Set([
      "--config",
      "--config-dir",
      "--globalconfig",
      "--global-config",
      "--userconfig",
      "--user-config",
    ]).has(name);
  }
  if (manager === "bun") return name === "--config";
  if (manager === "uv") return name === "--config-file";
  if (manager === "pip") {
    return new Set([
      "--cert",
      "--client-cert",
      "--config-settings",
      "--config-setting",
      "--proxy",
      "--trusted-host",
    ]).has(name);
  }
  if (manager === "yarn") {
    return name === "--use-yarnrc" || name === "--rc-file";
  }
  return false;
};

const registryOperation = (
  manager: string,
  arguments_: ReadonlyArray<string>,
): boolean => {
  const unambiguous = argumentsBeforeSeparator(arguments_);
  if (unambiguous === undefined) return false;
  const commandOptions = manager === "uv"
    ? new Set(["--cache-dir", "--config-file", "--default-index", "--directory", "--extra-index-url", "--index", "--index-url", "--project"])
    : manager === "pip"
    ? new Set([
      "--cache-dir",
      "--cert",
      "--client-cert",
      "--config-settings",
      "--config-setting",
      "--constraint",
      "-c",
      "--extra-index-url",
      "--find-links",
      "-f",
      "-i",
      "--index-url",
      "--isolated",
      "--no-binary",
      "--only-binary",
      "--proxy",
      "--requirement",
      "-r",
      "--trusted-host",
    ])
    : manager === "bun"
    ? new Set(["--config", "--cwd", "--filter", "--registry"])
    : new Set([
      "-C",
      "--cache",
      "--config-dir",
      "--dir",
      "--global-bin-dir",
      "--global-dir",
      "--prefix",
      "--registry",
      "--store-dir",
      "--userconfig",
      "--virtual-store-dir",
      "--workspace-dir",
    ]);
  const commandIndex = firstCommandIndex(unambiguous, commandOptions);
  const command = commandIndex === undefined
    ? undefined
    : unambiguous[commandIndex]?.toLowerCase();
  if (manager === "npm" || manager === "pnpm" || manager === "yarn") {
    return command !== undefined && new Set([
      "add",
      "i",
      "in",
      "ins",
      "inst",
      "insta",
      "instal",
      "install",
      "ci",
      "info",
      "list",
      "ls",
      "outdated",
      "prefix",
      "root",
      "search",
      "view",
      "why",
    ]).has(command);
  }
  if (manager === "bun") {
    return command !== undefined && new Set(["add", "i", "install", "update"]).has(command);
  }
  if (manager === "pip") {
    return command !== undefined && command === "install";
  }
  if (manager === "uv") {
    return command === "tool" && unambiguous[commandIndex! + 1]?.toLowerCase() === "install"
      || command === "pip" && unambiguous[commandIndex! + 1]?.toLowerCase() === "install";
  }
  return false;
};

const packageManagerOptionValues = (manager: string): ReadonlySet<string> =>
  manager === "uv"
    ? new Set([
      "--cache-dir",
      "--config-file",
      "--default-index",
      "--directory",
      "--extra-index-url",
      "--index",
      "--index-url",
      "--project",
    ])
    : manager === "pip"
    ? new Set([
      "--cache-dir",
      "--cert",
      "--client-cert",
      "--config-setting",
      "--config-settings",
      "--constraint",
      "-c",
      "--extra-index-url",
      "--find-links",
      "--index-url",
      "--proxy",
      "--requirement",
      "-r",
      "--trusted-host",
      "-f",
      "-i",
    ])
    : new Set();

const nonOptionPackageManagerArguments = (
  manager: string,
  arguments_: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const values = packageManagerOptionValues(manager);
  const result: Array<string> = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (!argument.startsWith("-")) {
      result.push(argument);
      continue;
    }
    const name = argument.split("=", 1)[0]!.toLowerCase();
    if (!argument.includes("=") && values.has(name)) index += 1;
  }
  return result;
};

const packageScopes = (value: string): ReadonlyArray<string> =>
  [...new Set(
    [...value.matchAll(/@[A-Za-z0-9._~-]+\//gu)]
      .map((match) => match[0]!.slice(0, -1)),
  )].sort();

export const registryScopesForInvocation = (
  executable: string,
  arguments_: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const manager = packageManagerName(executable);
  if (manager !== "npm" && manager !== "pnpm") return [];
  const indexes = npmDependencyArgumentIndexes(manager, arguments_);
  return [...new Set(
    [...indexes]
      .flatMap((index) => packageScopes(arguments_[index] ?? "")),
  )].sort();
};

const canonicalRegistryOrigin = (value: string): string | undefined => {
  return canonicalRegistryUrl(value)?.origin;
};

interface CanonicalRegistryUrl {
  readonly url: string;
  readonly origin: string;
}

const canonicalRegistryUrl = (value: string): CanonicalRegistryUrl | undefined => {
  if (
    value.trim() !== value
    || hasUnsafeUrlCharacter(value)
    || hasExplicitUrlCredentialOrFragment(value)
  ) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username.length > 0
      || url.password.length > 0
      || url.hash.length > 0
      || url.hostname.length === 0
    ) return undefined;
    const urlValue = url.pathname === "/" && url.search.length === 0
      ? url.origin
      : url.href;
    return {
      url: urlValue,
      origin: url.origin,
    };
  } catch {
    return undefined;
  }
};

export const registryOriginForInvocation = (
  executable: string,
  arguments_: ReadonlyArray<string>,
): string | undefined => {
  const manager = packageManagerName(executable);
  const operation = registryOperation(manager, arguments_);
  if (!operation) return undefined;
  const option = registryOptions(manager, arguments_)[0];
  return option?.value === undefined
    ? undefined
    : canonicalRegistryUrl(option.value)?.url;
};

const safeRegistryValue = (value: string): string => {
  try {
    const url = new URL(value);
    return url.username.length > 0 || url.password.length > 0
      ? "[REDACTED]"
      : value;
  } catch {
    return value.includes("@") ? "[REDACTED]" : value;
  }
};

const canonicalAllowedRegistry = (
  taskOrigins: ReadonlyArray<string>,
  harnessOrigins: ReadonlyArray<string>,
  actionOrigins: ReadonlyArray<string>,
): string | undefined => {
  const task = taskOrigins
    .map(canonicalRegistryUrl)
    .filter((registry): registry is CanonicalRegistryUrl => registry !== undefined);
  const harness = harnessOrigins
    .map(canonicalRegistryUrl)
    .filter((registry): registry is CanonicalRegistryUrl => registry !== undefined);
  const taskOriginsSet = new Set(
    task
      .map((registry) => registry.origin),
  );
  const harnessOriginsSet = new Set(
    harness
      .map((registry) => registry.origin),
  );
  const sharedOrigins = [...taskOriginsSet].filter((origin) => harnessOriginsSet.has(origin));
  const reviewed = actionOrigins
    .map(canonicalRegistryUrl)
    .filter((registry): registry is CanonicalRegistryUrl => registry !== undefined)
    .filter((registry) => sharedOrigins.includes(registry.origin));
  const taskCandidates = task.filter((registry) => sharedOrigins.includes(registry.origin));
  const harnessCandidates = harness.filter((registry) => sharedOrigins.includes(registry.origin));
  const candidates = reviewed.length > 0
    ? [...new Set(reviewed.map((registry) => registry.url))]
    : taskCandidates.length > 0
    ? [...new Set(taskCandidates.map((registry) => registry.url))]
    : [...new Set(harnessCandidates.map((registry) => registry.url))];
  return candidates.length === 1 ? candidates[0] : undefined;
};

const pipRequirementOption = (
  argument: string,
): { readonly kind: "include" | "index"; readonly value?: string } | undefined => {
  const separator = argument.indexOf("=");
  const name = (separator > 0 ? argument.slice(0, separator) : argument).toLowerCase();
  const inline = separator > 0 ? argument.slice(separator + 1) : undefined;
  if (name === "-r" || name === "--requirement") {
    return { kind: "include", value: inline };
  }
  if (name === "-c" || name === "--constraint") {
    return { kind: "include", value: inline };
  }
  if (name === "-i" || name === "--index-url" || name === "--extra-index-url"
    || name === "-f" || name === "--find-links") {
    return { kind: "index", value: inline };
  }
  if (argument.length > 2 && (argument.startsWith("-r") || argument.startsWith("-c"))) {
    return { kind: "include", value: argument.slice(2) };
  }
  if (argument.length > 2 && (argument.startsWith("-i") || argument.startsWith("-f"))) {
    return { kind: "index", value: argument.slice(2) };
  }
  return undefined;
};

const pipRequirementOptionName = (
  argument: string,
): boolean => argument.startsWith("-");

const pipRequirementFileReference = (value: string): boolean =>
  value.length > 0
  && value !== "-"
  && !value.startsWith("//")
  && !/^[A-Za-z][A-Za-z0-9+.-]*:(?![\\/])/u.test(value);

const pipRequirementTokens = (line: string): ReadonlyArray<string> | undefined => {
  const tokens: Array<string> = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      token += character === "\\" || character === "'" || character === '"'
        || /\s/u.test(character)
        ? character
        : `\\${character}`;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (token.length > 0) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += character;
  }
  if (escaped || quote !== undefined) return undefined;
  if (token.length > 0) tokens.push(token);
  return tokens;
};

const pipRequirementLogicalLines = (
  text: string,
): ReadonlyArray<string> | undefined => {
  if (text.includes("\u0000")) return undefined;
  const physical = text.replace(/\r\n?/gu, "\n").split("\n");
  const logical: Array<string> = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (const line of physical) {
    let content = "";
    let escaped = false;
    for (const character of line) {
      if (escaped) {
        content += character;
        escaped = false;
        continue;
      }
      if (character === "\\" && quote !== "'") {
        escaped = true;
        content += character;
        continue;
      }
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
        content += character;
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        content += character;
        continue;
      }
      if (
        character === "#"
          && (content.length === 0 || /\s/u.test(content.at(-1) ?? ""))
      ) break;
      content += character;
    }
    if (quote !== undefined) {
      if (!line.endsWith("\\")) return undefined;
    }
    const continuation = /(?<!\\)(?:\\\\)*\\$/u.test(content);
    if (continuation) {
      current += `${content.slice(0, -1)} `;
      continue;
    }
    current += content;
    if (current.trim().length > 0) logical.push(current.trim());
    current = "";
    quote = undefined;
  }
  return current.trim().length === 0 && quote === undefined ? logical : undefined;
};

const pipRequirementPackage = (line: string): boolean => {
  if (
    line.length === 0
    || line.startsWith("-")
    || /[\\/@:]/u.test(line)
    || /(?:^|\s)https?:/iu.test(line)
    || /(?:^|\s)(?:git\+|git:\/\/|github:|gitlab:|bitbucket:|file:|link:|editable)/iu.test(line)
  ) return false;
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[([A-Za-z0-9._,-]+)\])?(.*)$/u.exec(line);
  if (match === null) return false;
  const remainder = match[3] ?? "";
  const markerSeparator = remainder.indexOf(";");
  const specifier = markerSeparator === -1
    ? remainder
    : remainder.slice(0, markerSeparator);
  const marker = markerSeparator === -1
    ? undefined
    : remainder.slice(markerSeparator + 1);
  if (!/^\s*(?:(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+(?:\s*,\s*(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+)*)?\s*$/u.test(specifier)) {
    return false;
  }
  if (
    marker !== undefined
      && !/^\s*[A-Za-z0-9_.-]+\s*(?:===|==|!=|<=|>=|<|>|in|not\s+in)\s*["'A-Za-z0-9_.!*+<>=(), -]+\s*$/u.test(marker)
  ) {
    return false;
  }
  return !/--/u.test(remainder);
};

const pipRequirementSafeOption = (tokens: ReadonlyArray<string>): boolean => {
  const name = tokens[0]?.toLowerCase();
  if (name === "--isolated") return tokens.length === 1;
  if (name !== "--only-binary" && !name.startsWith("--only-binary=")) return false;
  const value = name === "--only-binary"
    ? tokens[1]?.toLowerCase()
    : name.slice("--only-binary=".length);
  return tokens.length === (name === "--only-binary" ? 2 : 1) && value === ":all:";
};

const requirementFileIdentityEqual = (
  left: { readonly dev: number; readonly ino: number; readonly size: number },
  right: { readonly dev: number; readonly ino: number; readonly size: number },
): boolean => left.dev === right.dev && left.ino === right.ino && left.size === right.size;

const readPipRequirementFile = async (path: string): Promise<string> => {
  const maximumBytes = 128 * 1024;
  const before = await lstat(path);
  if (!before.isFile() || before.size > maximumBytes) {
    throw new Error("requirement file is not a bounded regular file");
  }
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (!requirementFileIdentityEqual(before, opened)) {
      throw new Error("requirement file identity changed before reading");
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (bytesRead > maximumBytes) throw new Error("requirement file exceeds size limit");
    const after = await lstat(path);
    if (!requirementFileIdentityEqual(before, after)) {
      throw new Error("requirement file identity changed while reading");
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, bytesRead),
    );
    return decoded.startsWith("\uFEFF") ? decoded.slice(1) : decoded;
  } finally {
    await handle.close();
  }
};

const validatePipRequirementInputs = (
  executable: string,
  arguments_: ReadonlyArray<string>,
  workingDirectory: string,
  task: Pick<AuthorizationBounds, "allowedPaths" | "allowedOrigins">,
  harness: Pick<AuthorizationBounds, "allowedPaths" | "allowedOrigins">,
): Effect.Effect<void, DeniedAgentCapabilityError> =>
  Effect.gen(function*() {
    if (packageManagerName(executable) !== "pip") return;
    const fileOptions: Array<{ readonly path: string }> = [];
    for (let index = 0; index < arguments_.length; index += 1) {
      const option = pipRequirementOption(arguments_[index]!);
      if (option?.kind !== "include") continue;
      const value = option.value ?? arguments_[index + 1];
      if (option.value === undefined) index += 1;
      if (
        value === undefined
          || !pipRequirementFileReference(value)
          || normalizeOrigin(value) !== undefined
      ) {
        return yield* new DeniedAgentCapabilityError({
          capability: "package-manager-requirements",
          value: executable,
        });
      }
      fileOptions.push({
        path: lexicalPath(value, workingDirectory),
      });
    }
    const visited: Array<string> = [];
    let fileCount = 0;
    let totalBytes = 0;
    const visit = (
      file: string,
      depth: number,
    ): Effect.Effect<void, DeniedAgentCapabilityError> =>
      Effect.gen(function*() {
        if (depth > 8 || fileCount >= 64) {
          return yield* new DeniedAgentCapabilityError({
            capability: "package-manager-requirements",
            value: file,
          });
        }
        yield* ensureAllowedPath(
          file,
          workingDirectory,
          task.allowedPaths,
          harness.allowedPaths,
        );
        const canonical = yield* Effect.promise(() => canonicalPath(file, workingDirectory));
        if (visited.includes(canonical)) {
          return yield* new DeniedAgentCapabilityError({
            capability: "package-manager-requirements",
            value: file,
          });
        }
        visited.push(canonical);
        fileCount += 1;
        const content = yield* Effect.tryPromise({
          try: () => readPipRequirementFile(file),
          catch: () => new DeniedAgentCapabilityError({
            capability: "package-manager-requirements",
            value: file,
          }),
        });
        totalBytes += Buffer.byteLength(content, "utf8");
        if (totalBytes > 1024 * 1024) {
          return yield* new DeniedAgentCapabilityError({
            capability: "package-manager-requirements",
            value: file,
          });
        }
        const lines = pipRequirementLogicalLines(content);
        if (lines === undefined) {
          return yield* new DeniedAgentCapabilityError({
            capability: "package-manager-requirements",
            value: file,
          });
        }
        for (const line of lines) {
          const tokens = pipRequirementTokens(line);
          if (tokens === undefined || tokens.length === 0) {
            return yield* new DeniedAgentCapabilityError({
              capability: "package-manager-requirements",
              value: file,
            });
          }
          const option = pipRequirementOption(tokens[0]!);
          if (option?.value !== undefined && tokens.length !== 1) {
            return yield* new DeniedAgentCapabilityError({
              capability: "package-manager-requirements",
              value: file,
            });
          }
          if (option?.kind === "include") {
            const include = option.value ?? (
              tokens.length === 2 ? tokens[1] : undefined
            );
            if (include === undefined || (option.value === undefined && tokens.length !== 2)) {
              return yield* new DeniedAgentCapabilityError({
                capability: "package-manager-requirements",
                value: file,
              });
            }
            if (!pipRequirementFileReference(include)) {
              return yield* new DeniedAgentCapabilityError({
                capability: "package-manager-requirements",
                value: file,
              });
            }
            const nested = lexicalPath(include, dirname(file));
            yield* visit(nested, depth + 1);
            continue;
          }
          if (option?.kind === "index") {
            const value = option.value ?? (tokens.length === 2 ? tokens[1] : undefined);
            if (value === undefined || (option.value === undefined && tokens.length !== 2)) {
              return yield* new DeniedAgentCapabilityError({
                capability: "network-origin",
                value: executable,
              });
            }
            if (canonicalRegistryUrl(value) === undefined) {
              return yield* new DeniedAgentCapabilityError({
                capability: "network-origin",
                value: safeRegistryValue(value),
              });
            }
            yield* ensureAllowedOrigin(
              value,
              task.allowedOrigins,
              harness.allowedOrigins,
            );
            continue;
          }
          if (
            pipRequirementOptionName(tokens[0]!)
              ? !pipRequirementSafeOption(tokens)
              : !pipRequirementPackage(line)
          ) {
            return yield* new DeniedAgentCapabilityError({
              capability: "package-manager-requirements",
              value: file,
            });
          }
        }
        visited.pop();
      });
    for (const entry of fileOptions) yield* visit(entry.path, 0);
  });

const registryArguments = (
  manager: string,
  arguments_: ReadonlyArray<string>,
  registry: string,
): ReadonlyArray<string> => {
  const options = registryOptions(manager, arguments_);
  const removed = new Set<number>();
  for (const option of options) {
    removed.add(option.index);
    if (option.consumesNext) removed.add(option.index + 1);
  }
  const withoutOptions = arguments_.filter((_argument, index) => !removed.has(index));
  if (manager === "uv") {
    const command = withoutOptions.findIndex((argument) =>
      argument.toLowerCase() === "tool" || argument.toLowerCase() === "pip"
    );
    const flag = command >= 0 && withoutOptions[command]!.toLowerCase() === "pip"
      ? "--index-url"
      : "--default-index";
    return [...withoutOptions, `${flag}=${registry}`];
  }
  if (manager === "pip") {
    return [...withoutOptions, `--index-url=${registry}`];
  }
  const scopes = manager === "npm" || manager === "pnpm"
    ? registryScopesForInvocation(manager, withoutOptions)
    : [];
  return [
    ...withoutOptions,
    `--registry=${registry}`,
    ...scopes.map((scope) => `--${scope}:registry=${registry}`),
  ];
};

const authorizeRegistryInvocation = (
  executable: string,
  arguments_: ReadonlyArray<string>,
  taskOrigins: ReadonlyArray<string>,
  harnessOrigins: ReadonlyArray<string>,
  actionOrigins: ReadonlyArray<string> = [],
): Effect.Effect<ReadonlyArray<string>, DeniedAgentCapabilityError> => {
  const manager = packageManagerName(executable);
  if (!registryOperation(manager, arguments_)) return Effect.succeed(arguments_);
  if (arguments_.some((argument) => untrustedPackageConfigOption(manager, argument))) {
    return Effect.fail(new DeniedAgentCapabilityError({
      capability: "package-manager-config",
      value: executable,
    }));
  }
  const registry = canonicalAllowedRegistry(taskOrigins, harnessOrigins, actionOrigins);
  if (registry === undefined) {
    return Effect.fail(new DeniedAgentCapabilityError({
      capability: "network-origin",
      value: executable,
    }));
  }
  const options = registryOptions(manager, arguments_);
  const registryOrigin = canonicalRegistryOrigin(registry);
  for (const option of options) {
    if (
      option.value === undefined
        || registryOrigin === undefined
        || canonicalRegistryOrigin(option.value) !== registryOrigin
    ) {
      return Effect.fail(new DeniedAgentCapabilityError({
        capability: "network-origin",
        value: option.value === undefined
          ? executable
          : safeRegistryValue(option.value),
      }));
    }
  }
  return Effect.succeed(registryArguments(manager, arguments_, registry));
};

const isUnboundedSourceDependency = (argument: string): boolean => {
  const value = optionValue(argument) ?? argument;
  const specification = parseNpmPackageSpecification(value);
  return specification.kind === "ambiguous";
};

const isExplicitSourceDependency = (argument: string): boolean => {
  const value = optionValue(argument) ?? argument;
  return /^(?:git\+|git:\/\/|github:|gitlab:|bitbucket:|git@|file:|link:|workspace:|https?:\/\/)/iu
    .test(value)
    || /(?:^|@)(?:npm:|git\+|git:\/\/|github:|gitlab:|bitbucket:|git@|file:|link:|workspace:|https?:\/\/)/iu
      .test(value)
    || /\s+@\s*(?:git\+|git:\/\/|github:|gitlab:|bitbucket:|git@|file:|https?:\/\/)/iu
      .test(value);
};

const isPipSourceDependency = (argument: string): boolean => {
  const value = optionValue(argument) ?? argument;
  return isExplicitSourceDependency(value)
    || /^(?:[.~]{0,2}[\\/]|[A-Za-z]:[\\/]|[\\/])/u.test(value)
    || /^(?:-e|--editable)(?:=|$)/iu.test(argument);
};

const npmDependencyArgumentIndexes = (
  executable: string,
  arguments_: ReadonlyArray<string>,
): ReadonlySet<number> => {
  const manager = packageManagerName(executable);
  if (manager !== "npm" && manager !== "pnpm") return new Set();
  const commandIndex = firstCommandIndex(
    arguments_,
    new Set([
      "-C",
      "--cache",
      "--config-dir",
      "--dir",
      "--global-bin-dir",
      "--global-dir",
      "--prefix",
      "--registry",
      "--store-dir",
      "--userconfig",
      "--virtual-store-dir",
      "--workspace-dir",
    ]),
  );
  if (commandIndex === undefined) return new Set();
  const command = arguments_[commandIndex]?.toLowerCase();
  if (
    command === undefined
    || !new Set([
      "add",
      "ci",
      "i",
      "in",
      "ins",
      "inst",
      "insta",
      "instal",
      "install",
      "info",
      "list",
      "ls",
      "outdated",
      "prefix",
      "root",
      "search",
      "view",
      "why",
    ]).has(command)
  ) return new Set();
  const optionValues = new Set([
    "-C",
    "--cache",
    "--config-dir",
    "--dir",
    "--global-bin-dir",
    "--global-dir",
    "--prefix",
    "--registry",
    "--store-dir",
    "--userconfig",
    "--virtual-store-dir",
    "--workspace-dir",
  ]);
  const indexes = new Set<number>();
  for (let index = commandIndex + 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument.startsWith("-")) {
      if (
        !argument.includes("=")
        && (
          optionValues.has(argument)
          || /^--@[^:]+:registry$/iu.test(argument)
        )
      ) index += 1;
      continue;
    }
    indexes.add(index);
  }
  return indexes;
};

/**
 * Classify package-manager argv without consulting package/project metadata.
 * Unknown commands and ambiguous option layouts are denied: a package manager
 * may execute lifecycle hooks, project configuration, plugins, or downloaded
 * installers even though its top-level executable itself is allowlisted.
 */
const packageManagerPolicy = (
  executable: string,
  arguments_: ReadonlyArray<string>,
): PackageManagerPolicy | undefined => {
  const resolvedName = packageManagerName(executable);
  const manager = /^(?:pip|pip3)(?:\d+(?:\.\d+)*)?$/u.test(resolvedName)
    ? "pip"
    : resolvedName;
  const knownManagers = new Set([
    "apt",
    "apt-get",
    "brew",
    "bun",
    "composer",
    "dnf",
    "gem",
    "npm",
    "pip",
    "pipenv",
    "pnpm",
    "poetry",
    "uv",
    "winget",
    "yarn",
    "yum",
    "zypper",
  ]);
  if (!knownManagers.has(manager)) return undefined;
  const unambiguous = argumentsBeforeSeparator(arguments_);
  if (unambiguous === undefined) return { kind: "denied" };
  const dependencyIndexes = npmDependencyArgumentIndexes(manager, unambiguous);
  const sourceArguments = manager === "uv" || manager === "pip"
    ? nonOptionPackageManagerArguments(manager, unambiguous)
    : unambiguous;
  if (
    manager === "npm" || manager === "pnpm"
      ? [...dependencyIndexes].some((index) =>
        isUnboundedSourceDependency(unambiguous[index] ?? "")
      )
      : manager === "pip"
      ? sourceArguments.some(isPipSourceDependency)
      : sourceArguments.some(isExplicitSourceDependency)
  ) {
    return { kind: "denied" };
  }

  if (manager === "npm" || manager === "pnpm") {
    const commandIndex = firstCommandIndex(
      unambiguous,
      new Set([
        "-C",
        "--cache",
        "--config-dir",
        "--dir",
        "--global-bin-dir",
        "--global-dir",
        "--prefix",
        "--registry",
        "--store-dir",
        "--userconfig",
        "--virtual-store-dir",
        "--workspace-dir",
      ]),
    );
    const command = commandIndex === undefined
      ? undefined
      : unambiguous[commandIndex]?.toLowerCase();
    const nonExecuting = new Set([
      "diff",
      "info",
      "list",
      "ls",
      "outdated",
      "ping",
      "prefix",
      "root",
      "search",
      "show",
      "view",
      "why",
    ]);
    if (command !== undefined && nonExecuting.has(command)) {
      if (manager === "npm") return { kind: "non-executing" };
      const canonical = "--ignore-pnpmfile";
      if (
        hasDisabledOption(unambiguous, canonical)
        || unambiguous.includes("--use-pnpmfile")
      ) return { kind: "denied" };
      return {
        kind: "scripts-disabled",
        arguments: hasEnabledOption(unambiguous, canonical)
          ? arguments_
          : [...arguments_, canonical],
      };
    }
    if (
      command !== undefined
      && new Set([
        "add",
        "ci",
        "i",
        "in",
        "ins",
        "inst",
        "insta",
        "instal",
        "install",
        "isnt",
        "isnta",
        "isntal",
        "r",
        "remove",
        "rm",
        "un",
        "uninstall",
        "unlink",
      ])
        .has(command)
    ) {
      const canonical = "--ignore-scripts";
      if (
        hasDisabledOption(unambiguous, canonical)
        || unambiguous.includes("--no-ignore-scripts")
        || hasSeparateOptionValue(unambiguous, canonical)
      ) return { kind: "denied" };
      if (manager === "pnpm") {
        const projectHookGate = "--ignore-pnpmfile";
        if (
          hasDisabledOption(unambiguous, projectHookGate)
          || unambiguous.includes("--use-pnpmfile")
        ) return { kind: "denied" };
        return {
          kind: "scripts-disabled",
          arguments: [
            ...arguments_,
            ...(hasEnabledOption(unambiguous, canonical) ? [] : [canonical]),
            ...(hasEnabledOption(unambiguous, projectHookGate)
              ? []
              : [projectHookGate]),
          ],
        };
      }
      return {
        kind: "scripts-disabled",
        arguments: hasEnabledOption(unambiguous, canonical)
          ? arguments_
          : [...arguments_, canonical],
      };
    }
    return { kind: "denied" };
  }

  if (manager === "bun") {
    const commandIndex = firstCommandIndex(
      unambiguous,
      new Set(["--cwd", "--config", "--filter", "--registry"]),
    );
    const command = commandIndex === undefined
      ? undefined
      : unambiguous[commandIndex]?.toLowerCase();
    if (command === "help") {
      return { kind: "non-executing" };
    }
    if (
      command !== undefined
      && new Set(["add", "install", "i", "remove", "rm", "update"]).has(command)
    ) {
      const canonical = "--ignore-scripts";
      if (
        hasDisabledOption(unambiguous, canonical)
        || hasSeparateOptionValue(unambiguous, canonical)
      ) return { kind: "denied" };
      return {
        kind: "scripts-disabled",
        arguments: hasEnabledOption(unambiguous, canonical)
          ? arguments_
          : [...arguments_, canonical],
      };
    }
    return { kind: "denied" };
  }

  if (manager === "yarn") {
    // Yarn aliases and plugins can redefine commands, and Yarn has no stable
    // cross-version argv switch that independently disables all script paths.
    return { kind: "denied" };
  }

  if (manager === "pip") {
    const commandIndex = firstCommandIndex(
      unambiguous,
      new Set([
        "--cache-dir",
        "--config-settings",
        "--constraint",
        "--extra-index-url",
        "--find-links",
        "--index-url",
        "--isolated",
        "--proxy",
        "--requirement",
        "-r",
        "-c",
        "--trusted-host",
        "-f",
        "-i",
      ]),
    );
    const command = commandIndex === undefined
      ? undefined
      : unambiguous[commandIndex]?.toLowerCase();
    if (
      command !== undefined
      && new Set(["check", "freeze", "index", "inspect", "list", "show"]).has(command)
    ) {
      return { kind: "non-executing" };
    }
    if (command === "install") {
      if (hasNonCanonicalBinaryOption(unambiguous)) {
        return { kind: "denied" };
      }
      const canonical = "--only-binary=:all:";
      return {
        kind: "scripts-disabled",
        arguments: [
          ...(hasOnlyBinaryAll(unambiguous) ? arguments_ : [...arguments_, canonical]),
          ...(hasEnabledOption(unambiguous, "--isolated") ? [] : ["--isolated"]),
        ],
      };
    }
    return { kind: "denied" };
  }

  if (manager === "apt" || manager === "apt-get") {
    const commandIndex = firstCommandIndex(
      unambiguous,
      new Set(["-c", "-o", "--config-file", "--option"]),
    );
    return commandIndex !== undefined
      && new Set(["check", "download", "indextargets"]).has(
        unambiguous[commandIndex]!.toLowerCase(),
      )
      ? { kind: "non-executing" }
      : { kind: "denied" };
  }

  if (manager === "winget") {
    const commandIndex = firstCommandIndex(
      unambiguous,
      new Set(["--accept-source-agreements", "--disable-interactivity"]),
    );
    return commandIndex !== undefined
      && new Set(["download", "export", "list", "search", "show"]).has(
        unambiguous[commandIndex]!.toLowerCase(),
      )
      ? { kind: "non-executing" }
      : { kind: "denied" };
  }

  if (manager !== "uv") {
    // These managers have lifecycle hooks, plugins, build extensions, or
    // installer execution with no complete cross-version script-disable mode.
    return { kind: "denied" };
  }

  // uv can execute arbitrary build backends and project configuration during
  // install/sync. Only binary-only installs avoid that execution surface.
  const commandIndex = firstCommandIndex(
    unambiguous,
    new Set([
      "--cache-dir",
      "--config-file",
      "--default-index",
      "--directory",
      "--extra-index-url",
      "--index",
      "--index-url",
      "--project",
    ]),
  );
  const command = commandIndex === undefined
    ? undefined
    : unambiguous[commandIndex]?.toLowerCase();
  if (command !== undefined && new Set(["help", "version"]).has(command)) {
    return { kind: "non-executing" };
  }
  if (
    command === "tool"
    && unambiguous[commandIndex! + 1]?.toLowerCase() === "install"
  ) {
    if (hasNonCanonicalBinaryOption(unambiguous)) {
      return { kind: "denied" };
    }
    const canonical = "--only-binary=:all:";
    if (
      hasDisabledOption(unambiguous, "--no-config")
      || hasSeparateOptionValue(unambiguous, "--no-config")
    ) {
      return { kind: "denied" };
    }
    return {
      kind: "scripts-disabled",
      arguments: [
        ...(
          hasOnlyBinaryAll(unambiguous)
            ? arguments_
            : [...arguments_, canonical]
        ),
        ...(hasEnabledOption(unambiguous, "--no-config") ? [] : ["--no-config"]),
      ],
    };
  }
  if (command === "pip") {
    const subcommand = unambiguous[commandIndex! + 1]?.toLowerCase();
    if (subcommand !== undefined && new Set(["list", "show", "tree", "freeze"]).has(subcommand)) {
      return { kind: "non-executing" };
    }
    if (subcommand === "install") {
      if (hasNonCanonicalBinaryOption(unambiguous)) {
        return { kind: "denied" };
      }
      const canonical = "--only-binary=:all:";
      if (
        hasDisabledOption(unambiguous, "--no-config")
        || hasSeparateOptionValue(unambiguous, "--no-config")
      ) {
        return { kind: "denied" };
      }
      return {
        kind: "scripts-disabled",
        arguments: [
          ...(
            hasOnlyBinaryAll(unambiguous)
              ? arguments_
              : [...arguments_, canonical]
          ),
          ...(hasEnabledOption(unambiguous, "--no-config") ? [] : ["--no-config"]),
        ],
      };
    }
  }
  return { kind: "denied" };
};

const authorizePackageManagerInvocation = (
  executable: string,
  arguments_: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, DeniedAgentCapabilityError> => {
  const policy = packageManagerPolicy(executable, arguments_);
  if (policy === undefined || policy.kind === "non-executing") {
    return Effect.succeed(arguments_);
  }
  if (policy.kind === "scripts-disabled") {
    return Effect.succeed(policy.arguments);
  }
  return Effect.fail(new DeniedAgentCapabilityError({
    capability: "package-manager-scripts",
    value: executable,
  }));
};

interface InterpreterInvocation {
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
  readonly kind: InterpreterKind;
}

const interpreterInvocation = (
  executable: string,
  arguments_: ReadonlyArray<string>,
): InterpreterInvocation | undefined => {
  const direct = interpreterKind(executable);
  return direct === undefined
    ? undefined
    : { executable, arguments: arguments_, kind: direct };
};

const powershellOption = (argument: string): string | undefined => {
  if (!argument.startsWith("-") && !argument.startsWith("/")) return undefined;
  return argument.slice(1).split(/[=:]/u, 1)[0]?.toLowerCase();
};

const isPowershellOptionAbbreviation = (
  argument: string,
  option: "command" | "encodedcommand" | "file",
): boolean => {
  const token = powershellOption(argument);
  return token !== undefined
    && token.length > 0
    && option.startsWith(token);
};

const isInlineInterpreterArgument = (
  kind: InterpreterKind,
  argument: string,
): boolean => {
  const lower = argument.toLowerCase();
  switch (kind) {
    case "node":
      return /^-(?:e|p)(?:$|[^-])/u.test(lower)
        || /^--(?:eval|print)(?:$|=)/u.test(lower);
    case "python":
      return /^-c(?:$|.)/u.test(lower);
    case "posix-shell":
      return /^-[^-]*c/u.test(lower)
        || /^--command(?:$|=)/u.test(lower);
    case "powershell":
      return isPowershellOptionAbbreviation(argument, "command")
        || isPowershellOptionAbbreviation(argument, "encodedcommand");
  }
};

const interpreterScript = (
  invocation: InterpreterInvocation,
): string | undefined => {
  const arguments_ = invocation.arguments;
  if (invocation.kind === "powershell") {
    const first = arguments_[0];
    if (first === undefined || isInlineInterpreterArgument(invocation.kind, first)) {
      return undefined;
    }
    if (isPowershellOptionAbbreviation(first, "file")) {
      const separator = first.search(/[=:]/u);
      return separator > 0 ? first.slice(separator + 1) : arguments_[1];
    }
    const slashOption = /^\/[A-Za-z]+(?:[=:]|$)/u.test(first);
    return !first.startsWith("-") && !slashOption ? first : undefined;
  }
  const first = arguments_[0] === "--" ? arguments_[1] : arguments_[0];
  if (
    first === undefined
    || first.startsWith("-")
    || first.startsWith("+")
    || isInlineInterpreterArgument(invocation.kind, first)
  ) return undefined;
  return first;
};

const derivedCapabilities = (
  executable: string,
  arguments_: ReadonlyArray<string>,
): ReadonlySet<PrivilegedCapability> => {
  const capabilities = new Set<PrivilegedCapability>();
  const command = portableBasename(executable).toLowerCase().replace(/\.(?:cmd|exe)$/u, "");
  const tokens = arguments_.map((argument) => argument.toLowerCase());
  const commandTokens = [
    command,
    ...tokens
      .filter((argument) =>
        !argument.startsWith("-")
        && !(/^\/[^/\\]+$/u.test(argument))
      )
      .map((argument) =>
        portableBasename(argument).replace(/\.(?:cmd|exe)$/u, "")
      ),
  ];
  if (
    elevationExecutables.has(command)
    || tokens.some((argument) =>
      argument === "--sudo" || argument === "--elevated" || argument.startsWith("/runas")
    )
  ) {
    capabilities.add("elevation");
  }
  if (
    commandTokens.some((token) => loginExecutables.has(token))
    || tokens.some((argument) =>
      argument === "login"
      || argument === "logout"
      || argument === "logon"
      || argument === "session"
    )
  ) {
    capabilities.add("login");
  }
  if (commandTokens.includes("restart") || tokens.includes("restart")) {
    capabilities.add("restart");
  }
  if (
    commandTokens.some((token) => rebootExecutables.has(token))
    || tokens.some((argument) =>
      argument === "reboot"
      || (argument === "-r" && packageManagerName(executable) !== "pip")
      || argument === "/r"
    )
  ) {
    capabilities.add("reboot");
  }
  return capabilities;
};

type AuthorizationBounds = Pick<
  AgentHarnessConfiguration,
  | "allowedPaths"
  | "allowedExecutables"
  | "executableAuthorizations"
  | "allowedOrigins"
  | "allowedCapabilities"
>;

type AuthorizationEnvironment = {
  readonly environment?: ReadonlyArray<ProcessEnvironmentEntry> | undefined;
};

const taskBounds = (task: AgentTask): AuthorizationBounds => ({
  allowedPaths: task.allowedPaths,
  allowedExecutables: task.allowedExecutables,
  executableAuthorizations: task.executableAuthorizations,
  allowedOrigins: task.allowedOrigins,
  allowedCapabilities: (["elevation", "login", "restart", "reboot"] as const)
    .filter((capability) => !task.forbidden.includes(capability)),
});

const behaviorAuthorized = (
  executable: string,
  workingDirectory: string,
  environment: ReadonlyArray<ProcessEnvironmentEntry>,
  authorizations: ReadonlyArray<ExecutableAuthorization> | undefined,
  behavior: ExecutableAuthorization["behavior"],
): Effect.Effect<boolean> =>
  executableAllowed(
    executable,
    (authorizations ?? [])
      .filter((authorization) => authorization.behavior === behavior)
      .map((authorization) => authorization.executable),
    environment,
    workingDirectory,
  );

const authorizeExecutableBehavior = (
  executable: string,
  arguments_: ReadonlyArray<string>,
  workingDirectory: string,
  task: AgentTask,
  harness: AuthorizationBounds & AuthorizationEnvironment,
  deniedCapability: string,
  actionOrigins: ReadonlyArray<string> = [],
): Effect.Effect<ReadonlyArray<string>, DeniedAgentCapabilityError> =>
  Effect.gen(function*() {
    yield* validatePipRequirementInputs(
      executable,
      arguments_,
      workingDirectory,
      task,
      harness,
    );
    const scriptAuthorizedArguments = yield* authorizePackageManagerInvocation(
      executable,
      arguments_,
    );
    const authorizedArguments = yield* authorizeRegistryInvocation(
      executable,
      scriptAuthorizedArguments,
      task.allowedOrigins,
      harness.allowedOrigins,
      actionOrigins,
    );
    if (isNestedCommandLauncher(executable)) {
      // The descendant command of a launcher is not derivable from argv, so
      // neither a leaf nor a script-file classification can bound it. Deny
      // before any allowlist comparison regardless of what it is named.
      return yield* new DeniedAgentCapabilityError({
        capability: "nested-command-launcher",
        value: executable,
      });
    }
    const environment = harness.environment ?? [];
    const invocation = interpreterInvocation(executable, authorizedArguments);
    const behavior = invocation === undefined
      ? "leaf" as const
      : "script-interpreter" as const;
    const taskAuthorized = yield* behaviorAuthorized(
      executable,
      workingDirectory,
      environment,
      task.executableAuthorizations,
      behavior,
    );
    const harnessAuthorized = yield* behaviorAuthorized(
      executable,
      workingDirectory,
      environment,
      harness.executableAuthorizations,
      behavior,
    );
    if (!taskAuthorized || !harnessAuthorized) {
      return yield* new DeniedAgentCapabilityError({
        capability: deniedCapability,
        value: executable,
      });
    }
    if (invocation === undefined) return authorizedArguments;
    const script = interpreterScript(invocation);
    if (script === undefined) {
      return yield* new DeniedAgentCapabilityError({
        capability: "inline-program",
        value: invocation.executable,
      });
    }
    if (invocation.kind === "posix-shell" && !hasPathSeparator(script)) {
      return yield* new DeniedAgentCapabilityError({
        capability: "script-identity",
        value: script,
      });
    }
    yield* ensureAllowedPath(
      script,
      workingDirectory,
      task.allowedPaths,
      harness.allowedPaths,
    );
    return authorizedArguments;
  });

const resolveAuthorizedAction = (
  action: ProposedProcessAction,
  task: AgentTask,
  harness: AuthorizationBounds & AuthorizationEnvironment = taskBounds(task),
): Effect.Effect<ProposedProcessAction, DeniedAgentCapabilityError> =>
  Effect.gen(function*() {
    const workingDirectory = action.workingDirectory
      ?? task.allowedPaths[0]
      ?? process.cwd();
    const environment = harness.environment ?? [];
    const executable = yield* Effect.promise(() =>
      resolvedExecutableIdentity(action.executable, environment, workingDirectory)
    );
    if (
      executable === undefined
      || !(yield* executableAllowed(
        executable,
        task.allowedExecutables,
        environment,
        workingDirectory,
      ))
      || !(yield* executableAllowed(
        executable,
        harness.allowedExecutables,
        environment,
        workingDirectory,
      ))
    ) {
      return yield* new DeniedAgentCapabilityError({
        capability: "executable",
        value: action.executable,
      });
    }
    const capabilities = new Set([
      ...action.capabilities,
      ...derivedCapabilities(executable, action.arguments),
    ]);
    for (const capability of capabilities) {
      if (
        task.forbidden.includes(capability)
        || !harness.allowedCapabilities.includes(capability)
      ) {
        return yield* new DeniedAgentCapabilityError({
          capability,
          value: action.executable,
        });
      }
    }
    const authorizedArguments = yield* authorizeExecutableBehavior(
      executable,
      action.arguments,
      workingDirectory,
      task,
      harness,
      "executable-behavior",
      action.origins,
    );
    const npmArguments = npmDependencyArgumentIndexes(executable, authorizedArguments);
    const authorizedWorkingDirectory = action.workingDirectory
      ?? task.allowedPaths[0];
    if (authorizedWorkingDirectory === undefined) {
      return yield* new DeniedAgentCapabilityError({
        capability: "path",
        value: action.workingDirectory ?? "",
      });
    }
    yield* ensureAllowedPath(
      authorizedWorkingDirectory,
      authorizedWorkingDirectory,
      task.allowedPaths,
      harness.allowedPaths,
    );
    for (const path of action.paths) {
      yield* ensureAllowedPath(
        path,
        authorizedWorkingDirectory,
        task.allowedPaths,
        harness.allowedPaths,
      );
    }
    for (const [index, argument] of authorizedArguments.entries()) {
      const isNpmDependency = npmArguments.has(index);
      const path = argumentPath(argument, isNpmDependency);
      if (path !== undefined) {
        yield* ensureAllowedPath(
          path,
          authorizedWorkingDirectory,
          task.allowedPaths,
          harness.allowedPaths,
        );
      }
      for (const origin of argumentOrigins(argument, isNpmDependency)) {
        yield* ensureAllowedOrigin(
          origin,
          task.allowedOrigins,
          harness.allowedOrigins,
        );
      }
    }
    for (const origin of action.origins) {
      yield* ensureAllowedOrigin(
        origin,
        task.allowedOrigins,
        harness.allowedOrigins,
      );
    }
    return { ...action, executable, arguments: authorizedArguments };
  });

export const authorizeAction = (
  action: ProposedProcessAction,
  task: AgentTask,
  harness: AuthorizationBounds & AuthorizationEnvironment = taskBounds(task),
): Effect.Effect<void, DeniedAgentCapabilityError> =>
  resolveAuthorizedAction(action, task, harness).pipe(Effect.asVoid);

const resolveAuthorizedVerification = (
  task: AgentTask,
  harness: AuthorizationBounds & AuthorizationEnvironment,
): Effect.Effect<ReadonlyArray<string>, DeniedAgentCapabilityError> =>
  Effect.gen(function*() {
    const requestedExecutable = task.verification.command[0] ?? "";
    const workingDirectory = task.allowedPaths[0] ?? process.cwd();
    const environment = harness.environment ?? [];
    const executable = yield* Effect.promise(() =>
      resolvedExecutableIdentity(requestedExecutable, environment, workingDirectory)
    );
    if (
      executable === undefined
      || !(yield* executableAllowed(
        executable,
        task.allowedExecutables,
        environment,
        workingDirectory,
      ))
      || !(yield* executableAllowed(
        executable,
        harness.allowedExecutables,
        environment,
        workingDirectory,
      ))
      || derivedCapabilities(executable, task.verification.command.slice(1)).size > 0
    ) {
      return yield* new DeniedAgentCapabilityError({
        capability: "verification-executable",
        value: requestedExecutable,
      });
    }
    const authorizedArguments = yield* authorizeExecutableBehavior(
      executable,
      task.verification.command.slice(1),
      workingDirectory,
      task,
      harness,
      "verification-executable-behavior",
    );
    const npmArguments = npmDependencyArgumentIndexes(executable, authorizedArguments);
    yield* Effect.forEach(
      authorizedArguments.entries(),
      ([index, argument]) => {
        const isNpmDependency = npmArguments.has(index);
        const path = argumentPath(argument, isNpmDependency);
        if (path !== undefined) {
          return ensureAllowedPath(
            path,
            workingDirectory,
            task.allowedPaths,
            harness.allowedPaths,
          );
        }
        return Effect.forEach(
          argumentOrigins(argument, isNpmDependency),
          (origin) => ensureAllowedOrigin(
            origin,
            task.allowedOrigins,
            harness.allowedOrigins,
          ),
          { discard: true },
        );
      },
      { discard: true },
    );
    return [executable, ...authorizedArguments];
  });

export const resolveAuthorizedProposal = (
  proposal: AgentActionProposal,
  task: AgentTask,
  harness: AuthorizationBounds & AuthorizationEnvironment = taskBounds(task),
): Effect.Effect<
  {
    readonly proposal: AgentActionProposal;
    readonly verificationCommand: ReadonlyArray<string>;
  },
  DeniedAgentCapabilityError
> =>
  Effect.gen(function*() {
    const actions = yield* Effect.forEach(
      proposal.actions,
      (action) => resolveAuthorizedAction(action, task, harness),
    );
    const verificationCommand = yield* resolveAuthorizedVerification(task, harness);
    return {
      proposal: { ...proposal, actions },
      verificationCommand,
    };
  });

export const validateProposal = (
  proposal: AgentActionProposal,
  task: AgentTask,
  harness: AuthorizationBounds & AuthorizationEnvironment = taskBounds(task),
): Effect.Effect<void, DeniedAgentCapabilityError> =>
  resolveAuthorizedProposal(proposal, task, harness).pipe(Effect.asVoid);

export const profileChangeProposalFromResolution = (
  resolution: SourceDiscoveryResolution,
  createdAt: string,
): Effect.Effect<ReviewedProfileChangeProposal, InvalidAgentTaskError> => {
  if (!Number.isFinite(Date.parse(createdAt))) {
    return Effect.fail(new InvalidAgentTaskError({
      task: "source-discovery-resolution",
      message: "createdAt must be an ISO-compatible timestamp",
    }));
  }
  return Effect.succeed({
    reviewStatus: "pending",
    proposal: {
      createdAt,
      reason: resolution.reason,
      additions: resolution.additions,
      modifications: resolution.modifications,
      removals: resolution.removals,
      evidence: resolution.evidence,
    },
  });
};

export const nonzeroProcessError = (
  executable: string,
  exitCode: number | null,
  stderr: string,
): AgentProcessError => new AgentProcessError({
  executable,
  message: `process exited with ${String(exitCode)}: ${stderr}`,
});

export const failedVerification = (
  task: AgentTask,
  message: string,
): AgentVerificationError => new AgentVerificationError({
  command: task.verification.command,
  message,
});
