import { Schema, SchemaIssue } from "effect";
import { TaggedError } from "./tagged-error.ts";

import {
  ActionId,
  AgentTaskId,
  BlobId,
  ContentDigest,
  FollowerId,
  ProfileRevisionId,
  ResourceId as ResourceIdSchema,
  RunId,
  Timestamp,
} from "./brand.ts";
import type { ResourceId } from "./brand.ts";
import {
  AutomaticRecipeMethod,
  BuildPolicy as BuildPolicySchema,
  RecipeIndexPolicy,
  type RecipeSource,
  type BuildPolicy,
  AgentInstallBounds,
  ToolRecipeRef,
} from "./resource.ts";

import {
  isMissingAutomaticRecipeVersion,
  RecipeSourceMetadata,
  recipeValidationIssue,
} from "./recipe-versions.ts";
import {
  InstallerRecipeProvenance,
  McpQualificationInput,
  type InstallerRecipeProvenance as InstallerRecipeProvenanceType,
} from "./mcp-qualification.ts";
import { PublishedResourceSchema, VerificationInputSchema } from "./profile.ts";
import type { DesiredResource } from "../synchronization/synchronization.types.ts";
/**
 * Synchronization domain types: plans, actions, outcomes, drift, agent tasks,
 * and human action records.
 */

const noTextTransitionEvidence = {
  retainedDigest: Schema.optionalKey(Schema.Never),
  previousDigest: Schema.optionalKey(Schema.Never),
  previousSourceDigest: Schema.optionalKey(Schema.Never),
  sourceDigest: Schema.optionalKey(Schema.Never),
};

/** Persisted text-write intent, independent of optional evidence fields. */
export const TextWriteTransition = Schema.Union([
  // Released terminal writes retain history but have no replayable intent.
  Schema.Struct({ ...noTextTransitionEvidence, kind: Schema.Literal("completed") }),
  Schema.Struct({ ...noTextTransitionEvidence, kind: Schema.Literal("whole-file") }),
  Schema.Struct({ ...noTextTransitionEvidence, kind: Schema.Literal("create-section") }),
  Schema.Struct({ ...noTextTransitionEvidence, kind: Schema.Literal("adopt-local"), retainedDigest: ContentDigest }),
  Schema.Struct({ ...noTextTransitionEvidence, kind: Schema.Literal("convert-whole"), previousDigest: ContentDigest }),
  Schema.Struct({ ...noTextTransitionEvidence, kind: Schema.Literal("update-section"), previousSourceDigest: ContentDigest }),
  Schema.Struct({ ...noTextTransitionEvidence, kind: Schema.Literal("adopt-section"), sourceDigest: ContentDigest }),
  Schema.Struct({ ...noTextTransitionEvidence, kind: Schema.Literal("leave-section"), previousSourceDigest: ContentDigest }),
]);
export type TextWriteTransition = typeof TextWriteTransition.Type;

export const ObservedTextComposition = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unmanaged"), sourceDigest: Schema.optionalKey(Schema.Never), hasLocal: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ kind: Schema.Literal("managed"), sourceDigest: ContentDigest, hasLocal: Schema.Boolean }),
]);
export type ObservedTextComposition = typeof ObservedTextComposition.Type;

export type TextOwnership =
  | { readonly kind: "absent" }
  | { readonly kind: "unmanaged"; readonly digest: string }
  | { readonly kind: "owned-whole"; readonly digest: string; readonly appliedDigest: string }
  | { readonly kind: "owned-section"; readonly sourceDigest: string; readonly hasLocal: boolean; readonly appliedDigest: string }
  | { readonly kind: "orphan-section"; readonly sourceDigest: string; readonly hasLocal: boolean }
  | { readonly kind: "invalid" };

/** Markers prove composition, not ownership; only an applied record proves ownership. */
export const classifyTextOwnership = (
  observed: ObservedResourceState,
  applied: AppliedResourceRecord | undefined,
): TextOwnership => {
  if (observed.state === "absent") return { kind: "absent" };
  if (observed.state !== "present" || observed.objectKind !== "regular") return { kind: "invalid" };
  const composition = observed.textComposition;
  if (composition === undefined) return { kind: "invalid" };
  if (applied?.ownership === "WholeFile") return { kind: "owned-whole", digest: observed.digest, appliedDigest: applied.digest };
  if (composition.kind === "managed") {
    if (applied === undefined) return { ...composition, kind: "orphan-section" };
    return applied.ownership === "SourceSection"
      ? { ...composition, kind: "owned-section", appliedDigest: applied.digest }
      : { kind: "invalid" };
  }
  if (applied === undefined) return { kind: "unmanaged", digest: observed.digest };
  return { kind: "invalid" };
};

