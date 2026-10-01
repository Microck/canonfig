import { Context, type Effect } from "effect";

import type { FollowerId, GroupName } from "../domain/brand.ts";
import type { FollowerIdentity } from "../domain/identity.ts";
import type { EnrollmentError } from "./enrollment.errors.ts";
import type {
  AuthenticatedFollower,
  AuthorizedBlobRange,
  AuthorizedBlobRangeInput,
  RevisionList,
  RevisionMetadata,
  CreateInvitationInput,
  EnrollFollowerRequest,
  EnrollFollowerResponse,
  EnrollmentInvitationGrant,
  SourceCredentials,
  SourceEnrollmentMaterial,
} from "./enrollment.types.ts";

export class Enrollment extends Context.Service<Enrollment, {
  readonly initializeSource: (
  ) => Effect.Effect<SourceEnrollmentMaterial, EnrollmentError>;
  readonly source: (
  ) => Effect.Effect<SourceEnrollmentMaterial, EnrollmentError>;
  /**
   * Load the Source's keys and certificate from the native store, verified
   * against the recorded fingerprints. A Source initialized by an earlier
   * release has account-global item names; those items are used only when
   * they match this Source's fingerprints, and are then copied under this
   * state directory's own credential namespace.
   */
  readonly sourceCredentials: (
  ) => Effect.Effect<SourceCredentials, EnrollmentError>;
  readonly createInvitation: (
    input: CreateInvitationInput,
  ) => Effect.Effect<EnrollmentInvitationGrant, EnrollmentError>;
  readonly removeInvitation: (
    code: string,
  ) => Effect.Effect<void, EnrollmentError>;
  readonly enrollFollower: (
    request: EnrollFollowerRequest,
  ) => Effect.Effect<EnrollFollowerResponse, EnrollmentError>;
  readonly finalizeFollower: (
    credential: string,
  ) => Effect.Effect<void, EnrollmentError>;
  readonly cancelPendingEnrollment: (
    credential: string,
  ) => Effect.Effect<void, EnrollmentError>;
  readonly revokeAuthenticatedFollower: (
    credential: string,
  ) => Effect.Effect<void, EnrollmentError>;
  readonly authenticate: (
    credential: string,
  ) => Effect.Effect<AuthenticatedFollower, EnrollmentError>;
  readonly listAuthorizedRevisions: (
    credential: string,
  ) => Effect.Effect<RevisionList, EnrollmentError>;
  readonly getAuthorizedRevision: (
    credential: string,
    revisionId: string,
  ) => Effect.Effect<RevisionMetadata, EnrollmentError>;
  readonly getAuthorizedBlobRange: (
    credential: string,
    input: AuthorizedBlobRangeInput,
  ) => Effect.Effect<AuthorizedBlobRange, EnrollmentError>;
  readonly revokeFollower: (
    follower: FollowerId,
  ) => Effect.Effect<void, EnrollmentError>;
  readonly updateFollowerGroups: (
    follower: FollowerId,
    groups: ReadonlyArray<GroupName>,
  ) => Effect.Effect<void, EnrollmentError>;
  readonly getFollower: (
    follower: FollowerId,
  ) => Effect.Effect<FollowerIdentity, EnrollmentError>;
}>()("canonfig/enrollment/Enrollment") {}
