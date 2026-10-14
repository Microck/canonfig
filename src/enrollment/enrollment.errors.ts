import { Schema } from "effect";
import { TaggedError } from "../domain/tagged-error.ts";
import type { CredentialStorageError } from "../machine/machine-state.errors.ts";
import type { FollowerNotFoundError } from "../state/state-repository.errors.ts";

export class SourceNotInitializedError extends TaggedError<SourceNotInitializedError>()(
  "SourceNotInitializedError",
  { operation: Schema.String },
) {}

export class EnrollmentConfigurationError extends TaggedError<EnrollmentConfigurationError>()(
  "EnrollmentConfigurationError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export class InvitationNotFoundError extends TaggedError<InvitationNotFoundError>()(
  "InvitationNotFoundError",
  { message: Schema.String },
) {}

export class InvitationExpiredError extends TaggedError<InvitationExpiredError>()(
  "InvitationExpiredError",
  { message: Schema.String },
) {}

export class InvitationReplayError extends TaggedError<InvitationReplayError>()(
  "InvitationReplayError",
  { message: Schema.String },
) {}

export class EnrollmentSourceMismatchError extends TaggedError<EnrollmentSourceMismatchError>()(
  "EnrollmentSourceMismatchError",
  { message: Schema.String },
) {}

export class EnrollmentFingerprintMismatchError extends TaggedError<EnrollmentFingerprintMismatchError>()(
  "EnrollmentFingerprintMismatchError",
  { message: Schema.String },
) {}

export class MalformedEnrollmentRequestError extends TaggedError<MalformedEnrollmentRequestError>()(
  "MalformedEnrollmentRequestError",
  { message: Schema.String },
) {}

export class DuplicateFollowerIdentityError extends TaggedError<DuplicateFollowerIdentityError>()(
  "DuplicateFollowerIdentityError",
  { message: Schema.String },
) {}

export class InvalidFollowerCredentialError extends TaggedError<InvalidFollowerCredentialError>()(
  "InvalidFollowerCredentialError",
  { message: Schema.String },
) {}

export class RevokedFollowerCredentialError extends TaggedError<RevokedFollowerCredentialError>()(
  "RevokedFollowerCredentialError",
  { message: Schema.String },
) {}

export class EnrollmentTransportError extends TaggedError<EnrollmentTransportError>()(
  "EnrollmentTransportError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export class TransportResourceNotFoundError extends TaggedError<TransportResourceNotFoundError>()(
  "TransportResourceNotFoundError",
  { resource: Schema.String },
) {}

export class TransportUnauthorizedError extends TaggedError<TransportUnauthorizedError>()(
  "TransportUnauthorizedError",
  { resource: Schema.String },
) {}

export class TransportMalformedResponseError extends TaggedError<TransportMalformedResponseError>()(
  "TransportMalformedResponseError",
  { operation: Schema.String, message: Schema.String },
) {}

export class TransportIntegrityError extends TaggedError<TransportIntegrityError>()(
  "TransportIntegrityError",
  { artifact: Schema.String, message: Schema.String },
) {}

export class TransportSizeLimitError extends TaggedError<TransportSizeLimitError>()(
  "TransportSizeLimitError",
  { artifact: Schema.String, limit: Schema.Number },
) {}

export class TransportInterruptedError extends TaggedError<TransportInterruptedError>()(
  "TransportInterruptedError",
  { operation: Schema.String },
) {}

/** The Source and this follower run canonfig releases that do not interoperate. */
export class SourceVersionMismatchError extends TaggedError<SourceVersionMismatchError>()(
  "SourceVersionMismatchError",
  {
    sourceVersion: Schema.NullOr(Schema.String),
    followerVersion: Schema.NullOr(Schema.String),
    message: Schema.String,
  },
) {}

/**
 * A revision an earlier release published carries something this release
 * cannot represent, so the Source refuses it instead of serving an altered
 * copy. Publishing the profile again produces a revision in this format.
 */
export class LegacyRevisionFormatError extends TaggedError<LegacyRevisionFormatError>()(
  "LegacyRevisionFormatError",
  { message: Schema.String },
) {}

/**
 * The Source's credential items in the native store do not belong to the
 * identity its state records. Earlier releases kept them under
 * account-global names, so another Canonfig state directory of the same OS
 * account could overwrite them; using them would serve or sign as another
 * Source.
 */
export class SourceCredentialMismatchError extends TaggedError<SourceCredentialMismatchError>()(
  "SourceCredentialMismatchError",
  { message: Schema.String },
) {}

export type EnrollmentError =
  | SourceNotInitializedError
  // Naming a follower the Source Machine never enrolled is an ordinary
  // enrollment outcome, distinct from a credential that fails to authenticate.
  | FollowerNotFoundError
  // A follower cannot enroll without somewhere to keep its credential, and only
  // a person can make the credential store usable.
  | CredentialStorageError
  | EnrollmentConfigurationError
  | InvitationNotFoundError
  | InvitationExpiredError
  | InvitationReplayError
  | EnrollmentSourceMismatchError
  | EnrollmentFingerprintMismatchError
  | MalformedEnrollmentRequestError
  | DuplicateFollowerIdentityError
  | InvalidFollowerCredentialError
  | RevokedFollowerCredentialError
  | EnrollmentTransportError
  | TransportResourceNotFoundError
  | TransportUnauthorizedError
  | TransportMalformedResponseError
  | TransportIntegrityError
  | TransportSizeLimitError
  | TransportInterruptedError
  | SourceVersionMismatchError
  | LegacyRevisionFormatError
  | SourceCredentialMismatchError;
