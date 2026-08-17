import { Schema } from "effect";

import {
  BlobId,
  ContentDigest,
  CredentialReference,
  GroupName,
  ResourceId,
  ToolId,
} from "./brand.ts";

/**
 * Profile Resource kinds and Apply Policies from the architecture contract.
 * The defaults table is the single source of truth for policy-kind defaults.
 */

export const ResourceKind = Schema.Literals([
  "file",
  "directory",
  "config",
  "skill",
  "tool",
  "credential",
  "schedule",
]);
export type ResourceKind = Schema.Schema.Type<typeof ResourceKind>;

export const ApplyPolicy = Schema.Literals([
  "replace",
  "mirror-owned",
  "merge",
  "replace-if-unmodified",
  "ensure",
  "require-local",
]);
export type ApplyPolicy = Schema.Schema.Type<typeof ApplyPolicy>;

/** The default Apply Policy for each resource kind, per the architecture contract. */
export const defaultPolicyForKind = {
  file: "replace",
  directory: "mirror-owned",
  config: "merge",
  skill: "replace-if-unmodified",
  tool: "ensure",
  credential: "require-local",
  schedule: "replace",
} satisfies Readonly<Record<ResourceKind, ApplyPolicy>>;

/** Which policies are compatible with which kinds. `ensure` and `require-local` are kind-specific. */
const compatiblePolicies = {
  file: ["replace", "mirror-owned", "merge", "replace-if-unmodified"],
  directory: ["mirror-owned", "replace"],
  config: ["merge", "replace"],
  skill: ["replace-if-unmodified", "replace"],
  tool: ["ensure"],
  credential: ["require-local"],
  schedule: ["replace"],
} satisfies Readonly<Record<ResourceKind, ReadonlyArray<ApplyPolicy>>>;

export const policyCompatibleWithKind = (kind: ResourceKind, policy: ApplyPolicy): boolean =>
  compatiblePolicies[kind].some((candidate) => candidate === policy);

/** Platform selector for installation recipes and path mapping. */
export const Platform = Schema.Literals(["linux", "macos", "windows"]);
export type Platform = Schema.Schema.Type<typeof Platform>;

/**
 * A build policy is part of the reviewed recipe contract. The default keeps
 * package lifecycle hooks disabled. A required build policy records the
 * bounds a future sandboxed builder would need; the current process executor
 * deliberately escalates this mode to Human Action Required.
 */
export const BuildCapability = Schema.Literals([
  "read-files",
  "write-files",
  "network",
  "execute",
]);
export type BuildCapability = Schema.Schema.Type<typeof BuildCapability>;

export const BuildStep = Schema.Struct({
  executable: Schema.NonEmptyString,
  arguments: Schema.Array(Schema.String),
});
export type BuildStep = Schema.Schema.Type<typeof BuildStep>;

export const BuildPolicy = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("scripts-disabled"),
  }),
  Schema.Struct({
    mode: Schema.Literal("required"),
    reviewedBy: Schema.NonEmptyString,
    reviewedAt: Schema.NonEmptyString,
    executables: Schema.Array(Schema.NonEmptyString),
    paths: Schema.Array(Schema.NonEmptyString),
    origins: Schema.Array(Schema.NonEmptyString),
    capabilities: Schema.Array(BuildCapability),
    steps: Schema.Array(BuildStep),
  }),
]);
export type BuildPolicy = Schema.Schema.Type<typeof BuildPolicy>;

/**
 * A Profile Resource: one named item of desired configuration.
 * `spec` carries kind-specific fields decoded by `resourceSpecSchema`.
 */
export const GroupFilter = Schema.Struct({
  anyOf: Schema.Array(GroupName),
});
export type GroupFilter = Schema.Schema.Type<typeof GroupFilter>;

export const DirectoryFile = Schema.Struct({
  path: Schema.NonEmptyString,
  blob: BlobId,
  executable: Schema.Boolean,
});
export type DirectoryFile = Schema.Schema.Type<typeof DirectoryFile>;

export const FileResourceSpec = Schema.Struct({
  kind: Schema.Literal("file"),
  content: Schema.String,
  digest: ContentDigest,
  executable: Schema.Boolean,
  symlinkTo: Schema.optional(Schema.NonEmptyString),
});
export type FileResourceSpec = Schema.Schema.Type<typeof FileResourceSpec>;

export const DirectoryResourceSpec = Schema.Struct({
  kind: Schema.Literal("directory"),
  files: Schema.Array(DirectoryFile),
});
export type DirectoryResourceSpec = Schema.Schema.Type<typeof DirectoryResourceSpec>;

export const ConfigFormat = Schema.Literals(["toml", "json", "yaml"]);
export type ConfigFormat = Schema.Schema.Type<typeof ConfigFormat>;

export const ConfigValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.String),
]);
export type ConfigValue = Schema.Schema.Type<typeof ConfigValue>;

export const ConfigKey = Schema.Struct({
  path: Schema.NonEmptyString,
  value: ConfigValue,
});
export type ConfigKey = Schema.Schema.Type<typeof ConfigKey>;

export const ConfigResourceSpec = Schema.Struct({
  kind: Schema.Literal("config"),
  format: ConfigFormat,
  keys: Schema.Array(ConfigKey),
});
export type ConfigResourceSpec = Schema.Schema.Type<typeof ConfigResourceSpec>;

