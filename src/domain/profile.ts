import { Schema } from "effect";

import type {
  ContentDigest,
  CredentialReference,
  ProfileId,
  ProfileRevisionId,
  ResourceId,
} from "./brand.ts";
import {
  defaultPolicyForKind,
  ApplyPolicy as ApplyPolicySchema,
  Platform as PlatformSchema,
  ResourceKind as ResourceKindSchema,
  policyCompatibleWithKind,
  type Platform,
  type ResourceKind,
  type ApplyPolicy,
} from "./resource.ts";
import {
  BlobId,
  ContentDigest as ContentDigestSchema,
  CredentialReference as CredentialReferenceSchema,
  GroupName,
  ProfileId as ProfileIdSchema,
  ProfileRevisionId as ProfileRevisionIdSchema,
  ResourceId as ResourceIdSchema,
  SourceSignature,
  Timestamp,
  ToolId,
} from "./brand.ts";
import {
  canonicalJson,
  decodeJsonc,
  digestOf,
  type JsonValue,
} from "../profile/profile-codec.ts";

/**
 * Machine Profile authoring and published types, plus validation decisions:
 * unique ids, dependency existence, acyclic dependency graph, valid targets,
 * and policy-kind compatibility. These are pure functions over decoded data.
 */

/** Authoring-time Machine Profile (parsed from profile.jsonc). */
export interface MachineProfile {
  readonly id: ProfileId;
  readonly version: number;
  readonly name: string;
  readonly groups: ReadonlyArray<ProfileGroup>;
  readonly resources: ReadonlyArray<ProfileResourceInput>;
  readonly scheduleDefault: ScheduleDefault;
}

export interface ProfileGroup {
  readonly name: string;
  readonly description?: string | undefined;
}

export type ScheduleDefault =
  | { readonly type: "daily"; readonly at: string; readonly timezone: string }
  | { readonly type: "weekly"; readonly days: ReadonlyArray<string>; readonly at: string; readonly timezone: string }
  | { readonly type: "custom"; readonly expression: string; readonly timezone: string };

/** A resource as authored (before content addressing). */
export interface ProfileResourceInput {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly policy?: ApplyPolicy | undefined;
  readonly target: string;
  readonly groups?: ReadonlyArray<string> | undefined;
  readonly dependsOn?: ReadonlyArray<string> | undefined;
  readonly spec: ResourceSpecInput;
  readonly verify: VerificationInput;
}

export type ResourceSpecInput =
  | { readonly kind: "file"; readonly content: string; readonly executable?: boolean | undefined; readonly symlinkTo?: string | undefined }
  | { readonly kind: "directory"; readonly files: ReadonlyArray<{ readonly path: string; readonly content: string; readonly executable?: boolean | undefined }> }
  | { readonly kind: "config"; readonly format: "toml" | "json" | "yaml"; readonly keys: ReadonlyArray<{ readonly path: string; readonly value: string | number | boolean | ReadonlyArray<string> }> }
  | { readonly kind: "skill"; readonly name: string; readonly files: ReadonlyArray<{ readonly path: string; readonly content: string; readonly executable?: boolean | undefined }> }
  | { readonly kind: "tool"; readonly toolId: string; readonly recipes: ReadonlyArray<{ readonly platform: Platform; readonly method: string; readonly package: string; readonly version?: string | undefined }>; readonly login?: { readonly required: boolean; readonly howTo?: string | undefined } | undefined }
  | { readonly kind: "credential"; readonly reference: string }
  | { readonly kind: "schedule"; readonly calendar: { readonly type: "daily"; readonly at: string } | { readonly type: "weekly"; readonly days: ReadonlyArray<string>; readonly at: string } | { readonly type: "custom"; readonly expression: string }; readonly timezone: string };

export type VerificationInput =
  | { readonly method: "digest"; readonly digest: string }
  | { readonly method: "command"; readonly command: ReadonlyArray<string>; readonly expectContains?: string | undefined }
  | { readonly method: "executable-present"; readonly executable: string }
  | { readonly method: "credential-present"; readonly reference: string }
  | { readonly method: "symlink"; readonly target: string };

