import { Schema } from "effect";

export class RepositorySqlError extends Schema.TaggedError<RepositorySqlError>()(
  "RepositorySqlError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export class RepositoryDecodeError extends Schema.TaggedError<RepositoryDecodeError>()(
  "RepositoryDecodeError",
  {
    entity: Schema.String,
    id: Schema.String,
    message: Schema.String,
  },
) {}

export class RevisionImmutableError extends Schema.TaggedError<RevisionImmutableError>()(
  "RevisionImmutableError",
  {
    revision: Schema.String,
    message: Schema.String,
  },
) {}

export class ActiveRunExistsError extends Schema.TaggedError<ActiveRunExistsError>()(
  "ActiveRunExistsError",
  {
    follower: Schema.String,
  },
) {}

export class FollowerNotFoundError extends Schema.TaggedError<FollowerNotFoundError>()(
  "FollowerNotFoundError",
  {
    follower: Schema.String,
  },
) {}

export class RevisionNotFoundError extends Schema.TaggedError<RevisionNotFoundError>()(
  "RevisionNotFoundError",
  {
    revision: Schema.String,
  },
) {}

export class RunNotFoundError extends Schema.TaggedError<RunNotFoundError>()(
  "RunNotFoundError",
  {
    run: Schema.String,
  },
) {}

export class ActionNotInPlanError extends Schema.TaggedError<ActionNotInPlanError>()(
  "ActionNotInPlanError",
  {
    run: Schema.String,
    action: Schema.String,
  },
) {}

export class InvalidRunTransitionError extends Schema.TaggedError<InvalidRunTransitionError>()(
  "InvalidRunTransitionError",
  {
    run: Schema.String,
    message: Schema.String,
  },
) {}

export class EnrollmentStateConflictError extends Schema.TaggedError<EnrollmentStateConflictError>()(
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
  | FollowerNotFoundError
  | RevisionNotFoundError
  | RunNotFoundError
  | ActionNotInPlanError
  | InvalidRunTransitionError
  | EnrollmentStateConflictError;
