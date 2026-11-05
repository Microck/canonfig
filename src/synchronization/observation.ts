import { Effect, Redacted, Schema } from "effect";

import { ContentDigest, CredentialReference } from "../domain/brand.ts";
import type { ProfileRevision, VerificationInput } from "../domain/profile.ts";
import type { AppliedResourceRecord, ObservedResourceState } from "../domain/synchronization.ts";
import { parseTextComposition } from "../domain/text-composition.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import type { MachineFilesystemError } from "../machine/machine-state.errors.ts";
import { sha256BytesHex, sha256Hex } from "../profile/profile-codec.ts";
import { configKeysDigest, parseConfigDocument, renderConfigDocument } from "./config-codec.ts";
import { defaultSynchronizationExecutionLimits } from "./executor.ts";
import { toolInstallMethods } from "./installer-bindings.ts";
import { installedToolVersion } from "./installed-tool-version.ts";
import { relativePathAncestors, selectToolRecipe } from "./resource-plans.ts";
import type { DesiredResource } from "./synchronization.types.ts";

/**
 * Observing a resource on this machine, and the desired state of a resource
 * that is being removed. Follower sync and projection runs observe through
 * here, so both see the same no-follow, kind-aware state.
 */

/**
 * A version query only reads installer state, so it gets a short bound; a
 * query that does not finish leaves the version unknown and `ensure` keeps
 * the present tool.
 */
const installedVersionTimeoutMilliseconds = 60_000;

const decoder = new TextDecoder();

const isNotFoundFilesystemError = (
  error: MachineFilesystemError,
): boolean => /\b(?:ENOENT|ENOTDIR)\b/u.test(error.message);

const observeFile = (
  target: string,
  desired: Extract<DesiredResource, { readonly kind: "file" }>,
  policy: ProfileRevision["resources"][number]["policy"],
): Effect.Effect<ObservedResourceState, never, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const path = yield* machine.normalizePath({ path: target });
    const observedKind = yield* machine.inspectPath(path);
    if (observedKind.kind === "symlink") {
      return yield* machine.readSymlink(path).pipe(
        Effect.map((symlinkTo): ObservedResourceState => ({
          state: "present",
          digest: desired.symlinkTo === symlinkTo
            ? desired.digest
            : sha256Hex(symlinkTo),
          executable: false,
          objectKind: "symlink",
          symlinkTo,
        })),
      );
    }
    if (observedKind.kind !== "regular") {
      return {
        state: "present",
        digest: sha256Hex(`canonfig:observed-object:${observedKind.kind}`),
        executable: false,
        objectKind: observedKind.kind,
      } as const;
    }
    if (desired.symlinkTo !== undefined) {
      return {
        state: "present",
        digest: sha256Hex("canonfig:observed-object:regular"),
        executable: false,
        objectKind: "regular",
      } as const;
    }
    if (policy === "append-local") {
      const bytes = yield* machine.readFile({ path, maximumBytes: defaultSynchronizationExecutionLimits.maximumFileBytes });
      const composition = yield* Effect.try(() => parseTextComposition(bytes));
      const permissions = yield* machine.permissions(path);
      const observation = {
        state: "present",
        digest: sha256BytesHex(bytes),
        executable: permissions.executableByOwner,
        mode: permissions.mode,
        objectKind: "regular",
      } as const;
      return composition.kind === "managed"
        ? { ...observation, managedSourceDigest: sha256Hex(composition.source) }
        : observation;
    }
    return yield* machine.digestFile({ path }).pipe(
      Effect.flatMap((digest) =>
        machine.permissions(path).pipe(
          Effect.map((permissions): ObservedResourceState => ({
            state: "present",
            digest: digest.value,
            executable: permissions.executableByOwner,
            mode: permissions.mode,
            objectKind: "regular",
          })),
        )
      ),
      Effect.catchTag("MachineFilesystemError", (error) =>
        Effect.succeed(error.message.includes("ENOENT")
          ? { state: "absent" } as const
          : { state: "unverifiable", reason: error.message } as const)
      ),
      Effect.catch((error) =>
        Effect.succeed({ state: "unverifiable", reason: String(error) } as const)
      ),
    );
  }).pipe(
    Effect.catchTag("MachineFilesystemError", (error) =>
      Effect.succeed(error.message.includes("ENOENT")
        ? { state: "absent" } as const
        : { state: "unverifiable", reason: error.message } as const)
    ),
    Effect.catch((error) =>
      Effect.succeed({ state: "unverifiable", reason: String(error) } as const)
    ),
  );