/** An immutable, authenticated publication of a Machine Profile. */
export interface ProfileRevision {
  readonly id: ProfileRevisionId;
  readonly profileId: ProfileId;
  readonly sequence: number;
  readonly canonicalBytes: string;
  readonly digest: string;
  readonly signature: string;
  readonly publishedAt: string;
  readonly resources: ReadonlyArray<PublishedResource>;
  readonly groups: ReadonlyArray<ProfileGroup>;
}

export interface PublishedResource {
  readonly id: ResourceId;
  readonly kind: ResourceKind;
  readonly policy: ApplyPolicy;
  readonly target: string;
  readonly groups?: ReadonlyArray<string> | undefined;
  readonly dependsOn: ReadonlyArray<ResourceId>;
  readonly blobs: ReadonlyArray<string>;
}

/** A candidate Machine Profile change from discovery or an agent. */
export interface ProfileChangeProposal {
  readonly createdAt: string;
  readonly reason: string;
  readonly additions: ReadonlyArray<ProfileResourceInput>;
  readonly modifications: ReadonlyArray<ProfileResourceInput>;
  readonly removals: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<DiscoveryEvidenceRecord>;
}

export interface DiscoveryEvidenceRecord {
  readonly source: string;
  readonly line: number;
  readonly excerpt: string;
  readonly kind: "invocation" | "config" | "hook" | "mcp" | "package-metadata" | "prose";
}

export interface CredentialDescriptor {
  readonly reference: CredentialReference;
  readonly description: string;
  readonly loginRequired: boolean;
}

const ConfigValueInputSchema = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.String),
]);

const AuthoringFileSchema = Schema.Struct({
  kind: Schema.Literal("file"),
  content: Schema.String,
  executable: Schema.optional(Schema.Boolean),
  symlinkTo: Schema.optional(Schema.NonEmptyString),
});

const AuthoringDirectoryFileSchema = Schema.Struct({
  path: Schema.NonEmptyString,
  content: Schema.String,
  executable: Schema.optional(Schema.Boolean),
});

const AuthoringLoginSchema = Schema.Union([
  Schema.Struct({ required: Schema.Literal(false) }),
  Schema.Struct({
    required: Schema.Literal(true),
    howTo: Schema.NonEmptyString,
  }),
]);

export const ResourceSpecInputSchema = Schema.Union([
  AuthoringFileSchema,
  Schema.Struct({
    kind: Schema.Literal("directory"),
    files: Schema.Array(AuthoringDirectoryFileSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("config"),
    format: Schema.Literals(["toml", "json", "yaml"]),
    keys: Schema.Array(Schema.Struct({
      path: Schema.NonEmptyString,
      value: ConfigValueInputSchema,
    })),
  }),
  Schema.Struct({
    kind: Schema.Literal("skill"),
    name: Schema.NonEmptyString,
    files: Schema.Array(AuthoringDirectoryFileSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("tool"),
    toolId: ToolId,
    recipes: Schema.Array(Schema.Struct({
      platform: PlatformSchema,
      method: Schema.NonEmptyString,
      package: Schema.NonEmptyString,
      version: Schema.optional(Schema.NonEmptyString),
    })),
    login: Schema.optional(AuthoringLoginSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("credential"),
    reference: CredentialReferenceSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("schedule"),
    calendar: Schema.Union([
      Schema.Struct({ type: Schema.Literal("daily"), at: Schema.NonEmptyString }),
      Schema.Struct({
        type: Schema.Literal("weekly"),
        days: Schema.Array(Schema.NonEmptyString),
        at: Schema.NonEmptyString,
      }),
      Schema.Struct({
        type: Schema.Literal("custom"),
        expression: Schema.NonEmptyString,
      }),
    ]),
    timezone: Schema.NonEmptyString,
  }),
]);

export const VerificationInputSchema = Schema.Union([
  Schema.Struct({ method: Schema.Literal("digest"), digest: ContentDigestSchema }),
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
    reference: CredentialReferenceSchema,
  }),
  Schema.Struct({ method: Schema.Literal("symlink"), target: Schema.NonEmptyString }),
]);

export const ProfileResourceInputSchema = Schema.Struct({
  id: ResourceIdSchema,
  kind: ResourceKindSchema,
  policy: Schema.optional(ApplyPolicySchema),
  target: Schema.NonEmptyString,
  groups: Schema.optional(Schema.Array(GroupName)),
  dependsOn: Schema.optional(Schema.Array(ResourceIdSchema)),
  spec: ResourceSpecInputSchema,
  verify: VerificationInputSchema,
});

export const ProfileGroupSchema = Schema.Struct({
  name: GroupName,
  description: Schema.optional(Schema.NonEmptyString),
});

export const ScheduleDefaultSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("daily"),
    at: Schema.NonEmptyString,
    timezone: Schema.NonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("weekly"),
    days: Schema.Array(Schema.NonEmptyString),
    at: Schema.NonEmptyString,
    timezone: Schema.NonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("custom"),
    expression: Schema.NonEmptyString,
    timezone: Schema.NonEmptyString,
  }),
]);