export class InvalidTextTransitionError extends TaggedError<InvalidTextTransitionError>()(
  "InvalidTextTransitionError",
  { message: Schema.String },
) {}

/** Select the intent once; planners still apply the existing permission/drift rule. */
export const planTextWriteTransition = (
  ownership: TextOwnership,
  destination: "shared" | "whole",
): TextWriteTransition => {
  if (destination === "whole") {
    if (ownership.kind === "owned-section") return {
      kind: "leave-section", previousSourceDigest: ContentDigest.make(ownership.sourceDigest),
    };
    if (ownership.kind === "absent") return { kind: "whole-file" };
  } else {
    switch (ownership.kind) {
      case "absent": return { kind: "create-section" };
      case "unmanaged": return { kind: "adopt-local", retainedDigest: ContentDigest.make(ownership.digest) };
      case "owned-whole": return { kind: "convert-whole", previousDigest: ContentDigest.make(ownership.appliedDigest) };
      case "owned-section": return { kind: "update-section", previousSourceDigest: ContentDigest.make(ownership.sourceDigest) };
      case "orphan-section": return { kind: "adopt-section", sourceDigest: ContentDigest.make(ownership.sourceDigest) };
      case "invalid": break;
    }
  }
  throw new InvalidTextTransitionError({ message: `Cannot transition ${ownership.kind} text to ${destination} ownership` });
};

/** One owner for execution and review preconditions, including post-write replay. */
export const checkTextWriteTransition = (
  transition: TextWriteTransition,
  current: { readonly kind: "absent" } | { readonly kind: "unmanaged"; readonly digest: string }
    | { readonly kind: "managed"; readonly digest: string; readonly sourceDigest: string; readonly hasLocal: boolean },
  desiredDigest: string,
): void => {
  let valid: boolean;
  switch (transition.kind) {
    case "completed": valid = false; break;
    case "whole-file": valid = true; break;
    case "create-section": valid = current.kind === "absent"; break;
    case "adopt-local":
      valid = current.kind === "unmanaged" && current.digest === transition.retainedDigest;
      break;
    case "convert-whole":
      valid = current.kind !== "absent" && current.digest === transition.previousDigest;
      break;
    case "update-section":
      valid = current.kind === "managed"
        && (current.sourceDigest === transition.previousSourceDigest || current.sourceDigest === desiredDigest);
      break;
    case "adopt-section":
      valid = current.kind === "managed" && current.sourceDigest === transition.sourceDigest
        && current.sourceDigest === desiredDigest;
      break;
    case "leave-section":
      valid = current.kind === "managed" && !current.hasLocal
        && current.sourceDigest === transition.previousSourceDigest;
      break;
  }
  if (!valid) throw new InvalidTextTransitionError({
    message: `Illegal ${transition.kind} text transition from ${current.kind}; replan and review synchronization`,
  });
};

/** One planned action in a Synchronization Plan. */
export interface PlannedAction {
  readonly id: ActionId;
  readonly resource: ResourceId;
  readonly kind: PlannedActionKind;
  readonly detail: ActionDetail;
  readonly before: ReadonlyArray<ActionId>;
}

export type PlannedActionKind =
  | "no-op"
  | "transfer-blob"
  | "write-file"
  | "write-config"
  | "mirror-directory"
  | "remove-resource"
  | "install-tool"
  | "verify-only"
  | "human-action"
  | "agent-task"
  | "drift-conflict";

