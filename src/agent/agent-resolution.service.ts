import {
  constants,
} from "node:fs";
import {
  access,
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
  const separator = argument.indexOf("=");
  return separator > 0 ? argument.slice(separator + 1) : undefined;
};

const argumentPath = (argument: string): string | undefined => {
  const value = optionValue(argument) ?? argument;
  if (value.length === 0 || value.startsWith("-")) return undefined;
  if (normalizeOrigin(value) !== undefined) return undefined;
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

const argumentOrigins = (argument: string): ReadonlyArray<string> =>
  [...argument.matchAll(/https?:\/\/[^\s"'<>]+/giu)].map((match) => match[0]);

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

const normalizeOrigin = (value: string): string | undefined => {
  try {
    return new URL(value).origin;
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
 * Package managers performing their own operations (`npm install`, `brew`,
 * `winget`, `uv`, ...) remain classifiable as leaf operations: their
 * side-effect scripts come from registry packages already bounded by the
 * origin allowlist, not from an argv-chosen command. Runner forms that select
 * a command to execute (`npx`, `uvx`, `make`, `go run`, ...) do not qualify.
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
  "bun",
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
      || argument === "-r"
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
): Effect.Effect<void, DeniedAgentCapabilityError> =>
  Effect.gen(function*() {
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
    const invocation = interpreterInvocation(executable, arguments_);
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
    if (invocation === undefined) return;
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
    yield* authorizeExecutableBehavior(
      executable,
      action.arguments,
      workingDirectory,
      task,
      harness,
      "executable-behavior",
    );
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
    for (const argument of action.arguments) {
      const path = argumentPath(argument);
      if (path !== undefined) {
        yield* ensureAllowedPath(
          path,
          authorizedWorkingDirectory,
          task.allowedPaths,
          harness.allowedPaths,
        );
      }
      for (const origin of argumentOrigins(argument)) {
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
    return { ...action, executable };
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
    yield* authorizeExecutableBehavior(
      executable,
      task.verification.command.slice(1),
      workingDirectory,
      task,
      harness,
      "verification-executable-behavior",
    );
    yield* Effect.forEach(
      task.verification.command.slice(1),
      (argument) => {
        const path = argumentPath(argument);
        if (path !== undefined) {
          return ensureAllowedPath(
            path,
            workingDirectory,
            task.allowedPaths,
            harness.allowedPaths,
          );
        }
        return Effect.forEach(
          argumentOrigins(argument),
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
    return [executable, ...task.verification.command.slice(1)];
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