/** Strict schema for the normalized v2 authoring contract. */
export const MachineProfileSchema = Schema.Struct({
  id: ProfileIdSchema,
  version: Schema.Literal(2),
  name: Schema.NonEmptyString,
  groups: Schema.Array(ProfileGroupSchema),
  resources: Schema.Array(ProfileResourceInputSchema),
  scheduleDefault: ScheduleDefaultSchema,
});

/** Authoring schema permits only documented fields and fills omissions in normalization. */
export const MachineProfileAuthoringSchema = Schema.Struct({
  id: ProfileIdSchema,
  version: Schema.optional(Schema.Literal(2)),
  name: Schema.NonEmptyString,
  groups: Schema.optional(Schema.Array(ProfileGroupSchema)),
  resources: Schema.optional(Schema.Array(ProfileResourceInputSchema)),
  scheduleDefault: Schema.optional(ScheduleDefaultSchema),
});

export const PublishedResourceSchema = Schema.Struct({
  id: ResourceIdSchema,
  kind: ResourceKindSchema,
  policy: ApplyPolicySchema,
  target: Schema.NonEmptyString,
  groups: Schema.optional(Schema.Array(GroupName)),
  dependsOn: Schema.Array(ResourceIdSchema),
  blobs: Schema.Array(BlobId),
});

export const ProfileRevisionSchema = Schema.Struct({
  id: ProfileRevisionIdSchema,
  profileId: ProfileIdSchema,
  sequence: Schema.Natural,
  canonicalBytes: Schema.String,
  digest: ContentDigestSchema,
  signature: SourceSignature,
  publishedAt: Timestamp,
  resources: Schema.Array(PublishedResourceSchema),
  groups: Schema.Array(ProfileGroupSchema),
});

export const DiscoveryEvidenceRecordSchema = Schema.Struct({
  source: Schema.NonEmptyString,
  line: Schema.Int.check(Schema.isGreaterThan(0)),
  excerpt: Schema.String,
  kind: Schema.Literals([
    "invocation",
    "config",
    "hook",
    "mcp",
    "package-metadata",
    "prose",
  ]),
});

export const ProfileChangeProposalSchema = Schema.Struct({
  createdAt: Timestamp,
  reason: Schema.NonEmptyString,
  additions: Schema.Array(ProfileResourceInputSchema),
  modifications: Schema.Array(ProfileResourceInputSchema),
  removals: Schema.Array(ResourceIdSchema),
  evidence: Schema.Array(DiscoveryEvidenceRecordSchema),
});

export const CredentialDescriptorSchema = Schema.Struct({
  reference: CredentialReferenceSchema,
  description: Schema.NonEmptyString,
  loginRequired: Schema.Boolean,
});

/** Runtime schema aliases share names with their corresponding domain types. */
export const ResourceSpecInput = ResourceSpecInputSchema;
export const VerificationInput = VerificationInputSchema;
export const ProfileResourceInput = ProfileResourceInputSchema;
export const ProfileGroup = ProfileGroupSchema;
export const ScheduleDefault = ScheduleDefaultSchema;
export const MachineProfile = MachineProfileSchema;
export const PublishedResource = PublishedResourceSchema;
export const ProfileRevision = ProfileRevisionSchema;
export const DiscoveryEvidenceRecord = DiscoveryEvidenceRecordSchema;
export const ProfileChangeProposal = ProfileChangeProposalSchema;
export const CredentialDescriptor = CredentialDescriptorSchema;

