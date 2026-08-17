import { Effect, Schema } from "effect";
import { dirname, isAbsolute, join, relative, win32 } from "node:path";

import { CredentialReference, type RunId } from "../domain/brand.ts";
import {
  ResourceSpecInputSchema,
  type PublishedResource,
  type ResourceSpecInput,
  type VerificationInput,
} from "../domain/profile.ts";
import {
  AutomaticRecipeMethod,
  type BuildPolicy,
  type RecipeSource,
} from "../domain/resource.ts";
import type { PlannedAction } from "../domain/synchronization.ts";
import type { MachineStateError } from "../machine/machine-state.errors.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import type { MachinePath } from "../machine/machine-state.types.ts";
import { sha256BytesHex, sha256Hex } from "../profile/profile-codec.ts";
import { ScheduleManager } from "../schedule/schedule-manager.service.ts";
import {
  syncScheduleFromResourceSpec,
  type SetScheduleInput,
  type SyncSchedule,
} from "../schedule/schedule-manager.types.ts";
import {
  ActionExecutionError,
  InvalidArtifactError,
  InvalidExecutionPlanError,
  MissingArtifactError,
  type SynchronizationExecutionInputError,
} from "./synchronization.errors.ts";
import type {
  DesiredResource,
  SynchronizationArtifact,
  SynchronizationExecutionLimits,
} from "./synchronization.types.ts";
import {
  getConfigPath,
  parseConfigDocument,
  removeConfigPath,
  serializeConfigDocument,
  setConfigPath,
} from "./config-codec.ts";
import { desiredResourceDigest } from "./resource-plans.ts";
import { parseNpmPackageSpecification } from "../domain/npm-package-spec.ts";
import {
  isMissingAutomaticRecipeVersion,
  recipeSourceDetails,
  recipeValidationError,
  npmVersionFromTarballSource,
} from "../domain/recipe-versions.ts";
import {
  defaultNpmArtifactTransport,
  validateNpmArtifactProvenance,
  verifyNpmArtifactBytes,
  type NpmArtifactTransport,
} from "./npm-artifact.ts";

const isUnboundedNonNpmPackage = (value: string): boolean =>
  /^(?:git\+|git:\/\/|github:|gitlab:|bitbucket:|git@|file:|link:|workspace:|https?:\/\/)/iu
    .test(value)
  || /(?:^|@)(?:npm:|git\+|git:\/\/|github:|gitlab:|bitbucket:|git@|file:|link:|workspace:|https?:\/\/)/iu
    .test(value);

interface LegacyStoredFile {
  readonly path: string;
  readonly existed: boolean;
  readonly content: string;
}

type StoredFile =
  | { readonly path: string; readonly state: "absent" }
  | { readonly path: string; readonly state: "directory" }
  | { readonly path: string; readonly state: "regular"; readonly content: string; readonly mode: number }
  | { readonly path: string; readonly state: "symlink"; readonly target: string }
  | LegacyStoredFile;

const storedState = (
  entry: StoredFile,
): "absent" | "directory" | "regular" | "symlink" =>
  "state" in entry
    ? entry.state
    : entry.existed
    ? "regular"
    : "absent";

const StoredFileSchema = Schema.Union([
  Schema.Struct({
    path: Schema.NonEmptyString,
    state: Schema.Literal("absent"),
  }),
  Schema.Struct({
    path: Schema.NonEmptyString,
    state: Schema.Literal("directory"),
  }),
  Schema.Struct({
    path: Schema.NonEmptyString,
    state: Schema.Literal("regular"),
    content: Schema.String,
    mode: Schema.Int,
  }),
  Schema.Struct({
    path: Schema.NonEmptyString,
    state: Schema.Literal("symlink"),
    target: Schema.NonEmptyString,
  }),
  Schema.Struct({
    path: Schema.NonEmptyString,
    existed: Schema.Boolean,
    content: Schema.String,
  }),
]);

interface RollbackMaterial {
  readonly reference: string;
  readonly restore: Effect.Effect<void, MachineStateError, MachineState>;
}

export interface ResourceExecutionContext {
  readonly run: RunId;
  readonly action: PlannedAction;
  readonly resource: PublishedResource;
  readonly desired: DesiredResource;
  readonly verification: VerificationInput;
  readonly artifacts: ReadonlyMap<string, SynchronizationArtifact>;
  readonly limits: SynchronizationExecutionLimits;
  readonly previousSchedule?: SyncSchedule | undefined;
  /**
   * The default is the bounded HTTPS artifact transport. This optional seam
   * lets integration tests use a local HTTPS fixture without altering a
   * reviewed source or the production transport policy.
   */
  readonly npmArtifactTransport?: NpmArtifactTransport | undefined;
}

export interface PreparedResourceAction {
  readonly rollbackReference?: string | undefined;
  readonly execute: Effect.Effect<void, SynchronizationExecutionInputError | MachineStateError, MachineState>;
  readonly rollback?: Effect.Effect<
    void,
    SynchronizationExecutionInputError | MachineStateError,
    MachineState
  > | undefined;
}

export interface ResourceVerification {
  readonly passed: boolean;
  readonly method: string;
  readonly observedDigest?: string | undefined;
  readonly exitCode?: number | undefined;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const scheduleInputFromSpec = (
  spec: Extract<ResourceSpecInput, { readonly kind: "schedule" }>,
): SetScheduleInput => ({
  schedule: syncScheduleFromResourceSpec(spec),
});

const scheduleInputFor = (
  context: ResourceExecutionContext,
): Effect.Effect<
  SetScheduleInput,
  SynchronizationExecutionInputError | MachineStateError,
  MachineState
> =>
  Effect.gen(function*() {
    if (context.desired.kind !== "schedule") {
      return yield* new InvalidExecutionPlanError({
        message: `schedule action targets non-schedule resource ${context.resource.id}`,
      });
    }
    const digest = context.desired.digest;
    const bytes = yield* artifact(context.artifacts, digest);
    return yield* Effect.try({
      try: () => {
        const spec = Schema.decodeUnknownSync(ResourceSpecInputSchema)(
          JSON.parse(decoder.decode(bytes)),
        );
        if (spec.kind !== "schedule") {
          throw new Error("schedule artifact does not contain a schedule specification");
        }
        return scheduleInputFromSpec(spec);
      },
      catch: (cause) =>
        new InvalidArtifactError({
          digest,
          message: String(cause),
        }),
    });
  });

const artifact = (
  artifacts: ReadonlyMap<string, SynchronizationArtifact>,
  digest: string,
): Effect.Effect<Uint8Array, MissingArtifactError | InvalidArtifactError> => {
  const value = artifacts.get(digest);
  if (value === undefined) return Effect.fail(new MissingArtifactError({ digest }));
  const observed = sha256BytesHex(value.content);
  if (observed !== digest) {
    return Effect.fail(new InvalidArtifactError({
      digest,
      message: `artifact content digest was ${observed}`,
    }));
  }
  return Effect.succeed(value.content);
};

const readIfPresent = (
  path: MachinePath,
  maximumBytes: number,
): Effect.Effect<Uint8Array | undefined, MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    return yield* machine.readFile({ path, maximumBytes }).pipe(
      Effect.catchTag("MachineFilesystemError", (error) =>
        error.message.includes("ENOENT")
          ? Effect.succeed(undefined)
          : Effect.fail(error)
      ),
    );
  });

