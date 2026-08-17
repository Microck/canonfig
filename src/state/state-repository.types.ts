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
   * The ownership baseline removed by a terminal removal action. The
   * resource id alone is not enough to reconstruct a safe rollback or
   * recovery context after the applied-resource row is deleted.
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
