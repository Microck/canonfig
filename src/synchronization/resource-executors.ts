import { Effect, Schema } from "effect";

import { CredentialReference, type RunId } from "../domain/brand.ts";
import type { PublishedResource } from "../domain/profile.ts";
import type { PlannedAction } from "../domain/synchronization.ts";
import type { MachineStateError } from "../machine/machine-state.errors.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import type { MachinePath } from "../machine/machine-state.types.ts";
import { sha256BytesHex, sha256Hex } from "../profile/profile-codec.ts";
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

interface StoredFile {
  readonly path: string;
  readonly existed: boolean;
  readonly content: string;
}

const StoredFileSchema = Schema.Struct({
  path: Schema.NonEmptyString,
  existed: Schema.Boolean,
  content: Schema.String,
});

interface RollbackMaterial {
  readonly reference: string;
  readonly restore: Effect.Effect<void, MachineStateError, MachineState>;
}

export interface ResourceExecutionContext {
  readonly run: RunId;
  readonly action: PlannedAction;
  readonly resource: PublishedResource;
  readonly desired: DesiredResource;
  readonly artifacts: ReadonlyMap<string, SynchronizationArtifact>;
  readonly limits: SynchronizationExecutionLimits;
}

export interface PreparedResourceAction {
  readonly rollbackReference?: string | undefined;
  readonly execute: Effect.Effect<void, SynchronizationExecutionInputError | MachineStateError, MachineState>;
  readonly rollback?: Effect.Effect<void, MachineStateError, MachineState> | undefined;
}

export interface ResourceVerification {
  readonly passed: boolean;
  readonly method: string;
  readonly observedDigest?: string | undefined;
  readonly exitCode?: number | undefined;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const JsonObject = Schema.Record(Schema.String, Schema.MutableJson);

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
    const stored: Array<StoredFile> = [];
    for (const path of paths) {
      const content = yield* readIfPresent(path, context.limits.maximumFileBytes);
      stored.push(content === undefined
        ? { path: path.absolute, existed: false, content: "" }
        : {
          path: path.absolute,
          existed: true,
          content: Buffer.from(content).toString("base64"),
        });
    }
    yield* machine.atomicWrite({
      path: rollbackPath,
      content: encoder.encode(JSON.stringify(stored)),
    });
    const restore = Effect.gen(function*() {
      const activeMachine = yield* MachineState;
      for (const entry of stored) {
        const path = yield* activeMachine.normalizePath({ path: entry.path });
        if (entry.existed) {
          yield* activeMachine.atomicWrite({
            path,
            content: Buffer.from(entry.content, "base64"),
          });
        } else {
          yield* activeMachine.removeFile({ path });
        }
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
    for (const entry of stored) {
      const path = yield* machine.normalizePath({ path: entry.path });
      if (entry.existed) {
        yield* machine.atomicWrite({
          path,
          content: Buffer.from(entry.content, "base64"),
        });
      } else {
        yield* machine.removeFile({ path });
      }
    }
  });

const targetPath = (
  target: string,
): Effect.Effect<MachinePath, MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    return yield* machine.normalizePath({ path: target });
  });

