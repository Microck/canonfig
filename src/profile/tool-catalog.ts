import { Schema } from "effect";

import { AgentTaskId } from "../domain/brand.ts";
import { parseNpmPackageSpecification } from "../domain/npm-package-spec.ts";
import {
  isSafeSourceRevision,
  recipeValidationError,
} from "../domain/recipe-versions.ts";
import type { BuildPolicy } from "../domain/resource.ts";
import type { AgentTask } from "../domain/synchronization.ts";

export type DiscoverySourceKind =
  | "agents"
  | "tool-config"
  | "hook"
  | "mcp"
  | "executable-reference"
  | "package-metadata"
  | "prose";

export type EvidenceLocation =
  | { readonly kind: "line"; readonly line: number; readonly column?: number | undefined }
  | { readonly kind: "field"; readonly field: string; readonly line?: number | undefined };

export type EvidenceConfidence = "deterministic" | "strong" | "review";
export type EvidenceReviewStatus = "accepted" | "needs-review";

export type PackageEcosystem = "npm" | "homebrew" | "winget" | "uv" | "cargo" | "source";

export interface DiscoveredPackageMetadata {
  readonly ecosystem: PackageEcosystem;
  readonly name: string;
  readonly version?: string | undefined;
  readonly source: string;
  readonly integrity?: string | undefined;
  readonly upstream?: string | undefined;
  readonly buildCommands?: ReadonlyArray<ReadonlyArray<string>> | undefined;
  /**
   * Required build hooks are never inferred from buildCommands. They must be
   * explicitly reviewed with executable, path, origin, capability, and step
   * bounds before publication.
   */
  readonly buildPolicy?: BuildPolicy | undefined;
}

export interface ToolDiscoveryEvidence {
  readonly sourcePath: string;
  readonly location: EvidenceLocation;
  readonly kind: DiscoverySourceKind;
  readonly invocation: ReadonlyArray<string>;
  readonly resolvedExecutable?: string | undefined;
  readonly package?: DiscoveredPackageMetadata | undefined;
  readonly upstream?: string | undefined;
  readonly confidence: EvidenceConfidence;
  readonly reviewStatus: EvidenceReviewStatus;
}

interface VersionedRecipe {
  readonly version: string;
  readonly source: string;
  readonly integrity?: string | undefined;
  readonly buildPolicy: BuildPolicy;
}

export type InstallationRecipe =
  | (VersionedRecipe & {
    readonly method: "npm";
    readonly package: string;
    readonly command: ReadonlyArray<string>;
  })
  | (VersionedRecipe & {
    readonly method: "homebrew";
    readonly formula: string;
    readonly command: ReadonlyArray<string>;
  })
  | (VersionedRecipe & {
    readonly method: "winget";
    readonly id: string;
    readonly command: ReadonlyArray<string>;
  })
  | (VersionedRecipe & {
    readonly method: "uv";
    readonly package: string;
    readonly command: ReadonlyArray<string>;
  })
  | (VersionedRecipe & {
    readonly method: "cargo";
    readonly crate: string;
    readonly command: ReadonlyArray<string>;
  })
  | (VersionedRecipe & {
    readonly method: "source";
    readonly repository: string;
    readonly revision: string;
    readonly buildCommands: ReadonlyArray<ReadonlyArray<string>>;
  });

export interface DiscoveredTool {
  readonly kind: "tool";
  readonly id: string;
  readonly executable: string;
  readonly upstream?: string | undefined;
  readonly evidence: ReadonlyArray<ToolDiscoveryEvidence>;
  readonly recipes: ReadonlyArray<InstallationRecipe>;
  readonly reviewStatus: EvidenceReviewStatus;
  readonly verify: { readonly command: ReadonlyArray<string> };
}

export interface DiscoveredSkill {
  readonly kind: "skill";
  readonly id: string;
  readonly sourcePath: string;
  /**
   * Portable follower target and source-owned files are optional because
   * discovery can identify a skill from a reference before its contents are
   * supplied for review.
   */
  readonly target?: string | undefined;
  readonly files?: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
    readonly executable?: boolean | undefined;
  }> | undefined;
  readonly evidence: ReadonlyArray<ToolDiscoveryEvidence>;
  readonly reviewStatus: EvidenceReviewStatus;
}

export type DiscoveredCatalogResource = DiscoveredTool | DiscoveredSkill;

export type DiscoveryTaskReason =
  | "ambiguous-recipe"
  | "missing-version"
  | "missing-upstream"
  | "unresolved-executable";