const captureStoredFile = (
  path: MachinePath,
  maximumBytes: number,
): Effect.Effect<StoredFile, MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const kind = yield* machine.inspectPath(path).pipe(
      Effect.catchTag("MachineFilesystemError", (error) =>
        error.message.includes("ENOENT")
          ? Effect.succeed(undefined)
          : Effect.fail(error)
      ),
    );
    if (kind === undefined) return { path: path.absolute, state: "absent" };
    if (kind.kind === "directory") {
      return { path: path.absolute, state: "directory" };
    }
    const symlink = yield* machine.readSymlink(path).pipe(
      Effect.map((target) => target.absolute),
      Effect.catchTag("MachineFilesystemError", () => Effect.succeed(undefined)),
    );
    if (symlink !== undefined) {
      return { path: path.absolute, state: "symlink", target: symlink };
    }
    const content = yield* readIfPresent(path, maximumBytes);
    if (content === undefined) return { path: path.absolute, state: "absent" };
    const permissions = yield* machine.permissions(path);
    return {
      path: path.absolute,
      state: "regular",
      content: Buffer.from(content).toString("base64"),
      mode: permissions.mode,
    };
  });

const restoreStoredFile = (
  entry: StoredFile,
  root?: MachinePath | undefined,
): Effect.Effect<void, MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const path = yield* machine.normalizePath({ path: entry.path });
    if ("existed" in entry) {
      if (entry.existed) {
        const content = Buffer.from(entry.content, "base64");
        if (root === undefined) {
          yield* machine.atomicWrite({ path, content });
        } else {
          yield* machine.mutateWithinRoot({
            root,
            path,
            mutation: { kind: "write", content },
          });
        }
      } else {
        if (root === undefined) {
          yield* machine.removeFile({ path });
        } else {
          yield* machine.mutateWithinRoot({
            root,
            path,
            mutation: { kind: "remove" },
          });
        }
      }
      return;
    }
    switch (entry.state) {
      case "absent":
        if (root === undefined) {
          yield* machine.removeFile({ path });
        } else {
          const currentKind = yield* machine.inspectPath(path).pipe(
            Effect.catchTag("MachineFilesystemError", (error) =>
              error.message.includes("ENOENT")
                ? Effect.succeed(undefined)
                : Effect.fail(error)
            ),
          );
          if (currentKind?.kind === "directory") {
            yield* machine.removeEmptyDirectory({ path });
          } else {
            yield* machine.mutateWithinRoot({
              root,
              path,
              mutation: { kind: "remove" },
            });
          }
        }
        return;
      case "directory":
        yield* machine.ensureDirectory({ path });
        return;
      case "regular": {
        const content = Buffer.from(entry.content, "base64");
        if (root === undefined) {
          yield* machine.atomicWrite({ path, content, mode: entry.mode });
        } else {
          yield* machine.mutateWithinRoot({
            root,
            path,
            mutation: { kind: "write", content, mode: entry.mode },
          });
        }
        return;
      }
      case "symlink": {
        const target = yield* machine.normalizePath({ path: entry.target });
        if (root === undefined) {
          yield* machine.replaceSymlink({ path, target });
        } else {
          yield* machine.mutateWithinRoot({
            root,
            path,
            mutation: { kind: "symlink", target },
          });
        }
      }
    }
  });

const normalizeRelative = (
  target: MachinePath,
  relative: string,
): Effect.Effect<MachinePath, SynchronizationExecutionInputError | MachineStateError, MachineState> =>
  Effect.gen(function*() {
    if (
      relative.length === 0
      || relative.startsWith("/")
      || relative.startsWith("\\")
      || /^[A-Za-z]:/u.test(relative)
      || relative.split(/[\\/]/u).includes("..")
    ) {
      return yield* new InvalidExecutionPlanError({
        message: `mirror path must remain relative to its target: ${relative}`,
      });
    }
    const machine = yield* MachineState;
    return yield* machine.normalizePath({ path: relative, base: target });
  });

const sameMachinePath = (
  left: MachinePath,
  right: MachinePath,
): boolean =>
  left.platform === right.platform
  && (
    left.platform === "windows"
      ? left.absolute.toLowerCase() === right.absolute.toLowerCase()
      : left.absolute === right.absolute
  );

const machinePathKey = (path: MachinePath): string =>
  `${path.platform}:${path.platform === "windows"
    ? path.absolute.toLowerCase()
    : path.absolute}`;

const pathWithinMachineRoot = (
  root: MachinePath,
  path: MachinePath,
): boolean => {
  if (root.platform !== path.platform) return false;
  const remainder = root.platform === "windows"
    ? win32.relative(root.absolute.toLowerCase(), path.absolute.toLowerCase())
    : relative(root.absolute, path.absolute);
  return remainder === ""
    || (
      !remainder.startsWith("..")
      && !win32.isAbsolute(remainder)
      && !isAbsolute(remainder)
    );
};

/**
 * Return the exact deterministic rollback path set. Directory mutations need
 * snapshots for every intermediate ancestor because a failed restart can
 * otherwise leave newly-created nested directories behind. Keep this
 * expansion shared by capture and recovery validation so the persisted
 * material cannot be rejected or accepted under a different path contract.
 */
const rollbackPathSet = (
  paths: ReadonlyArray<MachinePath>,
  root?: MachinePath | undefined,
): Effect.Effect<
  ReadonlyArray<MachinePath>,
  SynchronizationExecutionInputError | MachineStateError,
  MachineState
> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const normalizedRoot = root === undefined
      ? undefined
      : yield* machine.normalizePath({ path: root.absolute });
    const normalizedPaths = yield* Effect.forEach(
      paths,
      (path) => machine.normalizePath({ path: path.absolute }),
    );
    const pathsWithAncestors = new Map(
      normalizedPaths.map((path) => [machinePathKey(path), path] as const),
    );
    if (normalizedRoot !== undefined) {
      for (const path of normalizedPaths) {
        if (!pathWithinMachineRoot(normalizedRoot, path)) {
          return yield* new InvalidExecutionPlanError({
            message: `rollback path is outside managed root ${normalizedRoot.absolute}: ${path.absolute}`,
          });
        }
        if (sameMachinePath(path, normalizedRoot)) continue;
        let ancestor = path.platform === "windows"
          ? win32.dirname(path.absolute)
          : dirname(path.absolute);
        while (!sameMachinePath({ platform: normalizedRoot.platform, absolute: ancestor }, normalizedRoot)) {
          const candidate: MachinePath = {
            platform: normalizedRoot.platform,
            absolute: ancestor,
          };
          if (!pathWithinMachineRoot(normalizedRoot, candidate)) {
            return yield* new InvalidExecutionPlanError({
              message: `rollback ancestor is outside managed root ${normalizedRoot.absolute}: ${ancestor}`,
            });
          }
          const normalized = yield* machine.normalizePath({ path: ancestor });
          if (!pathWithinMachineRoot(normalizedRoot, normalized)) {
            return yield* new InvalidExecutionPlanError({
              message: `rollback ancestor is outside managed root ${normalizedRoot.absolute}: ${normalized.absolute}`,
            });
          }
          pathsWithAncestors.set(machinePathKey(normalized), normalized);
          const parent = normalized.platform === "windows"
            ? win32.dirname(normalized.absolute)
            : dirname(normalized.absolute);
          if (parent === normalized.absolute) {
            return yield* new InvalidExecutionPlanError({
              message: `rollback path ancestry did not reach managed root ${normalizedRoot.absolute}`,
            });
          }
          ancestor = parent;
        }
      }
    }
    return [...pathsWithAncestors.values()].sort((left, right) =>
      left.platform.localeCompare(right.platform)
      || left.absolute.localeCompare(right.absolute)
    );
  });

const restoreOrder = (
  entries: ReadonlyArray<StoredFile>,
): ReadonlyArray<StoredFile> =>
  [...entries].sort((left, right) =>
    right.path.split(/[\\/]/u).length - left.path.split(/[\\/]/u).length
    || right.path.length - left.path.length
    || left.path.localeCompare(right.path)
  );

const captureRollback = (
  context: ResourceExecutionContext,
  paths: ReadonlyArray<MachinePath>,
  root?: MachinePath | undefined,
): Effect.Effect<
  RollbackMaterial,
  SynchronizationExecutionInputError | MachineStateError,
  MachineState
> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const directories = yield* machine.userDirectories();
    const rollbackDirectory = yield* machine.normalizePath({
      path: `canonfig/rollback/${context.run}`,
      base: directories.cache,
    });
    yield* machine.ensureDirectory({ path: rollbackDirectory });
    const rollbackPath = yield* machine.normalizePath({
      path: `${sha256Hex(context.action.id)}.json`,
      base: rollbackDirectory,
    });
    const pathsWithAncestors = yield* rollbackPathSet(paths, root);
    const stored = yield* Effect.forEach(
      pathsWithAncestors,
      (path) => captureStoredFile(path, context.limits.maximumFileBytes),
    );
    yield* machine.atomicWrite({
      path: rollbackPath,
      content: encoder.encode(JSON.stringify(stored)),
    });
    const restore = Effect.gen(function*() {
      const rootEntry = root === undefined
        ? undefined
        : stored.find((entry) => entry.path === root.absolute);
      if (root !== undefined && rootEntry !== undefined && storedState(rootEntry) !== "absent") {
        yield* restoreStoredFile(rootEntry);
      }
      if (
        rootEntry === undefined
        || storedState(rootEntry) === "absent"
        || storedState(rootEntry) === "directory"
      ) {
        for (const entry of restoreOrder(stored)) {
          if (entry === rootEntry) continue;
          yield* restoreStoredFile(entry, root);
        }
      }
      if (root !== undefined && rootEntry !== undefined && storedState(rootEntry) === "absent") {
        yield* machine.removeEmptyDirectory({ path: root }).pipe(
          Effect.catchTag("MachineFilesystemError", (error) =>
            error.message.includes("ENOENT") ? Effect.void : Effect.fail(error)
          ),
        );
      }
    });
    return { reference: rollbackPath.absolute, restore };
  });

const rollbackPaths = (
  context: ResourceExecutionContext,
): Effect.Effect<
  ReadonlyArray<MachinePath>,
  SynchronizationExecutionInputError | MachineStateError,
  MachineState
> =>
  Effect.gen(function*() {
    const detail = context.action.detail;
    switch (detail.kind) {
      case "write-file":
      case "write-config":
        return [yield* targetPath(detail.target)];
      case "mirror-directory": {
        const root = yield* targetPath(detail.target);
        const descendants = yield* Effect.forEach(
          [...new Set([...detail.adds, ...detail.removes])],
          (path) => normalizeRelative(root, path),
        );
        return yield* rollbackPathSet([root, ...descendants], root);
      }
      case "remove-resource": {
        if (context.resource.kind === "directory" || context.resource.kind === "skill") {
          const root = yield* targetPath(detail.target);
          const descendants = yield* Effect.forEach(
            detail.paths,
            (path) => normalizeRelative(root, path),
          );
          return yield* rollbackPathSet([root, ...descendants], root);
        }
        if (context.resource.kind === "file" || context.resource.kind === "config") {
          return [yield* targetPath(detail.target)];
        }
        return [];
      }
      default:
        return [];
    }
  });

/**
 * Restore a persisted, owned-file rollback snapshot. Both the reference and
 * every stored target are re-derived from the immutable action before use.
 */
export const restoreRollbackReference = (
  context: ResourceExecutionContext,
  reference: string,
): Effect.Effect<
  void,
  SynchronizationExecutionInputError | MachineStateError,
  MachineState
> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const directories = yield* machine.userDirectories();
    const rollbackDirectory = yield* machine.normalizePath({
      path: `canonfig/rollback/${context.run}`,
      base: directories.cache,
    });
    const expectedReference = yield* machine.normalizePath({
      path: `${sha256Hex(context.action.id)}.json`,
      base: rollbackDirectory,
    });
    const actualReference = yield* machine.normalizePath({ path: reference });
    if (actualReference.absolute !== expectedReference.absolute) {
      return yield* new InvalidExecutionPlanError({
        message: `rollback reference does not belong to action ${context.action.id}`,
      });
    }
    const expectedPaths = yield* rollbackPaths(context);
    const maximumBytes = context.limits.maximumFileBytes * Math.max(1, expectedPaths.length);
    if (!Number.isSafeInteger(maximumBytes)) {
      return yield* new InvalidExecutionPlanError({
        message: `rollback material is too large for action ${context.action.id}`,
      });
    }
    const bytes = yield* machine.readFile({
      path: actualReference,
      maximumBytes,
    });
    const stored = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(StoredFileSchema)),
    )(decoder.decode(bytes)).pipe(
      Effect.mapError((error) =>
        new InvalidExecutionPlanError({
          message: `invalid rollback material for action ${context.action.id}: ${String(error)}`,
        })
      ),
    );
    const allowed = new Set(expectedPaths.map((path) => path.absolute));
    if (
      stored.length !== allowed.size
      || stored.some((entry) => !allowed.has(entry.path))
      || new Set(stored.map((entry) => entry.path)).size !== stored.length
    ) {
      return yield* new InvalidExecutionPlanError({
        message: `rollback material targets do not match action ${context.action.id}`,
      });
    }
    const root = context.action.detail.kind === "mirror-directory"
      || (
        context.action.detail.kind === "remove-resource"
        && (context.resource.kind === "directory" || context.resource.kind === "skill")
      )
      ? yield* targetPath(context.action.detail.target)
      : undefined;
    const rootEntry = root === undefined
      ? undefined
      : stored.find((entry) => entry.path === root.absolute);
    if (root !== undefined && rootEntry !== undefined && storedState(rootEntry) !== "absent") {
      yield* restoreStoredFile(rootEntry);
    }
    if (
      rootEntry === undefined
      || storedState(rootEntry) === "absent"
      || storedState(rootEntry) === "directory"
    ) {
      for (const entry of restoreOrder(stored)) {
        if (entry === rootEntry) continue;
        yield* restoreStoredFile(entry, root);
      }
    }
    if (root !== undefined && rootEntry !== undefined && storedState(rootEntry) === "absent") {
      yield* machine.removeEmptyDirectory({ path: root }).pipe(
        Effect.catchTag("MachineFilesystemError", (error) =>
          error.message.includes("ENOENT") ? Effect.void : Effect.fail(error)
        ),
      );
    }
  });

const targetPath = (
  target: string,
): Effect.Effect<MachinePath, MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    return yield* machine.normalizePath({ path: target });
  });

const prepareSchedule = (
  context: ResourceExecutionContext,
  scheduleManager: ScheduleManager["Service"] | undefined,
): Effect.Effect<
  PreparedResourceAction,
  SynchronizationExecutionInputError | MachineStateError,
  MachineState
> =>
  Effect.gen(function*() {
    if (scheduleManager === undefined) {
      return yield* new InvalidExecutionPlanError({
        message: `schedule resource ${context.resource.id} requires ScheduleManager`,
      });
    }
    const input = yield* scheduleInputFor(context);
    const execute = (context.previousSchedule === undefined
      ? scheduleManager.install(input)
      : scheduleManager.update(input)
    ).pipe(Effect.asVoid);
    const rollback = context.previousSchedule === undefined
      ? scheduleManager.remove(input).pipe(Effect.asVoid)
      : scheduleManager.update({
        ...input,
        schedule: context.previousSchedule,
      }).pipe(Effect.asVoid);
    return { execute, rollback };
  });

const prepareWrite = (
  context: ResourceExecutionContext,
  target: string,
  digest: string,
): Effect.Effect<PreparedResourceAction, SynchronizationExecutionInputError | MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const path = yield* targetPath(target);
    const rollback = yield* captureRollback(context, [path]);
    const execute = Effect.gen(function*() {
      const machine = yield* MachineState;
      if (context.desired.kind !== "file") {
        const content = yield* artifact(context.artifacts, digest);
        yield* machine.atomicWrite({ path, content });
        return;
      }
      if (context.desired.symlinkTo !== undefined) {
        const target = yield* machine.normalizePath({
          path: context.desired.symlinkTo,
        });
        yield* machine.replaceSymlink({ path, target });
        return;
      }
      const content = yield* artifact(context.artifacts, digest);
      yield* machine.atomicWrite({
        path,
        content,
        mode: context.desired.executable ? 0o700 : 0o600,
      });
    });
    return {
      rollbackReference: rollback.reference,
      execute,
      rollback: rollback.restore,
    };
  });

const prepareConfig = (
  context: ResourceExecutionContext,
  target: string,
  keys: ReadonlyArray<string>,
): Effect.Effect<PreparedResourceAction, SynchronizationExecutionInputError | MachineStateError, MachineState> =>
  Effect.gen(function*() {
    if (context.desired.kind !== "config") {
      return yield* new InvalidExecutionPlanError({
        message: `write-config action does not target a config resource: ${context.resource.id}`,
      });
    }
    const config = context.desired;
    const path = yield* targetPath(target);
    const desiredBytes = yield* artifact(context.artifacts, config.digest);
    const desired = yield* Effect.try({
      try: () =>
        parseConfigDocument(
          config.format,
          decoder.decode(desiredBytes),
        ),
      catch: (error) =>
        new InvalidArtifactError({
          digest: config.digest,
          message: String(error),
        }),
    });
    const currentBytes = yield* readIfPresent(path, context.limits.maximumFileBytes);
    const current = currentBytes === undefined
      ? {}
      : yield* Effect.try({
        try: () =>
          parseConfigDocument(
            config.format,
            decoder.decode(currentBytes),
          ),
        catch: (error) =>
          new InvalidExecutionPlanError({
            message: `cannot merge non-object config ${target}: ${String(error)}`,
          }),
      });
    for (const key of keys) {
      const value = getConfigPath(desired, key);
      if (value !== undefined) setConfigPath(current, key, value);
    }
    const content = encoder.encode(
      serializeConfigDocument(config.format, current),
    );
    const rollback = yield* captureRollback(context, [path]);
    const execute = Effect.gen(function*() {
      const machine = yield* MachineState;
      yield* machine.atomicWrite({ path, content });
    });
    return {
      rollbackReference: rollback.reference,
      execute,
      rollback: rollback.restore,
    };
  });

