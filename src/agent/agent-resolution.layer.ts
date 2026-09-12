import { Effect, Layer } from "effect";

import type { ProcessEnvironmentEntry } from "../machine/machine-state.types.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import {
  resolveSecretBindings,
  type SecretProcessBinding,
} from "../secrets/secret-bindings.ts";
import { SecretTransferError } from "../secrets/secret-store.ts";

import {
  failedVerification,
  AgentResolution,
  decodeAgentProposal,
  nonzeroProcessError,
  profileChangeProposalFromResolution,
  registryOriginForInvocation,
  registryScopesForInvocation,
  redactAgentTask,
  revalidatePipRequirementFiles,
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

export type SecretBindingResolver = (
  bindings: ReadonlyArray<SecretProcessBinding>,
) => Effect.Effect<ReadonlyArray<ProcessEnvironmentEntry>, SecretTransferError>;

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
  resolveBindings: SecretBindingResolver,
  input: AgentResolutionInput,
): Effect.Effect<AgentResolutionOutcome, AgentResolutionError> =>
  Effect.gen(function*() {
    yield* validateAgentTask(input.task);
    const baseSecrets = input.secrets ?? [];
    const baseRecordedTask = redactAgentTask(input.task, baseSecrets);
    switch (input.policy) {
      case "deterministic-only":
        return {
          outcome: "deterministic-only",
          task: baseRecordedTask,
          reason: input.scheduled === true
            ? "scheduled deterministic-only policy requires human action"
            : "deterministic-only policy does not invoke an agent",
        };
      case "agent-propose":
      case "agent-apply":
        break;
    }
    const configuredBindings = input.harness.secretBindings ?? [];
    const literalEnvironmentNames = new Set(
      (input.harness.environment ?? []).map((entry) => entry.name),
    );
    const collision = configuredBindings.find((binding) =>
      literalEnvironmentNames.has(binding.name)
    );
    if (collision !== undefined) {
      return yield* new InvalidAgentTaskError({
        task: input.task.id,
        message:
          `secret binding ${collision.name} collides with a literal harness environment entry`,
      });
    }
    const boundEnvironment = yield* resolveBindings(configuredBindings).pipe(
      Effect.mapError(() =>
        new InvalidAgentTaskError({
          task: input.task.id,
          message: "a configured harness secret binding is unavailable",
        })
      ),
    );
    const secrets = [
      ...baseSecrets,
      ...boundEnvironment.map((entry) => entry.value),
    ];
    const recordedTask = redactAgentTask(input.task, secrets);

    const deadline = Date.now() + input.task.timeLimitSeconds * 1_000;
    const invocation = adaptHarnessInvocation(input.harness, input.task);
    const harnessEnvironment = [
      ...(invocation.environment ?? []),
      ...boundEnvironment,
    ];
    const harnessExecutable = yield* Effect.promise(() =>
      resolvedExecutableIdentity(
        invocation.executable,
        harnessEnvironment,
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
      environment: harnessEnvironment,
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
    // `outputBytes` is measured by the executor while the raw chunks are
    // still available. Never derive this budget from redacted strings:
    // replacing a long secret with "[REDACTED]" would otherwise let a
    // multi-action run exceed its aggregate limit.
    let consumed = rawHarness.outputBytes;
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
      const workingDirectory = action.workingDirectory ?? input.task.allowedPaths[0];
      if (workingDirectory === undefined) {
        return yield* new DeniedAgentCapabilityError({
          capability: "path",
          value: "",
        });
      }
      yield* revalidatePipRequirementFiles(
        action.executable,
        action.arguments,
        workingDirectory,
        input.task,
        input.harness,
        action.pipRequirementFiles ?? [],
      );
      const rawProcess = yield* executor({
        executable: action.executable,
        arguments: action.arguments,
        workingDirectory,
        environment: input.harness.environment,
        packageRegistryOrigin: registryOriginForInvocation(
          action.executable,
          action.arguments,
        ),
        packageRegistryScopes: registryScopesForInvocation(
          action.executable,
          action.arguments,
        ),
        pipRequirementFiles: action.pipRequirementFiles,
        timeoutMilliseconds: remainingTime(deadline),
        maximumInputBytes: 0,
        maximumOutputBytes: Math.min(
          input.task.outputLimitBytes,
          Math.max(0, input.task.outputLimitBytes - consumed),
        ),
        secrets,
        signal: input.signal,
      });
      const process = redactCaptured(rawProcess, secrets);
      consumed += rawProcess.outputBytes;
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
    yield* revalidatePipRequirementFiles(
      verificationExecutable,
      verificationArguments,
      input.task.allowedPaths[0] ?? process.cwd(),
      input.task,
      input.harness,
      authorized.verificationPipRequirementFiles,
    );
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
      pipRequirementFiles: authorized.verificationPipRequirementFiles,
      timeoutMilliseconds: remainingTime(deadline),
      maximumInputBytes: 0,
        maximumOutputBytes: Math.min(
          input.task.outputLimitBytes,
          Math.max(0, input.task.outputLimitBytes - consumed),
        ),
      secrets,
      signal: input.signal,
    });
    const observed = redactCaptured(rawObserved, secrets);
    consumed += rawObserved.outputBytes;
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

const makeAgentResolution = (
  executor: ControlledExecutor,
  resolveBindings: SecretBindingResolver,
): AgentResolution["Service"] =>
  AgentResolution.of({
    resolve: (input) => runResolution(executor, resolveBindings, input).pipe(
      Effect.mapError((error) => redactResolutionError(error, input.secrets ?? [])),
    ),
    proposeProfileChange: profileChangeProposalFromResolution,
  });

const noSecretBindings: SecretBindingResolver = (bindings) =>
  bindings.length === 0
    ? Effect.succeed([])
    : Effect.fail(new SecretTransferError({
      category: "storage",
      operation: "resolve harness secret bindings",
      message: "secret bindings require a configured machine credential store",
    }));

export const makeAgentResolutionLayer = (
  executor: ControlledExecutor,
  resolveBindings: SecretBindingResolver = noSecretBindings,
) => Layer.succeed(
  AgentResolution,
  makeAgentResolution(executor, resolveBindings),
);

export const AgentResolutionWithSecretsLive = Layer.effect(
  AgentResolution,
  Effect.gen(function*() {
    const machine = yield* MachineState;
    return makeAgentResolution(
      executeControlledProcess,
      (bindings) =>
        resolveSecretBindings(bindings).pipe(
          Effect.provideService(MachineState, machine),
        ),
    );
  }),
);

export const AgentResolutionLive = makeAgentResolutionLayer(
  executeControlledProcess,
);
