import { Schema } from "effect";

import {
  AgentTaskId,
  ContentDigest as ContentDigestSchema,
  type ContentDigest,
} from "../domain/brand.ts";
import type { ActionDetail, PlannedActionKind } from "../domain/synchronization.ts";
import type { AutomaticRecipeMethod, BuildPolicy } from "../domain/resource.ts";
import { isNestedCommandLauncher } from "../agent/agent-resolution.service.ts";
import { sha256Hex } from "../profile/profile-codec.ts";
import { recipeSourceDetails } from "../domain/recipe-versions.ts";
import { InvalidObservedStateError } from "./synchronization.errors.ts";
import type {
  DesiredResource,
  PlannedAgentTask,
  ResourcePlanningContext,
  SkillDriftInput,
  SkillDriftState,
  ToolRecipe,
} from "./synchronization.types.ts";

export interface ResourceActionDraft {
  readonly kind: Exclude<PlannedActionKind, "transfer-blob">;
  readonly detail: Exclude<ActionDetail, { readonly kind: "transfer-blob" }>;
  readonly task?: Omit<PlannedAgentTask, "id"> | undefined;
}

interface InstallToolActionDetail {
  kind: "install-tool";
  toolId: string;
  method: AutomaticRecipeMethod;
  package: string;
  version?: string;
  source?: ToolRecipe["source"];
  buildPolicy?: BuildPolicy;
}

interface WriteFileActionDetail {
  readonly kind: "write-file";
  readonly target: string;
  readonly digest: ContentDigest;
  executable?: boolean;
}

interface DriftConflictActionDetail {
  readonly kind: "drift-conflict";
  readonly target: string;
  readonly desiredDigest: ContentDigest;
  readonly observedDigest: ContentDigest;
  desiredExecutable?: boolean;
  observedExecutable?: boolean;
}

const compareText = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const sortedUnique = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values)].sort(compareText);

const pendingAgentTaskId = Schema.decodeUnknownSync(AgentTaskId)("pending");

const filesDigest = (
  files: ReadonlyArray<{
    readonly path: string;
    readonly digest: string;
    readonly executable?: boolean | undefined;
  }>,
): ContentDigest => {
  const encoded = [...files]
    .sort((left, right) => compareText(left.path, right.path))
    .map((file) => `${file.path}\0${file.digest}\0${file.executable === true ? "x" : "-"}`)
    .join("\n");
  return sha256Hex(encoded);
};

export const desiredResourceDigest = (desired: DesiredResource): ContentDigest | undefined => {
  switch (desired.kind) {
    case "file":
    case "config":
    case "skill":
    case "schedule":
      return desired.digest;
    case "directory":
      return filesDigest(desired.files);
    case "tool":
    case "credential":
      return undefined;
  }
};

const observedDigest = (
  context: ResourcePlanningContext,
): ContentDigest | undefined => {
  switch (context.observed.state) {
    case "absent":
    case "unverifiable":
      return undefined;
    case "present":
      return Schema.decodeUnknownSync(ContentDigestSchema)(context.observed.digest);
    case "directory":
      return filesDigest(context.observed.files);
  }
};

export const detectSkillDrift = (input: SkillDriftInput): SkillDriftState => {
  const observed = input.observedDigest;
  const applied = input.lastAppliedDigest;
  const observedMatchesDesired = observed === input.desiredDigest
    && (
      input.desiredExecutable === undefined
      || input.observedExecutable === input.desiredExecutable
    );
  const observedMatchesApplied = observed === applied
    && (
      input.lastAppliedExecutable === undefined
      || input.observedExecutable === input.lastAppliedExecutable
    );
  const desiredMatchesApplied = input.desiredDigest === applied
    && (
      input.desiredExecutable === undefined
      || input.lastAppliedExecutable === input.desiredExecutable
    );
  if (observedMatchesDesired) {
    return desiredMatchesApplied ? "unchanged" : "converged";
  }
  if (applied === undefined) {
    return observed === undefined ? "remote-only" : "conflicting";
  }
  if (observedMatchesApplied) return "remote-only";
  if (desiredMatchesApplied) return "local-only";
  return "conflicting";
};

const noOp = (): ResourceActionDraft => ({
  kind: "no-op",
  detail: { kind: "no-op" },
});

