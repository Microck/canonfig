import { Schema } from "effect";

import {
  BlobId,
  CertificateFingerprint,
  ContentDigest,
  CredentialReference,
  FollowerId,
  GroupName,
  InvitationCode,
  Timestamp,
} from "../domain/brand.ts";
import { FollowerIdentity, SourceIdentity } from "../domain/identity.ts";
import {
  PublishedResourceSchema,
  ScheduleDefaultSchema,
  VerificationInputSchema,
} from "../domain/profile.ts";

export const TransportPublishedResourceSchema = Schema.Struct({
  ...PublishedResourceSchema.fields,
  verify: VerificationInputSchema,
});

export interface CreateInvitationInput {
  readonly endpoint: string;
  readonly expiresInMilliseconds: number;
  readonly groups?: ReadonlyArray<typeof GroupName.Type> | undefined;
}

export interface EnrollmentInvitationGrant {
  readonly code: typeof InvitationCode.Type;
  readonly nonce: string;
  readonly endpoint: string;
  readonly sourceFingerprint: typeof CertificateFingerprint.Type;
  readonly tlsFingerprint: typeof CertificateFingerprint.Type;
  readonly groups: ReadonlyArray<typeof GroupName.Type>;
  readonly expiresAt: typeof Timestamp.Type;
}

export interface EnrollFollowerRequest {
  readonly code: typeof InvitationCode.Type;
  readonly nonce: string;
  readonly sourceFingerprint: typeof CertificateFingerprint.Type;
  readonly tlsFingerprint: typeof CertificateFingerprint.Type;
  readonly followerName: string;
}

export interface EnrollFollowerResponse {
  readonly follower: typeof FollowerIdentity.Type;
  readonly credential: string;
  readonly source: typeof SourceIdentity.Type;
  readonly tlsFingerprint: typeof CertificateFingerprint.Type;
  readonly authorizedProfiles?: ReadonlyArray<RevisionSummary> | undefined;
}

export interface AuthenticatedFollower {
  readonly follower: typeof FollowerIdentity.Type;
}

export interface SourceEnrollmentMaterial {
  readonly source: typeof SourceIdentity.Type;
  readonly signingKeyReference: typeof CredentialReference.Type;
  readonly tlsKeyReference: typeof CredentialReference.Type;
  readonly tlsCertificateReference: typeof CredentialReference.Type;
  readonly tlsFingerprint: typeof CertificateFingerprint.Type;
}

export interface StartSourceServerInput {
  /**
   * Runtime input is validated as an unambiguous loopback host by the server
   * boundary. Keep this as a string so callers cannot mistake the type for
   * the security check.
   */
  readonly hostname?: string | undefined;
  readonly port?: number | undefined;
  readonly maximumMetadataBytes?: number | undefined;
  readonly maximumBlobBytes?: number | undefined;
}

export interface SourceServerHandle {
  readonly endpoint: string;
  readonly fingerprint: typeof CertificateFingerprint.Type;
  readonly blobRequests: () => number;
  readonly close: () => Promise<void>;
}

export interface RevisionSummary {
  readonly id: string;
  readonly profileId: string;
  readonly sequence: number;
  readonly digest: typeof ContentDigest.Type;
  readonly publishedAt: string;
}

export interface RevisionList {
  readonly revisions: ReadonlyArray<RevisionSummary>;
}

export interface RevisionMetadata {
  readonly id: string;
  readonly profileId: string;
  readonly sequence: number;
  readonly digest: typeof ContentDigest.Type;
  readonly publishedAt: string;
  readonly resources: ReadonlyArray<typeof TransportPublishedResourceSchema.Type>;
  readonly scheduleDefault?: typeof ScheduleDefaultSchema.Type | undefined;
  readonly metadataDigest: typeof ContentDigest.Type;
  readonly signingKeyId: string;
  readonly signingPublicKey: string;
  readonly sourceSignature: string;
  readonly signature: string;
}

