import { Schema } from "effect";
import { TaggedError } from "../domain/tagged-error.ts";

export class RepositorySqlError extends TaggedError<RepositorySqlError>()(
  "RepositorySqlError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export class RepositoryDecodeError extends TaggedError<RepositoryDecodeError>()(
  "RepositoryDecodeError",
  {
    entity: Schema.String,
    id: Schema.String,
    message: Schema.String,
  },
) {}

export class RevisionImmutableError extends TaggedError<RevisionImmutableError>()(
  "RevisionImmutableError",
  {
    revision: Schema.String,
    message: Schema.String,
  },
) {}

export class ActiveRunExistsError extends TaggedError<ActiveRunExistsError>()(
  "ActiveRunExistsError",
  {
    follower: Schema.String,
  },
) {}


export class UpgradeGateError extends TaggedError<UpgradeGateError>()(
  "UpgradeGateError",
  {
    run: Schema.String,
    creatingVersion: Schema.String | null,
    creatingIdentity: Schema.String | null,
    currentVersion: Schema.String,
    currentIdentity: Schema.String,
  },
) {}

export class FollowerNotFoundError extends TaggedError<FollowerNotFoundError>()(
  "FollowerNotFoundError",
  {
    follower: Schema.String,
  },
) {}

export class RevisionNotFoundError extends TaggedError<RevisionNotFoundError>()(
  "RevisionNotFoundError",
  {
    revision: Schema.String,
  },
) {}

export class RunNotFoundError extends TaggedError<RunNotFoundError>()(
  "RunNotFoundError",
  {
    run: Schema.String,
  },
) {}

export class ActionNotInPlanError extends TaggedError<ActionNotInPlanError>()(
  "ActionNotInPlanError",
  {
    run: Schema.String,
    action: Schema.String,
  },
) {}

export class InvalidRunTransitionError extends TaggedError<InvalidRunTransitionError>()(
  "InvalidRunTransitionError",
  {
    run: Schema.String,
    message: Schema.String,
  },
) {}

export class EnrollmentStateConflictError extends TaggedError<EnrollmentStateConflictError>()(
  "EnrollmentStateConflictError",
  {
    reason: Schema.Literals([
      "invitation-not-found",
      "invitation-used",
      "invitation-expired",
      "invitation-mismatch",
      "follower-identity-conflict",
      "credential-conflict",
    ]),
    message: Schema.String,
  },
) {}

export type StateRepositoryError =
  | RepositorySqlError
  | RepositoryDecodeError
  | RevisionImmutableError
  | ActiveRunExistsError
  | UpgradeGateError
  | FollowerNotFoundError
  | RevisionNotFoundError
  | RunNotFoundError
  | ActionNotInPlanError
  | InvalidRunTransitionError
  | EnrollmentStateConflictError;