export const SkillResourceSpec = Schema.Struct({
  kind: Schema.Literal("skill"),
  name: Schema.NonEmptyString,
  files: Schema.Array(DirectoryFile),
});
export type SkillResourceSpec = Schema.Schema.Type<typeof SkillResourceSpec>;

export const ToolRecipeRef = Schema.Struct({
  platform: Platform,
  method: Schema.NonEmptyString,
  package: Schema.NonEmptyString,
  version: Schema.optional(Schema.NonEmptyString),
  buildPolicy: Schema.optional(BuildPolicy),
});
export type ToolRecipeRef = Schema.Schema.Type<typeof ToolRecipeRef>;

export const LoginRequirement = Schema.Union([
  Schema.Struct({ required: Schema.Literal(false) }),
  Schema.Struct({
    required: Schema.Literal(true),
    howTo: Schema.NonEmptyString,
  }),
]);
export type LoginRequirement = Schema.Schema.Type<typeof LoginRequirement>;

export const ToolResourceSpec = Schema.Struct({
  kind: Schema.Literal("tool"),
  toolId: ToolId,
  recipes: Schema.Array(ToolRecipeRef),
  login: LoginRequirement,
});
export type ToolResourceSpec = Schema.Schema.Type<typeof ToolResourceSpec>;

export const CredentialResourceSpec = Schema.Struct({
  kind: Schema.Literal("credential"),
  reference: CredentialReference,
});
export type CredentialResourceSpec = Schema.Schema.Type<typeof CredentialResourceSpec>;

export const ScheduleCalendar = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("daily"),
    at: Schema.NonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("weekly"),
    days: Schema.Array(Schema.NonEmptyString),
    at: Schema.NonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("custom"),
    expression: Schema.NonEmptyString,
  }),
]);
export type ScheduleCalendar = Schema.Schema.Type<typeof ScheduleCalendar>;

export const ScheduleResourceSpec = Schema.Struct({
  kind: Schema.Literal("schedule"),
  calendar: ScheduleCalendar,
  timezone: Schema.NonEmptyString,
});
export type ScheduleResourceSpec = Schema.Schema.Type<typeof ScheduleResourceSpec>;

export const ResourceSpec = Schema.Union([
  FileResourceSpec,
  DirectoryResourceSpec,
  ConfigResourceSpec,
  SkillResourceSpec,
  ToolResourceSpec,
  CredentialResourceSpec,
  ScheduleResourceSpec,
]);
export type ResourceSpec = Schema.Schema.Type<typeof ResourceSpec>;

/** How to verify a resource reached its desired state. */
export const VerificationSpec = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("digest"),
    digest: ContentDigest,
  }),
  Schema.Struct({
    method: Schema.Literal("command"),
    command: Schema.Array(Schema.NonEmptyString),
    expectContains: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    method: Schema.Literal("executable-present"),
    executable: Schema.NonEmptyString,
  }),
  Schema.Struct({
    method: Schema.Literal("credential-present"),
    reference: CredentialReference,
  }),
  Schema.Struct({
    method: Schema.Literal("symlink"),
    target: Schema.NonEmptyString,
  }),
]);
export type VerificationSpec = Schema.Schema.Type<typeof VerificationSpec>;

export const ProfileResource = Schema.Struct({
  id: ResourceId,
  kind: ResourceKind,
  policy: ApplyPolicy,
  target: Schema.NonEmptyString,
  group: Schema.optional(GroupFilter),
  dependsOn: Schema.Array(ResourceId),
  spec: ResourceSpec,
  verify: VerificationSpec,
});
export type ProfileResource = Schema.Schema.Type<typeof ProfileResource>;

/** A discovered tool entry from the source scan, per the profile contract. */
export const InvocationEvidence = Schema.Struct({
  source: Schema.NonEmptyString,
  line: Schema.Int.check(Schema.isGreaterThan(0)),
  invocation: Schema.NonEmptyString,
  resolvedExecutable: Schema.optional(Schema.NonEmptyString),
  packageManager: Schema.optional(Schema.NonEmptyString),
});
export type InvocationEvidence = Schema.Schema.Type<typeof InvocationEvidence>;

export const RecipeMethod = Schema.Literals([
  "npm",
  "brew",
  "apt",
  "winget",
  "uv",
  "cargo",
  "source",
]);
export type RecipeMethod = Schema.Schema.Type<typeof RecipeMethod>;

export const ToolRecipe = Schema.Struct({
  platform: Platform,
  method: RecipeMethod,
  package: Schema.NonEmptyString,
  version: Schema.optional(Schema.NonEmptyString),
});
export type ToolRecipe = Schema.Schema.Type<typeof ToolRecipe>;

export const DiscoveredTool = Schema.Struct({
  id: ToolId,
  upstream: Schema.NonEmptyString,
  evidence: Schema.Array(InvocationEvidence),
  recipes: Schema.Array(ToolRecipe),
  verify: Schema.Struct({
    command: Schema.Array(Schema.NonEmptyString),
    expectContains: Schema.optional(Schema.String),
  }),
  login: LoginRequirement,
});
export type DiscoveredTool = Schema.Schema.Type<typeof DiscoveredTool>;
