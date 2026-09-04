import { Schema } from "effect";
import type { CredentialStorageError } from "../machine/machine-state.errors.ts";
import type { FollowerNotFoundError } from "../state/state-repository.errors.ts";

export class SourceNotInitializedError extends Schema.TaggedError<SourceNotInitializedError>()(
  "SourceNotInitializedError",
  { operation: Schema.String },
) {}

export class EnrollmentConfigurationError extends Schema.TaggedError<EnrollmentConfigurationError>()(
  "EnrollmentConfigurationError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export class InvitationNotFoundError extends Schema.TaggedError<InvitationNotFoundError>()(
  "InvitationNotFoundError",
  { message: Schema.String },
) {}

export class InvitationExpiredError extends Schema.TaggedError<InvitationExpiredError>()(
  "InvitationExpiredError",
  { message: Schema.String },
) {}

export class InvitationReplayError extends Schema.TaggedError<InvitationReplayError>()(
  "InvitationReplayError",
  { message: Schema.String },
) {}

export class EnrollmentSourceMismatchError extends Schema.TaggedError<EnrollmentSourceMismatchError>()(
  "EnrollmentSourceMismatchError",
  { message: Schema.String },
) {}

export class EnrollmentFingerprintMismatchError extends Schema.TaggedError<EnrollmentFingerprintMismatchError>()(
  "EnrollmentFingerprintMismatchError",
  { message: Schema.String },
) {}

export class MalformedEnrollmentRequestError extends Schema.TaggedError<MalformedEnrollmentRequestError>()(
  "MalformedEnrollmentRequestError",
  { message: Schema.String },
) {}

export class DuplicateFollowerIdentityError extends Schema.TaggedError<DuplicateFollowerIdentityError>()(
  "DuplicateFollowerIdentityError",
  { message: Schema.String },
) {}

export class InvalidFollowerCredentialError extends Schema.TaggedError<InvalidFollowerCredentialError>()(
  "InvalidFollowerCredentialError",
  { message: Schema.String },
) {}

export class RevokedFollowerCredentialError extends Schema.TaggedError<RevokedFollowerCredentialError>()(
  "RevokedFollowerCredentialError",
  { message: Schema.String },
) {}

export class EnrollmentTransportError extends Schema.TaggedError<EnrollmentTransportError>()(
  "EnrollmentTransportError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export class TransportResourceNotFoundError extends Schema.TaggedError<TransportResourceNotFoundError>()(
  "TransportResourceNotFoundError",
  { resource: Schema.String },
) {}

export class TransportUnauthorizedError extends Schema.TaggedError<TransportUnauthorizedError>()(
  "TransportUnauthorizedError",
  { resource: Schema.String },
) {}

export class TransportMalformedResponseError extends Schema.TaggedError<TransportMalformedResponseError>()(
  "TransportMalformedResponseError",
  { operation: Schema.String, message: Schema.String },
) {}

export class TransportIntegrityError extends Schema.TaggedError<TransportIntegrityError>()(
  "TransportIntegrityError",
  { artifact: Schema.String, message: Schema.String },
) {}

export class TransportSizeLimitError extends Schema.TaggedError<TransportSizeLimitError>()(
  "TransportSizeLimitError",
  { artifact: Schema.String, limit: Schema.Number },
) {}

export class TransportInterruptedError extends Schema.TaggedError<TransportInterruptedError>()(
  "TransportInterruptedError",
  { operation: Schema.String },
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
  | TransportInterruptedError;