const observedMatchesDesired = (
  desired: DesiredResource,
  observed: ResourcePlanningContext["observed"],
): boolean => {
  if (observed.state === "absent" || observed.state === "unverifiable") return false;
  switch (desired.kind) {
    case "file":
      return observed.state === "present"
        && observed.digest === desired.digest
        && observed.executable === desired.executable
        && (
          desired.symlinkTo === undefined
            ? observed.symlinkTo === undefined
            : observed.symlinkTo !== undefined
        );
    case "config":
    case "schedule":
      return observed.state === "present" && observed.digest === desired.digest;
    case "directory":
    case "skill":
      return observed.state === "directory"
        && filesDigest(observed.files) === desiredResourceDigest(desired);
    case "tool":
    case "credential":
      return observed.state === "present";
  }
};

const observedMatchesApplied = (
  context: ResourcePlanningContext,
): boolean => {
  const applied = context.applied;
  if (applied === undefined || context.observed.state === "absent") return true;
  const currentDigest = observedDigest(context);
  if (currentDigest !== applied.digest) return false;
  if (
    context.resource.kind === "file"
    && context.observed.state === "present"
    && applied.executable !== undefined
    && context.observed.executable !== applied.executable
  ) {
    return false;
  }
  if (
    context.resource.kind === "file"
    && context.observed.state === "present"
    && applied.symlinkTo === undefined
    && context.observed.symlinkTo !== undefined
  ) {
    return false;
  }
  return true;
};

const writeFile = (
  context: ResourcePlanningContext,
  digest: ContentDigest,
  executable?: boolean | undefined,
): ResourceActionDraft => {
  const detail: WriteFileActionDetail = {
    kind: "write-file",
    target: context.resource.target,
    digest,
  };
  if (executable !== undefined) detail.executable = executable;
  return { kind: "write-file", detail };
};

const replaceDirectory = (
  context: ResourcePlanningContext,
  desired: Extract<DesiredResource, { readonly kind: "directory" | "skill" }>,
): ResourceActionDraft => {
  const observedFiles = context.observed.state === "directory"
    ? context.observed.files
    : [];
  const observedByPath = new Map(
    observedFiles.map((file) => [
      file.path,
      `${file.digest}\0${file.executable === true ? "x" : "-"}`,
    ] as const),
  );
  const desiredPaths = new Set(desired.files.map((file) => file.path));
  return {
    kind: "mirror-directory",
    detail: {
      kind: "mirror-directory",
      target: context.resource.target,
      adds: desired.files
        .filter((file) =>
          observedByPath.get(file.path)
            !== `${file.digest}\0${file.executable ? "x" : "-"}`
        )
        .map((file) => file.path)
        .sort(compareText),
      removes: observedFiles
        .filter((file) => !desiredPaths.has(file.path))
        .map((file) => file.path)
        .sort(compareText),
    },
  };
};

const driftConflict = (
  context: ResourcePlanningContext,
  desiredDigest: ContentDigest,
  currentDigest: ContentDigest,
  desiredExecutable?: boolean | undefined,
  observedExecutable?: boolean | undefined,
): ResourceActionDraft => {
  const detail: DriftConflictActionDetail = {
    kind: "drift-conflict",
    target: context.resource.target,
    desiredDigest,
    observedDigest: currentDigest,
  };
  if (desiredExecutable !== undefined) detail.desiredExecutable = desiredExecutable;
  if (observedExecutable !== undefined) detail.observedExecutable = observedExecutable;
  return { kind: "drift-conflict", detail };
};

const unresolvedAgentTask = (
  context: ResourcePlanningContext,
  summary: string,
): ResourceActionDraft => {
  const tool = context.desired.kind === "tool" ? context.desired : undefined;
  const allowedExecutables = tool === undefined
    ? []
    : sortedUnique([
      tool.toolId,
      ...tool.recipes.map((recipe) => recipe.method),
    ]);
  // Verification stays on the tool itself; package-manager recipe methods can
  // be launcher-class names (`make`, `npx`, ...), so they are never granted an
  // execution model. The bounded agent remains free to propose them, but any
  // launcher-class action fails closed at authorization time.
  const verifiable = tool === undefined || isNestedCommandLauncher(tool.toolId)
    ? undefined
    : tool;
  return {
    kind: "agent-task",
    detail: {
      kind: "agent-task",
      taskId: pendingAgentTaskId,
      summary,
    },
    task: {
      resource: context.resource.id,
      summary,
      desiredOutcome: `Converge ${context.resource.kind} ${context.resource.id}`,
      observedEvidence: [`Observed state: ${context.observed.state}`],
      allowedPaths: [context.resource.target],
      allowedExecutables,
      executableAuthorizations: verifiable === undefined
        ? []
        : [{ executable: verifiable.toolId, behavior: "leaf" }],
      allowedOrigins: [],
      forbidden: ["elevation", "login", "restart", "reboot"],
      timeLimitSeconds: 300,
      outputLimitBytes: 65_536,
      verification: {
        command: verifiable === undefined ? [] : [verifiable.toolId, "--version"],
      },
    },
  };
};