export type ActionDetail =
  | { readonly kind: "no-op"; readonly provenance?: InstallerRecipeProvenanceType | undefined }
  | { readonly kind: "transfer-blob"; readonly blob: string; readonly bytes: number }
  | {
    readonly kind: "write-file";
    readonly target: string;
    readonly digest: string;
    /** Normalized regular-file executable intent; absent for non-file writes. */
    readonly executable?: boolean | undefined;
    readonly mode?: number | undefined;
    readonly textTransition: TextWriteTransition;
    /** First adoption preserves unmanaged bytes and offers a private review. */
    readonly adoptionNotice?: string | undefined;
    /**
     * Publish without replacing: fail when a file appeared at `target` after
     * planning instead of overwriting it. Set only by `canonfig import`.
     */
    readonly noReplace?: boolean | undefined;
  }
  | {
    readonly kind: "write-config";
    readonly target: string;
    readonly keys: ReadonlyArray<string>;
    /**
     * Keys Canonfig owned that the revision no longer declares.
     *
     * A dropped key used to stay on the follower with its old value and the
     * plan read `no-op`, so only removing the whole resource ever removed a
     * key. These are pruned, and only when the file still holds exactly what
     * Canonfig wrote, so a local edit is never silently discarded.
     */
    readonly removes?: ReadonlyArray<string> | undefined;
    /**
     * Keys Canonfig owned that the revision no longer declares but that stay,
     * because a declared key now owns part of them. Canonfig stops managing them
     * and leaves their current values, so the plan names them instead of
     * reading as if nothing were left behind.
     */
    readonly retains?: ReadonlyArray<string> | undefined;
    readonly retentionNotice?: string | undefined;
  }
  | { readonly kind: "mirror-directory"; readonly target: string; readonly adds: ReadonlyArray<string>; readonly removes: ReadonlyArray<string> }
  | { readonly kind: "remove-resource"; readonly target: string; readonly paths: ReadonlyArray<string>; readonly keys: ReadonlyArray<string> }
  | { readonly kind: "install-tool"; readonly toolId: string; readonly method: AutomaticRecipeMethod; readonly package: string; readonly version?: string | undefined; /** The different version the installer reported before this install. */ readonly replaces?: string | undefined; readonly indexPolicy?: RecipeIndexPolicy | undefined; readonly source?: RecipeSource | undefined; readonly buildPolicy?: BuildPolicy | undefined; readonly provenance?: InstallerRecipeProvenanceType | undefined }
  | { readonly kind: "verify-only"; readonly method: string }
  | { readonly kind: "human-action"; readonly reason: string; readonly instructions: string }
  | { readonly kind: "agent-task"; readonly taskId: AgentTaskId; readonly summary: string }
  | {
    readonly kind: "drift-conflict";
    readonly target: string;
    readonly desiredDigest: string;
    readonly observedDigest: string;
    readonly desiredExecutable?: boolean | undefined;
    readonly observedExecutable?: boolean | undefined;
    /**
     * Filesystem modes are part of convergence, so drift can be mode-only.
     * A conflict that reported digests alone left the operator comparing two
     * identical hashes with nothing to say the modes were the difference,
     * which is what happens when a managed tree is recreated by hand with
     * default shell modes.
     */
    readonly desiredMode?: number | undefined;
    readonly observedMode?: number | undefined;
  };

/** A full, deterministic Synchronization Plan for one follower against one revision. */
export interface SynchronizationPlan {
  readonly revision: string;
  readonly follower: string;
  readonly actions: ReadonlyArray<PlannedAction>;
  readonly encoded: string;
  readonly digest?: ContentDigest | undefined;
}

/**
 * An explicit per-executable execution model. A task or harness can only
 * authorize behavior it can reason about: a direct leaf operation, or a
 * bounded script-file interpreter. Launchers that execute nested commands
 * cannot be authorized at all; they fail closed with Human Action Required.
 */
export interface ExecutableAuthorization {
  readonly executable: string;
  readonly behavior: "leaf" | "script-interpreter";
}

export interface AgentTask {
  readonly id: AgentTaskId;
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
  readonly verification: { readonly command: ReadonlyArray<string>; readonly expectContains?: string | undefined };
}

/** Human Action Required record with exact recovery instructions. */
export interface HumanAction {
  readonly reason: string;
  readonly instructions: string;
  readonly resource?: ResourceId | undefined;
}

/** Run outcome union. */
export type SynchronizationOutcome =
  | { readonly outcome: "Converged"; readonly run: RunId; readonly verified: ReadonlyArray<ResourceId> }
  | { readonly outcome: "HumanActionRequired"; readonly run: RunId; readonly actions: ReadonlyArray<HumanAction> }
  | { readonly outcome: "FollowerDrift"; readonly run: RunId; readonly conflicts: ReadonlyArray<DriftConflict> }
  | {
    readonly outcome: "Failed";
    readonly run: RunId;
    readonly reason: string;
    readonly rollbackIncomplete?: boolean;
    readonly failedRollbackResources?: ReadonlyArray<ResourceId>;
    /**
     * A no-replace write found this target taken by a file that appeared
     * after planning; that write published nothing and left the file alone.
     */
    readonly occupiedTarget?: string;
  }
  | { readonly outcome: "Interrupted"; readonly run: RunId; readonly completedActions: ReadonlyArray<ActionId> };

export interface DriftConflict {
  readonly resource: ResourceId;
  readonly target: string;
  readonly desiredDigest: string;
  readonly observedDigest: string;
  readonly lastAppliedDigest: string
  readonly desiredExecutable?: boolean | undefined;
  readonly observedExecutable?: boolean | undefined;
  readonly desiredMode?: number | undefined;
  readonly observedMode?: number | undefined;
}

