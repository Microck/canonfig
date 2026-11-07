import { Clock, Effect, Schema } from "effect";

import {
  AgentTaskId,
  BlobId,
  ContentDigest,
  FollowerId,
  ProfileRevisionId,
  ResourceId,
  type ActionId,
} from "../domain/brand.ts";
import type {
  AppliedResourceRecord,
  PlannedAction,
  SynchronizationOutcome,
} from "../domain/synchronization.ts";
import {
  ExecutableAuthorizationSchema,
  PlannedAction as PlannedActionSchema,
} from "../domain/synchronization.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { canonicalJson, sha256Hex } from "../profile/profile-codec.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import { transitionAction } from "../state/action-lifecycle.ts";
import type { StateRepositoryError } from "../state/state-repository.errors.ts";
import type {
  ActionJournalRecord,
  ActionLifecycle,
  RecoveryState,
  VerificationEvidence,
} from "../state/state-repository.types.ts";
import {
  appliedResourceFor,
  restoreAction,
  reduceActionResult,
  actionProgressOutcome,
  blockRunRollback,
  withRollbackOutcome,
  type RunRollback,
  type ActionProgress,
  executionContexts,
  executionLimits,
  executeSynchronizationAction,
  removeRunTemporaryEntries,
  type ActionResult,
  type SynchronizationExecutionResult,
} from "./executor.ts";
import { desiredResourceDigest } from "./resource-plans.ts";
import {
  inspectRollbackTargets,
  rollbackPreimages,
  type RollbackProjection,
  restoreRollbackReference,
  verifyResource,
  type ResourceExecutionContext,
  type ResourceVerification,
} from "./resource-executors.ts";
import {
  RecoveryIntegrityError,
  RecoveryLocalEditError,
  RecoveryRunNotFoundError,
  type SynchronizationRecoveryError,
} from "./synchronization.errors.ts";
import type {
  PlannedSynchronization,
  PlanningProfileRevision,
  SynchronizationRecoveryInput,
  SynchronizationRunInput,
} from "./synchronization.types.ts";

const PersistedPlanBody = Schema.Struct({
  revision: ProfileRevisionId,
  follower: FollowerId,
  requiredBlobs: Schema.Array(BlobId),
  actions: Schema.Array(PlannedActionSchema),
  agentTasks: Schema.Array(Schema.Struct({
    id: AgentTaskId,
    resource: ResourceId,
    summary: Schema.NonEmptyString,
    desiredOutcome: Schema.NonEmptyString,
    observedEvidence: Schema.Array(Schema.String),
    allowedPaths: Schema.Array(Schema.String),
    allowedExecutables: Schema.Array(Schema.String),
    executableAuthorizations: Schema.optional(
      Schema.Array(ExecutableAuthorizationSchema),
    ),
    allowedOrigins: Schema.Array(Schema.String),
    forbidden: Schema.Array(Schema.Literals([
      "elevation",
      "login",
      "restart",
      "reboot",
    ])),
    timeLimitSeconds: Schema.Int,
    outputLimitBytes: Schema.Int,
    verification: Schema.Struct({
      command: Schema.Array(Schema.String),
    }),
  })),
});

const now = Effect.map(
  Clock.currentTimeMillis,
  (milliseconds) => new Date(milliseconds).toISOString(),
);

const integrityError = (
  recovery: RecoveryState,
  message: string,
): RecoveryIntegrityError =>
  new RecoveryIntegrityError({ run: recovery.run.id, message });

