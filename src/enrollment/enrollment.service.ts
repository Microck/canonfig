import { Context, type Effect } from "effect";

import type { FollowerId, GroupName } from "../domain/brand.ts";
import type { FollowerIdentity } from "../domain/identity.ts";
import type { EnrollmentError } from "./enrollment.errors.ts";
import type {
  AuthenticatedFollower,
  RevisionList,
  RevisionMetadata,
  CreateInvitationInput,
  EnrollFollowerRequest,
  EnrollFollowerResponse,
  EnrollmentInvitationGrant,
  SourceEnrollmentMaterial,
} from "./enrollment.types.ts";

export class Enrollment extends Context.Service<Enrollment, {
  readonly initializeSource: (
  ) => Effect.Effect<SourceEnrollmentMaterial, EnrollmentError>;
  readonly source: (
  ) => Effect.Effect<SourceEnrollmentMaterial, EnrollmentError>;
  readonly createInvitation: (
    input: CreateInvitationInput,
  ) => Effect.Effect<EnrollmentInvitationGrant, EnrollmentError>;
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
  readonly getAuthorizedBlob: (
    credential: string,
    blobId: string,
  ) => Effect.Effect<Uint8Array, EnrollmentError>;
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
