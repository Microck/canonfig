import { Clock, Effect, Option, Schema } from "effect";

import {
  ContentDigest,
  FollowerId,
  ProfileRevisionId,
  type ActionId,
  type ResourceId,
} from "../domain/brand.ts";
import type {
  AppliedResourceRecord,
  DriftConflict,
  HumanAction,
  PlannedAction,
  SynchronizationOutcome,
} from "../domain/synchronization.ts";
import type { MachineStateError } from "../machine/machine-state.errors.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { canonicalJson, sha256Hex } from "../profile/profile-codec.ts";
import { desiredResourceDigest } from "./resource-plans.ts";
import {
  prepareResourceAction,
  verifyResource,
  type PreparedResourceAction,
  type ResourceExecutionContext,
} from "./resource-executors.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import { ScheduleManager } from "../schedule/schedule-manager.service.ts";
import type { StateRepositoryError } from "../state/state-repository.errors.ts";
import type { VerificationEvidence } from "../state/state-repository.types.ts";
import {
  InvalidExecutionPlanError,
  MissingExecutionResourceError,
  type SynchronizationExecutionInputError,
} from "./synchronization.errors.ts";
import type {
  SynchronizationExecutionLimits,
  SynchronizationRunInput,
} from "./synchronization.types.ts";

export const defaultSynchronizationExecutionLimits: SynchronizationExecutionLimits = {
  maximumFileBytes: 16 * 1024 * 1024,
  processTimeoutMilliseconds: 10 * 60 * 1000,
  maximumProcessOutputBytes: 1024 * 1024,
  verificationConcurrency: 4,
};

export interface SynchronizationExecutionResult {
  readonly outcome: SynchronizationOutcome;
  readonly appliedResources: ReadonlyArray<AppliedResourceRecord>;
  readonly removedResources: ReadonlyArray<ResourceId>;
}

export interface ActionState {
  readonly action: PlannedAction;
  readonly context: ResourceExecutionContext;
}

const now = (): Effect.Effect<string> =>
  Effect.map(Clock.currentTimeMillis, (milliseconds) =>
    new Date(milliseconds).toISOString()
  );

const redact = (
  value:
    | Error
    | MachineStateError
    | StateRepositoryError
    | SynchronizationExecutionInputError,
  secrets: ReadonlyArray<string>,
): string => {
  let message = value instanceof Error
    ? value.message || value.constructor.name
    : String(value);
  for (const secret of secrets) {
    if (secret.length > 0) message = message.replaceAll(secret, "[REDACTED]");
  }
  return message.slice(0, 2048);
};

export const executionLimits = (
  input: SynchronizationRunInput,
): SynchronizationExecutionLimits => ({
  ...defaultSynchronizationExecutionLimits,
  ...input.limits,
});

const validateLimits = (
  limits: SynchronizationExecutionLimits,
): Effect.Effect<void, InvalidExecutionPlanError> => {
  if (
    !Number.isSafeInteger(limits.maximumFileBytes)
    || limits.maximumFileBytes <= 0
    || !Number.isSafeInteger(limits.processTimeoutMilliseconds)
    || limits.processTimeoutMilliseconds <= 0
    || !Number.isSafeInteger(limits.maximumProcessOutputBytes)
    || limits.maximumProcessOutputBytes < 0
    || !Number.isSafeInteger(limits.verificationConcurrency)
    || limits.verificationConcurrency <= 0
  ) {
    return Effect.fail(new InvalidExecutionPlanError({
      message: "execution limits must be positive safe integers",
    }));
  }
  return Effect.void;
};