const hydratePlan = (
  recovery: RecoveryState,
): Effect.Effect<PlannedSynchronization, RecoveryIntegrityError> =>
  Effect.gen(function*() {
    const decoded = yield* Effect.try({
      try: () => JSON.parse(recovery.run.plan.encoded),
      catch: (error) => integrityError(recovery, `persisted plan encoding is malformed: ${String(error)}`),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PersistedPlanBody)),
      Effect.mapError((error) =>
        error instanceof RecoveryIntegrityError
          ? error
          : integrityError(recovery, `persisted plan encoding is invalid: ${String(error)}`)
      ),
    );
    const canonical = canonicalJson(Schema.decodeUnknownSync(Schema.MutableJson)(decoded));
    const computedDigest = Schema.decodeUnknownSync(ContentDigest)(
      sha256Hex(recovery.run.plan.encoded),
    );
    if (
      canonical !== recovery.run.plan.encoded
      || recovery.run.plan.digest !== computedDigest
      || decoded.revision !== recovery.run.revision
      || decoded.follower !== recovery.run.follower
      || JSON.stringify(decoded.actions) !== JSON.stringify(recovery.run.plan.actions)
    ) {
      return yield* integrityError(
        recovery,
        "persisted plan identity or actions do not match its canonical encoding",
      );
    }
    return {
      ...recovery.run.plan,
      digest: computedDigest,
      requiredBlobs: decoded.requiredBlobs,
      agentTasks: decoded.agentTasks,
    };
  });

const validateJournal = (
  recovery: RecoveryState,
  actions: ReadonlyArray<PlannedAction>,
): Effect.Effect<ReadonlyMap<string, ActionJournalRecord>, RecoveryIntegrityError> =>
  Effect.gen(function*() {
    const planned = new Set(actions.map((action) => action.id));
    const events = new Map<string, Array<ActionJournalRecord>>();
    for (let index = 0; index < recovery.actions.length; index += 1) {
      const event = recovery.actions[index]!;
      if (event.ordinal !== index || !planned.has(event.action)) {
        return yield* integrityError(recovery, "action journal order or action identity is invalid");
      }
      const actionEvents = events.get(event.action) ?? [];
      actionEvents.push(event);
      events.set(event.action, actionEvents);
    }
    const latest = new Map<string, ActionJournalRecord>();
    for (const action of actions) {
      const actionEvents = events.get(action.id);
      let lifecycle: ActionLifecycle | undefined;
      if (actionEvents === undefined) return yield* integrityError(recovery, `action ${action.id} has no journal`);
      for (const event of actionEvents) {
        lifecycle = yield* transitionAction(recovery.run.id, lifecycle, event).pipe(
          Effect.mapError((error) => integrityError(recovery, error.message)));
      }
      const last = actionEvents.at(-1)!;
      latest.set(action.id, last);
    }
    return latest;
  });

const baseRevision = (revision: PlanningProfileRevision) => ({
  id: revision.id,
  profileId: revision.profileId,
  sequence: revision.sequence,
  canonicalBytes: revision.canonicalBytes,
  digest: revision.digest,
  signature: revision.signature,
  publishedAt: revision.publishedAt,
  resources: revision.resources
    .filter((resource) => !revision.removedResources?.includes(resource.id))
    .map((resource) => ({
    id: resource.id,
    kind: resource.kind,
    policy: resource.policy,
    target: resource.target,
    groups: resource.groups,
    dependsOn: resource.dependsOn,
    spec: resource.spec,
    blobs: resource.blobs,
    })),
  groups: revision.groups,
  scheduleDefault: revision.scheduleDefault,
});

const evidence = (verification: ResourceVerification): VerificationEvidence => {
  const base = {
    status: verification.passed ? "passed" as const : "failed" as const,
    method: verification.method,
  };
  const withDigest = verification.observedDigest === undefined
    ? base
    : {
      ...base,
      observedDigest: Schema.decodeUnknownSync(ContentDigest)(
        verification.observedDigest,
      ),
    };
  return verification.exitCode === undefined
    ? withDigest
    : { ...withDigest, exitCode: verification.exitCode };
};