const observeConfig = (
  decoded: {
    readonly resource: Pick<ProfileRevision["resources"][number], "target">;
  },
  desired: Extract<DesiredResource, { readonly kind: "config" }>,
  applied: AppliedResourceRecord | undefined,
): Effect.Effect<ObservedResourceState, never, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const path = yield* machine.normalizePath({ path: decoded.resource.target });
    const observedKind = yield* machine.inspectPath(path);
    if (observedKind.kind !== "regular") {
      return {
        state: "present",
        digest: sha256Hex(`canonfig:observed-object:${observedKind.kind}`),
        executable: false,
        objectKind: observedKind.kind,
      } as const;
    }
    const bytes = yield* machine.readFile({
      path,
      maximumBytes: 8 * 1024 * 1024,
    });
    // An unparseable follower file blocks only the resources that merge into
    // it. Parsing used to throw inside this generator, which escaped as a
    // defect and aborted the whole synchronization with a raw stack trace.
    return yield* Effect.try({
      try: (): ObservedResourceState => {
        const current = parseConfigDocument(desired.format, decoder.decode(bytes));
        // The owned values go through the exact rendering the desired digest
        // used, key ordering included, so an unchanged file observes equal.
        const appliedKeysDigest = applied?.ownedKeys === undefined || applied.configFormat !== desired.format
          ? undefined
          : configKeysDigest(desired.format, current, applied.ownedKeys);
        return {
          state: "present",
          digest: configKeysDigest(desired.format, current, desired.keys)
            ?? sha256BytesHex(renderConfigDocument({ format: desired.format, keys: [] })),
          executable: false,
          objectKind: "regular",
          appliedKeysDigest,
        };
      },
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          state: "unverifiable",
          reason: `${decoded.resource.target} is not valid ${desired.format.toUpperCase()}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        } as const)
      ),
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        String(error).includes("ENOENT")
          ? { state: "absent" } as const
          : { state: "unverifiable", reason: String(error) } as const,
      )
    ),
  );

export const observeFollowerResource = (
  decoded: {
    // `policy` is read so a `replace` directory can be listed in full; the
    // other policies observe only owned and desired paths.
    readonly resource: Pick<
      ProfileRevision["resources"][number],
      "kind" | "target" | "policy"
    >;
  },
  desired: DesiredResource,
  verification: VerificationInput,
  applied?: AppliedResourceRecord,
): Effect.Effect<ObservedResourceState, never, MachineState> => {
  switch (desired.kind) {
    case "file":
      return observeFile(decoded.resource.target, desired, decoded.resource.policy);
    case "config":
      return observeConfig(decoded, desired, applied);
    case "directory":
    case "skill":
      return Effect.gen(function*() {
        const machine = yield* MachineState;
        const root = yield* machine.normalizePath({ path: decoded.resource.target });
        const rootKind = yield* machine.inspectPath(root).pipe(
          Effect.catchTag("MachineFilesystemError", (error) =>
            isNotFoundFilesystemError(error)
              ? Effect.succeed(undefined)
              : Effect.fail(error)
          ),
        );
        if (rootKind === undefined) return { state: "absent" } as const;
        if (rootKind.kind !== "directory") {
          return {
            state: "present",
            digest: sha256Hex(`canonfig:observed-object:${rootKind.kind}`),
            executable: false,
            objectKind: rootKind.kind,
          } as const;
        }
        const rootPermissions = yield* machine.permissions(root);
        // Under `replace` the managed subtree is the desired subtree exactly,
        // so every entry has to be observed, including ones Canonfig never
        // wrote. Observation otherwise inspects only owned and desired paths,
        // which made a locally added file invisible and therefore
        // unremovable: `replace` behaved like `mirror-owned` for anything
        // foreign, and the two policies were the same thing.
        // A projected directory keeps the same full view after takeover, so
        // an entry added to it is reported as drift instead of going unseen.
        const listsEverything = decoded.resource.policy === "replace"
          || decoded.resource.kind === "directory" && decoded.resource.policy === "replace-if-unmodified";
        const foreign = listsEverything
          ? yield* machine.listDirectory(root).pipe(
            Effect.map((entries) =>
              entries.map((entry) => {
                const observed = {
                  path: entry.path,
                  digest: Schema.decodeUnknownSync(ContentDigest)(
                    sha256Hex(`canonfig:observed-object:${entry.kind}`),
                  ),
                  executable: false,
                };
                return entry.kind === "directory"
                  ? { ...observed, objectKind: "directory" as const }
                  : observed;
              })
            ),
          )
          : [];
        const ancestors = [...relativePathAncestors([
          ...desired.files.map((entry) => entry.path),
          ...desired.directories.map((entry) => entry.path),
          ...(applied?.ownedFiles ?? []).map((entry) => entry.path),
        ])].sort((left, right) => left.split("/").length - right.split("/").length);
        const candidates = [...new Map([
          ...ancestors.map((path) => ({ path })),
          ...foreign,
          ...(applied?.ownedFiles ?? []).map((file) => ({
            ...file,
            executable: file.executable ?? false,
          })),
          ...desired.files,
          ...desired.directories.map((directory) => ({
            path: directory.path,
            digest: Schema.decodeUnknownSync(ContentDigest)(sha256Hex("canonfig:directory")),
            executable: (directory.mode & 0o100) !== 0,
            mode: directory.mode,
            objectKind: "directory" as const,
          })),
        ].map((file) => [file.path, file])).values()];
        const blockedAncestors = new Set<string>();
        const files = yield* Effect.forEach(candidates, (file) =>
          Effect.gen(function*() {
            if ([...relativePathAncestors([file.path])].some((ancestor) => blockedAncestors.has(ancestor))) {
              return { path: file.path, state: "absent" } as const;
            }
            const path = yield* machine.normalizePath({ path: file.path, base: root });
            const kind = yield* machine.inspectPath(path).pipe(
              Effect.catchTag("MachineFilesystemError", (error) =>
                isNotFoundFilesystemError(error)
                  ? Effect.succeed(undefined)
                  : Effect.fail(error)
              ),
            );
            if (kind === undefined) {
              blockedAncestors.add(file.path);
              return { path: file.path, state: "absent" } as const;
            }
            if (kind.kind !== "directory") blockedAncestors.add(file.path);
            if (kind.kind === "directory") {
              const permissions = yield* machine.permissions(path);
              return {
                path: file.path,
                digest: sha256Hex("canonfig:directory"),
                executable: permissions.executableByOwner,
                mode: permissions.mode,
                objectKind: "directory" as const,
              };
            }
            if (kind.kind === "symlink") {
              const symlinkTo = yield* machine.readSymlink(path);
              return {
                path: file.path,
                digest: sha256Hex(symlinkTo),
                executable: false,
                objectKind: "symlink" as const,
                symlinkTo,
              };
            }
            if (kind.kind !== "regular") {
              return {
                path: file.path,
                digest: sha256Hex(`canonfig:observed-object:${kind.kind}`),
                executable: false,
                objectKind: kind.kind,
              } as const;
            }
            return yield* machine.digestFile({ path }).pipe(
              Effect.flatMap((digest) =>
                machine.permissions(path).pipe(
                  Effect.map((permissions) => ({
                    path: file.path,
                    digest: digest.value,
                    executable: permissions.executableByOwner,
                    mode: permissions.mode,
                    objectKind: "regular" as const,
                  })),
                )
              ),
              Effect.catchTag("MachineFilesystemError", (error) =>
                isNotFoundFilesystemError(error)
                  ? Effect.succeed({ path: file.path, state: "absent" } as const)
                  : Effect.fail(error)
              ),
            );
          })
        );
        return {
          state: "directory",
          objectKind: "directory",
          mode: rootPermissions.mode,
          files,
        } as const;
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({ state: "unverifiable", reason: String(error) } as const)
        ),
      );
    case "tool":
      return Effect.gen(function*() {
        const machine = yield* MachineState;
        const platform = (yield* machine.userDirectories()).home.platform;
        const qualifiedEntrypoint = desired.qualification === undefined
          ? undefined
          : selectToolRecipe(desired, platform)?.entrypoint;
        const executable = qualifiedEntrypoint
          ?? (verification.method === "executable-present"
            ? verification.executable
            : decoded.resource.target);
        const present = executable.includes("/") || executable.includes("\\")
          ? yield* machine.normalizePath({ path: executable }).pipe(
            Effect.flatMap((path) => machine.permissions(path)),
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          )
          : yield* machine.findExecutable({
            name: executable,
            installMethods: yield* toolInstallMethods(desired.recipes),
          }).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          );
        if (!present) return { state: "absent" } as const;
        // The executable says nothing about its version; ask the installer
        // the plan would use, so a changed pin plans a reinstall.
        const recipe = selectToolRecipe(desired, platform);
        const installedVersion = recipe?.version === undefined
          ? undefined
          : yield* installedToolVersion({
            method: recipe.method,
            package: recipe.package,
            timeoutMilliseconds: installedVersionTimeoutMilliseconds,
            maximumOutputBytes: defaultSynchronizationExecutionLimits.maximumProcessOutputBytes,
          });
        return {
          state: "present",
          digest: sha256Hex(executable),
          executable: true,
          installedVersion,
        } as const;
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({ state: "unverifiable", reason: String(error) } as const)
        ),
      );
    case "credential":
      return Effect.gen(function*() {
        const machine = yield* MachineState;
        const reference = Schema.decodeUnknownSync(CredentialReference)(
          verification.method === "credential-present"
            ? verification.reference
            : desired.reference,
        );
        return yield* machine.loadCredential({ reference }).pipe(
          Effect.map((value) => {
            Redacted.value(value);
            return {
              state: "present",
              digest: sha256Hex(desired.reference),
              executable: false,
            } as const;
          }),
          Effect.catch(() => Effect.succeed({ state: "absent" } as const)),
        );
      });
  }
};

/**
 * The verification a removed resource's own shape requires.
 *
 * Every removed resource used to be given `digest` verification, but the
 * planner requires `symlink` verification for a symlink file and rejects the
 * mismatch, so a follower that had applied a symlink and then stopped
 * receiving it failed every plan and apply with a bare
 * `PlannerVerificationKindMismatchError` before any action was planned. The
 * record was never dropped, so the failure repeated forever and the follower
 * could neither converge nor remove anything.
 */
export const removedResourceVerification = (
  applied: AppliedResourceRecord,
  desired: DesiredResource,
): VerificationInput =>
  desired.kind === "file" && desired.symlinkTo !== undefined
    ? { method: "symlink", target: desired.symlinkTo }
    : { method: "digest", digest: Schema.decodeUnknownSync(ContentDigest)(applied.digest) };

export const removedResourceState = (
  applied: AppliedResourceRecord,
): {
  readonly resource: ProfileRevision["resources"][number];
  readonly desired: DesiredResource;
} | undefined => {
  if (
    applied.kind === undefined
    || applied.policy === undefined
    || applied.target === undefined
  ) {
    return undefined;
  }
  const resource = {
    id: applied.resource,
    kind: applied.kind,
    policy: applied.policy,
    target: applied.target,
    dependsOn: [],
    blobs: [],
  } satisfies ProfileRevision["resources"][number];
  const digest = Schema.decodeUnknownSync(ContentDigest)(applied.digest);
  switch (applied.kind) {
    case "file":
      return {
        resource,
        desired: {
          kind: "file",
          digest,
          executable: applied.executable ?? false,
          mode: applied.mode ?? (applied.executable === true ? 0o700 : 0o600),
          symlinkTo: applied.symlinkTo,
        },
      };
    case "directory":
    case "skill":
      if (applied.ownedFiles === undefined) return undefined;
      const directories = applied.ownedFiles
        .filter((file) => file.objectKind === "directory")
        .map((directory) => ({
          path: directory.path,
          mode: directory.mode ?? 0o700,
        }));
      const files = applied.ownedFiles
        .filter((file) => file.objectKind !== "directory")
        .map((file) => ({
          path: file.path,
          digest: Schema.decodeUnknownSync(ContentDigest)(file.digest),
          executable: file.executable ?? false,
          mode: file.mode ?? (file.executable === true ? 0o700 : 0o600),
          symlinkTo: file.symlinkTo,
        }));
      return {
        resource,
        desired: applied.kind === "skill"
          ? {
            kind: "skill",
            digest,
            mode: applied.mode ?? 0o700,
            directories,
            files,
          }
          : {
            kind: "directory",
            mode: applied.mode ?? 0o700,
            directories,
            files,
          },
      };
    case "config":
      if (
        applied.ownedKeys === undefined
        || applied.configFormat === undefined
      ) {
        return undefined;
      }
      return {
        resource,
        desired: {
          kind: "config",
          digest,
          format: applied.configFormat,
          keys: applied.ownedKeys,
        },
      };
    case "tool":
    case "credential":
      return undefined;
  }
};