const prepareMirror = (
  context: ResourceExecutionContext,
  target: string,
  adds: ReadonlyArray<string>,
  removes: ReadonlyArray<string>,
): Effect.Effect<PreparedResourceAction, SynchronizationExecutionInputError | MachineStateError, MachineState> =>
  Effect.gen(function*() {
    if (context.desired.kind !== "directory" && context.desired.kind !== "skill") {
      return yield* new InvalidExecutionPlanError({
        message: `mirror action does not target a directory resource: ${context.resource.id}`,
      });
    }
    const root = yield* targetPath(target);
    const allRelative = [...new Set([...adds, ...removes])];
    const paths = yield* Effect.forEach(allRelative, (path) => normalizeRelative(root, path));
    const byRelative = new Map(allRelative.map((path, index) => [path, paths[index]!]));
    const desiredByPath = new Map(context.desired.files.map((file) => [
      file.path,
      file,
    ]));
    const contentByPath = new Map<string, Uint8Array>();
    for (const relative of adds) {
      const desiredFile = desiredByPath.get(relative);
      if (desiredFile === undefined) {
        return yield* new InvalidExecutionPlanError({
          message: `mirror add is absent from desired content: ${relative}`,
        });
      }
      contentByPath.set(
        relative,
        yield* artifact(context.artifacts, desiredFile.digest),
      );
    }
    const rollback = yield* captureRollback(context, [root, ...paths], root);
    const execute = Effect.gen(function*() {
      const activeMachine = yield* MachineState;
      yield* activeMachine.ensureDirectory({ path: root });
      for (const relative of adds) {
        yield* activeMachine.mutateWithinRoot({
          root,
          path: byRelative.get(relative)!,
          mutation: {
            kind: "write",
            content: contentByPath.get(relative)!,
            mode: desiredByPath.get(relative)!.executable ? 0o700 : 0o600,
          },
        });
      }
      for (const relative of removes) {
        yield* activeMachine.mutateWithinRoot({
          root,
          path: byRelative.get(relative)!,
          mutation: { kind: "remove" },
        });
      }
    });
    return {
      rollbackReference: rollback.reference,
      execute,
      rollback: rollback.restore,
    };
  });

const prepareRemoval = (
  context: ResourceExecutionContext,
  detail: Extract<PlannedAction["detail"], { readonly kind: "remove-resource" }>,
  scheduleManager: ScheduleManager["Service"] | undefined,
): Effect.Effect<PreparedResourceAction, SynchronizationExecutionInputError | MachineStateError, MachineState> =>
  Effect.gen(function*() {
    switch (context.resource.kind) {
      case "file": {
        const path = yield* targetPath(detail.target);
        const rollback = yield* captureRollback(context, [path]);
        const execute = Effect.gen(function*() {
          const machine = yield* MachineState;
          yield* machine.removeFile({ path }).pipe(
            Effect.catchTag("MachineFilesystemError", (error) =>
              error.message.includes("ENOENT") ? Effect.void : Effect.fail(error)
            ),
          );
        });
        return { rollbackReference: rollback.reference, execute, rollback: rollback.restore };
      }
      case "config": {
        if (context.resource.policy === "replace") {
          const path = yield* targetPath(detail.target);
          const rollback = yield* captureRollback(context, [path]);
          const execute = Effect.gen(function*() {
            const machine = yield* MachineState;
            yield* machine.removeFile({ path }).pipe(
              Effect.catchTag("MachineFilesystemError", (error) =>
                error.message.includes("ENOENT") ? Effect.void : Effect.fail(error)
              ),
            );
          });
          return {
            rollbackReference: rollback.reference,
            execute,
            rollback: rollback.restore,
          };
        }
        if (context.desired.kind !== "config") {
          return yield* new InvalidExecutionPlanError({
            message: `removal action does not target a config resource: ${context.resource.id}`,
          });
        }
        const config = context.desired;
        const path = yield* targetPath(detail.target);
        const rollback = yield* captureRollback(context, [path]);
        const execute = Effect.gen(function*() {
          const currentBytes = yield* readIfPresent(
            path,
            context.limits.maximumFileBytes,
          );
          if (currentBytes === undefined) return;
          const current = yield* Effect.try({
            try: () => parseConfigDocument(
              config.format,
              decoder.decode(currentBytes),
            ),
            catch: (error) => new InvalidExecutionPlanError({
              message: `cannot remove keys from config ${detail.target}: ${String(error)}`,
            }),
          });
          for (const key of detail.keys) removeConfigPath(current, key);
          const machine = yield* MachineState;
          yield* machine.atomicWrite({
            path,
            content: encoder.encode(serializeConfigDocument(config.format, current)),
          });
        });
        return { rollbackReference: rollback.reference, execute, rollback: rollback.restore };
      }
      case "directory":
      case "skill": {
        if (context.desired.kind !== "directory" && context.desired.kind !== "skill") {
          return yield* new InvalidExecutionPlanError({
            message: `removal action does not target a directory resource: ${context.resource.id}`,
          });
        }
        const root = yield* targetPath(detail.target);
        const paths = yield* Effect.forEach(
          detail.paths,
          (path) => normalizeRelative(root, path),
        );
        const rollback = yield* captureRollback(context, [root, ...paths], root);
        const execute = Effect.gen(function*() {
          const machine = yield* MachineState;
          for (const path of paths) {
            yield* machine.mutateWithinRoot({
              root,
              path,
              mutation: { kind: "remove" },
            }).pipe(
              Effect.catchTag("MachineFilesystemError", (error) =>
                error.message.includes("ENOENT") ? Effect.void : Effect.fail(error)
              ),
            );
          }
        });
        return { rollbackReference: rollback.reference, execute, rollback: rollback.restore };
      }
      case "schedule": {
        if (
          scheduleManager === undefined
          || detail.schedule === undefined
          || context.desired.kind !== "schedule"
        ) {
          return yield* new InvalidExecutionPlanError({
            message: `removal action requires a schedule manager for ${context.resource.id}`,
          });
        }
        const input = { schedule: detail.schedule };
        return {
          execute: scheduleManager.remove(input).pipe(Effect.asVoid),
          rollback: scheduleManager.install(input).pipe(Effect.asVoid),
        };
      }
      case "tool":
      case "credential":
        return yield* new InvalidExecutionPlanError({
          message: `resource ${context.resource.id} does not support automatic removal`,
        });
    }
  });

const installInvocation = (
  context: ResourceExecutionContext,
  method: string,
  packageName: string,
  version?: string | undefined,
  buildPolicy: BuildPolicy = { mode: "scripts-disabled" },
  source?: RecipeSource | undefined,
): Effect.Effect<
  void,
  MachineStateError | ActionExecutionError | InvalidExecutionPlanError,
  MachineState
