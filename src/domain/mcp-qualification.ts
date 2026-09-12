import { createHash } from "node:crypto";

import { Schema } from "effect";

import { ContentDigest } from "./brand.ts";
import { Platform, RecipeMethod } from "./resource.ts";

export const McpQualificationStage = Schema.Literals([
  "installed",
  "launches",
  "protocol-compatible",
  "authenticated",
  "functional",
  "client-loaded",
  "canonfig-managed",
]);
export type McpQualificationStage = Schema.Schema.Type<typeof McpQualificationStage>;

export const McpQualificationProbe = Schema.Struct({
  command: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
  expectContains: Schema.optional(Schema.String),
  /** Human-readable name of the harmless operation; command output is never persisted. */
  operation: Schema.NonEmptyString,
});
export type McpQualificationProbe = Schema.Schema.Type<typeof McpQualificationProbe>;

export const McpLocalPrerequisiteKind = Schema.Literals([
  "browser-login",
  "license-entitlement",
  "local-runtime",
  "client-configuration",
]);
export type McpLocalPrerequisiteKind = Schema.Schema.Type<typeof McpLocalPrerequisiteKind>;

export const McpLocalPrerequisite = Schema.Struct({
  kind: McpLocalPrerequisiteKind,
  stage: Schema.Literals(["authenticated", "functional", "client-loaded"]),
  instructions: Schema.NonEmptyString,
  disposition: Schema.optional(Schema.Literals(["unresolved", "excluded"])),
});
export type McpLocalPrerequisite = Schema.Schema.Type<typeof McpLocalPrerequisite>;

export const McpQualificationInput = Schema.Struct({
  method: Schema.Literal("mcp-qualification"),
  /** Target client whose loading is verified; receipts never generalize across clients. */
  target: Schema.NonEmptyString,
  /** MCP/API compatibility constraint which invalidates a previously qualified recipe. */
  compatibility: Schema.NonEmptyString,
  launches: McpQualificationProbe,
  protocolCompatible: McpQualificationProbe,
  authenticated: Schema.optional(McpQualificationProbe),
  functional: Schema.optional(McpQualificationProbe),
  clientLoaded: Schema.optional(McpQualificationProbe),
  prerequisites: Schema.optional(Schema.Array(McpLocalPrerequisite)),
  exclusion: Schema.optional(Schema.Struct({ reason: Schema.NonEmptyString })),
});
export type McpQualificationInput = Schema.Schema.Type<typeof McpQualificationInput>;

export const InstallerRecipeProvenance = Schema.Struct({
  schema: Schema.Literal("canonfig.recipe-provenance/v1"),
  upstream: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  platform: Platform,
  architecture: Schema.NonEmptyString,
  artifactDigest: Schema.NonEmptyString,
  entrypoint: Schema.NonEmptyString,
  dependencyPolicy: Schema.NonEmptyString,
  executionContext: Schema.NonEmptyString,
  method: RecipeMethod,
  package: Schema.NonEmptyString,
  compatibility: Schema.NonEmptyString,
  target: Schema.NonEmptyString,
  fingerprint: ContentDigest,
});
export type InstallerRecipeProvenance = Schema.Schema.Type<typeof InstallerRecipeProvenance>;

export const QualificationEvidenceStatus = Schema.Literals([
  "passed",
  "failed",
  "not-run",
  "not-required",
  "unresolved",
  "excluded",
]);
export type QualificationEvidenceStatus = Schema.Schema.Type<typeof QualificationEvidenceStatus>;

export const McpQualificationStageEvidence = Schema.Struct({
  stage: McpQualificationStage,
  status: QualificationEvidenceStatus,
  method: Schema.NonEmptyString,
  operation: Schema.NonEmptyString,
  exitCode: Schema.optional(Schema.Int),
});
export type McpQualificationStageEvidence = Schema.Schema.Type<typeof McpQualificationStageEvidence>;

