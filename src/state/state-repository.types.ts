import { Schema } from "effect";
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
import type { McpQualificationReceipt } from "../domain/mcp-qualification.ts";
import type { FollowerSynchronizationConfiguration } from
  "../synchronization/follower-sync-config.ts";
import type { CompiledResourceBlob } from "../profile/compiler.ts";

const ScheduledInvocationFields = {
  id: Schema.NonEmptyString,
  generation: Schema.optional(Schema.NonEmptyString),
  startedAt: Schema.NonEmptyString,
};

export const ScheduledInvocation = Schema.Union([
  Schema.TaggedStruct("Running", ScheduledInvocationFields),
  Schema.TaggedStruct("Completed", { ...ScheduledInvocationFields, at: Schema.NonEmptyString }),
  Schema.TaggedStruct("Failed", {
    ...ScheduledInvocationFields, at: Schema.NonEmptyString, reason: Schema.NonEmptyString,
  }),
]);
export type ScheduledInvocation = typeof ScheduledInvocation.Type;

/**
 * Bytes held in memory, or a regular file the repository streams into
 * fixed-size chunks, checking it against `id` and `bytes` as it writes.
 */
export type StoredResourceBlob = CompiledResourceBlob;

export interface PublishRevisionInput {
  readonly revision: ProfileRevision;
  readonly blobs?: ReadonlyArray<StoredResourceBlob> | undefined;
  readonly approval?: {
    readonly proposalDigest: ContentDigest;
    readonly reviewer: string;
    readonly reviewedAt: string;
    readonly recordedAt: string;
  } | undefined;
}

export interface ReadResourceBlobRangeInput {
  readonly blob: ContentDigest;
  readonly offset: number;
  readonly maximumBytes: number;
}

export interface ResourceBlobRange {
  /** The requested bytes in order, as stored; never joined into one buffer. */
  readonly chunks: ReadonlyArray<Uint8Array>;
  /** Sum of the chunks' lengths. */
  readonly byteLength: number;
  readonly totalBytes: number;
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
  readonly passedVerificationMethods: ReadonlyArray<string>;
  readonly mcpQualifications: ReadonlyArray<McpQualificationReceipt>;
}

export interface RegisterFollowerInput {
  readonly follower: FollowerIdentity;
}

export interface SaveFollowerSynchronizationConfigurationInput {
  readonly configuration: FollowerSynchronizationConfiguration;
  /** Absent means create-only; settings and lifecycle changes compare the read snapshot. */
  readonly expectedConfiguration?: FollowerSynchronizationConfiguration;
  readonly sourceIdentity: SourceIdentity;
}

export interface EnrollmentSourceRecord {
  readonly identity: SourceIdentity;
  readonly signingKeyReference: CredentialReference;
  readonly tlsKeyReference: CredentialReference;
  readonly tlsCertificateReference: CredentialReference;
  readonly tlsFingerprint: CertificateFingerprint;
  /**
   * Stable per-state-directory id that namespaces the Source's native
   * credential items. Absent for a Source initialized before namespacing,
   * whose items still use the legacy account-global names.
   */
  readonly credentialNamespace?: string | undefined;
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
  /** Atomic re-prepare may replace only this still-prepared credential. */
  readonly replacingCredentialDigest?: ContentDigest;
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

export type EnrollmentCredentialRetirement = {
  readonly _tag: "Retiring";
  readonly credentialReference: CredentialReference;
};

export interface StoredEnrollmentInvitation {
  readonly intendedSourceFingerprint: CertificateFingerprint;
  readonly tlsFingerprint: CertificateFingerprint;
  readonly endpoint: string;
  readonly groups: ReadonlyArray<GroupName>;
  readonly expiresAt: string;
  readonly lifecycle:
    | { readonly _tag: "Available" }
    | { readonly _tag: "Expired" }
    | { readonly _tag: "Prepared"; readonly follower: FollowerId; readonly credentialDigest: ContentDigest }
    | { readonly _tag: "Consumed"; readonly usedAt: string };
}

export const EnrollmentCredentialLifecycle = Schema.Union([
  Schema.TaggedStruct("Prepared", {}),
  Schema.TaggedStruct("Active", {}),
  Schema.TaggedStruct("Retiring", {}),
  Schema.TaggedStruct("Retired", {}),
]);

/** Enrollment inventory without credentials or invitation bearer material. */
export interface EnrollmentFollowerSummary {
  readonly id: FollowerId;
  readonly name: string;
  readonly groups: ReadonlyArray<GroupName>;
  readonly enrolledAt: string;
  readonly revoked: boolean;
  readonly pending: boolean;
  readonly credentialPresent: boolean;
  readonly credentialLifecycle: typeof EnrollmentCredentialLifecycle.Type;
}

export interface EnrollmentInvitationSummary {
  readonly endpoint: string;
  readonly groups: ReadonlyArray<GroupName>;
  readonly expiresAt: string;
  readonly consumed: boolean;
}

export interface FollowerCredentialRecord {
  readonly lifecycle:
    | { readonly _tag: "Active" }
    | { readonly _tag: "Retiring"; readonly credentialReference: CredentialReference }
    | { readonly _tag: "Retired" };
  readonly follower: FollowerIdentity;
  readonly credentialDigest: ContentDigest;
  readonly credentialReference: CredentialReference;
}

/** One harness surface Canonfig has taken over, with the root pinned at takeover. */
export interface HarnessTakeover {
  /** A harness id, or `agents` for the shared `~/.agents/skills/` surface. */
  readonly harness: string;
  readonly surface: string;
  readonly root: string;
  /** The takeover snapshot holding the surface's prior content; absent without a backup. */
  readonly snapshot?: string | undefined;
  readonly run: RunId;
  readonly takenOverAt: string;
}

/**
 * One `canonfig export` or `canonfig import` (not `--dry-run`), journaled in
 * `archive_events` apart from Synchronization Runs, so an export never
 * becomes the last sync outcome `status` reports.
 */
export interface ArchiveEvent {
  readonly occurredAt: string;
  readonly command: "export" | "import";
  /**
   * `Exported`, the outcome of the run an import wrote through, or `Error`
   * when the command stopped with an error; that error said what, if
   * anything, it wrote.
   */
  readonly outcome: "Exported" | "Error" | SynchronizationOutcome["outcome"];
  /** The archive's path; the requested one when an error came before export resolved it. */
  readonly archive: string;
  /** The archive's SHA-256, when the command got far enough to know it. */
  readonly sha256?: ContentDigest | undefined;
  /** The signing key's fingerprint, `unsigned`, or absent when unknown. */
  readonly signer?: string | undefined;
}

export interface StartRunInput {
  readonly id: RunId;
  readonly follower: FollowerId;
  readonly revision: ProfileRevisionId;
  readonly plan: SynchronizationPlan;
  readonly startedAt: string;
  /** Cleanup locations recorded before preparation; not yet usable rollback snapshots. */
  readonly pendingRollbackReferences?: ReadonlyMap<ActionId, string> | undefined;
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
  readonly qualification?: McpQualificationReceipt | undefined;
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
