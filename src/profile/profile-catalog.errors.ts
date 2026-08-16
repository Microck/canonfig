import { Schema } from "effect";

import type { ProfileValidationError } from "../domain/profile.ts";
import type { StateRepositoryError } from "../state/state-repository.errors.ts";

export class DiscoveryFilesystemError extends Schema.TaggedError<DiscoveryFilesystemError>()(
  "DiscoveryFilesystemError",
  {
    path: Schema.String,
    operation: Schema.Literals(["read", "stat"]),
    reason: Schema.String,
  },
) {}

export class DiscoveryParseError extends Schema.TaggedError<DiscoveryParseError>()(
  "DiscoveryParseError",
  {
    path: Schema.String,
    format: Schema.Literals(["json", "toml"]),
    reason: Schema.String,
  },
) {}

export class InvalidDiscoveryInputError extends Schema.TaggedError<InvalidDiscoveryInputError>()(
  "InvalidDiscoveryInputError",
  {
    reason: Schema.String,
  },
) {}

export type ProfileCatalogScanError =
  | DiscoveryFilesystemError
  | DiscoveryParseError
  | InvalidDiscoveryInputError;

export class PublicationNotConfiguredError extends Schema.TaggedError<PublicationNotConfiguredError>()(
  "PublicationNotConfiguredError",
  {
    operation: Schema.Literals(["publish", "getRevision"]),
  },
) {}

export class PublicationReviewRequiredError extends Schema.TaggedError<PublicationReviewRequiredError>()(
  "PublicationReviewRequiredError",
  {
    decision: Schema.String,
  },
) {}

export class UnresolvedPublicationProposalError extends Schema.TaggedError<UnresolvedPublicationProposalError>()(
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

export class InvalidPublicationInputError extends Schema.TaggedError<InvalidPublicationInputError>()(
  "InvalidPublicationInputError",
  {
    reason: Schema.String,
  },
) {}

export class PublicationSigningError extends Schema.TaggedError<PublicationSigningError>()(
  "PublicationSigningError",
  {
    operation: Schema.Literals(["sign", "verify"]),
    reason: Schema.String,
  },
) {}

export class InvalidPublicationSignatureError extends Schema.TaggedError<InvalidPublicationSignatureError>()(
  "InvalidPublicationSignatureError",
  {
    keyId: Schema.String,
  },
) {}

export type ProfileCatalogPublishError =
  | PublicationNotConfiguredError
  | PublicationReviewRequiredError
  | UnresolvedPublicationProposalError
  | InvalidPublicationResourcesError
  | InvalidPublicationInputError
  | PublicationSigningError
  | InvalidPublicationSignatureError
  | StateRepositoryError;

export type ProfileCatalogRevisionError =
  | PublicationNotConfiguredError
  | StateRepositoryError;