export interface FollowerTransportInput extends FollowerAuthenticationInput {
  readonly sourceFingerprint: typeof CertificateFingerprint.Type;
  readonly timeoutMilliseconds?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface RevisionMetadataInput extends FollowerTransportInput {
  readonly revisionId: string;
  readonly maximumMetadataBytes?: number | undefined;
}

export interface BlobRetrievalInput extends FollowerTransportInput {
  readonly blobId: typeof BlobId.Type;
  readonly maximumBlobBytes?: number | undefined;
}

export interface FetchRevisionInput extends RevisionMetadataInput {
  readonly revisionId: string;
  readonly cacheDirectory: string;
  readonly maximumBlobBytes?: number | undefined;
}

export interface CachedBlob {
  readonly id: typeof BlobId.Type;
  readonly path: string;
}

export interface FetchedRevision {
  readonly metadata: RevisionMetadata;
  readonly blobs: ReadonlyArray<CachedBlob>;
  readonly downloadedBlobs: number;
  readonly reusedBlobs: number;
}

export interface FollowerEnrollmentInput {
  readonly invitation: EnrollmentInvitationGrant;
  readonly followerName: string;
  /**
   * Runtime enrollment sets this to false while it durably writes the local
   * configuration. The source only exposes the identity after finalization.
   */
  readonly finalize?: boolean | undefined;
}

export interface FollowerEnrollment {
  readonly follower: typeof FollowerIdentity.Type;
  readonly credentialReference: typeof CredentialReference.Type;
  readonly source: typeof SourceIdentity.Type;
  readonly tlsFingerprint: typeof CertificateFingerprint.Type;
  readonly authorizedProfiles?: ReadonlyArray<RevisionSummary> | undefined;
}

export interface FollowerAuthenticationInput {
  readonly endpoint: string;
  readonly tlsFingerprint: typeof CertificateFingerprint.Type;
  readonly credentialReference: typeof CredentialReference.Type;
}

export const EnrollFollowerRequestSchema = Schema.Struct({
  code: InvitationCode,
  nonce: Schema.NonEmptyString,
  sourceFingerprint: CertificateFingerprint,
  tlsFingerprint: CertificateFingerprint,
  followerName: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[^\p{Cc}]+$/u),
  ),
});

export const EnrollFollowerResponseSchema = Schema.Struct({
  follower: FollowerIdentity,
  credential: Schema.NonEmptyString,
  source: SourceIdentity,
  tlsFingerprint: CertificateFingerprint,
  authorizedProfiles: Schema.optional(Schema.Array(Schema.Struct({
    id: Schema.NonEmptyString,
    profileId: Schema.NonEmptyString,
    sequence: Schema.Natural,
    digest: ContentDigest,
    publishedAt: Timestamp,
  }))),
});

export const AuthenticatedFollowerSchema = Schema.Struct({
  follower: FollowerIdentity,
});

export const RevisionSummarySchema = Schema.Struct({
  id: Schema.NonEmptyString,
  profileId: Schema.NonEmptyString,
  sequence: Schema.Natural,
  digest: ContentDigest,
  publishedAt: Timestamp,
});

export const RevisionListSchema = Schema.Struct({
  revisions: Schema.Array(RevisionSummarySchema),
});

export const RevisionMetadataSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  profileId: Schema.NonEmptyString,
  sequence: Schema.Natural,
  digest: ContentDigest,
  publishedAt: Timestamp,
  resources: Schema.Array(TransportPublishedResourceSchema),
  scheduleDefault: Schema.optional(ScheduleDefaultSchema),
  metadataDigest: ContentDigest,
  signingKeyId: Schema.NonEmptyString,
  signingPublicKey: Schema.NonEmptyString,
  sourceSignature: Schema.NonEmptyString,
  signature: Schema.NonEmptyString,
});

export const WireEnrollmentErrorSchema = Schema.Struct({
  error: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
});

export type WireEnrollmentError = typeof WireEnrollmentErrorSchema.Type;
export type EnrollmentFollowerId = typeof FollowerId.Type;