export interface DiscoveryAgentTask extends AgentTask {
  readonly reason: DiscoveryTaskReason;
  readonly toolId: string;
  readonly allowedCapabilities: ReadonlyArray<
    "read-files" | "resolve-executable" | "lookup-package-metadata"
  >;
  readonly lookupBounds: {
    readonly paths: ReadonlyArray<string>;
    readonly executables: ReadonlyArray<string>;
    readonly origins: ReadonlyArray<string>;
  };
}

export interface DiscoveryTaskBounds {
  readonly allowedCapabilities: ReadonlyArray<
    "read-files" | "resolve-executable" | "lookup-package-metadata"
  >;
  readonly paths: ReadonlyArray<string>;
  readonly executables: ReadonlyArray<string>;
  readonly origins: ReadonlyArray<string>;
  readonly timeLimitSeconds: number;
  readonly outputLimitBytes: number;
}

export interface ToolCatalog {
  readonly resources: ReadonlyArray<DiscoveredCatalogResource>;
  readonly tools: ReadonlyArray<DiscoveredTool>;
  readonly skills: ReadonlyArray<DiscoveredSkill>;
  readonly evidence: ReadonlyArray<ToolDiscoveryEvidence>;
  readonly agentTasks: ReadonlyArray<DiscoveryAgentTask>;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const locationKey = (location: EvidenceLocation): string => {
  switch (location.kind) {
    case "line":
      return `line:${String(location.line).padStart(10, "0")}:${String(location.column ?? 0).padStart(10, "0")}`;
    case "field":
      return `field:${location.field}:${String(location.line ?? 0).padStart(10, "0")}`;
  }
};

const packageKey = (metadata: DiscoveredPackageMetadata | undefined): string =>
  metadata === undefined
    ? ""
    : [
      metadata.ecosystem,
      metadata.name,
      metadata.version ?? "",
      metadata.source,
      metadata.integrity ?? "",
      metadata.upstream ?? "",
      (metadata.buildCommands ?? []).map((command) => command.join("\0")).join("\u0001"),
      metadata.buildPolicy === undefined ? "" : JSON.stringify(metadata.buildPolicy),
    ].join("\0");

const evidenceKey = (evidence: ToolDiscoveryEvidence): string =>
  [
    evidence.sourcePath,
    locationKey(evidence.location),
    evidence.kind,
    evidence.invocation.join("\0"),
    evidence.resolvedExecutable ?? "",
    packageKey(evidence.package),
    evidence.upstream ?? "",
    evidence.confidence,
    evidence.reviewStatus,
  ].join("\u0002");

export const orderAndDeduplicateEvidence = (
  evidence: ReadonlyArray<ToolDiscoveryEvidence>,
): ReadonlyArray<ToolDiscoveryEvidence> => {
  const byKey = new Map<string, ToolDiscoveryEvidence>();
  for (const record of evidence) byKey.set(evidenceKey(record), record);
  return [...byKey.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, record]) => record);
};

const packageUpstream = (metadata: DiscoveredPackageMetadata): string | undefined => {
  if (metadata.upstream !== undefined) return metadata.upstream;
  switch (metadata.ecosystem) {
    case "npm":
      return `https://www.npmjs.com/package/${metadata.name}`;
    case "homebrew":
      return `https://formulae.brew.sh/formula/${metadata.name}`;
    case "winget":
      return `https://winget.run/pkg/${metadata.name.replaceAll(".", "/")}`;
    case "uv":
      return `https://pypi.org/project/${metadata.name}/`;
    case "cargo":
      return `https://crates.io/crates/${metadata.name}`;
    case "source":
      return metadata.source.startsWith("https://") ? metadata.source : undefined;
  }
};

const isUnboundedPackageSpecification = (value: string): boolean =>
  value === "--"
  || /^\s*-{1,2}\S*/u.test(value)
  || /\s/u.test(value)
  || /^(?:git\+|git:\/\/|github:|gitlab:|bitbucket:|git@|file:|link:|workspace:|https?:\/\/)/iu
    .test(value)
  || /(?:^|@)(?:npm:|git\+|git:\/\/|github:|gitlab:|bitbucket:|git@|file:|link:|workspace:|https?:\/\/)/iu
    .test(value);