> =>
  Effect.gen(function*() {
    if (method === "source") {
      return yield* new InvalidExecutionPlanError({
        message: `source recipe ${packageName} requires Human Action Required; no bounded source installer is available`,
      });
    }
    if (!Schema.is(AutomaticRecipeMethod)(method)) {
      return yield* new InvalidExecutionPlanError({
        message: `unknown installer method ${method}`,
      });
    }
    if (buildPolicy.mode === "required") {
      return yield* new InvalidExecutionPlanError({
        message:
          `recipe ${method}/${packageName} requires a bounded build policy; the process executor cannot confine lifecycle descendants`,
      });
    }
    if (
      method === "cargo"
      && buildPolicy.mode === "scripts-disabled"
    ) {
      return yield* new InvalidExecutionPlanError({
        message:
          `cargo recipe ${packageName} requires Human Action Required because Cargo has no disable-scripts mode`,
      });
    }
    if (
      version !== undefined
      && ![
        "npm",
        "pnpm",
        "bun",
        "brew",
        "homebrew",
        "winget",
        "uv",
        "cargo",
        "apt",
      ].includes(method)
    ) {
      return yield* new InvalidExecutionPlanError({
        message: `installer ${method} cannot honor requested version ${version}`,
      });
    }
    if (
      packageName === "--"
      || /^\s*-{1,2}\S*/u.test(packageName)
      || /\s/u.test(packageName)
      || (
        method === "npm"
          ? parseNpmPackageSpecification(packageName).kind !== "registry"
          : isUnboundedNonNpmPackage(packageName)
      )
    ) {
      return yield* new InvalidExecutionPlanError({
        message: `ambiguous or source dependency ${packageName} requires a separately bounded execution plan`,
      });
    }
    const recipeError = recipeValidationError({
      method,
      package: packageName,
      version,
      source,
    });
    if (
      recipeError !== undefined
      || isMissingAutomaticRecipeVersion({
        method,
        package: packageName,
        version,
        source,
      })
    ) {
      return yield* new InvalidExecutionPlanError({
        message: recipeError ?? `automatic installer ${method} requires an exact version`,
      });
    }
    const npmFamily = method === "npm" || method === "pnpm" || method === "bun";
    const sourceDetailsValue = recipeSourceDetails(source);
    const effectiveVersion = version
      ?? (
        npmFamily && sourceDetailsValue.source !== undefined
          ? npmVersionFromTarballSource(packageName, sourceDetailsValue.source)
          : undefined
      );
    const sourceUrl = npmFamily
      && sourceDetailsValue.source !== undefined
      && sourceDetailsValue.source.startsWith("https://")
      ? sourceDetailsValue.source
      : undefined;
    const machine = yield* MachineState;
    let verifiedArtifactPath: string | undefined;
    if (sourceUrl !== undefined) {
      if (method === "bun") {
        return yield* new InvalidExecutionPlanError({
          message:
            "bun cannot guarantee an offline local tarball installation; Human Action Required",
        });
      }
      const integrity = sourceDetailsValue.integrity;
      if (integrity === undefined) {
        return yield* new InvalidExecutionPlanError({
          message:
            `reviewed ${method} package artifact ${sourceUrl} has no supported integrity; Human Action Required`,
        });
      }
      const directories = yield* machine.userDirectories();
      const cacheDirectory = join(
        directories.cache.absolute,
        "canonfig",
        "npm-artifacts",
      );
      const artifact = yield* (context.npmArtifactTransport ?? defaultNpmArtifactTransport)
        .download({
          source: sourceUrl,
          packageName,
          version: effectiveVersion!,
          integrity,
          cacheDirectory,
          maximumBytes: 32 * 1024 * 1024,
          timeoutMilliseconds: context.limits.processTimeoutMilliseconds,
        }).pipe(
          Effect.mapError((error) =>
            new InvalidExecutionPlanError({
              message: `reviewed package artifact could not be verified: ${error.message}`,
            })
          ),
        );
      if (artifact.source !== sourceUrl || artifact.integrity !== integrity) {
        return yield* new InvalidExecutionPlanError({
          message: "verified npm artifact metadata changed before installation",
        });
      }
      const artifactPath = yield* machine.normalizePath({ path: artifact.path });
      yield* machine.validatePathWithinRoot({
        root: directories.cache,
        path: artifactPath,
      });
      const symlinkTarget = yield* machine.readSymlink(artifactPath).pipe(
        Effect.map((target) => target.absolute),
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (symlinkTarget !== undefined) {
        return yield* new InvalidExecutionPlanError({
          message: "verified npm artifact cache entry is a symlink",
        });
      }
      if (
        !Number.isSafeInteger(artifact.bytes)
        || artifact.bytes <= 0
        || artifact.bytes > 32 * 1024 * 1024
      ) {
        return yield* new InvalidExecutionPlanError({
          message: "verified npm artifact size is outside the execution bound",
        });
      }
      const bytes = yield* machine.readFile({
        path: artifactPath,
        maximumBytes: artifact.bytes,
      });
      if (bytes.byteLength !== artifact.bytes || !verifyNpmArtifactBytes(bytes, integrity)) {
        return yield* new InvalidExecutionPlanError({
          message: "verified npm artifact changed or is corrupt before installation",
        });
      }
      const provenanceError = validateNpmArtifactProvenance(
        bytes,
        packageName,
        effectiveVersion,
      );
      if (provenanceError !== undefined) {
        return yield* new InvalidExecutionPlanError({
          message: `verified npm artifact provenance is not safe: ${provenanceError}; Human Action Required`,
        });
      }
      verifiedArtifactPath = artifactPath.absolute;
    }
    const executableName = method === "apt"
      ? "apt-get"
      : method === "homebrew"
      ? "brew"
      : method;
    const executable = yield* machine.findExecutable({ name: executableName });
    const packageSpecifier = npmFamily && verifiedArtifactPath !== undefined
      ? verifiedArtifactPath
      : effectiveVersion === undefined
      ? packageName
      : `${packageName}@${effectiveVersion}`;
    const packageEnvironment = method === "npm" || method === "pnpm" || method === "bun"
      ? [
        { name: "NPM_CONFIG_USERCONFIG", value: process.platform === "win32" ? "NUL" : "/dev/null" },
        { name: "NPM_CONFIG_GLOBALCONFIG", value: process.platform === "win32" ? "NUL" : "/dev/null" },
        { name: "NPM_CONFIG_LOCATION", value: "global" },
        { name: "NPM_CONFIG_REGISTRY", value: "https://registry.npmjs.org/" },
        ...(verifiedArtifactPath !== undefined
          ? [{ name: "NPM_CONFIG_OFFLINE", value: "true" }]
          : []),
        ...(method === "pnpm"
          ? [
            { name: "PNPM_CONFIG_REGISTRY", value: "https://registry.npmjs.org/" },
            ...(verifiedArtifactPath !== undefined
              ? [{ name: "PNPM_CONFIG_OFFLINE", value: "true" }]
              : []),
          ]
          : []),
        ...(method === "bun"
          ? [
            { name: "BUN_CONFIG_FILE", value: process.platform === "win32" ? "NUL" : "/dev/null" },
            { name: "BUN_CONFIG_REGISTRY", value: "https://registry.npmjs.org/" },
          ]
          : []),
      ]
      : undefined;
    const arguments_ = method === "npm"
      ? [
        "install",
        "--global",
        packageSpecifier,
        ...(buildPolicy.mode === "scripts-disabled" ? ["--ignore-scripts"] : []),
        ...(verifiedArtifactPath !== undefined ? ["--offline"] : []),
      ]
      : method === "pnpm" || method === "bun"
      ? [
        "add",
        "--global",
        packageSpecifier,
        ...(buildPolicy.mode === "scripts-disabled" ? ["--ignore-scripts"] : []),
        ...(verifiedArtifactPath !== undefined ? ["--offline"] : []),
      ]
      : method === "brew" || method === "homebrew"
      ? ["install", version === undefined ? packageName : `${packageName}@${version}`]
      : method === "winget"
      ? version === undefined
        ? ["install", "--id", packageName, "--silent"]
        : ["install", "--id", packageName, "--version", version, "--exact", "--silent"]
      : method === "uv"
      ? [
        "tool",
        "install",
        version === undefined ? packageName : `${packageName}==${version}`,
        ...(buildPolicy.mode === "scripts-disabled" ? ["--only-binary=:all:"] : []),
      ]
      : method === "apt"
      ? ["install", "-y", version === undefined ? packageName : `${packageName}=${version}`]
      : method === "cargo" && version !== undefined
      ? ["install", packageName, "--version", version, "--locked"]
      : ["install", packageName];
    const result = yield* machine.runProcess({
      executable: executable.path,
      arguments: arguments_,
      timeoutMilliseconds: context.limits.processTimeoutMilliseconds,
      maximumOutputBytes: context.limits.maximumProcessOutputBytes,
      environment: packageEnvironment,
      environmentUnsetPrefixes: npmFamily
        ? ["NPM_CONFIG_", "PNPM_CONFIG_", "BUN_CONFIG_"]
        : undefined,
    });
    if (result.exitCode !== 0) {
      return yield* new ActionExecutionError({
        action: context.action.id,
        message: `installer ${method} exited with ${String(result.exitCode)}`,
      });
    }
  });

/** Prepare deterministic work. Preparation stores rollback material before owned-file mutation. */
export const prepareResourceAction = (
  context: ResourceExecutionContext,
  scheduleManager?: ScheduleManager["Service"] | undefined,
): Effect.Effect<PreparedResourceAction, SynchronizationExecutionInputError | MachineStateError, MachineState> => {
  const detail = context.action.detail;
  switch (detail.kind) {
    case "write-file":
      if (context.resource.kind === "schedule") {
        return prepareSchedule(context, scheduleManager);
      }
      return prepareWrite(context, detail.target, detail.digest);
    case "write-config":
      return prepareConfig(context, detail.target, detail.keys);
    case "mirror-directory":
      return prepareMirror(context, detail.target, detail.adds, detail.removes);
    case "remove-resource":
      return prepareRemoval(context, detail, scheduleManager);
    case "install-tool":
      return Effect.succeed({
        execute: installInvocation(
          context,
          detail.method,
          detail.package,
          detail.version,
          detail.buildPolicy,
          detail.source,
        ),
      });
    case "transfer-blob":
      return artifact(context.artifacts, detail.blob).pipe(
        Effect.flatMap((content) =>
          content.byteLength === detail.bytes
            ? Effect.succeed({ execute: Effect.void })
            : Effect.fail(new InvalidArtifactError({
              digest: detail.blob,
              message: `artifact size was ${content.byteLength}, expected ${detail.bytes}`,
            }))
        ),
      );
    case "no-op":
    case "verify-only":
      return Effect.succeed({ execute: Effect.void });
    case "human-action":
    case "agent-task":
    case "drift-conflict":
      return Effect.fail(new InvalidExecutionPlanError({
        message: `${detail.kind} is an outcome action, not executable work`,
      }));
  }
};

const verifyDigest = (
  target: string,
  desiredDigest: string,
): Effect.Effect<ResourceVerification, MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const path = yield* machine.normalizePath({ path: target });
    const kind = yield* machine.inspectPath(path);
    if (kind.kind !== "regular") {
      return {
        passed: false,
        method: `sha256:non-${kind.kind}`,
      };
    }
    const observed = yield* machine.digestFile({ path });
    return {
      passed: observed.value === desiredDigest,
      method: "sha256",
      observedDigest: observed.value,
    };
  });

