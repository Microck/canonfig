import { Schema } from "effect";
import { TaggedError } from "../domain/tagged-error.ts";

import type { ProfileValidationError } from "../domain/profile.ts";
import type { SourceCredentialMismatchError } from "../enrollment/enrollment.errors.ts";
import type { CredentialStorageError } from "../machine/machine-state.errors.ts";
import type { StateRepositoryError } from "../state/state-repository.errors.ts";

export class DiscoveryFilesystemError extends TaggedError<DiscoveryFilesystemError>()(
  "DiscoveryFilesystemError",
  {
    path: Schema.String,
    operation: Schema.Literals(["read", "stat"]),
    reason: Schema.String,
  },
) {}

export class DiscoveryParseError extends TaggedError<DiscoveryParseError>()(
  "DiscoveryParseError",
  {
    path: Schema.String,
    format: Schema.Literals(["json", "toml"]),
    reason: Schema.String,
  },
) {}

export class InvalidDiscoveryInputError extends TaggedError<InvalidDiscoveryInputError>()(
  "InvalidDiscoveryInputError",
  {
    reason: Schema.String,
  },
) {}

export type ProfileCatalogScanError =
  | DiscoveryFilesystemError
  | DiscoveryParseError
  | InvalidDiscoveryInputError;

export class PublicationNotConfiguredError extends TaggedError<PublicationNotConfiguredError>()(
  "PublicationNotConfiguredError",
  {
    operation: Schema.Literals(["publish", "getRevision"]),
  },
) {}

export class PublicationReviewRequiredError extends TaggedError<PublicationReviewRequiredError>()(
  "PublicationReviewRequiredError",
  {
    decision: Schema.String,
  },
) {}

export class UnresolvedPublicationProposalError extends TaggedError<UnresolvedPublicationProposalError>()(
  "UnresolvedPublicationProposalError",
  {
    reasons: Schema.Array(Schema.String),
  },
) {}

export class InvalidPublicationResourcesError extends Error {
  readonly errors: ReadonlyArray<ProfileValidationError>;

  constructor(errors: ReadonlyArray<ProfileValidationError>) {
    super(errors.map((error) => error._tag).join(", "));
    this.name = "InvalidPublicationResourcesError";
    this.errors = errors;
  }
}

export class InvalidPublicationInputError extends TaggedError<InvalidPublicationInputError>()(
  "InvalidPublicationInputError",
  {
    reason: Schema.String,
  },
) {}

export class PublicationSigningError extends TaggedError<PublicationSigningError>()(
  "PublicationSigningError",
  {
    operation: Schema.Literals(["sign", "verify"]),
    reason: Schema.String,
  },
) {}

export class InvalidPublicationSignatureError extends TaggedError<InvalidPublicationSignatureError>()(
  "InvalidPublicationSignatureError",
  {
    keyId: Schema.String,
  },
) {}

/**
 * A publication with no resources that the author did not explicitly ask
 * for. `scannedPaths` names what the proposal scanned, if anything.
 */
export class EmptyPublicationError extends TaggedError<EmptyPublicationError>()(
  "EmptyPublicationError",
  {
    scannedPaths: Schema.Array(Schema.String),
  },
) {}

/** An authored resource `source` that cannot be read from inside the profile directory. */
export class PublicationSourceError extends TaggedError<PublicationSourceError>()(
  "PublicationSourceError",
  {
    resource: Schema.String,
    path: Schema.String,
    reason: Schema.String,
  },
) {}

export type ProfileCatalogPublishError =
  | PublicationNotConfiguredError
  | PublicationReviewRequiredError
  | UnresolvedPublicationProposalError
  | EmptyPublicationError
  | PublicationSourceError
  | InvalidPublicationResourcesError
  | InvalidPublicationInputError
  | PublicationSigningError
  | InvalidPublicationSignatureError
  | StateRepositoryError
  // The signing key could not be read from, or does not match, the native
  // credential store: a local condition with its own recovery text.
  | CredentialStorageError
  | SourceCredentialMismatchError;

export type ProfileCatalogRevisionError =
  | PublicationNotConfiguredError
  | StateRepositoryError;
