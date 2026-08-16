import { Schema } from "effect";

/**
 * Branded identifier schemas. Every identifier that crosses a boundary or is
 * persisted is branded so an `AgentName` cannot be used where a
 * `FollowerId` is required.
 */

const IdentifierText = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, {
    expected: "a non-empty portable identifier",
  }),
);

const ReferenceText = Schema.NonEmptyString;

export const ProfileId = IdentifierText.pipe(Schema.brand("ProfileId"));
export type ProfileId = Schema.Schema.Type<typeof ProfileId>;

export const ProfileRevisionId = IdentifierText.pipe(Schema.brand("ProfileRevisionId"));
export type ProfileRevisionId = Schema.Schema.Type<typeof ProfileRevisionId>;

export const ResourceId = IdentifierText.pipe(Schema.brand("ResourceId"));
export type ResourceId = Schema.Schema.Type<typeof ResourceId>;

export const FollowerId = IdentifierText.pipe(Schema.brand("FollowerId"));
export type FollowerId = Schema.Schema.Type<typeof FollowerId>;

export const GroupName = IdentifierText.pipe(Schema.brand("GroupName"));
export type GroupName = Schema.Schema.Type<typeof GroupName>;

export const RunId = IdentifierText.pipe(Schema.brand("RunId"));
export type RunId = Schema.Schema.Type<typeof RunId>;

export const ActionId = IdentifierText.pipe(Schema.brand("ActionId"));
export type ActionId = Schema.Schema.Type<typeof ActionId>;

export const AgentTaskId = IdentifierText.pipe(Schema.brand("AgentTaskId"));
export type AgentTaskId = Schema.Schema.Type<typeof AgentTaskId>;

export const InvitationCode = ReferenceText.pipe(Schema.brand("InvitationCode"));
export type InvitationCode = Schema.Schema.Type<typeof InvitationCode>;

export const CredentialReference = ReferenceText.pipe(Schema.brand("CredentialReference"));
export type CredentialReference = Schema.Schema.Type<typeof CredentialReference>;

export const ContentDigest = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/u, { expected: "a lowercase SHA-256 digest" }),
).pipe(Schema.brand("ContentDigest"));
export type ContentDigest = Schema.Schema.Type<typeof ContentDigest>;

export const BlobId = ContentDigest.pipe(Schema.brand("BlobId"));
export type BlobId = Schema.Schema.Type<typeof BlobId>;

export const CertificateFingerprint = ReferenceText.pipe(Schema.brand("CertificateFingerprint"));
export type CertificateFingerprint = Schema.Schema.Type<typeof CertificateFingerprint>;

export const SourceSignature = ReferenceText.pipe(Schema.brand("SourceSignature"));
export type SourceSignature = Schema.Schema.Type<typeof SourceSignature>;

export const ToolId = IdentifierText.pipe(Schema.brand("ToolId"));
export type ToolId = Schema.Schema.Type<typeof ToolId>;

/** RFC 3339 timestamp kept as a string at persistence and wire boundaries. */
export const Timestamp = Schema.String.check(
  Schema.isPattern(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u,
    { expected: "an RFC 3339 timestamp" },
  ),
);
export type Timestamp = Schema.Schema.Type<typeof Timestamp>;

/** Decode helpers that keep branding at the boundary. */
export const decode = Schema.decodeUnknownSync;
