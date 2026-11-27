import { Effect, Schema } from "effect";

import { ContentDigest, CredentialReference, parseSurfaceResourceId, resourcesOwner, type ResourceId } from "../domain/brand.ts";
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
import { authoredResourceAnchor } from "./resource-executors.ts";
import { relativePathAncestors, selectToolRecipe } from "./resource-plans.ts";
import type { DesiredResource } from "./synchronization.types.ts";
import { binaryDestination, binaryFormatProblem, binaryRecipeProblem } from "./binary-artifact.ts";
import { recipeSourceDetails } from "../domain/recipe-versions.ts";
import { verifyNpmArtifactBytes } from "./npm-artifact.ts";

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
  /** Read the marked composition: the policy is append-local now or was when last applied. */
  composed: boolean,
  resourceId: ResourceId | undefined,
): Effect.Effect<ObservedResourceState, never, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const anchor = yield* authoredResourceAnchor(resourceId);
    const path = yield* machine.normalizePath({ path: target });
    const observedKind = yield* machine.inspectPath(path, anchor);
    if (observedKind.kind === "symlink") {
      return yield* machine.readSymlink(path, anchor).pipe(
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
    if (composed) {
      const bytes = yield* machine.readFile({ path, anchor, maximumBytes: defaultSynchronizationExecutionLimits.maximumFileBytes });
      const composition = yield* Effect.try(() => parseTextComposition(bytes));
      const permissions = yield* machine.permissions(path, anchor);
      const observation = {
        state: "present",
        digest: sha256BytesHex(bytes),
        executable: permissions.executableByOwner,
        mode: permissions.mode,
        objectKind: "regular",
      } as const;
      return composition.kind === "managed"
        ? { ...observation, textComposition: { kind: "managed" as const, sourceDigest: sha256Hex(composition.source), hasLocal: composition.local.length > 0 } }
        : { ...observation, textComposition: { kind: "unmanaged" as const } };
    }
    return yield* machine.digestFile({ path, anchor }).pipe(
      Effect.flatMap((digest) =>
        machine.permissions(path, anchor).pipe(
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
    readonly resource: Pick<ProfileRevision["resources"][number], "target"> & { readonly id?: ResourceId };
  },
  desired: Extract<DesiredResource, { readonly kind: "config" }>,
  applied: AppliedResourceRecord | undefined,
): Effect.Effect<ObservedResourceState, never, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const anchor = yield* authoredResourceAnchor(decoded.resource.id);
    const path = yield* machine.normalizePath({ path: decoded.resource.target });
    const observedKind = yield* machine.inspectPath(path, anchor);
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
      anchor,
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
        const appliedKeysDigest = applied?.ownership !== "ConfigKeys" || applied.configFormat !== desired.format
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
    // `policy` decides how much of a directory is listed: all of it under
    // `replace` and for a `replace-if-unmodified` directory, Canonfig's
    // top-level entries under `append-local`, and otherwise only owned and
    // desired paths.
    readonly resource: Pick<
      ProfileRevision["resources"][number],
      "kind" | "target" | "policy"
    > & { readonly id?: ResourceId };
    // Restore preflight and retirement reconstruct desired paths from the
    // applied record. Those paths describe what exists, not what stays.
    readonly retainsDesiredDirectories?: boolean;
  },
  desired: DesiredResource,
  verification: VerificationInput,
  applied?: AppliedResourceRecord,
): Effect.Effect<ObservedResourceState, never, MachineState> => {
  switch (desired.kind) {
    case "file":
      return observeFile(
        decoded.resource.target,
        desired,
        decoded.resource.policy === "append-local" || applied?.policy === "append-local",
        decoded.resource.id,
      );
    case "config":
      return observeConfig(decoded, desired, applied);
    case "directory":
    case "skill":
      return Effect.gen(function*() {
        const machine = yield* MachineState;
        const anchor = yield* authoredResourceAnchor(decoded.resource.id);
        const root = yield* machine.normalizePath({ path: decoded.resource.target });
        const rootKind = yield* machine.inspectPath(root, anchor).pipe(
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
        const rootPermissions = yield* machine.permissions(root, anchor);
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
        // Under `append-local` Canonfig owns only the top-level entries it
        // writes or wrote (a skill directory, a file), so each of those is
        // listed in full: a file the machine adds inside one is drift. The
        // machine's own top-level entries are never read; the planner's
        // append-local view drops them in any case.
        const desiredPaths = [...desired.files, ...desired.directories].map((entry) => entry.path);
        const ownedPaths = applied?.ownership === "DirectoryEntries" ? applied.ownedFiles.map((entry) => entry.path) : [];
        const managedPaths = [...desiredPaths, ...ownedPaths];
        const claimed = decoded.resource.policy === "append-local"
          ? [...new Set(managedPaths.map((path) => path.split("/", 1)[0]!))].sort()
          : [];
        const listed = listsEverything
          ? yield* machine.listDirectory(root, anchor)
          : yield* Effect.forEach(claimed, (name) =>
            Effect.gen(function*() {
              const entry = yield* machine.normalizePath({ path: name, base: root });
              const kind = yield* machine.inspectPath(entry, anchor).pipe(
                Effect.catchTag("MachineFilesystemError", (error) =>
                  isNotFoundFilesystemError(error) ? Effect.succeed(undefined) : Effect.fail(error)
                ),
              );
              if (kind?.kind !== "directory") return [];
              return (yield* machine.listDirectory(entry, anchor)).map((child) => ({ ...child, path: `${name}/${child.path}` }));
            })).pipe(Effect.map((lists) => lists.flat()));
        const surface = decoded.resource.id === undefined ? undefined : parseSurfaceResourceId(decoded.resource.id);
        const individualSkill = surface?.surface.startsWith("skill.") === true;
        const projectedSkills = surface !== undefined && surface.harness !== resourcesOwner
          && (surface.surface === "skills" || individualSkill);
        let observedEntries = listed;
        if (projectedSkills && decoded.retainsDesiredDirectories) {
          const managed = new Set(managedPaths);
          const retainedDirectories = new Set([...desired.directories.map((entry) => entry.path), ...relativePathAncestors(desiredPaths)]);
          // Only a per-skill resource has the skill itself at the observation root.
          if (individualSkill) retainedDirectories.add("");
          // Python imports create bytecode beside skill scripts. Keep those
          // undeclared runtime files local, but never hide an owned path or link.
          observedEntries = listed.filter((entry) => {
            if (managed.has(entry.path)) return true;
            const parts = entry.path.split("/");
            const name = parts.at(-1)!;
            const cacheDirectory = entry.kind === "directory" && name === "__pycache__";
            const bytecode = entry.kind === "regular" && parts.at(-2) === "__pycache__" && name.endsWith(".pyc");
            if (!cacheDirectory && !bytecode) return true;
            // A cache cannot be left behind when its parent is removed or
            // replaced. Keep the existing drift protection for those operations.
            const parent = parts.slice(0, cacheDirectory ? -1 : -2).join("/");
            return !retainedDirectories.has(parent);
          });
        }
        const ancestors = [...relativePathAncestors(managedPaths)]
          .sort((left, right) => left.split("/").length - right.split("/").length);
        const candidates = new Set([
          ...ancestors,
          ...observedEntries.map((entry) => entry.path),
          ...ownedPaths,
          ...desiredPaths,
        ]);
        const blockedAncestors = new Set<string>();
        const files = yield* Effect.forEach(candidates, (relativePath) =>
          Effect.gen(function*() {
            if ([...relativePathAncestors([relativePath])].some((ancestor) => blockedAncestors.has(ancestor))) {
              return { path: relativePath, state: "absent" } as const;
            }
            const path = yield* machine.normalizePath({ path: relativePath, base: root });
            const kind = yield* machine.inspectPath(path, anchor).pipe(
              Effect.catchTag("MachineFilesystemError", (error) =>
                isNotFoundFilesystemError(error)
                  ? Effect.succeed(undefined)
                  : Effect.fail(error)
              ),
            );
            if (kind === undefined) {
              blockedAncestors.add(relativePath);
              return { path: relativePath, state: "absent" } as const;
            }
            if (kind.kind !== "directory") blockedAncestors.add(relativePath);
            if (kind.kind === "directory") {
              const permissions = yield* machine.permissions(path, anchor);
              return {
                path: relativePath,
                digest: sha256Hex("canonfig:directory"),
                executable: permissions.executableByOwner,
                mode: permissions.mode,
                objectKind: "directory" as const,
              };
            }
            if (kind.kind === "symlink") {
              const symlinkTo = yield* machine.readSymlink(path, anchor);
              return {
                path: relativePath,
                digest: sha256Hex(symlinkTo),
                executable: false,
                objectKind: "symlink" as const,
                symlinkTo,
              };
            }
            if (kind.kind !== "regular") {
              return {
                path: relativePath,
                digest: sha256Hex(`canonfig:observed-object:${kind.kind}`),
                executable: false,
                objectKind: kind.kind,
              } as const;
            }
            return yield* machine.digestFile({ path, anchor }).pipe(
              Effect.flatMap((digest) =>
                machine.permissions(path, anchor).pipe(
                  Effect.map((permissions) => ({
                    path: relativePath,
                    digest: digest.value,
                    executable: permissions.executableByOwner,
                    mode: permissions.mode,
                    objectKind: "regular" as const,
                  })),
                )
              ),
              Effect.catchTag("MachineFilesystemError", (error) =>
                isNotFoundFilesystemError(error)
                  ? Effect.succeed({ path: relativePath, state: "absent" } as const)
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
        const binary = selectToolRecipe(desired, platform);
        if (binary?.method === "binary") {
          const problem = binaryRecipeProblem(binary);
          if (problem !== undefined) return { state: "absent" } as const;
          const { home, path } = yield* binaryDestination(binary);
          return yield* Effect.gen(function* () {
            yield* machine.validatePathWithinRoot({ root: home, path });
            const object = yield* machine.inspectPath(path);
            if (object.kind !== "regular") return { state: "unverifiable", reason: "Binary destination is not a regular file" } as const;
            const bytes = yield* machine.readFile({ path, maximumBytes: 128 * 1024 * 1024 });
            const permissions = yield* machine.permissions(path);
            const source = recipeSourceDetails(binary.source);
            const integrity = source.archive?.executableIntegrity ?? source.integrity!;
            return { state: "present", objectKind: "regular", digest: sha256BytesHex(bytes), executable: permissions.executableByOwner,
              installedVersion: verifyNpmArtifactBytes(bytes, integrity)
                && binaryFormatProblem(bytes, platform, binary.architecture!) === undefined
                && (platform === "windows" || permissions.executableByOwner) ? binary.version : undefined } as const;
          }).pipe(Effect.catchTag("MachineFilesystemError", (error) =>
            isNotFoundFilesystemError(error) ? Effect.succeed({ state: "absent" } as const) : Effect.fail(error)));
        }
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
        return { state: "tool", installedVersion } as const;
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
          Effect.as({ state: "credential" } as const),
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
  const resource = {
    id: applied.resource,
    kind: applied.kind,
    policy: applied.policy,
    target: applied.target,
    dependsOn: [],
    blobs: [],
  } satisfies ProfileRevision["resources"][number];
  const digest = applied.digest;
  switch (applied.ownership) {
    case "WholeFile":
    case "SourceSection":
      return {
        resource,
        desired: {
          kind: "file",
          digest,
          executable: applied.executable,
          mode: applied.mode,
        },
      };
    case "Symlink":
      return {
        resource,
        desired: { kind: "file", digest, executable: false, mode: 0, symlinkTo: applied.symlinkTo },
      };
    case "DirectoryEntries":
      const directories = applied.ownedFiles
        .filter((file) => file.objectKind === "directory")
        .map((directory) => ({
          path: directory.path,
          mode: directory.mode,
        }));
      const files = applied.ownedFiles
        .filter((file) => file.objectKind !== "directory")
        .map((file) => ({
          path: file.path,
          digest: file.digest,
          executable: file.executable,
          mode: file.mode,
          symlinkTo: file.symlinkTo,
        }));
      return {
        resource,
        desired: applied.kind === "skill"
          ? {
            kind: "skill",
            digest,
            mode: applied.mode,
            directories,
            files,
          }
          : {
            kind: "directory",
            mode: applied.mode,
            directories,
            files,
          },
      };
    case "ConfigKeys":
      return {
        resource,
        desired: {
          kind: "config",
          digest,
          format: applied.configFormat,
          keys: applied.ownedKeys,
        },
      };
    case "QualifiedTool":
      // Qualified provenance pins verification, not permission to uninstall software.
      return undefined;
    default: {
      const unexpected: never = applied;
      throw new Error(`Unknown applied resource ownership: ${String(unexpected)}`);
    }
  }
};