/** Observed state of one resource target on the follower. */
export const ObservedObjectKind = Schema.Literals([
  "regular",
  "directory",
  "symlink",
  "reparse-point",
  "special",
]);
export type ObservedObjectKind = Schema.Schema.Type<typeof ObservedObjectKind>;

export type ObservedDirectoryFile =
  | {
    readonly path: string;
    readonly state: "absent";
  }
  | {
    readonly path: string;
    readonly digest: string;
    readonly executable?: boolean | undefined;
    readonly mode?: number | undefined;
    readonly objectKind?: ObservedObjectKind | undefined;
    readonly symlinkTo?: string | undefined;
  };

export type ObservedResourceState =
  | { readonly state: "absent" }
  | {
    readonly state: "present";
    readonly digest: string;
    /** Parsed composition evidence is paired, never inferred from missing flags. */
    readonly textComposition?: ObservedTextComposition | undefined;
    readonly executable: boolean;
    readonly mode?: number | undefined;
    /**
     * Actual final path kind. Optional for compatibility with observations
     * produced before no-follow object inspection was introduced.
     */
    readonly objectKind?: ObservedObjectKind | undefined;
    readonly symlinkTo?: string | undefined;
    /**
     * Tools: the version the selected recipe's installer reports as
     * installed, when it lists the package. Undefined when it cannot say.
     */
    readonly installedVersion?: string | undefined;
    /**
     * Configs: the current values at the Applied Resource Record's keys,
     * rendered like `digest`, so they compare with the record's digest even
     * when the desired key set changed. Undefined when none of those keys is
     * present or nothing was applied.
     */
    readonly appliedKeysDigest?: string | undefined;
  }
  | {
    readonly state: "directory";
    readonly objectKind?: ObservedObjectKind | undefined;
    readonly mode: number;
    readonly files: ReadonlyArray<ObservedDirectoryFile>;
  }
  | { readonly state: "unverifiable"; readonly reason: string };

/** Applied Resource Records have exactly one ownership interpretation. */
export type AppliedResourceRecord = Schema.Schema.Type<typeof AppliedResourceRecordSchema>;

export interface AppliedDirectoryEntry {
  readonly path: string;
  readonly digest: string;
  readonly executable: boolean;
  readonly mode: number;
  readonly objectKind: "regular" | "directory" | "symlink";
  readonly symlinkTo?: string | undefined;
}

export const PlannedActionKindSchema = Schema.Literals([
  "no-op",
  "transfer-blob",
  "write-file",
  "write-config",
  "mirror-directory",
  "remove-resource",
  "install-tool",
  "verify-only",
  "human-action",
  "agent-task",
  "drift-conflict",
]);

const InstallToolActionDetailSchema = Schema.Struct({
  kind: Schema.Literal("install-tool"),
  toolId: Schema.NonEmptyString,
  method: AutomaticRecipeMethod,
  package: Schema.NonEmptyString,
  version: Schema.optional(Schema.NonEmptyString),
  replaces: Schema.optional(Schema.NonEmptyString),
  indexPolicy: Schema.optional(RecipeIndexPolicy),
  source: Schema.optional(Schema.Union([
    Schema.NonEmptyString,
    RecipeSourceMetadata,
  ])),
  buildPolicy: Schema.optional(BuildPolicySchema),
  provenance: Schema.optional(InstallerRecipeProvenance),
}).check(
  Schema.makeFilter((detail) => {
    const issue = recipeValidationIssue(detail);
    if (issue !== undefined) return issue;
    return isMissingAutomaticRecipeVersion(detail)
      ? {
        path: ["version"],
        issue: new SchemaIssue.InvalidValue({
          expected: `automatic installer ${detail.method} requires an exact version`,
        }),
      }
      : undefined;
  }),
);

