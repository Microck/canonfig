import { Context, type Effect } from "effect";

import type {
  AppliedResourceRecord,
} from "../domain/synchronization.ts";
import type {
  ContentDigest,
  FollowerId,
  GroupName,
  ProfileId,
  ProfileRevisionId,
} from "../domain/brand.ts";
import type { SourceIdentity } from "../domain/identity.ts";
import type { ProfileRevision } from "../domain/profile.ts";
import type { StateRepositoryError } from "./state-repository.errors.ts";
import type {
  CompleteRunInput,
  CancelPendingEnrollmentInput,
  ConsumeEnrollmentInvitationInput,
  CreateEnrollmentInvitationInput,
  EnrollmentSourceRecord,
  FollowerCredentialRecord,
  FinalizeEnrollmentInput,
  JournalActionInput,
  PendingEnrollmentRecord,
  PublishRevisionInput,
  RecordDriftInput,
  RecoveryState,
  RegisterFollowerInput,
  RemoveLocalOverlayInput,
  SaveLocalOverlayInput,
  StartRunInput,
  StateSnapshot,
  StoredEnrollmentInvitation,
  SaveFollowerSynchronizationConfigurationInput,
} from "./state-repository.types.ts";
import type { FollowerSynchronizationConfiguration } from
  "../synchronization/follower-sync-config.ts";
import type { LocalOverlayEntry } from
  "../synchronization/synchronization.types.ts";

export class StateRepository extends Context.Service<StateRepository, {
  readonly saveSourceIdentity: (
    identity: SourceIdentity,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly registerFollower: (
    input: RegisterFollowerInput,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly saveFollowerSynchronizationConfiguration: (
    input: SaveFollowerSynchronizationConfigurationInput,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly saveLocalOverlay: (
    input: SaveLocalOverlayInput,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly removeLocalOverlay: (
    input: RemoveLocalOverlayInput,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly listLocalOverlays: (
  ) => Effect.Effect<ReadonlyArray<LocalOverlayEntry>, StateRepositoryError>;
  readonly getFollowerSynchronizationConfiguration: (
  ) => Effect.Effect<
    FollowerSynchronizationConfiguration | undefined,
    StateRepositoryError
  >;
  readonly saveEnrollmentSource: (
    source: EnrollmentSourceRecord,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly getEnrollmentSource: (
  ) => Effect.Effect<EnrollmentSourceRecord | undefined, StateRepositoryError>;
  readonly createEnrollmentInvitation: (
    input: CreateEnrollmentInvitationInput,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly findEnrollmentInvitation: (
    codeDigest: ContentDigest,
  ) => Effect.Effect<StoredEnrollmentInvitation | undefined, StateRepositoryError>;
  readonly consumeEnrollmentInvitation: (
    input: ConsumeEnrollmentInvitationInput,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly finalizeEnrollment: (
    input: FinalizeEnrollmentInput,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly cancelPendingEnrollment: (
    input: CancelPendingEnrollmentInput,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly listPendingEnrollments: (
  ) => Effect.Effect<ReadonlyArray<PendingEnrollmentRecord>, StateRepositoryError>;
  readonly findFollowerCredential: (
    credentialDigest: ContentDigest,
  ) => Effect.Effect<FollowerCredentialRecord | undefined, StateRepositoryError>;
  readonly getFollowerCredential: (
    follower: FollowerId,
  ) => Effect.Effect<FollowerCredentialRecord, StateRepositoryError>;
  readonly revokeFollower: (
    follower: FollowerId,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly updateFollowerGroups: (
    follower: FollowerId,
    groups: ReadonlyArray<GroupName>,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly publishRevision: (
    input: PublishRevisionInput,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly getRevision: (
    revision: ProfileRevisionId,
  ) => Effect.Effect<ProfileRevision, StateRepositoryError>;
  readonly findRevision: (
    revision: ProfileRevisionId,
  ) => Effect.Effect<ProfileRevision | undefined, StateRepositoryError>;
  readonly getLatestRevision: (
    profile: ProfileId,
  ) => Effect.Effect<ProfileRevision | undefined, StateRepositoryError>;
  readonly listRevisions: (
  ) => Effect.Effect<ReadonlyArray<ProfileRevision>, StateRepositoryError>;
  readonly loadAppliedResources: (
    follower: FollowerId,
  ) => Effect.Effect<ReadonlyArray<AppliedResourceRecord>, StateRepositoryError>;
  readonly startRun: (
    input: StartRunInput,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly journalAction: (
    input: JournalActionInput,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly recordDrift: (
    input: RecordDriftInput,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly completeRun: (
    input: CompleteRunInput,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly loadRecovery: (
    follower: FollowerId,
  ) => Effect.Effect<RecoveryState | undefined, StateRepositoryError>;
  readonly loadState: (
    follower: FollowerId,
  ) => Effect.Effect<StateSnapshot, StateRepositoryError>;
}>()("canonfig/state/StateRepository") {}
