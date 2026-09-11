import { Schema } from "effect";
import { TaggedError } from "../domain/tagged-error.ts";

import type { ScheduleManagerError } from "../schedule/schedule-manager.errors.ts";

export class DuplicatePlannerInputError extends TaggedError<DuplicatePlannerInputError>()(
  "DuplicatePlannerInputError",
  {
    collection: Schema.String,
    id: Schema.String,
  },
) {}

export class MissingDesiredResourceError extends TaggedError<MissingDesiredResourceError>()(
  "MissingDesiredResourceError",
  { resource: Schema.String },
) {}

export class MissingObservedResourceError extends TaggedError<MissingObservedResourceError>()(
  "MissingObservedResourceError",
  { resource: Schema.String },
) {}

export class PlannerResourceKindMismatchError extends TaggedError<PlannerResourceKindMismatchError>()(
  "PlannerResourceKindMismatchError",
  {
    resource: Schema.String,
    publishedKind: Schema.String,
    desiredKind: Schema.String,
  },
) {}

export class PlannerPolicyKindMismatchError extends TaggedError<PlannerPolicyKindMismatchError>()(
  "PlannerPolicyKindMismatchError",
  {
    resource: Schema.String,
    kind: Schema.String,
    policy: Schema.String,
  },
) {}

export class PlannerVerificationKindMismatchError extends TaggedError<PlannerVerificationKindMismatchError>()(
  "PlannerVerificationKindMismatchError",
  {
    resource: Schema.String,
    kind: Schema.String,
    method: Schema.String,
  },
) {}

export class PlannerTextCompositionError extends TaggedError<PlannerTextCompositionError>()(
  "PlannerTextCompositionError",
  { resource: Schema.String, reason: Schema.String },
) {}

export class PlannerVerificationContentMismatchError extends TaggedError<PlannerVerificationContentMismatchError>()(
  "PlannerVerificationContentMismatchError",
  {
    resource: Schema.String,
    kind: Schema.String,
    method: Schema.String,
    reason: Schema.String,
  },
) {}

export class PlannerInvalidRecipeError extends TaggedError<PlannerInvalidRecipeError>()(
  "PlannerInvalidRecipeError",
  {
    resource: Schema.String,
    method: Schema.String,
    package: Schema.String,
    reason: Schema.String,
  },
) {}

export class PlannerInvalidResourcePathError extends TaggedError<PlannerInvalidResourcePathError>()(
  "PlannerInvalidResourcePathError",
  {
    resource: Schema.String,
    path: Schema.String,
    reason: Schema.String,
  },
) {}

export class PlannerConflictingResourcePathError extends TaggedError<PlannerConflictingResourcePathError>()(
  "PlannerConflictingResourcePathError",
  {
    resource: Schema.String,
    path: Schema.String,
    conflictsWith: Schema.String,
    reason: Schema.String,
  },
) {}

export class PlannerMissingDependencyError extends TaggedError<PlannerMissingDependencyError>()(
  "PlannerMissingDependencyError",
  {
    resource: Schema.String,
    dependency: Schema.String,
  },
) {}

export class PlannerDependencyCycleError extends TaggedError<PlannerDependencyCycleError>()(
  "PlannerDependencyCycleError",
  { cycle: Schema.Array(Schema.String) },
) {}

export class MissingBlobMetadataError extends TaggedError<MissingBlobMetadataError>()(
  "MissingBlobMetadataError",
  {
    resource: Schema.String,
    blob: Schema.String,
  },
) {}

export class InvalidObservedStateError extends TaggedError<InvalidObservedStateError>()(
  "InvalidObservedStateError",
  {
    resource: Schema.String,
    kind: Schema.String,
    observedState: Schema.String,
  },
) {}

export class InvalidExecutionPlanError extends TaggedError<InvalidExecutionPlanError>()(
  "InvalidExecutionPlanError",
  { message: Schema.String },
) {}

export class MissingExecutionResourceError extends TaggedError<MissingExecutionResourceError>()(
  "MissingExecutionResourceError",
  { resource: Schema.String },
) {}

export class MissingArtifactError extends TaggedError<MissingArtifactError>()(
  "MissingArtifactError",
  { digest: Schema.String },
) {}

export class InvalidArtifactError extends TaggedError<InvalidArtifactError>()(
  "InvalidArtifactError",
  {
    digest: Schema.String,
    message: Schema.String,
  },
) {}

export class ActionExecutionError extends TaggedError<ActionExecutionError>()(
  "ActionExecutionError",
  {
    action: Schema.String,
    message: Schema.String,
  },
) {}

export class RecoveryRunNotFoundError extends TaggedError<RecoveryRunNotFoundError>()(
  "RecoveryRunNotFoundError",
  { follower: Schema.String },
) {}


export class InsufficientDiskError extends TaggedError<InsufficientDiskError>()(
  "InsufficientDiskError",
  {
    path: Schema.String,
    requiredBytes: Schema.BigIntFromNumber,
    availableBytes: Schema.BigIntFromNumber,
  },
});

export class RecoveryIntegrityError extends TaggedError<RecoveryIntegrityError>()(
  "RecoveryIntegrityError",
  {
    run: Schema.String,
    message: Schema.String,
  },
) {}

export class RollbackCleanupError extends TaggedError<RollbackCleanupError>()(
  "RollbackCleanupError",
  {
    run: Schema.String,
    outcome: Schema.String,
    message: Schema.String,
  },
) {}

export type SynchronizationPlanningError =
  | DuplicatePlannerInputError
  | MissingDesiredResourceError
  | MissingObservedResourceError
  | PlannerResourceKindMismatchError
  | PlannerPolicyKindMismatchError
  | PlannerTextCompositionError
  | PlannerVerificationKindMismatchError
  | PlannerVerificationContentMismatchError
  | PlannerInvalidRecipeError
  | PlannerInvalidResourcePathError
  | PlannerConflictingResourcePathError
  | PlannerMissingDependencyError
  | PlannerDependencyCycleError
  | MissingBlobMetadataError
  | InvalidObservedStateError;

export type SynchronizationExecutionInputError =
  | InvalidExecutionPlanError
  | MissingExecutionResourceError
  | MissingArtifactError
  | InvalidArtifactError
  | ActionExecutionError
  | RollbackCleanupError
  | InsufficientDiskError
  | ScheduleManagerError;

export type SynchronizationRecoveryError =
  | RecoveryRunNotFoundError
  | RecoveryIntegrityError
  | SynchronizationExecutionInputError;
