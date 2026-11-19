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

/**
 * The pseudo-harness that owns authored `resources.<id>`: each resource is
 * one of its surfaces, rooted at the home directory, so takeover, snapshots,
 * restore and retirement treat it as they treat a harness surface.
 */
export const resourcesOwner = "resources";

const projectionResourcePrefix = "harness:";

/** A harness surface's resource id: `harness:<harness>:<surface>`. */
export const surfaceResourceId = (harness: string, surface: string): ResourceId => {
  const id = Schema.decodeUnknownSync(ResourceId)(`${projectionResourcePrefix}${harness}:${surface}`);
  const parsed = parseSurfaceResourceId(id);
  if (parsed?.harness !== harness || parsed.surface !== surface) {
    throw new Error("Invalid projection resource owner or surface");
  }
  return id;
};

const splitSurfaceResourceId = (
  id: ResourceId,
): { readonly harness: string; readonly surface: string } | undefined => {
  if (!id.startsWith(projectionResourcePrefix)) return undefined;
  const separator = id.indexOf(":", projectionResourcePrefix.length);
  if (separator <= projectionResourcePrefix.length) return undefined;
  return {
    harness: id.slice(projectionResourcePrefix.length, separator),
    surface: id.slice(separator + 1),
  };
};

/** The harness and surface a projection resource id names, if it names one. */
export const parseSurfaceResourceId = (id: ResourceId): ReturnType<typeof splitSurfaceResourceId> => {
  const parts = splitSurfaceResourceId(id);
  return parts?.surface ? parts : undefined;
};

/** A missing surface cannot route a reserved authored ID through generic execution. */
export const classifyAuthoredResourceId = (id: ResourceId): "authored" | "other" | "invalid" => {
  const parts = splitSurfaceResourceId(id);
  if (parts?.harness !== resourcesOwner) return "other";
  return parts.surface.length === 0 ? "invalid" : "authored";
};

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