const prepareWrite = (
  context: ResourceExecutionContext,
  target: string,
  digest: string,
): Effect.Effect<PreparedResourceAction, SynchronizationExecutionInputError | MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const path = yield* targetPath(target);
    const content = yield* artifact(context.artifacts, digest);
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
    const path = yield* targetPath(target);
    const desiredBytes = yield* artifact(context.artifacts, context.desired.digest);
    const desired = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(JsonObject),
    )(decoder.decode(desiredBytes)).pipe(
      Effect.mapError((error) =>
        new InvalidArtifactError({
          digest: context.desired.kind === "config" ? context.desired.digest : "",
          message: String(error),
        })
      ),
    );
    const currentBytes = yield* readIfPresent(path, context.limits.maximumFileBytes);
    const current = currentBytes === undefined
      ? {}
      : yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(JsonObject),
      )(decoder.decode(currentBytes)).pipe(
        Effect.mapError((error) =>
          new InvalidExecutionPlanError({
            message: `cannot merge non-object config ${target}: ${String(error)}`,
          })
        ),
      );
    const selected = Object.fromEntries(
      keys.flatMap((key) => key in desired ? [[key, desired[key]]] : []),
    );
    const content = encoder.encode(JSON.stringify({ ...current, ...selected }));
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
    const desiredByPath = new Map(context.desired.files.map((file) => [file.path, file.digest]));
    const contentByPath = new Map<string, Uint8Array>();
    for (const relative of adds) {
      const digest = desiredByPath.get(relative);
      if (digest === undefined) {
        return yield* new InvalidExecutionPlanError({
          message: `mirror add is absent from desired content: ${relative}`,
        });
      }
      contentByPath.set(relative, yield* artifact(context.artifacts, digest));
    }
    const rollback = yield* captureRollback(context, paths);
    const execute = Effect.gen(function*() {
      const activeMachine = yield* MachineState;
      yield* activeMachine.ensureDirectory({ path: root });
      for (const relative of adds) {
        yield* activeMachine.atomicWrite({
          path: byRelative.get(relative)!,
          content: contentByPath.get(relative)!,
        });
      }
      for (const relative of removes) {
        yield* activeMachine.removeFile({ path: byRelative.get(relative)! });
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
): Effect.Effect<void, MachineStateError | ActionExecutionError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const executableName = method === "apt" ? "apt-get" : method;
    const executable = yield* machine.findExecutable({ name: executableName });
    const arguments_ = method === "npm"
      ? ["install", "--global", packageName]
      : method === "winget"
      ? ["install", "--id", packageName, "--silent"]
      : method === "uv"
      ? ["tool", "install", packageName]
      : method === "apt"
      ? ["install", "-y", packageName]
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
): Effect.Effect<PreparedResourceAction, SynchronizationExecutionInputError | MachineStateError, MachineState> => {
  const detail = context.action.detail;
  switch (detail.kind) {
    case "write-file":
      return prepareWrite(context, detail.target, detail.digest);
    case "write-config":
      return prepareConfig(context, detail.target, detail.keys);
    case "mirror-directory":
      return prepareMirror(context, detail.target, detail.adds, detail.removes);
    case "install-tool":
      return Effect.succeed({
        execute: installInvocation(context, detail.method, detail.package),
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

/** Observe required postconditions independently from action execution. */
export const verifyResource = (
  context: ResourceExecutionContext,
): Effect.Effect<ResourceVerification, SynchronizationExecutionInputError | MachineStateError, MachineState> => {
  const desired = context.desired;
  switch (desired.kind) {
    case "file":
    case "schedule":
      return verifyDigest(context.resource.target, desired.digest);
    case "skill":
      return verifyDirectory(context, desired.files);
    case "directory":
      return verifyDirectory(context, desired.files);
    case "config":
      return verifyConfig(context, desired.digest, desired.keys);
    case "tool":
      return Effect.gen(function*() {
        const machine = yield* MachineState;
        return yield* machine.findExecutable({ name: desired.toolId }).pipe(
          Effect.as({
            passed: true,
            method: `executable:${desired.toolId}`,
          }),
          Effect.catchTag("ExecutableNotFoundError", () =>
            Effect.succeed({
              passed: false,
              method: `executable:${desired.toolId}`,
            })
          ),
        );
      });
    case "credential":
      return Effect.gen(function*() {
        const machine = yield* MachineState;
        const reference = yield* Schema.decodeUnknownEffect(CredentialReference)(
          desired.reference,
        ).pipe(
          Effect.mapError((error) =>
            new InvalidExecutionPlanError({ message: String(error) })
          ),
        );
        return yield* machine.loadCredential({ reference }).pipe(
          Effect.as({
            passed: true,
            method: `credential:${desired.reference}`,
          }),
          Effect.catch(() =>
            Effect.succeed({
              passed: false,
              method: `credential:${desired.reference}`,
            })
          ),
        );
      });
  }
};

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
        return { expected: file.digest, observed: observed.value };
      }), {
      concurrency: context.limits.verificationConcurrency,
    });
    const mismatch = observations.find((observation) =>
      observation.observed !== observation.expected
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
    const desired = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(JsonObject),
    )(decoder.decode(desiredBytes)).pipe(
      Effect.mapError((error) =>
        new InvalidArtifactError({ digest, message: String(error) })
      ),
    );
    const machine = yield* MachineState;
    const path = yield* machine.normalizePath({ path: context.resource.target });
    const observedBytes = yield* machine.readFile({
      path,
      maximumBytes: context.limits.maximumFileBytes,
    });
    const observed = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(JsonObject),
    )(decoder.decode(observedBytes)).pipe(
      Effect.mapError((error) =>
        new InvalidExecutionPlanError({
          message: `cannot verify non-object config ${context.resource.target}: ${String(error)}`,
        })
      ),
    );
    const passed = keys.every((key) =>
      JSON.stringify(observed[key]) === JSON.stringify(desired[key])
    );
    return { passed, method: "config-keys" };
  });