export const executionContexts = (
  input: SynchronizationRunInput,
  limits: SynchronizationExecutionLimits,
): Effect.Effect<ReadonlyArray<ActionState>, SynchronizationExecutionInputError> =>
  Effect.gen(function*() {
    yield* validateLimits(limits);
    const encodedBody = canonicalJson(Schema.decodeUnknownSync(Schema.MutableJson)(
      JSON.parse(JSON.stringify({
        revision: input.plan.revision,
        follower: input.plan.follower,
        requiredBlobs: input.plan.requiredBlobs,
        actions: input.plan.actions,
        agentTasks: input.plan.agentTasks,
      })),
    ));
    if (
      input.plan.revision !== input.revision.id
      || input.plan.follower.length === 0
      || input.plan.digest !== sha256Hex(input.plan.encoded)
      || input.plan.encoded !== encodedBody
    ) {
      return yield* new InvalidExecutionPlanError({
        message: "plan identity or digest does not match its hydrated content",
      });
    }
    const resources = new Map(input.revision.resources.map((resource) => [
      resource.id,
      resource,
    ]));
    const desired = new Map(input.revision.desired.map((entry) => [
      entry.resource,
      entry,
    ]));
    const artifacts = new Map(input.artifacts.map((entry) => [
      entry.digest,
      entry,
    ]));
    const seen = new Set<string>();
    const completed = new Set<string>();
    const ordered: Array<ActionState> = [];
    const remaining = [...input.plan.actions];
    while (remaining.length > 0) {
      const index = remaining.findIndex((action) =>
        action.before.every((dependency) => completed.has(dependency))
      );
      if (index < 0) {
        return yield* new InvalidExecutionPlanError({
          message: "plan actions are cyclic or reference an unknown prerequisite",
        });
      }
      const action = remaining.splice(index, 1)[0]!;
      if (seen.has(action.id) || action.kind !== action.detail.kind) {
        return yield* new InvalidExecutionPlanError({
          message: `invalid or duplicate action ${action.id}`,
        });
      }
      const resource = resources.get(action.resource);
      const desiredEntry = desired.get(action.resource);
      if (resource === undefined || desiredEntry === undefined) {
        return yield* new MissingExecutionResourceError({
          resource: action.resource,
        });
      }
      seen.add(action.id);
      completed.add(action.id);
      ordered.push({
        action,
        context: {
          run: input.id,
          action,
          resource,
          desired: desiredEntry.desired,
          verification: desiredEntry.verification,
          artifacts,
          limits,
          previousSchedule: input.appliedResources?.find((record) =>
            record.resource === action.resource
          )?.schedule,
        },
      });
    }
    return ordered;
  });

const verificationEvidence = (
  result: {
    readonly passed: boolean;
    readonly method: string;
    readonly observedDigest?: string | undefined;
    readonly exitCode?: number | undefined;
  },
): VerificationEvidence => {
  const base = {
    status: result.passed ? "passed" as const : "failed" as const,
    method: result.method,
  };
  const withDigest = result.observedDigest === undefined
    ? base
    : {
      ...base,
      observedDigest: Schema.decodeUnknownSync(ContentDigest)(result.observedDigest),
    };
  return result.exitCode === undefined
    ? withDigest
    : { ...withDigest, exitCode: result.exitCode };
};

const journal = (
  run: SynchronizationRunInput["id"],
  action: ActionId,
  state: "running" | "succeeded" | "failed" | "skipped",
  verification?: VerificationEvidence | undefined,
  rollbackReference?: string | undefined,
  attempt = 1,
  appliedResource?: AppliedResourceRecord | undefined,
  removedResource?: ResourceId | undefined,
) =>
  Effect.gen(function*() {
    const repository = yield* StateRepository;
    const recordedAt = yield* now();
    const base = {
      run,
      action,
      state,
      recordedAt,
      attempt,
    };
    yield* repository.journalAction({
      ...base,
      verification,
      rollbackReference,
      appliedResource,
      removedResource,
    });
  });

const rollbackPrepared = (
  prepared: PreparedResourceAction | undefined,
) => prepared?.rollback ?? Effect.void;

const appliedResourceFor = (
  input: SynchronizationRunInput,
  state: ActionState,
  appliedAt: string,
): AppliedResourceRecord | undefined => {
  const desired = state.context.desired;
  const digest = desiredResourceDigest(desired);
  if (digest === undefined) return undefined;
  return {
    resource: state.action.resource,
    revision: input.revision.id,
    digest,
    appliedAt,
    kind: state.context.resource.kind,
    policy: state.context.resource.policy,
    target: state.context.resource.target,
    executable: desired.kind === "file" ? desired.executable : undefined,
    symlinkTo: desired.kind === "file" ? desired.symlinkTo : undefined,
    ownedFiles: desired.kind === "directory" || desired.kind === "skill"
      ? desired.files.map((file) => ({
        path: file.path,
        digest: file.digest,
        executable: file.executable,
      }))
      : undefined,
    ownedKeys: desired.kind === "config" ? desired.keys : undefined,
    configFormat: desired.kind === "config" ? desired.format : undefined,
    schedule: desired.kind === "schedule" ? desired.schedule : undefined,
  };
};

export interface ActionResult {
  readonly kind: "verified" | "human" | "drift" | "failed";
  readonly resource?: ResourceId | undefined;
  readonly human?: HumanAction | undefined;
  readonly drift?: DriftConflict | undefined;
  readonly reason?: string | undefined;
}

export const driftResult = (
  input: SynchronizationRunInput,
  state: ActionState,
): ActionResult => {
  const detail = state.action.detail;
  if (detail.kind !== "drift-conflict") {
    return { kind: "failed", reason: "invalid drift action" };
  }
  const previous = input.appliedResources?.find((record) =>
    record.resource === state.action.resource
  );
  return {
    kind: "drift",
    drift: {
      resource: state.action.resource,
      target: detail.target,
      desiredDigest: detail.desiredDigest,
      observedDigest: detail.observedDigest,
      lastAppliedDigest: previous?.digest ?? detail.desiredDigest,
    },
  };
};