const isUnboundedSourceReference = (value: string): boolean =>
  value === "--"
  || /^\s*-{1,2}\S*/u.test(value)
  || /^(?:git\+|git:\/\/|github:|gitlab:|bitbucket:|git@|file:|link:|workspace:|https?:\/\/.+\.git(?:#.*)?$)/iu
    .test(value)
  || /(?:^|@)(?:npm:|git\+|git:\/\/|github:|gitlab:|bitbucket:|git@|file:|link:|workspace:|https?:\/\/.+\.git(?:#.*)?$)/iu
    .test(value);

const isUnboundedNpmSpecification = (value: string): boolean =>
  isUnboundedPackageSpecification(value)
  || parseNpmPackageSpecification(value).kind !== "registry";

const recipeFromPackage = (
  metadata: DiscoveredPackageMetadata,
): InstallationRecipe | undefined => {
  const version = metadata.version;
  if (version === undefined || version.trim().length === 0) return undefined;
  if (
    metadata.ecosystem !== "source"
    && (
      isUnboundedSourceReference(metadata.source)
      || (metadata.ecosystem === "npm" && isUnboundedNpmSpecification(metadata.name))
    )
  ) {
    return undefined;
  }
  if (metadata.ecosystem === "source" && !isSafeSourceRevision(version)) {
    return undefined;
  }
  const recipeMethod = metadata.ecosystem === "homebrew"
    ? "homebrew"
    : metadata.ecosystem;
  if (metadata.ecosystem !== "source" && recipeValidationError({
    method: recipeMethod,
    package: metadata.name,
    version,
    source: metadata.source,
    integrity: metadata.integrity,
  }) !== undefined) {
    return undefined;
  }
  const buildPolicy: BuildPolicy = metadata.buildPolicy ?? { mode: "scripts-disabled" };
  switch (metadata.ecosystem) {
    case "npm": {
      const specification = `${metadata.name}@${version}`;
      return {
        method: "npm",
        package: metadata.name,
        version,
        source: metadata.source,
        integrity: metadata.integrity,
        buildPolicy,
        command: buildPolicy.mode === "scripts-disabled"
          ? ["npm", "install", "--global", specification, "--ignore-scripts"]
          : ["npm", "install", "--global", specification],
      };
    }
    case "homebrew":
      return {
        method: "homebrew",
        formula: metadata.name,
        version,
        source: metadata.source,
        integrity: metadata.integrity,
        buildPolicy,
        command: ["brew", "install", `${metadata.name}@${version}`],
      };
    case "winget":
      return {
        method: "winget",
        id: metadata.name,
        version,
        source: metadata.source,
        integrity: metadata.integrity,
        buildPolicy,
        command: ["winget", "install", "--id", metadata.name, "--version", version, "--exact"],
      };
    case "uv": {
      const specification = `${metadata.name}==${version}`;
      return {
        method: "uv",
        package: metadata.name,
        version,
        source: metadata.source,
        integrity: metadata.integrity,
        buildPolicy,
        command: buildPolicy.mode === "scripts-disabled"
          ? ["uv", "tool", "install", specification, "--only-binary=:all:"]
          : ["uv", "tool", "install", specification],
      };
    }
    case "cargo":
      return {
        method: "cargo",
        crate: metadata.name,
        version,
        source: metadata.source,
        integrity: metadata.integrity,
        buildPolicy,
        command: ["cargo", "install", metadata.name, "--version", version, "--locked"],
      };
    case "source": {
      const upstream = packageUpstream(metadata);
      if (
        upstream === undefined
        || metadata.buildPolicy?.mode !== "required"
        || metadata.buildPolicy.steps.length === 0
      ) {
        return undefined;
      }
      return {
        method: "source",
        repository: upstream,
        revision: version,
        version,
        source: metadata.source,
        integrity: metadata.integrity,
        buildPolicy: metadata.buildPolicy,
        buildCommands: metadata.buildPolicy.steps.map((step) => [
          step.executable,
          ...step.arguments,
        ]),
      };
    }
  }
};

const recipeKey = (recipe: InstallationRecipe): string => {
  switch (recipe.method) {
    case "npm":
      return `${recipe.method}\0${recipe.package}\0${recipe.version}\0${recipe.source}\0${recipe.integrity ?? ""}\0${JSON.stringify(recipe.buildPolicy)}`;
    case "homebrew":
      return `${recipe.method}\0${recipe.formula}\0${recipe.version}\0${recipe.source}\0${recipe.integrity ?? ""}\0${JSON.stringify(recipe.buildPolicy)}`;
    case "winget":
      return `${recipe.method}\0${recipe.id}\0${recipe.version}\0${recipe.source}\0${recipe.integrity ?? ""}\0${JSON.stringify(recipe.buildPolicy)}`;
    case "uv":
      return `${recipe.method}\0${recipe.package}\0${recipe.version}\0${recipe.source}\0${recipe.integrity ?? ""}\0${JSON.stringify(recipe.buildPolicy)}`;
    case "cargo":
      return `${recipe.method}\0${recipe.crate}\0${recipe.version}\0${recipe.source}\0${recipe.integrity ?? ""}\0${JSON.stringify(recipe.buildPolicy)}`;
    case "source":
      return `${recipe.method}\0${recipe.repository}\0${recipe.revision}\0${JSON.stringify(recipe.buildPolicy)}\0${recipe.buildCommands.map((command) => command.join("\u0001")).join("\u0002")}`;
  }
};

const toolIdForEvidence = (evidence: ToolDiscoveryEvidence): string => {
  const packageName = evidence.package?.name;
  const raw = packageName === undefined
    ? evidence.invocation[0] ?? "unknown-tool"
    : packageName.includes("/")
      ? packageName.slice(packageName.lastIndexOf("/") + 1)
      : packageName;
  return raw
    .replace(/^@/u, "")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase() || "unknown-tool";
};

const executableForEvidence = (evidence: ToolDiscoveryEvidence): string => {
  const invocation = evidence.invocation[0];
  if (invocation !== undefined && !["npm", "npx", "brew", "winget", "uv", "uvx", "cargo", "git"].includes(invocation)) {
    return invocation;
  }
  const name = evidence.package?.name ?? invocation ?? "unknown-tool";
  return name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
};

const taskId = (toolId: string, reason: DiscoveryTaskReason): Schema.Schema.Type<typeof AgentTaskId> =>
  Schema.decodeUnknownSync(AgentTaskId)(`discovery-${toolId}-${reason}`);

const makeTask = (
  toolId: string,
  reason: DiscoveryTaskReason,
  evidence: ReadonlyArray<ToolDiscoveryEvidence>,
  upstream: string | undefined,
  bounds: DiscoveryTaskBounds | undefined,
): DiscoveryAgentTask => {
  const evidenceText = evidence.map((record) =>
    `${record.sourcePath}#${locationKey(record.location)} ${record.invocation.join(" ")}`
  );
  const executables = [...new Set(evidence.flatMap((record) => {
    const executable = record.invocation[0];
    return executable === undefined ? [] : [executable];
  }))].sort(compareText);
  const derivedPaths = [...new Set(evidence.map((record) => record.sourcePath))].sort(compareText);
  const derivedOrigins = upstream === undefined ? [] : [upstream];
  return {
    id: taskId(toolId, reason),
    reason,
    toolId,
    summary: `Resolve ${reason.replaceAll("-", " ")} for ${toolId}`,
    desiredOutcome: `Return reviewed package metadata and a verification command for ${toolId}`,
    observedEvidence: evidenceText,
    allowedCapabilities: bounds?.allowedCapabilities
      ?? ["read-files", "resolve-executable", "lookup-package-metadata"],
    lookupBounds: {
      paths: bounds?.paths ?? derivedPaths,
      executables: bounds?.executables ?? executables,
      origins: bounds?.origins ?? derivedOrigins,
    },
    allowedPaths: bounds?.paths ?? derivedPaths,
    allowedExecutables: bounds?.executables ?? executables,
    allowedOrigins: bounds?.origins ?? derivedOrigins,
    forbidden: ["elevation", "login", "restart", "reboot"],
    timeLimitSeconds: bounds?.timeLimitSeconds ?? 60,
    outputLimitBytes: bounds?.outputLimitBytes ?? 16_384,
    verification: { command: [executables[0] ?? toolId, "--version"] },
  };
};

interface ToolGroup {
  readonly id: string;
  readonly records: ReadonlyArray<ToolDiscoveryEvidence>;
}

interface CatalogedTool {
  readonly tool: DiscoveredTool;
  readonly tasks: ReadonlyArray<DiscoveryAgentTask>;
}

const catalogToolWithBounds = (
  group: ToolGroup,
  bounds?: DiscoveryTaskBounds,
): CatalogedTool => {
  const evidence = orderAndDeduplicateEvidence(group.records);
  const upstream = evidence
    .map((record) => record.upstream ?? (record.package === undefined ? undefined : packageUpstream(record.package)))
    .find((value) => value !== undefined);
  const recipeCandidates = evidence
    .filter((record) => record.kind !== "prose" && record.reviewStatus === "accepted")
    .flatMap((record) => {
      const recipe = record.package === undefined ? undefined : recipeFromPackage(record.package);
      return recipe === undefined ? [] : [recipe];
    });
  const byMethod = new Map<InstallationRecipe["method"], Map<string, InstallationRecipe>>();
  for (const recipe of recipeCandidates) {
    const recipes = byMethod.get(recipe.method) ?? new Map<string, InstallationRecipe>();
    recipes.set(recipeKey(recipe), recipe);
    byMethod.set(recipe.method, recipes);
  }
  const recipes: Array<InstallationRecipe> = [];
  let ambiguous = false;
  for (const method of ["npm", "homebrew", "winget", "uv", "cargo", "source"] as const) {
    const candidates = byMethod.get(method);
    if (candidates === undefined) continue;
    if (candidates.size === 1) recipes.push([...candidates.values()][0]!);
    else ambiguous = true;
  }
  recipes.sort((left, right) => compareText(recipeKey(left), recipeKey(right)));

  const acceptedEvidence = evidence.filter((record) => record.reviewStatus === "accepted");
  const resolved = acceptedEvidence.some((record) => record.resolvedExecutable !== undefined);
  const packageWithoutVersion = acceptedEvidence.some((record) =>
    record.package !== undefined && record.package.version === undefined
  );
  const tasks: Array<DiscoveryAgentTask> = [];
  if (ambiguous) tasks.push(makeTask(group.id, "ambiguous-recipe", evidence, upstream, bounds));
  if (recipes.length === 0 && packageWithoutVersion) {
    tasks.push(makeTask(group.id, "missing-version", evidence, upstream, bounds));
  }
  if (upstream === undefined) tasks.push(makeTask(group.id, "missing-upstream", evidence, upstream, bounds));
  if (!resolved && recipes.length === 0) {
    tasks.push(makeTask(group.id, "unresolved-executable", evidence, upstream, bounds));
  }
  const executable = executableForEvidence(evidence[0]!);
  const reviewStatus = tasks.length === 0 && evidence.some((record) => record.reviewStatus === "accepted")
    ? "accepted"
    : "needs-review";
  return {
    tool: {
      kind: "tool",
      id: group.id,
      executable,
      upstream,
      evidence,
      recipes,
      reviewStatus,
      verify: { command: [executable, "--version"] },
    },
    tasks,
  };
};

export const buildToolCatalog = (
  evidenceInput: ReadonlyArray<ToolDiscoveryEvidence>,
  skillsInput: ReadonlyArray<DiscoveredSkill> = [],
  taskBounds?: DiscoveryTaskBounds,
): ToolCatalog => {
  const evidence = orderAndDeduplicateEvidence(evidenceInput);
  const groups = new Map<string, Array<ToolDiscoveryEvidence>>();
  for (const record of evidence) {
    const id = toolIdForEvidence(record);
    const records = groups.get(id) ?? [];
    records.push(record);
    groups.set(id, records);
  }
  const cataloged = [...groups.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([id, records]) => catalogToolWithBounds({ id, records }, taskBounds));
  const tools = cataloged.map(({ tool }) => tool);
  const skillGroups = new Map<string, Array<DiscoveredSkill>>();
  for (const skill of skillsInput) {
    const records = skillGroups.get(skill.id) ?? [];
    records.push(skill);
    skillGroups.set(skill.id, records);
  }
  const skills = [...skillGroups.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([id, records]): DiscoveredSkill => {
      const ordered = records.sort((left, right) => compareText(left.sourcePath, right.sourcePath));
      const reviewStatus = ordered.every((record) => record.reviewStatus === "accepted")
        ? "accepted"
        : "needs-review";
      return {
        kind: "skill",
        id,
        sourcePath: ordered[0]!.sourcePath,
        target: ordered.find((record) => record.target !== undefined)?.target,
        files: ordered.find((record) => record.files !== undefined)?.files,
        evidence: orderAndDeduplicateEvidence(ordered.flatMap((record) => record.evidence)),
        reviewStatus,
      };
    });
  const agentTasks = cataloged
    .flatMap(({ tasks }) => tasks)
    .sort((left, right) => compareText(left.id, right.id));
  const resources: ReadonlyArray<DiscoveredCatalogResource> = [...tools, ...skills]
    .sort((left, right) => compareText(`${left.kind}\0${left.id}`, `${right.kind}\0${right.id}`));
  return { resources, tools, skills, evidence, agentTasks };
};