const verifySchedule = (
  context: ResourceExecutionContext,
  scheduleManager: ScheduleManager["Service"] | undefined,
): Effect.Effect<
  ResourceVerification,
  SynchronizationExecutionInputError | MachineStateError,
  MachineState
> =>
  Effect.gen(function*() {
    if (scheduleManager === undefined || context.desired.kind !== "schedule") {
      return yield* new InvalidExecutionPlanError({
        message: `schedule resource ${context.resource.id} requires ScheduleManager verification`,
      });
    }
    const input = yield* scheduleInputFor(context);
    const status = yield* scheduleManager.status(input);
    return {
      passed: status.state === "current",
      method: `native-scheduler:${status.platform}`,
    };
  });

/** Observe required postconditions independently from action execution. */
export const verifyResource = (
  context: ResourceExecutionContext,
  scheduleManager?: ScheduleManager["Service"] | undefined,
): Effect.Effect<ResourceVerification, SynchronizationExecutionInputError | MachineStateError, MachineState> => {
  const desired = context.desired;
  const verification = context.verification;
  if (desired.kind === "schedule") {
    return verifySchedule(context, scheduleManager);
  }
  if (verification.method === "command") {
    return verifyCommand(context, verification.command, verification.expectContains);
  }
  if (verification.method === "symlink") {
    return verifySymlink(context, verification.target);
  }
  if (verification.method === "executable-present") {
    return verifyExecutable(context, verification.executable);
  }
  if (verification.method === "credential-present") {
    return verifyCredential(context, verification.reference);
  }
  const declaredDigest = verification.digest;
  switch (desired.kind) {
    case "file":
      return Effect.gen(function*() {
        const digest = yield* verifyDigest(
          context.resource.target,
          declaredDigest,
        );
        if (!digest.passed) return digest;
        const machine = yield* MachineState;
        const path = yield* machine.normalizePath({
          path: context.resource.target,
        });
        const permissions = yield* machine.permissions(path);
        const kind = yield* machine.inspectPath(path);
        if (kind.kind !== "regular") {
          return {
            ...digest,
            passed: false,
            method: `${digest.method}+non-${kind.kind}`,
          };
        }
        return {
          ...digest,
          passed: permissions.executableByOwner === desired.executable,
          method: `${digest.method}+permissions`,
        };
      });
    case "skill":
    case "directory":
      return desiredResourceDigest(desired) === declaredDigest
        ? verifyDirectory(context, desired.files)
        : Effect.succeed({
          passed: false,
          method: "declared-directory-digest",
        });
    case "config":
      return desired.digest === declaredDigest
        ? verifyConfig(context, desired.digest, desired.keys)
        : Effect.succeed({
          passed: false,
          method: "declared-config-digest",
        });
    case "tool":
    case "credential":
      return Effect.fail(new InvalidExecutionPlanError({
        message: `resource ${context.resource.id} has incompatible digest verification`,
      }));
  }
};

