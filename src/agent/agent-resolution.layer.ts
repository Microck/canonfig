import { Effect, Layer } from "effect";

import {
  failedVerification,
  AgentResolution,
  decodeAgentProposal,
  nonzeroProcessError,
  profileChangeProposalFromResolution,
  registryOriginForInvocation,
  registryScopesForInvocation,
  redactAgentTask,
  resolvedExecutableIdentity,
  resolveAuthorizedProposal,
  validateAgentTask,
} from "./agent-resolution.service.ts";
import type { AgentResolutionError } from "./agent-resolution.errors.ts";
import {
  AgentExecutionCancelledError,
  AgentExecutionTimeoutError,
  AgentInputLimitError,
  AgentOutputLimitError,
  AgentProcessError,
  AgentVerificationError,
  DeniedAgentCapabilityError,
  InvalidAgentResponseError,
  InvalidAgentTaskError,
  UnsupportedHarnessError,
} from "./agent-resolution.errors.ts";
import type {
  AgentResolutionInput,
  AgentResolutionOutcome,
  CapturedProcess,
  ControlledProcessInput,
  VerificationEvidence,
} from "./agent-resolution.types.ts";
import {
  executeControlledProcess,
  redactText,
} from "./controlled-executor.ts";
import {
  adaptHarnessInvocation,
  extractHarnessResponse,
} from "./harness-adapters.ts";

export type ControlledExecutor = (
  input: ControlledProcessInput,
) => Effect.Effect<CapturedProcess, AgentResolutionError>;

const byteLength = (process: CapturedProcess): number =>
  Buffer.byteLength(process.stdout) + Buffer.byteLength(process.stderr);

const redactCaptured = (
  process: CapturedProcess,
  secrets: ReadonlyArray<string>,
): CapturedProcess => ({
  ...process,
  executable: redactText(process.executable, secrets),
  arguments: process.arguments.map((value) => redactText(value, secrets)),
  stdout: redactText(process.stdout, secrets),
  stderr: redactText(process.stderr, secrets),
});

const remainingTime = (deadline: number): number =>
  Math.max(1, deadline - Date.now());

const ensureOutputBudget = (
  executable: string,
  maximum: number,
  consumed: number,
): Effect.Effect<void, AgentOutputLimitError> =>
  consumed <= maximum
    ? Effect.void
    : Effect.fail(new AgentOutputLimitError({
      executable,
      maximumBytes: maximum,
    }));