/**
 * Validation failures as tagged errors.
 */
export class DuplicateResourceError extends Schema.TaggedError<DuplicateResourceError>()(
  "DuplicateResourceError",
  { id: Schema.String },
) {}

export class MissingDependencyError extends Schema.TaggedError<MissingDependencyError>()(
  "MissingDependencyError",
  { id: Schema.String, dependsOn: Schema.String },
) {}

export class DependencyCycleError extends Schema.TaggedError<DependencyCycleError>()(
  "DependencyCycleError",
  { cycle: Schema.Array(Schema.String) },
) {}

export class PolicyKindMismatchError extends Schema.TaggedError<PolicyKindMismatchError>()(
  "PolicyKindMismatchError",
  { id: Schema.String, kind: Schema.String, policy: Schema.String },
) {}

export class InvalidTargetError extends Schema.TaggedError<InvalidTargetError>()(
  "InvalidTargetError",
  { id: Schema.String, target: Schema.String, reason: Schema.String },
) {}

export class InvalidScheduleError extends Schema.TaggedError<InvalidScheduleError>()(
  "InvalidScheduleError",
  { id: Schema.String, reason: Schema.String },
) {}

export class DuplicateGroupError extends Schema.TaggedError<DuplicateGroupError>()(
  "DuplicateGroupError",
  { name: Schema.String },
) {}

export class MissingGroupReferenceError extends Schema.TaggedError<MissingGroupReferenceError>()(
  "MissingGroupReferenceError",
  { id: Schema.String, group: Schema.String },
) {}

export class ResourceSpecKindMismatchError extends Schema.TaggedError<ResourceSpecKindMismatchError>()(
  "ResourceSpecKindMismatchError",
  { id: Schema.String, kind: Schema.String, specKind: Schema.String },
) {}

export class VerificationKindMismatchError extends Schema.TaggedError<VerificationKindMismatchError>()(
  "VerificationKindMismatchError",
  { id: Schema.String, kind: Schema.String, method: Schema.String },
) {}

export type ProfileValidationError =
  | DuplicateResourceError
  | MissingDependencyError
  | DependencyCycleError
  | PolicyKindMismatchError
  | InvalidTargetError
  | InvalidScheduleError
  | DuplicateGroupError
  | MissingGroupReferenceError
  | ResourceSpecKindMismatchError
  | VerificationKindMismatchError;

/** Aggregate contract failure preserving all precise tagged graph errors. */
export class ProfileContractError extends Error {
  readonly errors: ReadonlyArray<ProfileValidationError>;

  constructor(errors: ReadonlyArray<ProfileValidationError>) {
    super(errors.map((error) => error._tag).join(", "));
    this.name = "ProfileContractError";
    this.errors = errors;
  }
}

export const validateMachineProfile = (
  profile: MachineProfile,
): ReadonlyArray<ProfileValidationError> => {
  const errors: Array<ProfileValidationError> = [];
  const groups = new Set<string>();
  for (const group of profile.groups) {
    if (groups.has(group.name)) {
      errors.push(new DuplicateGroupError({ name: group.name }));
    }
    groups.add(group.name);
  }
  errors.push(...validateProfileResources(profile.resources, groups));
  const scheduleError = validateScheduleDefault(profile.scheduleDefault);
  if (scheduleError !== null) errors.push(scheduleError);
  return errors;
};

