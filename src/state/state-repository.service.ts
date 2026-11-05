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
  ResourceId,
  RunId,
} from "../domain/brand.ts";
import type { SourceIdentity } from "../domain/identity.ts";
import type { ProfileRevision } from "../domain/profile.ts";
import type { StateRepositoryError } from "./state-repository.errors.ts";
import type {
  CompleteRunInput,
  CancelPendingEnrollmentInput,
  ConsumeEnrollmentInvitationInput,
  CreateEnrollmentInvitationInput,
  DeploymentReceipt,
  HarnessTakeover,
  EnrollmentSourceRecord,
  FollowerCredentialRecord,
  FinalizeEnrollmentInput,
  JournalActionInput,
  PendingEnrollmentRecord,
  PublishRevisionInput,
  ReadResourceBlobRangeInput,
  RecordDriftInput,
  RecoveryState,
  RegisterFollowerInput,
  ResourceBlobRange,
  RevisionApprovalRecord,
  RunEvidenceSummary,
  StateSnapshot,
  RevisionBlobCandidate,
  StoredEnrollmentInvitation,
  SaveFollowerSynchronizationConfigurationInput,
  StartRunInput,
} from "./state-repository.types.ts";
import type { FollowerSynchronizationConfiguration } from
  "../synchronization/follower-sync-config.ts";
import type { PlanningLocalRevision } from
  "../synchronization/synchronization.types.ts";

export class StateRepository extends Context.Service<StateRepository, {
  /** Canonical SQLite filename, for cross-process lifecycle exclusion. */
  readonly databaseFile: () => Effect.Effect<string, StateRepositoryError>;
  readonly saveSourceIdentity: (
    identity: SourceIdentity,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly registerFollower: (
    input: RegisterFollowerInput,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly saveFollowerSynchronizationConfiguration: (
    input: SaveFollowerSynchronizationConfigurationInput,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly getFollowerSynchronizationConfiguration: (
  ) => Effect.Effect<
    FollowerSynchronizationConfiguration | undefined,
    StateRepositoryError
  >;
  /**
   * Forget this machine's enrollment. Applied Resource Records and run
   * history stay, so re-enrolling the same identity continues from them.
   * Returns whether an enrollment was recorded.
   */
  readonly removeFollowerSynchronizationConfiguration: (
  ) => Effect.Effect<boolean, StateRepositoryError>;
  readonly saveEnrollmentSource: (
    source: EnrollmentSourceRecord,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly getEnrollmentSource: (
  ) => Effect.Effect<EnrollmentSourceRecord | undefined, StateRepositoryError>;
  readonly createEnrollmentInvitation: (
    input: CreateEnrollmentInvitationInput,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly removeEnrollmentInvitation: (
    codeDigest: ContentDigest,
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
  readonly listRevisionBlobCandidates: (
    blob: ContentDigest,
  ) => Effect.Effect<ReadonlyArray<RevisionBlobCandidate>, StateRepositoryError>;
  readonly readResourceBlobRange: (
    input: ReadResourceBlobRangeInput,
  ) => Effect.Effect<ResourceBlobRange | undefined, StateRepositoryError>;
  /** Store the planning revision of a local projection; equal content is a no-op. */
  readonly recordLocalRevision: (
    revision: PlanningLocalRevision,
    recordedAt: string,
  ) => Effect.Effect<void, StateRepositoryError>;
  readonly getLocalRevision: (
    revision: ProfileRevisionId,
  ) => Effect.Effect<PlanningLocalRevision, StateRepositoryError>;
  readonly loadHarnessTakeovers: (
  ) => Effect.Effect<ReadonlyArray<HarnessTakeover>, StateRepositoryError>;
  readonly recordHarnessTakeovers: (
    takeovers: ReadonlyArray<HarnessTakeover>,
  ) => Effect.Effect<void, StateRepositoryError>;
  /** Forget the takeovers a run recorded, after that run rolled back. */
  readonly removeRunTakeovers: (
    run: RunId,
  ) => Effect.Effect<void, StateRepositoryError>;
  /** Forget surfaces a restore gave back to their harness. */
  readonly releaseTakeovers: (
    surfaces: ReadonlyArray<{ readonly harness: string; readonly surface: string }>,
  ) => Effect.Effect<void, StateRepositoryError>;
  /**
   * The resources of a run's actions that started (journaled running,
   * succeeded or failed), whether the run is open or finished. A started
   * action may have written its target even without an Applied Resource
   * Record, for example when the process died before journaling success.
   */
  readonly loadStartedResources: (
    run: RunId,
  ) => Effect.Effect<ReadonlyArray<ResourceId>, StateRepositoryError>;
  /**
   * Hand this machine's local projection records to the follower identity it
   * enrolled as, in one transaction: the follower's runs then own the harness
   * surfaces the machine projected while it projected its own folder. Run
   * history stays under the local projection. Returns how many records moved.
   */
  readonly adoptLocalProjection: (
    follower: FollowerId,
  ) => Effect.Effect<number, StateRepositoryError>;
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
  readonly loadDeploymentReceipt: (
    run: RunId,
  ) => Effect.Effect<DeploymentReceipt | undefined, StateRepositoryError>;
  readonly latestDeploymentReceipt: (
    follower: FollowerId,
  ) => Effect.Effect<DeploymentReceipt | undefined, StateRepositoryError>;
  readonly loadRevisionApproval: (
    revision: ProfileRevisionId,
  ) => Effect.Effect<RevisionApprovalRecord | undefined, StateRepositoryError>;
  readonly loadRunEvidence: (
    run: RunId,
  ) => Effect.Effect<RunEvidenceSummary | undefined, StateRepositoryError>;
  readonly loadRecovery: (
    follower: FollowerId,
  ) => Effect.Effect<RecoveryState | undefined, StateRepositoryError>;
  readonly loadOpenRunIdentity: (
    follower: FollowerId,
  ) => Effect.Effect<{
    readonly run: string;
    readonly creatingVersion: string;
    readonly creatingIdentity: string;
    readonly stateFormat: number;
  } | undefined, StateRepositoryError>;
  readonly loadState: (
    follower: FollowerId,
  ) => Effect.Effect<StateSnapshot, StateRepositoryError>;
}>()("canonfig/state/StateRepository") {}