const appendJournal = (
  run: SynchronizationRunInput["id"],
  action: PlannedAction,
  state: "running" | "succeeded" | "failed" | "blocked" | "interrupted" | "rolled-back",
  attempt: number,
  verification?: VerificationEvidence,
  rollbackReference?: string,
  appliedResource?: AppliedResourceRecord,
  removedResource?: ResourceId,
) =>
  Effect.gen(function*() {
    const repository = yield* StateRepository;
    const base = {
      run,
      action: action.id,
      state,
      recordedAt: yield* now,
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

const latestRollbackReference = (
  events: ReadonlyArray<ActionJournalRecord>,
  action: ActionJournalRecord["action"],
): string | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.action === action && event.state !== "pending" && event.rollbackReference !== undefined) {
      return event.rollbackReference;
    }
  }
  return undefined;
};

const restoreResourceRollbackReference = (
  context: ResourceExecutionContext,
  reference: string,
) => restoreRollbackReference(context, reference);

const preservedOutcome = (
  input: SynchronizationRunInput,
  action: PlannedAction,
): ActionResult => {
  const detail = action.detail;
  if (detail.kind === "human-action") {
    return {
      kind: "human",
      human: {
        reason: detail.reason,
        instructions: detail.instructions,
        resource: action.resource,
      },
    };
  }
  if (detail.kind === "agent-task") {
    return {
      kind: "human",
      human: {
        reason: `Bounded agent task requires resolution: ${detail.summary}`,
        instructions:
          `Resolve task ${detail.taskId} under the configured agent policy, then rerun synchronization.`,
        resource: action.resource,
      },
    };
  }
  if (detail.kind === "drift-conflict") {
    const previous = input.appliedResources?.find((record) =>
      record.resource === action.resource
    );
    return {
      kind: "drift",
      drift: {
        resource: action.resource,
        target: detail.target,
        desiredDigest: detail.desiredDigest,
        observedDigest: detail.observedDigest,
        lastAppliedDigest: previous?.digest ?? detail.desiredDigest,
      },
    };
  }
  return { kind: "failed", reason: `invalid blocked action ${action.id}`, rollbackState: { _tag: "NotRequired" } };
};

const uncertainInstaller = (
  input: SynchronizationRunInput,
  state: Parameters<typeof verifyResource>[0],
  action: PlannedAction,
  attempt: number,
): Effect.Effect<ActionResult, never, StateRepository | MachineState> =>
  verifyResource(state).pipe(
    Effect.flatMap((verification): Effect.Effect<
      ActionResult,
      StateRepositoryError,
      StateRepository
    > => {
      const observed = evidence(verification);
      if (verification.passed) {
        return appendJournal(
          input.id,
          action,
          "succeeded",
          attempt,
          observed,
        ).pipe(Effect.as({
          kind: "verified",
          resource: action.resource,
        } satisfies ActionResult));
      }
      return appendJournal(
        input.id,
        action,
        "blocked",
        attempt,
        observed,
      ).pipe(Effect.as({
        kind: "human",
        human: {
          reason: `Installer state is uncertain for ${action.resource}`,
          instructions:
            "Verify or complete the external installation manually, then rerun recovery.",
          resource: action.resource,
        },
      } satisfies ActionResult));
    }),
    Effect.catch(() =>
      Effect.succeed({
        kind: "human",
        human: {
          reason: `Installer state is uncertain for ${action.resource}`,
          instructions:
            "Verify or complete the external installation manually, then rerun recovery.",
          resource: action.resource,
        },
      } satisfies ActionResult)
    ),
  );

/**
 * Resume one active run from repository evidence. The persisted plan remains
 * authoritative; hydrated revision content and artifacts are integrity inputs.
 */
export const recoverSynchronizationPlan = (
  recoveryInput: SynchronizationRecoveryInput,
): Effect.Effect<
  SynchronizationExecutionResult,
  SynchronizationRecoveryError | StateRepositoryError,
  StateRepository | MachineState
