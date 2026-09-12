import { Schema } from "effect";

/** The machine role setup establishes before any role-specific inspection. */
export const SetupRole = Schema.Literals(["source", "follower"]);
export type SetupRole = typeof SetupRole.Type;

/** Ordered setup stages. `apply` resumes at the next eligible stage. */
export const setupStages = [
  "role",
  "preflight",
  "inventory",
  "plan",
  "approve",
  "apply",
] as const;
export type SetupStage = typeof setupStages[number];

/** Bounds that keep setup inspection deterministic on any machine. */
export const maxSetupTools = 16;
export const maxSetupDiscoveryFiles = 32;
export const maxSetupDiscoveryFileBytes = 256 * 1024;
export const maxSetupJournalBytes = 256 * 1024;
export const maxSetupProcessBytes = 16 * 1024;
export const setupProcessTimeoutMilliseconds = 5_000;
export const setupRecipeTimeoutMilliseconds = 5 * 60_000;
export const maxSetupRecipeOutputBytes = 64 * 1024;

/** Installer methods setup probes, per platform. */
export const setupToolMethodsFor = (
  platform: "linux" | "macos" | "windows",
): ReadonlyArray<string> => {
  switch (platform) {
    case "linux":
      return ["apt", "npm", "pnpm", "bun", "uv", "cargo"];
    case "macos":
      return ["brew", "npm", "pnpm", "bun", "uv", "cargo"];
    case "windows":
      return ["winget", "npm", "pnpm", "bun", "uv", "cargo"];
  }
};

export const SetupInventoryTool = Schema.Struct({
  method: Schema.String,
  executable: Schema.String,
  version: Schema.optional(Schema.String),
  verified: Schema.Boolean,
});
export type SetupInventoryTool = typeof SetupInventoryTool.Type;

/**
 * Bounded typed inventory: verified OS, account, transport, runtime, and tool
 * identities. Every probe is a structured native invocation or a direct
 * machine query; setup never generates shell syntax.
 */
export const SetupInventory = Schema.Struct({
  schema: Schema.Literal("canonfig.setup-inventory/v1"),
  platform: Schema.Literals(["linux", "macos", "windows"]),
  home: Schema.String,
  account: Schema.String,
  osRelease: Schema.String,
  nodeRuntime: Schema.String,
  credentialStorage: Schema.Struct({
    kind: Schema.Literals([
      "secure-noninteractive",
      "local-file",
      "unavailable",
    ]),
    provider: Schema.optional(Schema.String),
    verification: Schema.optional(Schema.String),
    recovery: Schema.optional(Schema.String),
  }),
  transport: Schema.Struct({
    policy: Schema.Literal("loopback"),
    initialized: Schema.Boolean,
    tlsFingerprint: Schema.optional(Schema.String),
  }),
  tools: Schema.Array(SetupInventoryTool),
  discoveryFiles: Schema.Number,
  discoveryEvidence: Schema.Number,
  discoveryDigest: Schema.String,
});
export type SetupInventory = typeof SetupInventory.Type;
export const SetupRecipe = Schema.Struct({
  resource: Schema.String,
  installerMethod: Schema.String,
  installerExecutable: Schema.String,
  arguments: Schema.Array(Schema.String),
  verifyExecutable: Schema.String,
  verifyArguments: Schema.Array(Schema.String),
  version: Schema.String,
  source: Schema.String,
  upstream: Schema.optional(Schema.String),
  integrity: Schema.optional(Schema.String),
});
export type SetupRecipe = typeof SetupRecipe.Type;

export const SetupItemKind = Schema.Literals([
  "source-init",
  "ensure-directory",
  "tool-verify",
  "recipe-install",
  "toolchain-verify",
]);
export type SetupItemKind = typeof SetupItemKind.Type;

/**
 * One executable plan step. `scope` names the machine or resource the step
 * belongs to, so unrelated approved work can continue when an optional step
 * fails; `dependsOn` names the item ids that must complete first.
 */
export const SetupPlanItem = Schema.Struct({
  id: Schema.String,
  kind: SetupItemKind,
  scope: Schema.String,
  optional: Schema.Boolean,
  dependsOn: Schema.Array(Schema.String),
  detail: Schema.Record(Schema.String, Schema.Unknown),
});
export type SetupPlanItem = typeof SetupPlanItem.Type;

export const SetupItemStatus = Schema.Literals([
  "pending",
  "completed",
  "skipped",
  "failed",
]);
export type SetupItemStatus = typeof SetupItemStatus.Type;

export const SetupItemRecord = Schema.Struct({
  id: Schema.String,
  status: SetupItemStatus,
  evidence: Schema.optional(Schema.String),
  detailDigest: Schema.optional(Schema.String),
  updatedAt: Schema.String,
});
export type SetupItemRecord = typeof SetupItemRecord.Type;

export const SetupStageRecord = Schema.Struct({
  stage: Schema.String,
  digest: Schema.String,
  completedAt: Schema.String,
});
export type SetupStageRecord = typeof SetupStageRecord.Type;

export const SetupApproval = Schema.Struct({
  digest: Schema.String,
  approver: Schema.String,
  approvedAt: Schema.String,
});
export type SetupApproval = typeof SetupApproval.Type;

/** Qualified local or artifact provenance kept for reuse across runs. */
export const SetupProvenance = Schema.Struct({
  resource: Schema.String,
  method: Schema.String,
  platform: Schema.String,
  executable: Schema.String,
  version: Schema.optional(Schema.String),
  source: Schema.String,
  upstream: Schema.optional(Schema.String),
  integrity: Schema.optional(Schema.String),
  verifiedAt: Schema.optional(Schema.String),
});
export type SetupProvenance = typeof SetupProvenance.Type;

/**
 * The persisted setup journal. Intent, decisions, exclusions, evidence, and
 * approvals are all recorded against `planDigest`, so a re-plan invalidates
 * stale approvals instead of reusing them.
 */
export const SetupJournal = Schema.Struct({
  schema: Schema.Literal("canonfig.setup/v1"),
  role: SetupRole,
  planDigest: Schema.String,
  intent: Schema.String,
  inventory: SetupInventory,
  items: Schema.Array(SetupPlanItem),
  decisions: Schema.Array(Schema.String),
  exclusions: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.String),
  approvals: Schema.Array(SetupApproval),
  catalog: Schema.Array(SetupProvenance),
  stages: Schema.Array(SetupStageRecord),
  records: Schema.Array(SetupItemRecord),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type SetupJournal = typeof SetupJournal.Type;

export const decodeSetupJournal = Schema.decodeUnknownSync(SetupJournal);
export const encodeSetupJournal = Schema.encodeUnknownSync(SetupJournal);