export const ActionDetailSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("no-op"),
    provenance: Schema.optional(InstallerRecipeProvenance),
  }),
  Schema.Struct({
    kind: Schema.Literal("transfer-blob"),
    blob: BlobId,
    bytes: Schema.Natural,
  }),
  Schema.Struct({
    kind: Schema.Literal("write-file"),
    target: Schema.NonEmptyString,
    digest: ContentDigest,
    executable: Schema.optional(Schema.Boolean),
    mode: Schema.optional(Schema.Int),
    textTransition: TextWriteTransition,
    previousSourceDigest: Schema.optionalKey(Schema.Never),
    retainedLocalDigest: Schema.optionalKey(Schema.Never),
    adoptionNotice: Schema.optional(Schema.NonEmptyString),
    noReplace: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("write-config"),
    target: Schema.NonEmptyString,
    keys: Schema.Array(Schema.NonEmptyString),
    removes: Schema.optional(Schema.Array(Schema.NonEmptyString)),
    retains: Schema.optional(Schema.Array(Schema.NonEmptyString)),
    retentionNotice: Schema.optional(Schema.NonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("mirror-directory"),
    target: Schema.NonEmptyString,
    adds: Schema.Array(Schema.NonEmptyString),
    removes: Schema.Array(Schema.NonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("remove-resource"),
    target: Schema.NonEmptyString,
    paths: Schema.Array(Schema.NonEmptyString),
    keys: Schema.Array(Schema.NonEmptyString),
  }),
  InstallToolActionDetailSchema,
  Schema.Struct({
    kind: Schema.Literal("verify-only"),
    method: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("human-action"),
    reason: Schema.NonEmptyString,
    instructions: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("agent-task"),
    taskId: AgentTaskId,
    summary: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("drift-conflict"),
    target: Schema.NonEmptyString,
    desiredDigest: ContentDigest,
    observedDigest: ContentDigest,
    desiredExecutable: Schema.optional(Schema.Boolean),
    observedExecutable: Schema.optional(Schema.Boolean),
    desiredMode: Schema.optional(Schema.Int),
    observedMode: Schema.optional(Schema.Int),
  }),
]);

export const PlannedActionSchema = Schema.Struct({
  id: ActionId,
  resource: ResourceIdSchema,
  kind: PlannedActionKindSchema,
  detail: ActionDetailSchema,
  before: Schema.Array(ActionId),
});

export const SynchronizationPlanSchema = Schema.Struct({
  revision: ProfileRevisionId,
  follower: FollowerId,
  actions: Schema.Array(PlannedActionSchema),
  encoded: Schema.String,
  digest: Schema.optional(ContentDigest),
});

export const ForbiddenAgentCapabilitySchema = Schema.Literals([
  "elevation",
  "login",
  "restart",
  "reboot",
]);

export const ExecutableAuthorizationSchema = Schema.Struct({
  executable: Schema.NonEmptyString,
  behavior: Schema.Literals(["leaf", "script-interpreter"]),
});

export const AgentTaskSchema = Schema.Struct({
  id: AgentTaskId,
  summary: Schema.NonEmptyString,
  desiredOutcome: Schema.NonEmptyString,
  observedEvidence: Schema.Array(Schema.String),
  allowedPaths: Schema.Array(Schema.NonEmptyString),
  allowedExecutables: Schema.Array(Schema.NonEmptyString),
  executableAuthorizations: Schema.optional(Schema.Array(ExecutableAuthorizationSchema)),
  allowedOrigins: Schema.Array(Schema.NonEmptyString),
  forbidden: Schema.Array(ForbiddenAgentCapabilitySchema),
  timeLimitSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
  outputLimitBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  verification: Schema.Struct({
    command: Schema.Array(Schema.NonEmptyString),
    expectContains: Schema.optional(Schema.String),
  }),
});

export const HumanActionSchema = Schema.Struct({
  reason: Schema.NonEmptyString,
  instructions: Schema.NonEmptyString,
  resource: Schema.optional(ResourceIdSchema),
});

export const HumanActionRequiredSchema = Schema.Struct({
  outcome: Schema.Literal("HumanActionRequired"),
  run: RunId,
  actions: Schema.Array(HumanActionSchema),
});
export type HumanActionRequired = Schema.Schema.Type<typeof HumanActionRequiredSchema>;

export const DriftConflictSchema = Schema.Struct({
  resource: ResourceIdSchema,
  target: Schema.NonEmptyString,
  desiredDigest: ContentDigest,
  observedDigest: ContentDigest,
  lastAppliedDigest: ContentDigest,
  desiredExecutable: Schema.optional(Schema.Boolean),
  observedExecutable: Schema.optional(Schema.Boolean),
  desiredMode: Schema.optional(Schema.Int),
  observedMode: Schema.optional(Schema.Int),
});

export const SynchronizationOutcomeSchema = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("Converged"),
    run: RunId,
    verified: Schema.Array(ResourceIdSchema),
  }),
  HumanActionRequiredSchema,
  Schema.Struct({
    outcome: Schema.Literal("FollowerDrift"),
    run: RunId,
    conflicts: Schema.Array(DriftConflictSchema),
  }),
  Schema.Struct({
    outcome: Schema.Literal("Failed"),
    run: RunId,
    reason: Schema.NonEmptyString,
    rollbackIncomplete: Schema.optional(Schema.Boolean),
    failedRollbackResources: Schema.optional(Schema.Array(ResourceIdSchema)),
    occupiedTarget: Schema.optional(Schema.NonEmptyString),
  }),
  Schema.Struct({
    outcome: Schema.Literal("Interrupted"),
    run: RunId,
    completedActions: Schema.Array(ActionId),
  }),
]);

