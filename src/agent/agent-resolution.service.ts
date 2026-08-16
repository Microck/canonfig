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
  isAbsolute,
  posix,
  relative,
  resolve,
  win32,
} from "node:path";

import { Context, Effect, Schema } from "effect";

import type { AgentTask } from "../domain/synchronization.ts";
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
  ProposedProcessAction,
  ReviewedProfileChangeProposal,
  SourceDiscoveryResolution,
} from "./agent-resolution.types.ts";
import { redactText } from "./controlled-executor.ts";

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

const executableCandidates = (value: string): ReadonlyArray<string> => {
  if (isAbsolute(value) || win32.isAbsolute(value) || hasPathSeparator(value)) {
    return [resolve(value)];
  }
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  return (process.env.PATH ?? "").split(delimiter).flatMap((directory) =>
    extensions.map((extension) => resolve(directory, `${value}${extension}`))
  );
};

const resolvedExecutableIdentity = async (value: string): Promise<string | undefined> => {
  for (const candidate of executableCandidates(value)) {
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
): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    if (allowed.includes(executable) && !hasPathSeparator(executable)) return true;
    const executableIdentity = await resolvedExecutableIdentity(executable);
    if (executableIdentity === undefined) return false;
    for (const entry of allowed) {
      const allowedIdentity = await resolvedExecutableIdentity(entry);
      if (allowedIdentity === executableIdentity) return true;
    }
    return false;
  });

const portableBasename = (value: string): string =>
  value.includes("\\") ? win32.basename(value) : basename(value);

const pathWithin = (path: string, root: string): boolean => {
  const windows = win32.isAbsolute(path) || win32.isAbsolute(root);
  const difference = windows
    ? win32.relative(win32.resolve(root), win32.resolve(path))
    : relative(resolve(root), resolve(path));
  return difference === "" || (
    !difference.startsWith("..")
    && !(windows ? win32.isAbsolute(difference) : isAbsolute(difference))
  );
};

const absoluteArgumentPath = (argument: string): string | undefined => {
  const value = argument.includes("=")
    ? argument.slice(argument.indexOf("=") + 1)
    : argument;
  return posix.isAbsolute(value) || win32.isAbsolute(value) ? value : undefined;
};

const argumentOrigins = (argument: string): ReadonlyArray<string> =>
  [...argument.matchAll(/https?:\/\/[^\s"'<>]+/giu)].map((match) => match[0]);

const ensureAllowedPath = (
  path: string,
  task: AgentTask,
): Effect.Effect<void, DeniedAgentCapabilityError> =>
  task.allowedPaths.some((root) => pathWithin(path, root))
    ? Effect.void
    : Effect.fail(new DeniedAgentCapabilityError({
      capability: "path",
      value: path,
    }));

const normalizeOrigin = (value: string): string | undefined => {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

const ensureAllowedOrigin = (
  value: string,
  task: AgentTask,
): Effect.Effect<void, DeniedAgentCapabilityError> => {
  const origin = normalizeOrigin(value);
  const allowed = task.allowedOrigins
    .map(normalizeOrigin)
    .filter((candidate) => candidate !== undefined);
  return origin !== undefined && allowed.includes(origin)
    ? Effect.void
    : Effect.fail(new DeniedAgentCapabilityError({
      capability: "network-origin",
      value,
    }));
};

const elevationExecutables = new Set(["sudo", "doas", "pkexec", "runas"]);

export const authorizeAction = (
  action: ProposedProcessAction,
  task: AgentTask,
): Effect.Effect<void, DeniedAgentCapabilityError> =>
  Effect.gen(function*() {
    if (!(yield* executableAllowed(action.executable, task.allowedExecutables))) {
      return yield* new DeniedAgentCapabilityError({
        capability: "executable",
        value: action.executable,
      });
    }
    if (
      elevationExecutables.has(portableBasename(action.executable).toLowerCase())
      || action.capabilities.includes("elevation")
    ) {
      return yield* new DeniedAgentCapabilityError({
        capability: "elevation",
        value: action.executable,
      });
    }
    for (const capability of action.capabilities) {
      if (task.forbidden.includes(capability)) {
        return yield* new DeniedAgentCapabilityError({
          capability,
          value: action.executable,
        });
      }
    }
    for (const path of action.paths) yield* ensureAllowedPath(path, task);
    if (action.workingDirectory !== undefined) {
      yield* ensureAllowedPath(action.workingDirectory, task);
    }
    for (const argument of action.arguments) {
      const path = absoluteArgumentPath(argument);
      if (path !== undefined) yield* ensureAllowedPath(path, task);
      for (const origin of argumentOrigins(argument)) {
        yield* ensureAllowedOrigin(origin, task);
      }
    }
    for (const origin of action.origins) yield* ensureAllowedOrigin(origin, task);
  });

const authorizeVerification = (
  task: AgentTask,
): Effect.Effect<void, DeniedAgentCapabilityError> =>
  Effect.gen(function*() {
    const executable = task.verification.command[0] ?? "";
    if (
      !(yield* executableAllowed(executable, task.allowedExecutables))
      || elevationExecutables.has(portableBasename(executable).toLowerCase())
    ) {
      return yield* new DeniedAgentCapabilityError({
        capability: "verification-executable",
        value: executable,
      });
    }
    yield* Effect.forEach(
      task.verification.command.slice(1),
      (argument) => {
        const path = absoluteArgumentPath(argument);
        if (path !== undefined) return ensureAllowedPath(path, task);
        return Effect.forEach(
          argumentOrigins(argument),
          (origin) => ensureAllowedOrigin(origin, task),
          { discard: true },
        );
      },
      { discard: true },
    );
  });

export const validateProposal = (
  proposal: AgentActionProposal,
  task: AgentTask,
): Effect.Effect<void, DeniedAgentCapabilityError> =>
  Effect.forEach(
    proposal.actions,
    (action) => authorizeAction(action, task),
    { discard: true },
  ).pipe(Effect.andThen(authorizeVerification(task)));

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