const planReplace = (context: ResourcePlanningContext): ReadonlyArray<ResourceActionDraft> => {
  const desiredDigest = desiredResourceDigest(context.desired);
  if (desiredDigest === undefined) {
    return [unresolvedAgentTask(context, `Resolve ${context.resource.kind} ${context.resource.id}`)];
  }
  if (observedMatchesDesired(context.desired, context.observed)) return [noOp()];
  if (context.desired.kind === "directory" || context.desired.kind === "skill") {
    return [replaceDirectory(context, context.desired)];
  }
  return [
    writeFile(
      context,
      desiredDigest,
      context.desired.kind === "file" ? context.desired.executable : undefined,
    ),
  ];
};

const planMerge = (context: ResourcePlanningContext): ReadonlyArray<ResourceActionDraft> => {
  if (context.desired.kind !== "config") {
    const desiredDigest = desiredResourceDigest(context.desired);
    if (
      desiredDigest !== undefined
      && observedMatchesDesired(context.desired, context.observed)
    ) return [noOp()];
    return [{
      kind: "write-config",
      detail: {
        kind: "write-config",
        target: context.resource.target,
        keys: [],
      },
    }];
  }
  const conflicts = context.desired.keys.filter((key) => context.overlayKeys.includes(key));
  if (conflicts.length > 0) {
    const keys = sortedUnique(conflicts);
    return [{
      kind: "human-action",
      detail: {
        kind: "human-action",
        reason: `Local Overlay conflicts with canonical keys: ${keys.join(", ")}`,
        instructions: `Remove or rename the conflicting Local Overlay keys for ${context.resource.id}, then rerun synchronization.`,
      },
    }];
  }
  if (observedMatchesDesired(context.desired, context.observed)) return [noOp()];
  return [{
    kind: "write-config",
    detail: {
      kind: "write-config",
      target: context.resource.target,
      keys: sortedUnique(context.desired.keys),
    },
  }];
};

const planMirror = (context: ResourcePlanningContext): ReadonlyArray<ResourceActionDraft> => {
  const desiredFiles = context.desired.kind === "directory" || context.desired.kind === "skill"
    ? context.desired.files
    : [{ path: context.resource.target, digest: desiredResourceDigest(context.desired) }];
  const observedFiles = context.observed.state === "directory"
    ? context.observed.files
    : [];
  const currentByPath = new Map(observedFiles.map((file) => [
    file.path,
    `${file.digest}\0${file.executable === true ? "x" : "-"}`,
  ] as const));
  const desiredPaths = new Set(desiredFiles.map((file) => file.path));
  const ownedByPath = new Map(
    (context.applied?.ownedFiles ?? []).map((file) => [
      file.path,
      `${file.digest}\0${file.executable === true ? "x" : "-"}`,
    ] as const),
  );
  const adds = desiredFiles
    .filter((file) =>
      file.digest !== undefined
      && currentByPath.get(file.path)
        !== `${file.digest}\0${"executable" in file && file.executable ? "x" : "-"}`
    )
    .map((file) => file.path)
    .sort(compareText);
  const removes = observedFiles
    .filter((file) => !desiredPaths.has(file.path))
    .filter((file) =>
      ownedByPath.get(file.path)
        === `${file.digest}\0${file.executable === true ? "x" : "-"}`,
    )
    .map((file) => file.path)
    .sort(compareText);
  if (adds.length === 0 && removes.length === 0) return [noOp()];
  return [{
    kind: "mirror-directory",
    detail: {
      kind: "mirror-directory",
      target: context.resource.target,
      adds,
      removes,
    },
  }];
};