export const executeSynchronizationAction = (
  input: SynchronizationRunInput,
  state: ActionState,
  attempt = 1,
): Effect.Effect<ActionResult, never, StateRepository | MachineState> =>
  Effect.gen(function*() {
    const detail = state.action.detail;
    if (detail.kind === "human-action") {
      yield* journal(input.id, state.action.id, "skipped", undefined, undefined, attempt);
      return {
        kind: "human",
        human: {
          reason: detail.reason,
          instructions: detail.instructions,
          resource: state.action.resource,
        },
      } satisfies ActionResult;
    }
    if (detail.kind === "agent-task") {
      yield* journal(input.id, state.action.id, "skipped", undefined, undefined, attempt);
      return {
        kind: "human",
        human: {
          reason: `Bounded agent task requires resolution: ${detail.summary}`,
          instructions:
            `Resolve task ${detail.taskId} under the configured agent policy, then rerun synchronization.`,
          resource: state.action.resource,
        },
      } satisfies ActionResult;
    }
    if (detail.kind === "drift-conflict") {
      const result = driftResult(input, state);
      if (result.drift !== undefined) {
        const repository = yield* StateRepository;
        yield* repository.recordDrift({
          run: input.id,
          conflict: result.drift,
          recordedAt: yield* now(),
        });
      }
      yield* journal(input.id, state.action.id, "skipped", undefined, undefined, attempt);
      return result;
    }

    let prepared: PreparedResourceAction | undefined;
    const scheduleManager = state.context.resource.kind === "schedule"
      ? Option.getOrUndefined(yield* Effect.serviceOption(ScheduleManager))
      : undefined;
    const work = Effect.gen(function*() {
      prepared = yield* prepareResourceAction(state.context, scheduleManager);
      yield* journal(
        input.id,
        state.action.id,
        "running",
        undefined,
        prepared.rollbackReference,
        attempt,
      );
      yield* prepared.execute;
      if (detail.kind === "transfer-blob") {
        yield* journal(
          input.id,
          state.action.id,
          "succeeded",
          { status: "passed", method: "sha256-and-size" },
          prepared.rollbackReference,
          attempt,
        );
        return { kind: "verified" } satisfies ActionResult;
      }
      if (detail.kind === "remove-resource") {
        yield* journal(
          input.id,
          state.action.id,
          "succeeded",
          { status: "passed", method: "owned-resource-removed" },
          prepared.rollbackReference,
          attempt,
          undefined,
          state.action.resource,
        );
        return {
          kind: "verified",
          resource: state.action.resource,
        } satisfies ActionResult;
      }
      const verification = yield* verifyResource(state.context, scheduleManager);
      const evidence = verificationEvidence(verification);
      if (!verification.passed) {
        yield* rollbackPrepared(prepared);
        yield* journal(
          input.id,
          state.action.id,
          "failed",
          evidence,
          prepared.rollbackReference,
          attempt,
        );
        return {
          kind: "failed",
          reason: `verification failed for resource ${state.action.resource}`,
        } satisfies ActionResult;
      }
      const appliedResource = appliedResourceFor(input, state, yield* now());
      yield* journal(
        input.id,
        state.action.id,
        "succeeded",
        evidence,
        prepared.rollbackReference,
        attempt,
        appliedResource,
      );
      return {
        kind: "verified",
        resource: state.action.resource,
      } satisfies ActionResult;
    }).pipe(
      Effect.onInterrupt(() =>
        rollbackPrepared(prepared).pipe(
          Effect.andThen(journal(
            input.id,
            state.action.id,
            "failed",
            { status: "not-run", method: "interrupted" },
            prepared?.rollbackReference,
            attempt,
          )),
          Effect.ignore,
        )
      ),
    );
    return yield* work.pipe(
      Effect.catch((error) =>
        rollbackPrepared(prepared).pipe(
          Effect.andThen(journal(
            input.id,
            state.action.id,
            "failed",
            { status: "not-run", method: "action-failed" },
            prepared?.rollbackReference,
            attempt,
          )),
          Effect.as({
            kind: "failed",
            reason: redact(error, input.knownSecrets ?? []),
          } satisfies ActionResult),
          Effect.catch((journalError) =>
            Effect.succeed({
              kind: "failed",
              reason: redact(journalError, input.knownSecrets ?? []),
            } satisfies ActionResult)
          ),
        )
      ),
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        kind: "failed",
        reason: redact(error, input.knownSecrets ?? []),
      } satisfies ActionResult)
    ),
  );

