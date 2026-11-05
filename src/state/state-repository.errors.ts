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


/**
 * An upgrade found an unfinished run that a different build, or the same
 * build under a different state format, left behind. Both formats travel
 * with the error so the message can name what actually differs.
 */
export class UpgradeGateError extends TaggedError<UpgradeGateError>()(
  "UpgradeGateError",
  {
    run: Schema.String,
    creatingVersion: Schema.String,
    creatingIdentity: Schema.String,
    creatingStateFormat: Schema.Number,
    currentVersion: Schema.String,
    currentIdentity: Schema.String,
    currentStateFormat: Schema.Number,
  },
) {}

/**
 * The state database has a migration history this release cannot upgrade:
 * a release before 4.0.0 (`before-state-format-4`, a prefix of the 5.0.1
 * history, which running 5.0.1 once completes) or one this release does not
 * know at all, such as a newer release's (`unrecognized`).
 */
export class EarlierStateFormatError extends TaggedError<EarlierStateFormatError>()(
  "EarlierStateFormatError",
  {
    migrations: Schema.Array(Schema.String),
    origin: Schema.Literals(["before-state-format-4", "unrecognized"]),
  },
) {}

/**
 * State that Canonfig 4.0.0 through 5.0.1 wrote holds an item this release
 * has no equivalent for. The upgrade changed nothing; `recovery` names the
 * step that makes the state upgradable.
 */
export class EarlierStateUpgradeError extends TaggedError<EarlierStateUpgradeError>()(
  "EarlierStateUpgradeError",
  {
    item: Schema.String,
    reason: Schema.String,
    recovery: Schema.String,
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