const planReplaceIfUnmodified = (
  context: ResourcePlanningContext,
): ReadonlyArray<ResourceActionDraft> => {
  const desiredDigest = desiredResourceDigest(context.desired);
  if (desiredDigest === undefined) {
    return [unresolvedAgentTask(context, `Resolve ${context.resource.kind} ${context.resource.id}`)];
  }
  const currentDigest = observedDigest(context);
  const drift = detectSkillDrift({
    desiredDigest,
    observedDigest: currentDigest,
    lastAppliedDigest: context.applied === undefined
      ? undefined
      : Schema.decodeUnknownSync(ContentDigestSchema)(context.applied.digest),
    desiredExecutable: context.desired.kind === "file"
      ? context.desired.executable
      : undefined,
    observedExecutable: context.observed.state === "present"
      ? context.observed.executable
      : undefined,
    lastAppliedExecutable: context.applied?.executable,
  });
  switch (drift) {
    case "unchanged":
    case "converged":
      return [noOp()];
    case "remote-only":
      if (context.desired.kind === "skill") {
        return [replaceDirectory(context, context.desired)];
      }
      return [
        writeFile(
          context,
          desiredDigest,
          context.desired.kind === "file" ? context.desired.executable : undefined,
        ),
      ];
    case "local-only":
    case "conflicting":
      if (currentDigest === undefined) {
        return [
          writeFile(
            context,
            desiredDigest,
            context.desired.kind === "file" ? context.desired.executable : undefined,
          ),
        ];
      }
      return [driftConflict(
        context,
        desiredDigest,
        currentDigest,
        context.desired.kind === "file" ? context.desired.executable : undefined,
        context.observed.state === "present" ? context.observed.executable : undefined,
      )];
  }
};

const planEnsure = (context: ResourcePlanningContext): ReadonlyArray<ResourceActionDraft> => {
  if (context.desired.kind !== "tool") {
    throw new InvalidObservedStateError({
      resource: context.resource.id,
      kind: context.resource.kind,
      observedState: context.observed.state,
    });
  }
  if (context.observed.state === "present") return [noOp()];
  if (context.observed.state === "unverifiable") {
    return [unresolvedAgentTask(context, `Verify or install tool ${context.desired.toolId}`)];
  }
  const recipe = [...context.desired.recipes]
    .filter((candidate) => candidate.platform === context.platform)
    .sort((left, right) =>
      compareText(
        `${left.method}\0${left.package}\0${left.version ?? ""}\0${JSON.stringify(left.source)}`,
        `${right.method}\0${right.package}\0${right.version ?? ""}\0${JSON.stringify(right.source)}`,
      )
    )[0];
  if (recipe === undefined) {
    return [unresolvedAgentTask(context, `Find an installation recipe for ${context.desired.toolId}`)];
  }
  if (recipe.method === "source") {
    return [{
      kind: "human-action",
      detail: {
        kind: "human-action",
        reason: `Installing ${context.desired.toolId} from source requires Human Action Required`,
        instructions:
          `Canonfig preserves the reviewed source recipe at revision ${recipe.version ?? "unknown"}, but it cannot automatically check out or build source code. Apply the bounded source build manually, then rerun synchronization.`,
      },
    }];
  }
  if (
    recipe.method === "cargo"
    && (recipe.buildPolicy?.mode ?? "scripts-disabled") === "scripts-disabled"
  ) {
    return [{
      kind: "human-action",
      detail: {
        kind: "human-action",
        reason: `Installing ${context.desired.toolId} with Cargo requires Human Action Required`,
        instructions:
          `Cargo may execute build.rs and procedural macros for ${recipe.package}, but Cargo has no disable-scripts mode. Review and apply this recipe with a separately bounded builder policy, then rerun synchronization.`,
      },
    }];
  }
  const sourceDetails = recipeSourceDetails(recipe.source);
  if (
    (recipe.method === "npm" || recipe.method === "pnpm" || recipe.method === "bun")
    && sourceDetails.source?.startsWith("https://") === true
    && sourceDetails.integrity === undefined
  ) {
    return [{
      kind: "human-action",
      detail: {
        kind: "human-action",
        reason: `Installing ${context.desired.toolId} requires a reviewed npm artifact integrity`,
        instructions:
          `The reviewed ${recipe.method} tarball for ${recipe.package}@${recipe.version ?? "the declared version"} has no supported sha256 or sha512 SRI value. Add a lockfile integrity value, or install the package manually and rerun synchronization.`,
      },
    }];
  }
  const detail: InstallToolActionDetail = {
    kind: "install-tool",
    toolId: context.desired.toolId,
    method: recipe.method,
    package: recipe.package,
  };
  if (recipe.version !== undefined) detail.version = recipe.version;
  if (recipe.source !== undefined) detail.source = recipe.source;
  if (recipe.buildPolicy !== undefined) detail.buildPolicy = recipe.buildPolicy;
  if (detail.buildPolicy?.mode === "required") {
    return [{
      kind: "human-action",
      detail: {
        kind: "human-action",
        reason: `Installing ${context.desired.toolId} requires reviewed build hooks`,
        instructions:
          `The ${recipe.method} recipe has a reviewed build policy, but Canonfig's current process executor cannot confine lifecycle descendants. Run the bounded build plan manually within its declared executable, path, origin, and capability bounds, then rerun synchronization.`,
      },
    }];
  }
  const actions: Array<ResourceActionDraft> = [{
    kind: "install-tool",
    detail,
  }];
  if (context.desired.loginRequired) {
    actions.push({
      kind: "human-action",
      detail: {
        kind: "human-action",
        reason: `${context.desired.toolId} requires a local login`,
        instructions: context.desired.loginInstructions ?? `Log in to ${context.desired.toolId}, then rerun synchronization.`,
      },
    });
  }
  return actions;
};

