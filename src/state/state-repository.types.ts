import type {
  ActionId,
  CertificateFingerprint,
  ContentDigest,
  CredentialReference,
  FollowerId,
  GroupName,
  ProfileRevisionId,
  ResourceId,
  RunId,
} from "../domain/brand.ts";
import type { FollowerIdentity, SourceIdentity } from "../domain/identity.ts";
import type { ProfileRevision } from "../domain/profile.ts";
import type {
  AppliedResourceRecord,
  DriftConflict,
  SynchronizationOutcome,
  SynchronizationPlan,
} from "../domain/synchronization.ts";
import type { LocalOverlayEntry } from "../synchronization/synchronization.types.ts";
import type { FollowerSynchronizationConfiguration } from
  "../synchronization/follower-sync-config.ts";

export interface PublishRevisionInput {
  readonly revision: ProfileRevision;
}

export interface RevisionBlobCandidate {
  readonly blob: ContentDigest;
  readonly revision: ProfileRevisionId;
  readonly resource: ResourceId;
}

/**
 * A deployment receipt names the build that applied one completed run. It is
 * the durable half of the completion receipt: audits can say which sources
 * produced the deployed state on each machine.
 */
export interface DeploymentReceipt {
  readonly run: RunId;
  readonly follower: FollowerId;
  readonly revision: ProfileRevisionId;
  readonly packageVersion: string;
  readonly buildIdentity: string;
  readonly stateFormat: number;
  readonly outcome: SynchronizationOutcome["outcome"];
  readonly recordedAt: string;
}

/**
 * The approval that authorized a revision, persisted at publish time. It
 * binds the reviewer's accepted proposal digest to the exact revision digest
 * publish produced, so the plan and approval stay bound to the revision the
 * fleet applies instead of living only in the publish call.
 */
export interface RevisionApprovalRecord {
  readonly revision: ProfileRevisionId;
  readonly proposalDigest: ContentDigest;
  readonly revisionDigest: ContentDigest;
  readonly reviewer: string;
  readonly reviewedAt: string;
  readonly recordedAt: string;
}

export interface RecordRevisionApprovalInput {
  readonly revision: ProfileRevisionId;
  readonly proposalDigest: ContentDigest;
  readonly revisionDigest: ContentDigest;
  readonly reviewer: string;
  readonly reviewedAt: string;
  readonly recordedAt: string;
}

/**
 * Lean evidence for one finished run, backing the completion receipt without
 * replaying the full journal. Verification counts come from journaled
 * verification evidence; the mutating action count comes from the persisted
 * plan, so a clean second run reads as a no-op (zero mutating actions).
 */
export interface RunEvidenceSummary {
  readonly run: RunId;
  readonly revision: ProfileRevisionId;
  readonly outcome: SynchronizationOutcome["outcome"];
  readonly completedAt: string;
  readonly totalActions: number;
  readonly mutatingActions: number;
  readonly verifiedActions: number;
  readonly passedVerifications: number;
}

export interface RegisterFollowerInput {
  readonly follower: FollowerIdentity;
}

export interface SaveFollowerSynchronizationConfigurationInput {
  readonly configuration: FollowerSynchronizationConfiguration;
  readonly sourceIdentity: SourceIdentity;
}

export interface SaveLocalOverlayInput {
  readonly entry: LocalOverlayEntry;
  readonly updatedAt: string;
}

export interface RemoveLocalOverlayInput {
  readonly resource: ResourceId;
  readonly updatedAt: string;
}

export interface EnrollmentSourceRecord {
  readonly identity: SourceIdentity;
  readonly signingKeyReference: CredentialReference;
  readonly tlsKeyReference: CredentialReference;
  readonly tlsCertificateReference: CredentialReference;
  readonly tlsFingerprint: CertificateFingerprint;
}

export interface CreateEnrollmentInvitationInput {
  readonly codeDigest: ContentDigest;
  readonly nonceDigest: ContentDigest;
  readonly intendedSourceFingerprint: CertificateFingerprint;
  readonly tlsFingerprint: CertificateFingerprint;
  readonly endpoint: string;
  readonly groups: ReadonlyArray<GroupName>;
  readonly expiresAt: string;
}

export interface ConsumeEnrollmentInvitationInput {
  readonly codeDigest: ContentDigest;
  readonly nonceDigest: ContentDigest;
  readonly intendedSourceFingerprint: CertificateFingerprint;
  readonly tlsFingerprint: CertificateFingerprint;
  readonly follower: FollowerIdentity;
  readonly credentialDigest: ContentDigest;
  readonly credentialReference: CredentialReference;
  readonly consumedAt: string;
}