/** Validate resource graph: returns every violation, not just the first. */
export const validateProfileResources = (
  resources: ReadonlyArray<ProfileResourceInput>,
  declaredGroups?: ReadonlySet<string>,
): ReadonlyArray<ProfileValidationError> => {
  const errors: Array<ProfileValidationError> = [];
  const seen = new Set<string>();
  for (const resource of resources) {
    if (seen.has(resource.id)) {
      errors.push(new DuplicateResourceError({ id: resource.id }));
    }
    seen.add(resource.id);
  }
  const byId = new Map(resources.map((resource) => [resource.id, resource] as const));
  for (const resource of resources) {
    if (resource.spec.kind !== resource.kind) {
      errors.push(new ResourceSpecKindMismatchError({
        id: resource.id,
        kind: resource.kind,
        specKind: resource.spec.kind,
      }));
    }
    for (const dep of resource.dependsOn ?? []) {
      if (!byId.has(dep)) {
        errors.push(new MissingDependencyError({ id: resource.id, dependsOn: dep }));
      }
    }
    if (declaredGroups !== undefined) {
      for (const group of resource.groups ?? []) {
        if (!declaredGroups.has(group)) {
          errors.push(new MissingGroupReferenceError({ id: resource.id, group }));
        }
      }
    }
    const kind = resource.kind;
    const policy = resource.policy ?? defaultPolicy(kind);
    if (!policyAllowed(kind, policy)) {
      errors.push(new PolicyKindMismatchError({ id: resource.id, kind, policy }));
    }
    const targetError = validateTarget(resource);
    if (targetError !== null) errors.push(targetError);
    if (resource.spec.kind === "schedule") {
      const scheduleError = validateSchedule(resource);
      if (scheduleError !== null) errors.push(scheduleError);
    }
    if (!verificationAllowed(resource.kind, resource.verify.method)) {
      errors.push(new VerificationKindMismatchError({
        id: resource.id,
        kind: resource.kind,
        method: resource.verify.method,
      }));
    }
  }
  const cycle = findDependencyCycle(resources);
  if (cycle !== null) errors.push(new DependencyCycleError({ cycle }));
  return errors;
};

const defaultPolicy = (kind: ResourceKind): ApplyPolicy => {
  return defaultPolicyForKind[kind];
};

const policyAllowed = (kind: ResourceKind, policy: ApplyPolicy): boolean => {
  return policyCompatibleWithKind(kind, policy);
};

const verificationAllowed = (
  kind: ResourceKind,
  method: VerificationInput["method"],
): boolean => {
  switch (kind) {
    case "file":
      return method === "digest" || method === "symlink" || method === "command";
    case "directory":
    case "config":
    case "skill":
      return method === "digest" || method === "command";
    case "tool":
      return method === "executable-present" || method === "command";
    case "credential":
      return method === "credential-present" || method === "command";
    case "schedule":
      return method === "command";
  }
};

const validateTarget = (resource: ProfileResourceInput): InvalidTargetError | null => {
  const target = resource.target;
  if (target.trim().length === 0) {
    return new InvalidTargetError({ id: resource.id, target, reason: "empty target" });
  }
  if (target.includes("\0")) {
    return new InvalidTargetError({ id: resource.id, target, reason: "null byte in target" });
  }
  const pathSegments = target.replaceAll("\\", "/").split("/");
  if (pathSegments.some((segment) => segment === "..")) {
    return new InvalidTargetError({ id: resource.id, target, reason: "parent traversal in target" });
  }
  if (/[*?[\]]/u.test(target)) {
    return new InvalidTargetError({ id: resource.id, target, reason: "glob in target" });
  }
  return null;
};

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/u;
const dayNames = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

const validateScheduleDefault = (
  schedule: ScheduleDefault,
): InvalidScheduleError | null => {
  if (schedule.type === "daily" && !timePattern.test(schedule.at)) {
    return new InvalidScheduleError({
      id: "$scheduleDefault",
      reason: `invalid daily time ${schedule.at}`,
    });
  }
  if (schedule.type === "weekly") {
    if (!timePattern.test(schedule.at)) {
      return new InvalidScheduleError({
        id: "$scheduleDefault",
        reason: `invalid weekly time ${schedule.at}`,
      });
    }
    if (schedule.days.length === 0) {
      return new InvalidScheduleError({
        id: "$scheduleDefault",
        reason: "weekly schedule needs at least one day",
      });
    }
    for (const day of schedule.days) {
      if (!dayNames.has(day)) {
        return new InvalidScheduleError({
          id: "$scheduleDefault",
          reason: `unknown day ${day}`,
        });
      }
    }
  }
  return null;
};