export const ObservedResourceStateSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("absent") }),
  Schema.Struct({
    state: Schema.Literal("present"),
    digest: ContentDigest,
    textComposition: Schema.optional(ObservedTextComposition),
    managedSourceDigest: Schema.optionalKey(Schema.Never),
    managedLocalText: Schema.optionalKey(Schema.Never),
    executable: Schema.Boolean,
    mode: Schema.optional(Schema.Int),
    objectKind: Schema.optional(ObservedObjectKind),
    symlinkTo: Schema.optional(Schema.NonEmptyString),
    installedVersion: Schema.optional(Schema.NonEmptyString),
    appliedKeysDigest: Schema.optional(ContentDigest),
  }),
  Schema.Struct({
    state: Schema.Literal("directory"),
    objectKind: Schema.optional(ObservedObjectKind),
    mode: Schema.Int,
    files: Schema.Array(Schema.Union([
      Schema.Struct({
        path: Schema.NonEmptyString,
        state: Schema.Literal("absent"),
      }),
      Schema.Struct({
        path: Schema.NonEmptyString,
        digest: ContentDigest,
        executable: Schema.optional(Schema.Boolean),
        mode: Schema.optional(Schema.Int),
        objectKind: Schema.optional(ObservedObjectKind),
        symlinkTo: Schema.optional(Schema.NonEmptyString),
      }),
    ])),
  }),
  Schema.Struct({
    state: Schema.Literal("unverifiable"),
    reason: Schema.NonEmptyString,
  }),
]);

const appliedResourceFields = {
  resource: ResourceIdSchema,
  revision: ProfileRevisionId,
  digest: ContentDigest,
  appliedAt: Timestamp,
  target: Schema.NonEmptyString,
};

const appliedFileFields = {
  ...appliedResourceFields,
  kind: Schema.Literal("file"),
  executable: Schema.Boolean,
  mode: Schema.Int,
};

const wholeFilePolicies = Schema.Literals(["replace", "replace-if-unmodified"]);

export const AppliedResourceRecordSchema = Schema.Union([
  Schema.Struct({
    ...appliedFileFields,
    ownership: Schema.Literal("WholeFile"),
    policy: wholeFilePolicies,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    ...appliedResourceFields,
    ownership: Schema.Literal("Symlink"),
    kind: Schema.Literal("file"),
    policy: wholeFilePolicies,
    symlinkTo: Schema.NonEmptyString,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    ...appliedFileFields,
    ownership: Schema.Literal("SourceSection"),
    policy: Schema.Literal("append-local"),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    ...appliedResourceFields,
    ownership: Schema.Literal("DirectoryEntries"),
    kind: Schema.Literals(["directory", "skill"]),
    policy: Schema.Literals(["replace", "replace-if-unmodified", "mirror-owned", "append-local"]),
    mode: Schema.Int,
    ownedFiles: Schema.Array(Schema.Struct({
      path: Schema.NonEmptyString,
      digest: ContentDigest,
      executable: Schema.Boolean,
      mode: Schema.Int,
      objectKind: Schema.Literals(["regular", "directory", "symlink"]),
      symlinkTo: Schema.optional(Schema.NonEmptyString),
    }).check(Schema.makeFilter((entry) =>
      (entry.objectKind === "symlink") !== (entry.symlinkTo !== undefined)
        ? { path: ["symlinkTo"], issue: "only a symlink entry must name its target" }
        : undefined
    ))),
  }).check(Schema.makeFilter((record) =>
    record.kind === "skill" && record.policy !== "replace" && record.policy !== "replace-if-unmodified"
      ? { path: ["policy"], issue: "skill ownership requires replace or replace-if-unmodified" }
      : undefined
  )).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    ...appliedResourceFields,
    ownership: Schema.Literal("ConfigKeys"),
    kind: Schema.Literal("config"),
    policy: Schema.Literals(["merge", "replace", "replace-if-unmodified"]),
    ownedKeys: Schema.Array(Schema.NonEmptyString),
    configFormat: Schema.Literals(["toml", "json", "yaml"]),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    ...appliedResourceFields,
    ownership: Schema.Literal("QualifiedTool"),
    kind: Schema.Literal("tool"),
    policy: Schema.Literal("ensure"),
    /** Exact qualified recipe prevents PATH discovery from impersonating it. */
    installerRecipe: InstallerRecipeProvenance,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
]);