const planRequireLocal = (context: ResourcePlanningContext): ReadonlyArray<ResourceActionDraft> => {
  if (context.desired.kind !== "credential") {
    throw new InvalidObservedStateError({
      resource: context.resource.id,
      kind: context.resource.kind,
      observedState: context.observed.state,
    });
  }
  if (context.observed.state === "present") return [noOp()];
  return [{
    kind: "human-action",
    detail: {
      kind: "human-action",
      reason: `Local credential ${context.desired.reference} is unavailable`,
      instructions: context.desired.instructions,
    },
  }];
};

const planRemovedResource = (
  context: ResourcePlanningContext,
): ReadonlyArray<ResourceActionDraft> => {
  const applied = context.applied;
  if (
    applied === undefined
    || applied.kind !== context.resource.kind
    || applied.policy !== context.resource.policy
    || applied.target === undefined
  ) {
    return [];
  }
  if (!observedMatchesApplied(context)) return [];
  switch (context.resource.kind) {
    case "file":
      if (context.resource.policy !== "replace"
        && context.resource.policy !== "replace-if-unmodified") {
        return [];
      }
      return [{
        kind: "remove-resource",
        detail: {
          kind: "remove-resource",
          target: applied.target,
          paths: [],
          keys: [],
        },
      }];
    case "config":
      if (context.resource.policy === "replace") {
        return [{
          kind: "remove-resource",
          detail: {
            kind: "remove-resource",
            target: applied.target,
            paths: [],
            keys: [],
          },
        }];
      }
      if (
        context.resource.policy !== "merge"
        || applied.ownedKeys === undefined
        || applied.configFormat === undefined
      ) {
        return [];
      }
      return [{
        kind: "remove-resource",
        detail: {
          kind: "remove-resource",
          target: applied.target,
          paths: [],
          keys: sortedUnique(applied.ownedKeys),
        },
      }];
    case "directory":
    case "skill":
      if (
        (context.resource.policy !== "mirror-owned"
          && context.resource.policy !== "replace"
          && context.resource.policy !== "replace-if-unmodified")
        || applied.ownedFiles === undefined
      ) {
        return [];
      }
      return [{
        kind: "remove-resource",
        detail: {
          kind: "remove-resource",
          target: applied.target,
          paths: sortedUnique(applied.ownedFiles.map((file) => file.path)),
          keys: [],
        },
      }];
    case "schedule":
      if (context.resource.policy !== "replace" || applied.schedule === undefined) {
        return [];
      }
      return [{
        kind: "remove-resource",
        detail: {
          kind: "remove-resource",
          target: applied.target,
          paths: [],
          keys: [],
          schedule: applied.schedule,
        },
      }];
    case "tool":
    case "credential":
      // Ensure and require-local intentionally do not claim ownership of
      // follower software or secrets, so removal is never automatic.
      return [];
  }
};

/** Exhaustive Apply Policy dispatch. Transfer planning is intentionally absent. */
export const planResource = (
  context: ResourcePlanningContext,
): ReadonlyArray<ResourceActionDraft> => {
  switch (context.resource.policy) {
    case "replace":
      return planReplace(context);
    case "mirror-owned":
      return planMirror(context);
    case "merge":
      return planMerge(context);
    case "replace-if-unmodified":
      return planReplaceIfUnmodified(context);
    case "ensure":
      return planEnsure(context);
    case "require-local":
      return planRequireLocal(context);
  }
};

export const planRemoved = planRemovedResource;