const completeSkipped = (
  input: SynchronizationRunInput,
  states: ReadonlyArray<ActionState>,
): Effect.Effect<void, never, StateRepository> =>
  Effect.forEach(
    states,
    (state) => journal(input.id, state.action.id, "skipped").pipe(Effect.ignore),
    { discard: true },
  );

/** Execute one already-recorded plan. The caller owns startRun ordering. */
export const executeSynchronizationPlan = (
  input: SynchronizationRunInput,
): Effect.Effect<
  SynchronizationExecutionResult,
  SynchronizationExecutionInputError,
  StateRepository | MachineState
> =>
  Effect.gen(function*() {
    const states = yield* executionContexts(input, executionLimits(input));
    const completedActions: Array<ActionId> = [];
    const verified = new Set<ResourceId>();
    const applied: Array<AppliedResourceRecord> = [];
    const human: Array<HumanAction> = [];
    const drift: Array<DriftConflict> = [];
    const removedResources = new Set<ResourceId>();
    let failedReason: string | undefined;

    const runActions = Effect.gen(function*() {
      for (let index = 0; index < states.length; index += 1) {
        const state = states[index]!;
        const result = yield* executeSynchronizationAction(input, state);
        completedActions.push(state.action.id);
        if (result.resource !== undefined) verified.add(result.resource);
        if (
          result.resource !== undefined
          && input.revision.removedResources?.includes(result.resource) === true
        ) {
          removedResources.add(result.resource);
        }
        if (result.human !== undefined) human.push(result.human);
        if (result.drift !== undefined) drift.push(result.drift);
        if (result.reason !== undefined) failedReason = result.reason;
        if (result.kind !== "verified") {
          yield* completeSkipped(input, states.slice(index + 1));
          break;
        }
      }
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.gen(function*() {
          const repository = yield* StateRepository;
          const outcome: SynchronizationOutcome = {
            outcome: "Interrupted",
            run: input.id,
            completedActions,
          };
          yield* repository.completeRun({
            run: input.id,
            completedAt: yield* now(),
            outcome,
            appliedResources: [],
            removedResources: [],
          });
        }).pipe(Effect.ignore)
      ),
    );
    yield* runActions;

    const outcome: SynchronizationOutcome = failedReason !== undefined
      ? { outcome: "Failed", run: input.id, reason: failedReason }
      : drift.length > 0
      ? { outcome: "FollowerDrift", run: input.id, conflicts: drift }
      : human.length > 0
      ? { outcome: "HumanActionRequired", run: input.id, actions: human }
      : {
        outcome: "Converged",
        run: input.id,
        verified: [...verified].sort(),
      };

    if (outcome.outcome === "Converged") {
      const appliedAt = yield* now();
      const desiredByResource = new Map(input.revision.desired.map((entry) => [
        entry.resource,
        entry.desired,
      ]));
      const resourceById = new Map(input.revision.resources.map((resource) => [
        resource.id,
        resource,
      ]));
      for (const resource of outcome.verified) {
        if (removedResources.has(resource)) continue;
        const desired = desiredByResource.get(resource);
        const digest = desired === undefined ? undefined : desiredResourceDigest(desired);
        if (digest !== undefined) {
          const ownedFiles = desired?.kind === "directory" || desired?.kind === "skill"
            ? desired.files.map((file) => ({
              path: file.path,
              digest: file.digest,
              executable: file.executable,
            }))
            : undefined;
          applied.push({
            resource,
            revision: input.revision.id,
            digest,
            appliedAt,
            kind: resourceById.get(resource)?.kind,
            policy: resourceById.get(resource)?.policy,
            target: resourceById.get(resource)?.target,
            executable: desired?.kind === "file" ? desired.executable : undefined,
            symlinkTo: desired?.kind === "file" ? desired.symlinkTo : undefined,
            ownedFiles,
            ownedKeys: desired?.kind === "config" ? desired.keys : undefined,
            configFormat: desired?.kind === "config" ? desired.format : undefined,
            schedule: desired?.kind === "schedule"
              ? desired.schedule
              : undefined,
          });
        }
      }
    }
    return {
      outcome,
      appliedResources: applied,
      removedResources: outcome.outcome === "Converged"
        ? [...removedResources].sort()
        : [],
    };
  });

export const executionFollower = (input: SynchronizationRunInput) =>
  Schema.decodeUnknownEffect(FollowerId)(input.plan.follower).pipe(
    Effect.mapError((error) =>
      new InvalidExecutionPlanError({ message: String(error) })
    ),
  );

export const executionRevision = (input: SynchronizationRunInput) =>
  Schema.decodeUnknownEffect(ProfileRevisionId)(input.plan.revision).pipe(
    Effect.mapError((error) =>
      new InvalidExecutionPlanError({ message: String(error) })
    ),
  );
