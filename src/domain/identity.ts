import { Schema } from "effect";

import {
  CertificateFingerprint,
  FollowerId,
  GroupName,
  InvitationCode,
  Timestamp,
} from "./brand.ts";
import { TaggedError } from "./tagged-error.ts";

/** Source Machine identity: an ed25519 signing key with a public fingerprint. */
export const SourceIdentity = Schema.Struct({
  keyId: Schema.NonEmptyString,
  publicKeyFingerprint: CertificateFingerprint,
});
export type SourceIdentity = Schema.Schema.Type<typeof SourceIdentity>;

/**
 * Source state lacks a credential namespace, or the store does not hold
 * the keys for the recorded Source identity.
 */
export class SourceCredentialMismatchError extends TaggedError<SourceCredentialMismatchError>()(
  "SourceCredentialMismatchError",
  { message: Schema.String },
) {}

export const sourceCredentialRecovery =
  "Move this state directory aside, run `canonfig source init` to create a new Source identity, then enroll its Followers with new invitations.";

/** One issued Follower Identity with its independently revocable credential reference. */
export const FollowerReference = Schema.Struct({
  id: FollowerId,
  name: Schema.NonEmptyString,
});
export type FollowerReference = Schema.Schema.Type<typeof FollowerReference>;

export const FollowerIdentity = Schema.Struct({
  id: FollowerId,
  name: Schema.NonEmptyString,
  groups: Schema.Array(GroupName),
  revoked: Schema.Boolean,
  credentialReference: Schema.NonEmptyString,
  enrolledAt: Timestamp,
});
export type FollowerIdentity = Schema.Schema.Type<typeof FollowerIdentity>;

/** A short-lived, single-use enrollment invitation. */
export const EnrollmentInvitation = Schema.Struct({
  code: InvitationCode,
  endpoint: Schema.NonEmptyString,
  fingerprint: CertificateFingerprint,
  groups: Schema.Array(GroupName),
  expiresAt: Timestamp,
  used: Schema.Boolean,
});
export type EnrollmentInvitation = Schema.Schema.Type<typeof EnrollmentInvitation>;

/** Agent execution policy on a follower. */
export const AgentPolicy = Schema.Literals(["deterministic-only", "agent-propose", "agent-apply"]);
export type AgentPolicy = Schema.Schema.Type<typeof AgentPolicy>;