const decodeAppliedResourceRecord = Schema.decodeUnknownSync(AppliedResourceRecordSchema);

/**
 * Build ownership only after verification. Execution and recovery supply the
 * same post-write config keys/digest, including write-and-release handovers.
 * Tool discovery and credential checks do not establish removable ownership.
 */
export const createAppliedResourceRecord = (input: {
  readonly resource: Pick<Schema.Schema.Type<typeof PublishedResourceSchema>, "id" | "kind" | "policy" | "target">;
  readonly revision: string;
  readonly digest: string;
  readonly appliedAt: string;
  readonly desired: DesiredResource;
  readonly ownedFiles?: ReadonlyArray<AppliedDirectoryEntry> | undefined;
  readonly ownedKeys?: ReadonlyArray<string> | undefined;
  readonly installerRecipe?: InstallerRecipeProvenanceType | undefined;
}): AppliedResourceRecord | undefined => {
  const { desired, resource } = input;
  if (desired.kind !== resource.kind) {
    throw new Error(`Cannot record ownership for ${resource.id}: verified ${desired.kind} differs from ${resource.kind}`);
  }
  const common = {
    resource: resource.id,
    revision: input.revision,
    digest: input.digest,
    appliedAt: input.appliedAt,
    target: resource.target,
    kind: resource.kind,
    policy: resource.policy,
  };
  // Decode once at the construction boundary, not again in ownership readers.
  switch (desired.kind) {
    case "file":
      return decodeAppliedResourceRecord(desired.symlinkTo !== undefined
        ? { ...common, ownership: "Symlink", symlinkTo: desired.symlinkTo }
        : {
          ...common,
          ownership: resource.policy === "append-local" ? "SourceSection" : "WholeFile",
          executable: desired.executable,
          mode: desired.mode,
        });
    case "directory":
    case "skill":
      return decodeAppliedResourceRecord({ ...common, ownership: "DirectoryEntries", mode: desired.mode, ownedFiles: input.ownedFiles });
    case "config":
      return decodeAppliedResourceRecord({ ...common, ownership: "ConfigKeys", ownedKeys: input.ownedKeys, configFormat: desired.format });
    case "tool":
      return input.installerRecipe === undefined ? undefined : decodeAppliedResourceRecord({
        ...common,
        ownership: "QualifiedTool",
        digest: input.installerRecipe.fingerprint,
        installerRecipe: input.installerRecipe,
      });
    case "credential":
      return undefined;
  }
};

/** Runtime schema aliases share names with their corresponding domain types. */
export const PlannedActionKind = PlannedActionKindSchema;
export const ActionDetail = ActionDetailSchema;
export const PlannedAction = PlannedActionSchema;
export const SynchronizationPlan = SynchronizationPlanSchema;
export const AgentTask = AgentTaskSchema;
export const HumanAction = HumanActionSchema;
export const HumanActionRequired = HumanActionRequiredSchema;
export const DriftConflict = DriftConflictSchema;
export const SynchronizationOutcome = SynchronizationOutcomeSchema;
export const ObservedResourceState = ObservedResourceStateSchema;
export const AppliedResourceRecord = AppliedResourceRecordSchema;

export class DuplicateActionError extends TaggedError<DuplicateActionError>()(
  "DuplicateActionError",
  { id: Schema.String },
) {}

export class MissingActionReferenceError extends TaggedError<MissingActionReferenceError>()(
  "MissingActionReferenceError",
  { id: Schema.String, before: Schema.String },
) {}

export class ActionCycleError extends TaggedError<ActionCycleError>()(
  "ActionCycleError",
  { cycle: Schema.Array(Schema.String) },
) {}

export class ActionKindMismatchError extends TaggedError<ActionKindMismatchError>()(
  "ActionKindMismatchError",
  { id: Schema.String, kind: Schema.String, detailKind: Schema.String },
) {}

export type SynchronizationPlanValidationError =
  | DuplicateActionError
  | MissingActionReferenceError
  | ActionCycleError
  | ActionKindMismatchError;

/** Validate action references, detail compatibility, and action graph acyclicity. */
export const validateSynchronizationPlan = (
  plan: SynchronizationPlan,
): ReadonlyArray<SynchronizationPlanValidationError> => {
  const errors: Array<SynchronizationPlanValidationError> = [];
  const actionIds = new Set<string>();
  for (const action of plan.actions) {
    if (actionIds.has(action.id)) errors.push(new DuplicateActionError({ id: action.id }));
    actionIds.add(action.id);
    if (action.kind !== action.detail.kind) {
      errors.push(new ActionKindMismatchError({
        id: action.id,
        kind: action.kind,
        detailKind: action.detail.kind,
      }));
    }
  }
  for (const action of plan.actions) {
    for (const before of action.before) {
      if (!actionIds.has(before)) {
        errors.push(new MissingActionReferenceError({ id: action.id, before }));
      }
    }
  }
  const cycle = findActionCycle(plan.actions);
  if (cycle !== null) errors.push(new ActionCycleError({ cycle }));
  return errors;
};