const validateSchedule = (resource: ProfileResourceInput): InvalidScheduleError | null => {
  const spec = resource.spec;
  if (spec.kind !== "schedule") return null;
  const calendar = spec.calendar;
  if (calendar.type === "daily" && !timePattern.test(calendar.at)) {
    return new InvalidScheduleError({ id: resource.id, reason: `invalid daily time ${calendar.at}` });
  }
  if (calendar.type === "weekly") {
    if (!timePattern.test(calendar.at)) {
      return new InvalidScheduleError({ id: resource.id, reason: `invalid weekly time ${calendar.at}` });
    }
    if (calendar.days.length === 0) {
      return new InvalidScheduleError({ id: resource.id, reason: "weekly schedule needs at least one day" });
    }
    for (const day of calendar.days) {
      if (!dayNames.has(day)) {
        return new InvalidScheduleError({ id: resource.id, reason: `unknown day ${day}` });
      }
    }
  }
  if (calendar.type === "custom" && calendar.expression.trim().length === 0) {
    return new InvalidScheduleError({ id: resource.id, reason: "empty custom expression" });
  }
  return null;
};

/** Detect a dependency cycle; returns one cycle path or null. */
export const findDependencyCycle = (
  resources: ReadonlyArray<ProfileResourceInput>,
): ReadonlyArray<string> | null => {
  const graph = new Map<string, ReadonlyArray<string>>();
  for (const resource of resources) {
    graph.set(resource.id, resource.dependsOn ?? []);
  }
  const visiting: Array<string> = [];
  const visited = new Set<string>();
  const dfs = (node: string): ReadonlyArray<string> | null => {
    if (visited.has(node)) return null;
    const index = visiting.indexOf(node);
    if (index >= 0) return [...visiting.slice(index), node];
    visiting.push(node);
    const deps = graph.get(node) ?? [];
    for (const dep of deps) {
      if (!graph.has(dep)) continue;
      const found = dfs(dep);
      if (found !== null) return found;
    }
    visiting.pop();
    visited.add(node);
    return null;
  };
  for (const resource of resources) {
    const found = dfs(resource.id);
    if (found !== null) return found;
  }
  return null;
};

/** Topological order of resource ids; deterministic (stable input order, deps first). */
export const topologicalOrder = (
  resources: ReadonlyArray<ProfileResourceInput>,
): ReadonlyArray<string> => {
  const byId = new Map(resources.map((r) => [r.id, r] as const));
  const ordered: Array<string> = [];
  const emitted = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (emitted.has(id) || visiting.has(id)) return;
    visiting.add(id);
    const resource = byId.get(id);
    if (resource !== undefined) {
      for (const dep of resource.dependsOn ?? []) visit(dep);
    }
    visiting.delete(id);
    emitted.add(id);
    ordered.push(id);
  };
  for (const resource of resources) visit(resource.id);
  return ordered;
};

type MachineProfileAuthoring = Schema.Schema.Type<typeof MachineProfileAuthoringSchema>;

const compareText = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const uniqueSorted = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values)].sort(compareText);

const normalizeResourceSpec = (spec: ResourceSpecInput): ResourceSpecInput => {
  switch (spec.kind) {
    case "file": {
      const base = {
        kind: spec.kind,
        content: spec.content,
        executable: spec.executable ?? false,
      } as const;
      if (spec.symlinkTo === undefined) return base;
      return { ...base, symlinkTo: spec.symlinkTo };
    }
    case "directory":
      return {
        kind: spec.kind,
        files: spec.files
          .map((file) => ({
            path: file.path,
            content: file.content,
            executable: file.executable ?? false,
          }))
          .sort((left, right) => compareText(left.path, right.path)),
      };
    case "config":
      return {
        kind: spec.kind,
        format: spec.format,
        keys: [...spec.keys].sort((left, right) => compareText(left.path, right.path)),
      };
    case "skill":
      return {
        kind: spec.kind,
        name: spec.name,
        files: spec.files
          .map((file) => ({
            path: file.path,
            content: file.content,
            executable: file.executable ?? false,
          }))
          .sort((left, right) => compareText(left.path, right.path)),
      };
    case "tool":
      return {
        kind: spec.kind,
        toolId: spec.toolId,
        recipes: [...spec.recipes].sort((left, right) =>
          compareText(
            `${left.platform}\0${left.method}\0${left.package}\0${left.version ?? ""}`,
            `${right.platform}\0${right.method}\0${right.package}\0${right.version ?? ""}`,
          )
        ),
        login: spec.login ?? { required: false },
      };
    case "credential":
      return { kind: spec.kind, reference: spec.reference };
    case "schedule": {
      if (spec.calendar.type !== "weekly") {
        return {
          kind: spec.kind,
          calendar: spec.calendar,
          timezone: spec.timezone,
        };
      }
      const dayOrder = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
      const days = [...new Set(spec.calendar.days)].sort(
        (left, right) => dayOrder.indexOf(left) - dayOrder.indexOf(right),
      );
      return {
        kind: spec.kind,
        calendar: { ...spec.calendar, days },
        timezone: spec.timezone,
      };
    }
  }
};