export interface FinalizeEnrollmentInput {
  readonly follower: FollowerId;
  readonly credentialDigest: ContentDigest;
  readonly credentialReference: CredentialReference;
}

export interface CancelPendingEnrollmentInput {
  readonly credentialDigest: ContentDigest;
}

export interface PendingEnrollmentRecord {
  readonly follower: FollowerId;
  readonly codeDigest: ContentDigest;
  readonly credentialDigest: ContentDigest;
  readonly credentialReference: CredentialReference;
}

export interface StoredEnrollmentInvitation {
  readonly intendedSourceFingerprint: CertificateFingerprint;
  readonly tlsFingerprint: CertificateFingerprint;
  readonly endpoint: string;
  readonly groups: ReadonlyArray<GroupName>;
  readonly expiresAt: string;
  readonly usedAt?: string | undefined;
}

export interface FollowerCredentialRecord {
  readonly follower: FollowerIdentity;
  readonly credentialDigest: ContentDigest;
  readonly credentialReference: CredentialReference;
}

export interface StartRunInput {
  readonly id: RunId;
  readonly follower: FollowerId;
  readonly revision: ProfileRevisionId;
  readonly plan: SynchronizationPlan;
  readonly startedAt: string;
}

export type ActionJournalState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

/**
 * Persistable verification evidence is deliberately constrained. Raw command
 * output and environment data do not cross this repository boundary.
 */
export interface VerificationEvidence {
  readonly status: "passed" | "failed" | "not-run";
  readonly method: string;
  readonly observedDigest?: ContentDigest | undefined;
  readonly exitCode?: number | undefined;
}

export interface JournalActionInput {
  readonly run: RunId;
  readonly action: ActionId;
  readonly state: Exclude<ActionJournalState, "pending">;
  readonly recordedAt: string;
  readonly attempt: number;
  readonly verification?: VerificationEvidence | undefined;
  readonly rollbackReference?: string | undefined;
  /**
   * A successful action may update the durable ownership baseline in the
   * same transaction as its terminal journal event.
   */
  readonly appliedResource?: AppliedResourceRecord | undefined;
  readonly removedResource?: ResourceId | undefined;
  /**
   * The ownership baseline replaced or removed by a terminal action. The
   * current record alone is not enough to restore ownership during recovery.
   */
  readonly removedResourceRecord?: AppliedResourceRecord | undefined;
}

export interface ActionJournalRecord {
  readonly action: ActionId;
  readonly ordinal: number;
  readonly state: ActionJournalState;
  readonly recordedAt: string;
  readonly attempt: number;
  readonly verification?: VerificationEvidence | undefined;
  readonly rollbackReference?: string | undefined;
  readonly removedResource?: AppliedResourceRecord | undefined;
}

export interface CompleteRunInput {
  readonly run: RunId;
  readonly completedAt: string;
  readonly outcome: SynchronizationOutcome;
  readonly appliedResources: ReadonlyArray<AppliedResourceRecord>;
  readonly removedResources?: ReadonlyArray<ResourceId> | undefined;
}

export interface RecordDriftInput {
  readonly run: RunId;
  readonly conflict: DriftConflict;
  readonly recordedAt: string;
}

export interface DriftRecord {
  readonly ordinal: number;
  readonly conflict: DriftConflict;
  readonly recordedAt: string;
}

export interface RecoveryRun {
  readonly id: RunId;
  readonly follower: FollowerId;
  readonly revision: ProfileRevisionId;
  readonly startedAt: string;
  readonly plan: SynchronizationPlan;
}

export interface RecoveryState {
  readonly run: RecoveryRun;
  readonly actions: ReadonlyArray<ActionJournalRecord>;
  readonly drift: ReadonlyArray<DriftRecord>;
  readonly appliedResources: ReadonlyArray<AppliedResourceRecord>;
  readonly removedResources: ReadonlyArray<AppliedResourceRecord>;
}

export interface StateSnapshot {
  readonly sourceIdentity?: SourceIdentity | undefined;
  readonly follower: FollowerIdentity;
  readonly activeRecovery?: RecoveryState | undefined;
}

export interface AppliedResourceLookup {
  readonly follower: FollowerId;
  readonly resources: ReadonlyArray<ResourceId>;
}