export const findActionCycle = (
  actions: ReadonlyArray<PlannedAction>,
): ReadonlyArray<string> | null => {
  const graph = new Map<string, ReadonlyArray<string>>();
  for (const action of actions) graph.set(action.id, action.before);
  const active: Array<string> = [];
  const complete = new Set<string>();
  const visit = (id: string): ReadonlyArray<string> | null => {
    if (complete.has(id)) return null;
    const index = active.indexOf(id);
    if (index >= 0) return [...active.slice(index), id];
    active.push(id);
    for (const next of graph.get(id) ?? []) {
      if (!graph.has(next)) continue;
      const cycle = visit(next);
      if (cycle !== null) return cycle;
    }
    active.pop();
    complete.add(id);
    return null;
  };
  for (const action of actions) {
    const cycle = visit(action.id);
    if (cycle !== null) return cycle;
  }
  return null;
};

/** Exit codes for the CLI, mapped from outcomes. */
export const ExitCode = {
  success: 0,
  invalidInput: 2,
  drift: 3,
  humanAction: 4,
  interrupted: 5,
  operationalFailure: 1,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** Agent policy schema re-exported for the profile authoring boundary. */
export { AgentPolicy } from "./identity.ts";

/**
 * The follower id of runs that project this machine's own Canonical Folder.
 * Enrolled followers are named `follower-<hash>`, so this never collides.
 */
export const localProjectionFollower = Schema.decodeUnknownSync(FollowerId)("local");

const DesiredFileSchema = Schema.Struct({
  path: Schema.NonEmptyString,
  digest: ContentDigest,
  executable: Schema.Boolean,
  mode: Schema.Int,
  symlinkTo: Schema.optional(Schema.NonEmptyString),
});

/**
 * The stored form of a revision this machine built: a local projection
 * (`folder`, `snapshot`), an import of an export archive (`archive`), or a
 * follower run built from a Source revision (`revision`), which also mirrors
 * items and installs tools.
 */
export const PlanningLocalRevisionSchema = Schema.Struct({
  origin: Schema.Literals(["folder", "snapshot", "archive", "revision"]),
  id: ProfileRevisionId,
  originDigest: ContentDigest,
  resources: Schema.Array(PublishedResourceSchema),
  desired: Schema.Array(Schema.Struct({
    resource: ResourceIdSchema,
    desired: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("file"),
        digest: ContentDigest,
        executable: Schema.Boolean,
        mode: Schema.Int,
        symlinkTo: Schema.optional(Schema.NonEmptyString),
      }),
      Schema.Struct({
        kind: Schema.Literal("directory"),
        mode: Schema.Int,
        directories: Schema.Array(Schema.Struct({ path: Schema.NonEmptyString, mode: Schema.Int })),
        files: Schema.Array(DesiredFileSchema),
      }),
      Schema.Struct({
        kind: Schema.Literal("config"),
        digest: ContentDigest,
        format: Schema.Literals(["toml", "json", "yaml"]),
        keys: Schema.Array(Schema.String),
        releases: Schema.optional(Schema.Array(Schema.String)),
      }),
      Schema.Struct({
        kind: Schema.Literal("skill"),
        digest: ContentDigest,
        mode: Schema.Int,
        directories: Schema.Array(Schema.Struct({ path: Schema.NonEmptyString, mode: Schema.Int })),
        files: Schema.Array(DesiredFileSchema),
      }),
      Schema.Struct({
        kind: Schema.Literal("tool"),
        toolId: Schema.NonEmptyString,
        recipes: Schema.Array(ToolRecipeRef),
        loginRequired: Schema.Boolean,
        loginInstructions: Schema.optional(Schema.String),
        qualification: Schema.optional(McpQualificationInput),
        agentInstall: Schema.optional(AgentInstallBounds),
      }),
      Schema.Struct({
        kind: Schema.Literal("credential"),
        reference: Schema.NonEmptyString,
        instructions: Schema.String,
      }),
    ]),
    verification: VerificationInputSchema,
  })),
  blobs: Schema.Array(Schema.Struct({ id: BlobId, bytes: Schema.Int })),
  removedResources: Schema.optional(Schema.Array(ResourceIdSchema)),
});