const normalizeResource = (resource: ProfileResourceInput): ProfileResourceInput => {
  const base = {
    id: resource.id,
    kind: resource.kind,
    policy: resource.policy ?? defaultPolicy(resource.kind),
    target: resource.target,
    dependsOn: uniqueSorted(resource.dependsOn ?? []),
    spec: normalizeResourceSpec(resource.spec),
    verify: resource.verify,
  } as const;
  if (resource.groups === undefined) return base;
  return { ...base, groups: uniqueSorted(resource.groups) };
};

/** Apply all v2 defaults and order unordered collections deterministically. */
export const normalizeMachineProfile = (
  profile: MachineProfileAuthoring | MachineProfile,
): MachineProfile => {
  const groups = (profile.groups ?? [])
    .map((group) => group.description === undefined
      ? { name: group.name }
      : { name: group.name, description: group.description })
    .sort((left, right) => compareText(left.name, right.name));
  const resources = (profile.resources ?? [])
    .map(normalizeResource)
    .sort((left, right) => compareText(left.id, right.id));
  const scheduleDefault = profile.scheduleDefault ?? {
    type: "daily",
    at: "00:00",
    timezone: "local",
  };
  const normalizedSchedule = scheduleDefault.type === "weekly"
    ? { ...scheduleDefault, days: uniqueSorted(scheduleDefault.days) }
    : scheduleDefault;
  return {
    id: profile.id,
    version: 2,
    name: profile.name,
    groups,
    resources,
    scheduleDefault: normalizedSchedule,
  };
};

/** Decode strict JSONC authoring input, normalize it, then reject invalid graphs. */
export const decodeMachineProfileJsonc = (text: string): MachineProfile => {
  const authored = decodeJsonc(MachineProfileAuthoringSchema)(text);
  const normalized = normalizeMachineProfile(authored);
  Schema.decodeUnknownSync(MachineProfileSchema, { onExcessProperty: "error" })(normalized);
  const errors = validateMachineProfile(normalized);
  if (errors.length > 0) throw new ProfileContractError(errors);
  return normalized;
};

/** Backwards-friendly concise name for the JSONC authoring boundary. */
export const decodeMachineProfile = decodeMachineProfileJsonc;

const profileJsonValue = (profile: MachineProfile): JsonValue =>
  Schema.decodeUnknownSync(Schema.MutableJson)(profile);

/** Canonical publication encoding of a validated, normalized profile. */
export const encodeMachineProfile = (profile: MachineProfile): string => {
  const normalized = normalizeMachineProfile(profile);
  Schema.decodeUnknownSync(MachineProfileSchema, { onExcessProperty: "error" })(normalized);
  const errors = validateMachineProfile(normalized);
  if (errors.length > 0) throw new ProfileContractError(errors);
  return canonicalJson(profileJsonValue(normalized));
};

/** Stable SHA-256 digest of the canonical publication encoding. */
export const digestMachineProfile = (profile: MachineProfile): ContentDigest => {
  const normalized = normalizeMachineProfile(profile);
  Schema.decodeUnknownSync(MachineProfileSchema, { onExcessProperty: "error" })(normalized);
  const errors = validateMachineProfile(normalized);
  if (errors.length > 0) throw new ProfileContractError(errors);
  return digestOf(profileJsonValue(normalized));
};