export const McpPrerequisiteEvidence = Schema.Struct({
  kind: McpLocalPrerequisiteKind,
  stage: Schema.Literals(["authenticated", "functional", "client-loaded"]),
  status: Schema.Literals(["satisfied", "unresolved", "excluded"]),
  instructions: Schema.NonEmptyString,
});
export type McpPrerequisiteEvidence = Schema.Schema.Type<typeof McpPrerequisiteEvidence>;

export const McpQualificationReceipt = Schema.Struct({
  schema: Schema.Literal("canonfig.mcp-qualification/v1"),
  resource: Schema.NonEmptyString,
  target: Schema.NonEmptyString,
  recipe: InstallerRecipeProvenance,
  stages: Schema.Array(McpQualificationStageEvidence),
  prerequisites: Schema.Array(McpPrerequisiteEvidence),
  ready: Schema.Boolean,
  recordedAt: Schema.NonEmptyString,
});
export type McpQualificationReceipt = Schema.Schema.Type<typeof McpQualificationReceipt>;

const canonicalRecipeFields = (
  recipe: Omit<InstallerRecipeProvenance, "fingerprint" | "schema">,
) => ({
  architecture: recipe.architecture,
  artifactDigest: recipe.artifactDigest,
  compatibility: recipe.compatibility,
  dependencyPolicy: recipe.dependencyPolicy,
  entrypoint: recipe.entrypoint,
  executionContext: recipe.executionContext,
  method: recipe.method,
  package: recipe.package,
  platform: recipe.platform,
  target: recipe.target,
  upstream: recipe.upstream,
  version: recipe.version,
});

export const installerRecipeProvenance = (
  recipe: Omit<InstallerRecipeProvenance, "fingerprint" | "schema">,
): InstallerRecipeProvenance => {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(canonicalRecipeFields(recipe)))
    .digest("hex");
  return InstallerRecipeProvenance.make({
    schema: "canonfig.recipe-provenance/v1",
    ...recipe,
    fingerprint: Schema.decodeUnknownSync(ContentDigest)(fingerprint),
  });
};

const acceptable = (status: QualificationEvidenceStatus): boolean =>
  status === "passed" || status === "not-required";

/** Startup and protocol success alone can never produce authenticated-functional readiness. */
export const mcpQualificationReady = (
  stages: ReadonlyArray<McpQualificationStageEvidence>,
): boolean => {
  const byStage = new Map(stages.map((stage) => [stage.stage, stage.status]));
  return ([
    "installed",
    "launches",
    "protocol-compatible",
    "authenticated",
    "functional",
    "client-loaded",
    "canonfig-managed",
  ] as const).every((stage) => acceptable(byStage.get(stage) ?? "not-run"));
};

/** Known local-only prerequisites from the MCP qualification audit. */
export const unresolvedMcpIntegrations = [
  { integration: "Iris", kind: "browser-login", stage: "authenticated", disposition: "unresolved", detail: "Complete Iris browser login locally before authenticated verification." },
  { integration: "Oracle", kind: "browser-login", stage: "authenticated", disposition: "unresolved", detail: "Complete Oracle browser login locally before authenticated verification." },
  { integration: "IDA", kind: "license-entitlement", stage: "functional", disposition: "unresolved", detail: "Verify the local IDA license entitlement before functional verification." },
  { integration: "Parkour", kind: "local-runtime", stage: "functional", disposition: "unresolved", detail: "Verify the required local Parkour runtime before functional verification." },
  { integration: "Ghidra-headless", kind: "local-runtime", stage: "functional", disposition: "unresolved", detail: "Verify a local headless Ghidra runtime before functional verification." },
] as const satisfies ReadonlyArray<{
  readonly integration: string;
  readonly kind: McpLocalPrerequisiteKind;
  readonly stage: "authenticated" | "functional";
  readonly disposition: "unresolved";
  readonly detail: string;
}>;