> =>
  Effect.gen(function*() {
    const repository = yield* StateRepository;
    const recovery = yield* repository.loadRecovery(recoveryInput.follower);
    if (recovery === undefined) {
      return yield* new RecoveryRunNotFoundError({
        follower: recoveryInput.follower,
      });
    }
    const plan = yield* hydratePlan(recovery);
    // A local revision is stored whole, so recovery resumes from exactly the
    // stored value; a published revision is compared without its hydration.
    const matchesPersisted = "origin" in recoveryInput.revision
      ? JSON.stringify(yield* repository.getLocalRevision(recovery.run.revision))
        === JSON.stringify(recoveryInput.revision)
      : JSON.stringify(baseRevision(recoveryInput.revision))
        === JSON.stringify(yield* repository.getRevision(recovery.run.revision));
    if (recoveryInput.revision.id !== recovery.run.revision || !matchesPersisted) {
      return yield* integrityError(
        recovery,
        "hydrated revision does not match the persisted run revision",
      );
    }
    const latest = yield* validateJournal(recovery, plan.actions);
    const recoveryAppliedResources = [
      ...new Map([
        ...recovery.appliedResources,
        ...recovery.removedResources,
      ].map((record) => [record.resource, record] as const)).values(),
    ];
    const input: SynchronizationRunInput = {
      id: recovery.run.id,
      plan,
      revision: recoveryInput.revision,
      appliedResources: recoveryAppliedResources,
      artifacts: recoveryInput.artifacts,
      knownSecrets: recoveryInput.knownSecrets,
      limits: recoveryInput.limits,
      agent: recoveryInput.agent,
      agentResolution: recoveryInput.agentResolution,
    };
    const states = yield* executionContexts(input, executionLimits(input));
    // Nothing is touched until every interrupted action's targets are known
    // to be either as they were before the run or as the run was writing
    // them. Anything else is a later local edit: restoring the snapshot or
    // re-running the action would destroy it, so recovery stops and keeps the
    // run open, the edited file and the snapshot.
    // A completed successor rollback may already have been followed by an
    // older removal's inverse when recovery was killed. Only its recorded
    // predecessor preimages are additionally admissible, never arbitrary bytes.
    const earlierRemovalPreimages: RollbackProjection = new Map();
    const restoredPreimagesByAction = new Map<ActionId, RollbackProjection>();
    for (const state of states) {
      const last = latest.get(state.action.id)!;
      if (last.state === "pending" || last.state === "blocked") continue;
      if (last.state === "rolled-back") {
        restoredPreimagesByAction.set(state.action.id, new Map(earlierRemovalPreimages));
      }
      const reference = latestRollbackReference(recovery.actions, state.action.id);
      if (state.action.detail.kind !== "remove-resource" || reference === undefined) continue;
      const entries = yield* rollbackPreimages(state.context, reference).pipe(Effect.mapError((error) =>
        integrityError(recovery, `cannot inspect ${state.action.id}: ${String(error)}`)));
      for (const [key, entry] of entries) earlierRemovalPreimages.set(key, entry);
    }
    const laterPreimages: RollbackProjection = new Map();
    const removalsWithSuccessorWrites = new Set<ActionId>();
    for (const state of [...states].reverse()) {
      const last = latest.get(state.action.id)!;
      if (last.state === "pending" || last.state === "blocked") continue;
      const reference = latestRollbackReference(recovery.actions, state.action.id);
      if (reference === undefined) continue;
      const inspection = yield* inspectRollbackTargets(state.context, reference, laterPreimages, restoredPreimagesByAction.get(state.action.id)).pipe(
        Effect.mapError((error) =>
          integrityError(recovery, `cannot inspect ${state.action.id}: ${String(error)}`)
        ),
      );
      if (inspection.successorWrites) removalsWithSuccessorWrites.add(state.action.id);
      if (inspection.edited.length > 0) {
        return yield* new RecoveryLocalEditError({
          run: recovery.run.id,
          resource: state.action.resource,
          paths: inspection.edited,
          snapshot: reference,
        });
      }
    }
    // A killed run leaves its temporary files behind. A directory that still
    // holds one cannot be restored (rmdir fails with ENOTEMPTY).
    yield* removeRunTemporaryEntries(plan.actions, recovery.run.id).pipe(
      Effect.mapError((error) =>
        integrityError(recovery, `cannot remove temporary files of the interrupted run: ${String(error)}`)
      ),
    );
    const verified = new Set<ResourceId>();
    const removedResources = new Set<ResourceId>();
    let runRollback: RunRollback = { _tag: "Complete" };
    let progress: ActionProgress = { _tag: "Running", verified };
    const completedRollbacks: Array<{
      readonly action: PlannedAction;
      readonly attempt: number;
      readonly rollback: Effect.Effect<void, unknown, MachineState>;
      readonly reference?: string | undefined;
      readonly resource?: ResourceId | undefined;
      readonly previousApplied?: AppliedResourceRecord | undefined;
    }> = [];
    let failedReason: string | undefined;

    for (const state of states) {
      const last = latest.get(state.action.id)!;
      const attempt = Math.max(1, last.attempt + 1);
      let result: ActionResult;
      let rollbackOwnership: {
        readonly resource: ResourceId;
        readonly previousApplied?: AppliedResourceRecord | undefined;
      } | undefined;
      if (last.state === "blocked" && state.action.detail.kind !== "install-tool") {
        result = preservedOutcome(input, state.action);
      } else if (
        last.state === "succeeded"
        && state.action.detail.kind === "transfer-blob"
      ) {
        result = { kind: "verified" };
      } else if (
        state.action.detail.kind === "install-tool"
        && last.state !== "pending"
      ) {
        result = yield* uncertainInstaller(
          input,
          state.context,
          state.action,
          attempt,
        );
      } else if (
        state.action.detail.kind === "remove-resource"
        && last.state === "succeeded"
      ) {
        if (last.rollbackReference === undefined) {
          return yield* integrityError(
            recovery,
            `completed removal ${state.action.id} lacks rollback material`,
          );
        }
        rollbackOwnership = { resource: state.action.resource, previousApplied: last.removedResource };
        if (removalsWithSuccessorWrites.has(state.action.id)) {
          // Its removal already happened. Replaying it now would erase the
          // validated successor; retain its inverse for whole-run rollback.
          result = { kind: "verified", resource: state.action.resource,
            rollback: restoreResourceRollbackReference(state.context, last.rollbackReference),
            rollbackReference: last.rollbackReference };
        } else {
          yield* restoreResourceRollbackReference(
            state.context,
            last.rollbackReference,
          ).pipe(
            Effect.mapError((error) =>
              integrityError(recovery, `cannot restore ${state.action.id}: ${String(error)}`)
            ),
          );
          result = yield* executeSynchronizationAction(input, state, attempt);
        }
      } else if (last.state === "succeeded") {
        const verification = yield* verifyResource(state.context).pipe(
          Effect.mapError((error) =>
            integrityError(recovery, `cannot reverify ${state.action.id}: ${String(error)}`)
          ),
        );
        if (verification.passed) {
          const rollback = last.rollbackReference === undefined
            ? undefined
            : restoreResourceRollbackReference(
              state.context,
              last.rollbackReference,
            );
          result = {
            kind: "verified",
            resource: state.action.resource,
            // Agent successes only verify external work. Ordinary successes
            // with a digest also replaced the ownership record atomically.
            rollback: rollback
              ?? (
                state.action.detail.kind !== "agent-task"
                  && desiredResourceDigest(state.context.desired) !== undefined
                  ? Effect.void
                  : undefined
              ),
            rollbackReference: last.rollbackReference,
          };
          rollbackOwnership = {
            resource: state.action.resource,
            previousApplied: last.removedResource,
          };
        } else if (last.rollbackReference !== undefined) {
          rollbackOwnership = {
            resource: state.action.resource,
            previousApplied: last.removedResource,
          };
          yield* restoreResourceRollbackReference(
            state.context,
            last.rollbackReference,
          ).pipe(
            Effect.mapError((error) =>
              integrityError(recovery, `cannot restore ${state.action.id}: ${String(error)}`)
            ),
          );
          result = yield* executeSynchronizationAction(input, state, attempt);
        } else {
          result = {
            kind: "failed",
            rollbackState: { _tag: "NotRequired" },
            reason: `previously completed action ${state.action.id} no longer verifies`,
          };
        }
      } else {
        const rollbackReference = latestRollbackReference(
          recovery.actions,
          state.action.id,
        );
        if (
          (last.state === "running" || last.state === "failed")
          && rollbackReference !== undefined
        ) {
          yield* restoreResourceRollbackReference(
            state.context,
            rollbackReference,
          ).pipe(
            Effect.mapError((error) =>
              integrityError(recovery, `cannot restore ${state.action.id}: ${String(error)}`)
            ),
          );
        }
        result = yield* executeSynchronizationAction(input, state, attempt);
      }
      if (result.kind === "failed" && result.rollbackState._tag === "Blocked") {
        runRollback = blockRunRollback(runRollback, { action: state.action.id, resource: state.action.resource, state: result.rollbackState });
      }
      if (result.kind === "verified" && result.rollback !== undefined) {
        if (result.resource !== undefined && rollbackOwnership === undefined) {
          rollbackOwnership = {
            resource: result.resource,
            previousApplied: input.appliedResources?.find((record) =>
              record.resource === result.resource
            ),
          };
        }
        completedRollbacks.push({
          action: state.action,
          attempt,
          rollback: result.rollback,
          reference: result.rollbackReference,
          resource: rollbackOwnership?.resource,
          previousApplied: rollbackOwnership?.previousApplied,
        });
      } else if (result.kind === "failed" && result.rollbackState._tag !== "Blocked" && rollbackOwnership !== undefined) {
        yield* appendJournal(
          input.id,
          state.action,
          "rolled-back",
          attempt,
          { status: "not-run", method: "run-rolled-back" },
          result.rollbackReference,
          rollbackOwnership.previousApplied,
          rollbackOwnership.previousApplied === undefined
            ? rollbackOwnership.resource
            : undefined,
        );
      }
      if (result.kind === "verified" && result.resource !== undefined
        && recoveryInput.revision.removedResources?.includes(result.resource) === true) removedResources.add(result.resource);
      progress = yield* reduceActionResult(progress, result);
      if (result.kind === "failed") failedReason = result.reason;
      if (result.kind !== "verified") {
        if (result.kind === "failed") {
          for (const completed of completedRollbacks.reverse()) {
            const rollback = yield* restoreAction(completed.rollback, appendJournal(
              input.id, completed.action, "rolled-back", completed.attempt,
              { status: "not-run", method: "run-rolled-back" }, completed.reference, completed.previousApplied,
              completed.previousApplied === undefined ? completed.resource : undefined,
            ));
            if (rollback._tag === "Blocked") {
              runRollback = blockRunRollback(runRollback, { action: completed.action.id, resource: completed.resource,
                state: { _tag: "Blocked", phase: rollback.phase, reference: completed.reference } });
              failedReason = `${failedReason ?? "synchronization recovery failed"}; ${rollback.phase} rollback failed for ${completed.action.id}: ${rollback.reason}`;
            }
          }
        }
        break;
      }
    }

    const outcome: SynchronizationOutcome = failedReason !== undefined
      ? { outcome: "Failed", run: input.id, reason: failedReason }
      : actionProgressOutcome(input.id, progress);
    const appliedResources: Array<AppliedResourceRecord> = [];
    if (outcome.outcome === "Converged") {
      const appliedAt = yield* now;
      for (const state of states) {
        if (!verified.has(state.action.resource) || removedResources.has(state.action.resource)) continue;
        const record = appliedResourceFor(input, state, appliedAt);
        if (record !== undefined) appliedResources.push(record);
      }
    }
    return {
      outcome: withRollbackOutcome(outcome, runRollback),
      rollback: runRollback,
      appliedResources,
      removedResources: outcome.outcome === "Converged"
        ? [...removedResources].sort()
        : [],
    };
  });