const runResolution = (
  executor: ControlledExecutor,
  input: AgentResolutionInput,
): Effect.Effect<AgentResolutionOutcome, AgentResolutionError> =>
  Effect.gen(function*() {
    yield* validateAgentTask(input.task);
    const secrets = input.secrets ?? [];
    const recordedTask = redactAgentTask(input.task, secrets);
    switch (input.policy) {
      case "deterministic-only":
        return {
          outcome: "deterministic-only",
          task: recordedTask,
          reason: input.scheduled === true
            ? "scheduled deterministic-only policy requires human action"
            : "deterministic-only policy does not invoke an agent",
        };
      case "agent-propose":
      case "agent-apply":
        break;
    }

    const deadline = Date.now() + input.task.timeLimitSeconds * 1_000;
    const invocation = adaptHarnessInvocation(input.harness, input.task);
    const harnessExecutable = yield* Effect.promise(() =>
      resolvedExecutableIdentity(
        invocation.executable,
        invocation.environment,
        process.cwd(),
      )
    );
    if (harnessExecutable === undefined) {
      return yield* new DeniedAgentCapabilityError({
        capability: "harness-executable",
        value: invocation.executable,
      });
    }
    const rawHarness = yield* executor({
      executable: harnessExecutable,
      arguments: invocation.arguments,
      environment: invocation.environment,
      standardInput: invocation.input,
      timeoutMilliseconds: remainingTime(deadline),
      maximumInputBytes: input.harness.maximumInputBytes,
      maximumOutputBytes: input.task.outputLimitBytes,
      secrets,
      signal: input.signal,
    });
    const harness = redactCaptured(rawHarness, secrets);
    if (harness.exitCode !== 0) {
      return yield* nonzeroProcessError(
        harness.executable,
        harness.exitCode,
        harness.stderr,
      );
    }
    let consumed = byteLength(harness);
    yield* ensureOutputBudget(
      harness.executable,
      input.task.outputLimitBytes,
      consumed,
    );
    const decodedProposal = yield* decodeAgentProposal(
      extractHarnessResponse(input.harness.harness, harness.stdout),
    );
    const authorized = yield* resolveAuthorizedProposal(
      decodedProposal,
      input.task,
      input.harness,
    );
    const proposal = authorized.proposal;
    if (input.policy === "agent-propose") {
      return {
        outcome: "proposed",
        task: recordedTask,
        proposal,
        harness,
      };
    }

    const executions: Array<CapturedProcess> = [];
    for (const action of proposal.actions) {
      const rawProcess = yield* executor({
        executable: action.executable,
        arguments: action.arguments,
        workingDirectory: action.workingDirectory ?? input.task.allowedPaths[0],
        environment: input.harness.environment,
        packageRegistryOrigin: registryOriginForInvocation(
          action.executable,
          action.arguments,
        ),
        packageRegistryScopes: registryScopesForInvocation(
          action.executable,
          action.arguments,
        ),
        timeoutMilliseconds: remainingTime(deadline),
        maximumInputBytes: 0,
        maximumOutputBytes: Math.max(0, input.task.outputLimitBytes - consumed),
        secrets,
        signal: input.signal,
      });
      const process = redactCaptured(rawProcess, secrets);
      consumed += byteLength(process);
      yield* ensureOutputBudget(
        process.executable,
        input.task.outputLimitBytes,
        consumed,
      );
      executions.push(process);
      if (process.exitCode !== 0) {
        return yield* nonzeroProcessError(
          process.executable,
          process.exitCode,
          process.stderr,
        );
      }
    }

    const [verificationExecutable = "", ...verificationArguments] =
      authorized.verificationCommand;
    const rawObserved = yield* executor({
      executable: verificationExecutable,
      arguments: verificationArguments,
      workingDirectory: input.task.allowedPaths[0],
      environment: input.harness.environment,
      packageRegistryOrigin: registryOriginForInvocation(
        verificationExecutable,
        verificationArguments,
      ),
      packageRegistryScopes: registryScopesForInvocation(
        verificationExecutable,
        verificationArguments,
      ),
      timeoutMilliseconds: remainingTime(deadline),
      maximumInputBytes: 0,
      maximumOutputBytes: Math.max(0, input.task.outputLimitBytes - consumed),
      secrets,
      signal: input.signal,
    });
    const observed = redactCaptured(rawObserved, secrets);
    consumed += byteLength(observed);
    yield* ensureOutputBudget(
      observed.executable,
      input.task.outputLimitBytes,
      consumed,
    );
    const matched = observed.exitCode === 0
      && (
        input.task.verification.expectContains === undefined
        || observed.stdout.includes(input.task.verification.expectContains)
        || observed.stderr.includes(input.task.verification.expectContains)
      );
    const verification: VerificationEvidence = {
      command: input.task.verification.command,
      exitCode: observed.exitCode,
      stdout: observed.stdout,
      stderr: observed.stderr,
      matched,
    };
    if (!matched) {
      return yield* failedVerification(
        input.task,
        `independent observer did not satisfy the verification contract: ${observed.stderr}`,
      );
    }
    return {
      outcome: "applied",
      task: recordedTask,
      proposal,
      harness,
      executions,
      verification,
    };
  });

const redactResolutionError = (
  error: AgentResolutionError,
  secrets: ReadonlyArray<string>,
): AgentResolutionError => {
  const clean = (value: string): string => redactText(value, secrets);
  switch (error._tag) {
    case "InvalidAgentTaskError":
      return new InvalidAgentTaskError({
        task: clean(error.task),
        message: clean(error.message),
      });
    case "UnsupportedHarnessError":
      return new UnsupportedHarnessError({ harness: clean(error.harness) });
    case "DeniedAgentCapabilityError":
      return new DeniedAgentCapabilityError({
        capability: clean(error.capability),
        value: clean(error.value),
      });
    case "AgentInputLimitError":
      return new AgentInputLimitError({
        actualBytes: error.actualBytes,
        maximumBytes: error.maximumBytes,
      });
    case "AgentExecutionTimeoutError":
      return new AgentExecutionTimeoutError({
        executable: clean(error.executable),
        timeoutMilliseconds: error.timeoutMilliseconds,
      });
    case "AgentExecutionCancelledError":
      return new AgentExecutionCancelledError({
        executable: clean(error.executable),
      });
    case "AgentOutputLimitError":
      return new AgentOutputLimitError({
        executable: clean(error.executable),
        maximumBytes: error.maximumBytes,
      });
    case "AgentProcessError":
      return new AgentProcessError({
        executable: clean(error.executable),
        message: clean(error.message),
      });
    case "InvalidAgentResponseError":
      return new InvalidAgentResponseError({ message: clean(error.message) });
    case "AgentVerificationError":
      return new AgentVerificationError({
        command: error.command.map(clean),
        message: clean(error.message),
      });
  }
};

export const makeAgentResolutionLayer = (
  executor: ControlledExecutor,
) => Layer.succeed(
  AgentResolution,
  AgentResolution.of({
    resolve: (input) => runResolution(executor, input).pipe(
      Effect.mapError((error) => redactResolutionError(error, input.secrets ?? [])),
    ),
    proposeProfileChange: profileChangeProposalFromResolution,
  }),
);

export const AgentResolutionLive = makeAgentResolutionLayer(
  executeControlledProcess,
);