const verifyCommand = (
  context: ResourceExecutionContext,
  command: ReadonlyArray<string>,
  expectContains?: string,
): Effect.Effect<ResourceVerification, SynchronizationExecutionInputError | MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const [name, ...arguments_] = command;
    if (name === undefined) {
      return yield* new InvalidExecutionPlanError({
        message: `resource ${context.resource.id} has an empty verification command`,
      });
    }
    const machine = yield* MachineState;
    const executable = isAbsolute(name) || win32.isAbsolute(name)
      ? {
        name,
        path: yield* machine.normalizePath({ path: name }),
      }
      : yield* machine.findExecutable({ name });
    const result = yield* machine.runProcess({
      executable: executable.path,
      arguments: arguments_,
      timeoutMilliseconds: context.limits.processTimeoutMilliseconds,
      maximumOutputBytes: context.limits.maximumProcessOutputBytes,
    });
    const output = `${decoder.decode(result.standardOutput)}${decoder.decode(result.standardError)}`;
    return {
      passed: result.exitCode === 0
        && (expectContains === undefined || output.includes(expectContains)),
      method: `command:${name}`,
      exitCode: result.exitCode ?? undefined,
    };
  });

const verifyExecutable = (
  context: ResourceExecutionContext,
  executable: string,
): Effect.Effect<ResourceVerification, MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    return yield* machine.findExecutable({ name: executable }).pipe(
      Effect.as({ passed: true, method: `executable:${executable}` }),
      Effect.catch(() =>
        Effect.succeed({ passed: false, method: `executable:${executable}` })
      ),
    );
  });

const verifyCredential = (
  context: ResourceExecutionContext,
  referenceValue: string,
): Effect.Effect<ResourceVerification, SynchronizationExecutionInputError | MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const reference = yield* Schema.decodeUnknownEffect(CredentialReference)(
      referenceValue,
    ).pipe(
      Effect.mapError((error) =>
        new InvalidExecutionPlanError({ message: String(error) })
      ),
    );
    const machine = yield* MachineState;
    return yield* machine.loadCredential({ reference }).pipe(
      Effect.as({ passed: true, method: `credential:${referenceValue}` }),
      Effect.catch(() =>
        Effect.succeed({ passed: false, method: `credential:${referenceValue}` })
      ),
    );
  });

const verifySymlink = (
  context: ResourceExecutionContext,
  target: string,
): Effect.Effect<ResourceVerification, MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const path = yield* machine.normalizePath({ path: context.resource.target });
    const expected = yield* machine.normalizePath({ path: target });
    return yield* machine.readSymlink(path).pipe(
      Effect.map((observed) => ({
        passed: observed.absolute === expected.absolute,
        method: "symlink-target",
      })),
      Effect.catch(() =>
        Effect.succeed({ passed: false, method: "symlink-target" })
      ),
    );
  });

const verifyDirectory = (
  context: ResourceExecutionContext,
  files: ReadonlyArray<{ readonly path: string; readonly digest: string }>,
): Effect.Effect<ResourceVerification, SynchronizationExecutionInputError | MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const root = yield* targetPath(context.resource.target);
    const machine = yield* MachineState;
    const rootKind = yield* machine.inspectPath(root).pipe(
      Effect.catchTag("MachineFilesystemError", (error) =>
        error.message.includes("ENOENT")
          ? Effect.succeed(undefined)
          : Effect.fail(error)
      ),
    );
    if (rootKind === undefined) {
      return { passed: false, method: "directory-root-missing" };
    }
    if (rootKind.kind !== "directory") {
      return {
        passed: false,
        method: `directory-root-non-${rootKind.kind}`,
      };
    }
    const observations = yield* Effect.forEach(files, (file) =>
      Effect.gen(function*() {
      const path = yield* normalizeRelative(root, file.path);
      const kind = yield* machine.inspectPath(path);
      if (kind.kind !== "regular") {
        return {
          expected: file.digest,
          observed: undefined,
          executable: false,
          expectedExecutable: "executable" in file && file.executable === true,
        };
      }
      const observed = yield* machine.digestFile({ path });
      const permissions = yield* machine.permissions(path);
      const finalKind = yield* machine.inspectPath(path);
        return {
          expected: file.digest,
          observed: finalKind.kind === "regular" ? observed.value : undefined,
          executable: permissions.executableByOwner,
          expectedExecutable: "executable" in file && file.executable === true,
        };
      }), {
      concurrency: context.limits.verificationConcurrency,
    });
    const mismatch = observations.find((observation) =>
      observation.observed !== observation.expected
      || observation.executable !== observation.expectedExecutable
    );
    if (mismatch !== undefined) {
      return {
        passed: false,
        method: "directory-sha256",
        observedDigest: mismatch.observed,
      };
    }
    return { passed: true, method: "directory-sha256" };
  });

const verifyConfig = (
  context: ResourceExecutionContext,
  digest: string,
  keys: ReadonlyArray<string>,
): Effect.Effect<ResourceVerification, SynchronizationExecutionInputError | MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const desiredBytes = yield* artifact(context.artifacts, digest);
    if (context.desired.kind !== "config") {
      return yield* new InvalidExecutionPlanError({
        message: `config verification targets non-config ${context.resource.id}`,
      });
    }
    const desired = yield* Effect.try({
      try: () =>
        parseConfigDocument(
          context.desired.kind === "config" ? context.desired.format : "json",
          decoder.decode(desiredBytes),
        ),
      catch: (error) =>
        new InvalidArtifactError({ digest, message: String(error) }),
    });
    const machine = yield* MachineState;
    const path = yield* machine.normalizePath({ path: context.resource.target });
    const observedBytes = yield* machine.readFile({
      path,
      maximumBytes: context.limits.maximumFileBytes,
    });
    const observed = yield* Effect.try({
      try: () =>
        parseConfigDocument(
          context.desired.kind === "config" ? context.desired.format : "json",
          decoder.decode(observedBytes),
        ),
      catch: (error) =>
        new InvalidExecutionPlanError({
          message: `cannot verify non-object config ${context.resource.target}: ${String(error)}`,
        }),
    });
    const passed = keys.every((key) =>
      JSON.stringify(getConfigPath(observed, key))
        === JSON.stringify(getConfigPath(desired, key))
    );
    return { passed, method: "config-keys" };
  });
