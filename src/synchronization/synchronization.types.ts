import type {
  AgentTaskId,
  BlobId,
  ContentDigest,
  FollowerId,
  RunId,
  ResourceId,
} from "../domain/brand.ts";
import type { ProfileRevision, PublishedResource } from "../domain/profile.ts";
import type { VerificationInput } from "../domain/profile.ts";
import type {
  AppliedResourceRecord,
  ExecutableAuthorization,
  ObservedResourceState,
  PlannedAction,
  SynchronizationPlan,
} from "../domain/synchronization.ts";
import type { Platform } from "../domain/resource.ts";

/** Transfer metadata is deliberately separate from a resource's Apply Policy. */
export interface AvailableBlob {
  readonly id: BlobId;
  readonly bytes: number;
}

/** Canonical details needed to plan kind-specific behavior. */
export type DesiredResource =
  | {
    readonly kind: "file";
    readonly digest: ContentDigest;
    readonly executable: boolean;
    readonly symlinkTo?: string | undefined;
  }
  | {
    readonly kind: "directory";
    readonly files: ReadonlyArray<DesiredFile>;
  }
  | {
    readonly kind: "config";
    readonly digest: ContentDigest;
    readonly format: "toml" | "json" | "yaml";
    readonly keys: ReadonlyArray<string>;
  }
  | {
    readonly kind: "skill";
    readonly digest: ContentDigest;
    readonly files: ReadonlyArray<DesiredFile>;
  }
  | {
    readonly kind: "tool";
    readonly toolId: string;
    readonly recipes: ReadonlyArray<ToolRecipe>;
    readonly loginRequired: boolean;
    readonly loginInstructions?: string | undefined;
  }
  | {
    readonly kind: "credential";
    readonly reference: string;
    readonly instructions: string;
  }
  | { readonly kind: "schedule"; readonly digest: ContentDigest };

export interface DesiredFile {
  readonly path: string;
  readonly digest: ContentDigest;
  readonly executable: boolean;
}

export interface ToolRecipe {
  readonly platform: Platform;
  readonly method: string;
  readonly package: string;
}

export interface DesiredResourceEntry {
  readonly resource: ResourceId;
  readonly desired: DesiredResource;
  readonly verification: VerificationInput;
}

export interface ObservedResourceEntry {
  readonly resource: ResourceId;
  readonly observed: ObservedResourceState;
}

/** A hydrated immutable revision: metadata plus its verified content artifacts. */
export interface PlanningProfileRevision extends ProfileRevision {
  readonly desired: ReadonlyArray<DesiredResourceEntry>;
  readonly blobs: ReadonlyArray<AvailableBlob>;
}

/** All follower observations used by planning, including its blob cache. */
export interface ObservedState {
  readonly platform: Platform;
  readonly resources: ReadonlyArray<ObservedResourceEntry>;
  readonly availableBlobs: ReadonlyArray<BlobId>;
}

/**
 * A Local Overlay is data, not an operation. It only affects merge planning and
 * is never uploaded or mutated by the planner.
 */
export interface LocalOverlayEntry {
  readonly resource: ResourceId;
  readonly keys: ReadonlyArray<string>;
}

export interface SynchronizationPlannerInput {
  readonly revision: PlanningProfileRevision;
  readonly follower: FollowerId;
  readonly observedState: ObservedState;
  readonly localOverlay: ReadonlyArray<LocalOverlayEntry>;
  readonly appliedResources: ReadonlyArray<AppliedResourceRecord>;
}

export type SkillDriftState =
  | "unchanged"
  | "local-only"
  | "remote-only"
  | "converged"
  | "conflicting";

export interface SkillDriftInput {
  readonly desiredDigest: ContentDigest;
  readonly observedDigest?: ContentDigest | undefined;
  readonly lastAppliedDigest?: ContentDigest | undefined;
}

export interface PlannedResourceActions {
  readonly resource: PublishedResource;
  readonly actions: ReadonlyArray<PlannedAction>;
}

export interface PlannedSynchronization extends SynchronizationPlan {
  readonly digest: ContentDigest;
  readonly requiredBlobs: ReadonlyArray<BlobId>;
  readonly agentTasks: ReadonlyArray<PlannedAgentTask>;
}

export interface PlannedAgentTask {
  readonly id: AgentTaskId;
  readonly resource: ResourceId;
  readonly summary: string;
  readonly desiredOutcome: string;
  readonly observedEvidence: ReadonlyArray<string>;
  readonly allowedPaths: ReadonlyArray<string>;
  readonly allowedExecutables: ReadonlyArray<string>;
  readonly executableAuthorizations?: ReadonlyArray<ExecutableAuthorization> | undefined;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly forbidden: ReadonlyArray<"elevation" | "login" | "restart" | "reboot">;
  readonly timeLimitSeconds: number;
  readonly outputLimitBytes: number;
  readonly verification: {
    readonly command: ReadonlyArray<string>;
  };
}

export interface ResourcePlanningContext {
  readonly resource: PublishedResource;
  readonly desired: DesiredResource;
  readonly observed: ObservedResourceState;
  readonly overlayKeys: ReadonlyArray<string>;
  readonly applied?: AppliedResourceRecord | undefined;
  readonly platform: Platform;
}

/** Immutable content made available to the apply engine by the transport boundary. */
export interface SynchronizationArtifact {
  readonly digest: string;
  readonly content: Uint8Array;
}

export interface SynchronizationExecutionLimits {
  readonly maximumFileBytes: number;
  readonly processTimeoutMilliseconds: number;
  readonly maximumProcessOutputBytes: number;
  readonly verificationConcurrency: number;
}

export interface SynchronizationRunInput {
  readonly id: RunId;
  readonly plan: PlannedSynchronization;
  readonly revision: PlanningProfileRevision;
  readonly appliedResources?: ReadonlyArray<AppliedResourceRecord> | undefined;
  readonly artifacts: ReadonlyArray<SynchronizationArtifact>;
  readonly knownSecrets?: ReadonlyArray<string> | undefined;
  readonly limits?: Partial<SynchronizationExecutionLimits> | undefined;
}

/** Hydrated immutable inputs needed to resume one persisted follower run. */
export interface SynchronizationRecoveryInput {
  readonly follower: FollowerId;
  readonly revision: PlanningProfileRevision;
  readonly artifacts: ReadonlyArray<SynchronizationArtifact>;
  readonly knownSecrets?: ReadonlyArray<string> | undefined;
  readonly limits?: Partial<SynchronizationExecutionLimits> | undefined;
}
