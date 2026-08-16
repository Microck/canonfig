import { Effect, Schema } from "effect";
import { isAbsolute, win32 } from "node:path";

import { CredentialReference, type RunId } from "../domain/brand.ts";
import {
  ResourceSpecInputSchema,
  type PublishedResource,
  type ResourceSpecInput,
  type VerificationInput,
} from "../domain/profile.ts";
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
  serializeConfigDocument,
  setConfigPath,
} from "./config-codec.ts";
import { desiredResourceDigest } from "./resource-plans.ts";

interface LegacyStoredFile {
  readonly path: string;
  readonly existed: boolean;
  readonly content: string;
}

type StoredFile =
  | { readonly path: string; readonly state: "absent" }
  | { readonly path: string; readonly state: "regular"; readonly content: string; readonly mode: number }
  | { readonly path: string; readonly state: "symlink"; readonly target: string }
  | LegacyStoredFile;

const StoredFileSchema = Schema.Union([
  Schema.Struct({
    path: Schema.NonEmptyString,
    state: Schema.Literal("absent"),
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
          yield* machine.mutateWithinRoot({
            root,
            path,
            mutation: { kind: "remove" },
          });
        }
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

const captureRollback = (
  context: ResourceExecutionContext,
  paths: ReadonlyArray<MachinePath>,
  root?: MachinePath | undefined,
): Effect.Effect<RollbackMaterial, MachineStateError, MachineState> =>
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
    const stored = yield* Effect.forEach(
      paths,
      (path) => captureStoredFile(path, context.limits.maximumFileBytes),
    );
    yield* machine.atomicWrite({
      path: rollbackPath,
      content: encoder.encode(JSON.stringify(stored)),
    });
    const restore = Effect.gen(function*() {
      for (const entry of stored) {
        yield* restoreStoredFile(entry, root);
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
        return yield* Effect.forEach(
          [...new Set([...detail.adds, ...detail.removes])],
          (path) => normalizeRelative(root, path),
        );
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
      ? yield* targetPath(context.action.detail.target)
      : undefined;
    for (const entry of stored) {
      yield* restoreStoredFile(entry, root);
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
    const rollback = yield* captureRollback(context, paths, root);
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

const installInvocation = (
  context: ResourceExecutionContext,
  method: string,
  packageName: string,
  version?: string | undefined,
): Effect.Effect<
  void,
  MachineStateError | ActionExecutionError | InvalidExecutionPlanError,
  MachineState
> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const executableName = method === "apt"
      ? "apt-get"
      : method === "homebrew"
      ? "brew"
      : method;
    if (
      version !== undefined
      && !["npm", "brew", "homebrew", "winget", "uv", "cargo", "apt"].includes(method)
    ) {
      return yield* new InvalidExecutionPlanError({
        message: `installer ${method} cannot honor requested version ${version}`,
      });
    }
    const executable = yield* machine.findExecutable({ name: executableName });
    const arguments_ = method === "npm"
      ? [
        "install",
        "--global",
        version === undefined ? packageName : `${packageName}@${version}`,
        "--ignore-scripts",
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
        "--only-binary=:all:",
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
    case "install-tool":
      return Effect.succeed({
        execute: installInvocation(
          context,
          detail.method,
          detail.package,
          detail.version,
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
    const observations = yield* Effect.forEach(files, (file) =>
      Effect.gen(function*() {
      const path = yield* normalizeRelative(root, file.path);
      const observed = yield* machine.digestFile({ path });
      const permissions = yield* machine.permissions(path);
        return {
          expected: file.digest,
          observed: observed.value,
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
