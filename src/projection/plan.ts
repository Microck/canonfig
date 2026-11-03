import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";

import { Effect, Schema } from "effect";

import { ContentDigest, ProfileRevisionId, ResourceId } from "../domain/brand.ts";
import type { ResourceId as ResourceIdType } from "../domain/brand.ts";
import { configPathSegments } from "../domain/config-path.ts";
import type { PublishedResource, VerificationInput } from "../domain/profile.ts";
import type { ApplyPolicy, ConfigValue } from "../domain/resource.ts";
import {
  localProjectionFollower,
  type AppliedResourceRecord,
  type ObservedResourceState,
} from "../domain/synchronization.ts";
import { TaggedError } from "../domain/tagged-error.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import {
  canonicalJson,
  directoryVerificationDigest,
  sha256BytesHex,
  sha256Hex,
} from "../profile/profile-codec.ts";
import type { HarnessTakeover } from "../state/state-repository.types.ts";
import { renderConfigDocument } from "../synchronization/config-codec.ts";
import {
  observeFollowerResource,
  removedResourceState,
  removedResourceVerification,
} from "../synchronization/follower-orchestration.ts";
import { planSynchronization } from "../synchronization/planner.ts";
import { planResource, relativePathAncestors } from "../synchronization/resource-plans.ts";
import type {
  DesiredResource,
  DesiredResourceEntry,
  ObservedResourceEntry,
  PlannedSynchronization,
  PlanningLocalRevision,
  SynchronizationArtifact,
} from "../synchronization/synchronization.types.ts";
import { adapterFor } from "./adapters/index.ts";
import { CanonicalFolderError, type LoadedFolder } from "./folder.ts";
import type {
  ConfigFormat,
  Diagnostic,
  HarnessLayout,
  OwnedSurface,
  RootContext,
  SurfaceContent,
} from "./harness.ts";
import type { TargetId } from "./model.ts";
import { hookRegistryJson, hookRunnerSource } from "./templates/runtime.ts";
import type { Snapshot, SnapshotEntry, TakeoverUnit } from "./takeover.ts";
import { snapshotCopy } from "./takeover.ts";

/**
 * Projection planning: the Canonical Model becomes internal `file`,
 * `directory` and `config` resources at adapter-computed targets, observed
 * and planned by the same planner a follower uses. A restore is planned the
 * same way from a takeover snapshot.
 */

/** Projection cannot continue without a person deciding something. */
export class ProjectionHumanActionError extends TaggedError<ProjectionHumanActionError>()(
  "ProjectionHumanActionError",
  { harness: Schema.optional(Schema.String), message: Schema.String },
) {}

/** The pseudo-harness that owns the shared `~/.agents/skills/` surface. */
export const sharedSkillsOwner = "agents";

/** One surface with the content this run projects into it. */
export interface ProjectedSurface {
  readonly harness: string;
  readonly root: string;
  readonly surface: OwnedSurface;
  readonly content: SurfaceContent;
}

/** A harness surface's resource id: `harness:<harness>:<surface>`. */
export const surfaceResourceId = (harness: string, surface: string): ResourceIdType =>
  Schema.decodeUnknownSync(ResourceId)(`harness:${harness}:${surface}`);

/** The harness and surface a projection resource id names, if it names one. */
export const parseSurfaceResourceId = (
  id: string,
): { readonly harness: string; readonly surface: string } | undefined => {
  const match = /^harness:([^:]+):(.+)$/u.exec(id);
  return match === null ? undefined : { harness: match[1]!, surface: match[2]! };
};

const pathsFor = (platform: RootContext["platform"]) => platform === "windows" ? win32 : posix;

/** True when `path` is `root` or lies beneath it. */
const within = (paths: typeof posix, root: string, path: string): boolean => {
  const fromRoot = paths.relative(root, path);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !paths.isAbsolute(fromRoot));
};

/** Whether a declared key and a reserved pattern (`*` matches one segment) overlap. */
const reservedOverlap = (key: string, reserved: string): boolean => {
  const left = configPathSegments(key);
  const right = configPathSegments(reserved);
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (right[index] !== "*" && left[index] !== right[index]) return false;
  }
  return true;
};

const encoder = new TextEncoder();
const bytesOf = (content: string | Uint8Array): Uint8Array =>
  content instanceof Uint8Array ? content : encoder.encode(content);

/** Build the RootContext adapters resolve paths with. */
export const rootContext = (environment: (name: string) => string | undefined) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const directories = yield* machine.userDirectories();
    const platform = directories.home.platform;
    const paths = pathsFor(platform);
    return {
      platform,
      home: directories.home.absolute,
      appData: directories.config.absolute,
      environment: (name: string) => {
        const value = environment(name);
        return value === undefined || value.length === 0 ? undefined : value;
      },
      join: (...segments: ReadonlyArray<string>) => paths.join(...segments),
    } satisfies RootContext;
  });

/** A config surface's file: `target`, or the first alternative that exists when it does not. */
const resolveConfigTarget = (surface: Extract<OwnedSurface, { readonly kind: "config" }>) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const exists = (path: string) =>
      machine.normalizePath({ path }).pipe(
        Effect.flatMap((normalized) => machine.inspectPath(normalized)),
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
    if (yield* exists(surface.target)) return surface.target;
    for (const alternative of surface.alternatives ?? []) {
      if (yield* exists(alternative)) return alternative;
    }
    return surface.target;
  });

/** Merge a harness's declared settings into its settings file's content. */
const withSettings = (
  harness: TargetId,
  layout: HarnessLayout,
  contents: ReadonlyArray<SurfaceContent>,
  settings: ReadonlyArray<{ readonly path: string; readonly value: ConfigValue }>,
  configPath: string,
): ReadonlyArray<SurfaceContent> => {
  if (settings.length === 0) return contents;
  const surface = layout.surfaces.find((candidate) =>
    candidate.kind === "config" && candidate.settings !== undefined
  );
  if (surface === undefined || surface.kind !== "config") {
    throw new CanonicalFolderError({ path: configPath, message: `settings.${harness}: ${harness} has no settings file Canonfig writes` });
  }
  for (const entry of settings) {
    const reserved = (surface.settings?.reserved ?? []).find((pattern) => reservedOverlap(entry.path, pattern));
    if (reserved !== undefined) {
      throw new CanonicalFolderError({ path: configPath, message: `settings.${harness}.${entry.path} overlaps ${reserved}, which ${harness} keeps for itself` });
    }
    const owned = surface.keys.find((key) => reservedOverlap(entry.path, key));
    if (owned !== undefined) {
      throw new CanonicalFolderError({ path: configPath, message: `settings.${harness}.${entry.path} overlaps ${owned}, which Canonfig already writes from the folder` });
    }
  }
  const existing = contents.find((content) => content.surface === surface.id);
  const keys = [...(existing?.kind === "config" ? existing.keys : []), ...settings];
  return [
    ...contents.filter((content) => content !== existing),
    { kind: "config", surface: surface.id, keys },
  ];
};

export interface HarnessPlan {
  readonly harness: TargetId;
  readonly layout: HarnessLayout;
}

/**
 * Every surface this run projects, with harness roots checked: inside the
 * home directory, and equal to the root pinned at takeover.
 */
export const projectSurfaces = (
  loaded: LoadedFolder,
  context: RootContext,
  takeovers: ReadonlyArray<HarnessTakeover>,
) =>
  Effect.gen(function*() {
    const model = loaded.model;
    const paths = pathsFor(context.platform);
    const runtime = {
      folder: model.folder,
      hookRunner: paths.join(model.folder, ".runtime", "hook-runner.mjs"),
      platform: context.platform,
    };
    const configPath = paths.join(model.folder, "canonfig.jsonc");
    const pinned = new Map(takeovers.map((takeover) => [takeover.harness, takeover.root]));
    const checkRoot = (harness: string, root: string) => {
      if (!within(paths, context.home, root)) {
        return Effect.fail(new ProjectionHumanActionError({
          harness,
          message: `${harness} resolves to ${root}, outside the home directory ${context.home}; Canonfig projects only into roots inside the home directory`,
        }));
      }
      const previous = pinned.get(harness);
      if (previous !== undefined && previous !== root) {
        return Effect.fail(new ProjectionHumanActionError({
          harness,
          message: `${harness} was taken over at ${previous} but now resolves to ${root}, for example because an environment override such as CODEX_HOME changed. Canonfig will not project into a second location: restore the environment, or run 'canonfig restore' and sync again`,
        }));
      }
      return Effect.void;
    };
    const surfaces: Array<ProjectedSurface> = [];
    const diagnostics: Array<Diagnostic> = loaded.ignoredLocal.map((path) => ({
      level: "warning" as const,
      code: "LOCAL_NOT_ALLOWED",
      message: `${path} is not admitted by canonfig.jsonc local.allow and was not projected`,
    }));
    const harnesses: Array<HarnessPlan> = [];
    for (const harness of model.harnesses) {
      const adapter = adapterFor(harness);
      const layout = adapter.layout(context, model);
      yield* checkRoot(harness, layout.root);
      harnesses.push({ harness, layout });
      const projection = adapter.project(model, layout, runtime);
      diagnostics.push(...projection.diagnostics);
      const contents = yield* Effect.try({
        try: () => withSettings(harness, layout, projection.contents, model.settings[harness] ?? [], configPath),
        catch: (error) => error instanceof CanonicalFolderError
          ? error
          : new CanonicalFolderError({ path: configPath, message: String(error) }),
      });
      for (const content of contents) {
        const surface = layout.surfaces.find((candidate) => candidate.id === content.surface);
        if (surface === undefined || surface.kind !== content.kind) {
          return yield* Effect.die(new Error(`${harness} projected content for undeclared surface ${content.surface}`));
        }
        const resolved = surface.kind === "config"
          ? { ...surface, target: yield* resolveConfigTarget(surface) }
          : surface;
        surfaces.push({ harness, root: layout.root, surface: resolved, content });
      }
    }
    if (model.skills.length > 0 && harnesses.some((entry) => entry.layout.sharedSkills)) {
      const root = paths.join(context.home, ".agents");
      yield* checkRoot(sharedSkillsOwner, root);
      surfaces.push({
        harness: sharedSkillsOwner,
        root,
        surface: { id: "skills", kind: "directory", target: paths.join(root, "skills") },
        content: {
          kind: "directory",
          surface: "skills",
          files: model.skills.flatMap((skill) => skill.files.map((file) => ({
            path: `${skill.name}/${file.path}`,
            content: file.content,
            executable: file.executable,
          }))),
        },
      });
    }
    return { surfaces, harnesses, diagnostics, runtime };
  });

/** Units of takeover: whole files and directories, and single config keys. */
const takeoverUnits = (projected: ProjectedSurface): ReadonlyArray<TakeoverUnit> => {
  const base = { harness: projected.harness, root: projected.root, target: projected.surface.target };
  if (projected.surface.kind !== "config" || projected.content.kind !== "config") {
    return [{ ...base, surface: projected.surface.id, kind: projected.surface.kind }];
  }
  const format = projected.surface.format;
  return projected.content.keys.map((entry) => ({
    ...base,
    surface: `${projected.surface.id}#${entry.path}`,
    kind: "config" as const,
    format,
    key: entry.path,
  }));
};

interface BuiltResource {
  readonly resource: PublishedResource;
  readonly entry: DesiredResourceEntry;
  readonly artifacts: ReadonlyArray<SynchronizationArtifact>;
}

const fileResource = (
  id: ResourceIdType,
  target: string,
  policy: ApplyPolicy,
  content: Uint8Array,
  executable: boolean,
): BuiltResource => {
  const digest = sha256BytesHex(content);
  return {
    resource: { id, kind: "file", policy, target, dependsOn: [], blobs: [] },
    entry: {
      resource: id,
      desired: { kind: "file", digest, executable, mode: executable ? 0o700 : 0o600 },
      verification: { method: "digest", digest },
    },
    artifacts: [{ digest, content }],
  };
};

const directoryResource = (
  id: ResourceIdType,
  target: string,
  policy: ApplyPolicy,
  files: ReadonlyArray<{ readonly path: string; readonly content: Uint8Array; readonly executable: boolean }>,
): BuiltResource => {
  const desiredFiles = files.map((file) => ({
    path: file.path,
    digest: sha256BytesHex(file.content),
    executable: file.executable,
    mode: file.executable ? 0o700 : 0o600,
  }));
  // Subdirectories are declared, so Canonfig owns them too and removing the
  // surface (or restoring a snapshot that had none) leaves no empty skeleton.
  const directories = [...relativePathAncestors(desiredFiles.map((file) => file.path))]
    .sort()
    .map((path) => ({ path, mode: 0o700 }));
  return {
    resource: { id, kind: "directory", policy, target, dependsOn: [], blobs: [] },
    entry: {
      resource: id,
      desired: { kind: "directory", mode: 0o700, directories, files: desiredFiles },
      verification: { method: "digest", digest: directoryVerificationDigest(desiredFiles) },
    },
    artifacts: files.map((file, index) => ({ digest: desiredFiles[index]!.digest, content: file.content })),
  };
};

const configResource = (
  id: ResourceIdType,
  target: string,
  policy: ApplyPolicy,
  format: ConfigFormat,
  keys: ReadonlyArray<{ readonly path: string; readonly value: ConfigValue }>,
): BuiltResource => {
  const content = renderConfigDocument({ format, keys });
  const digest = sha256BytesHex(content);
  return {
    resource: { id, kind: "config", policy, target, dependsOn: [], blobs: [] },
    entry: {
      resource: id,
      desired: {
        kind: "config",
        digest,
        format,
        keys: keys.map((entry) => entry.path).sort((left, right) => left.localeCompare(right)),
      },
      verification: { method: "digest", digest },
    },
    artifacts: [{ digest, content }],
  };
};

export interface LocalRevisionPlan {
  readonly revision: PlanningLocalRevision;
  readonly plan: PlannedSynchronization;
  readonly artifacts: ReadonlyArray<SynchronizationArtifact>;
  readonly appliedResources: ReadonlyArray<AppliedResourceRecord>;
}

/**
 * Observe and plan a set of built resources, plus removal of every applied
 * resource the set no longer holds, through the shared planner.
 */
const planBuilt = (
  origin: PlanningLocalRevision["origin"],
  originDigest: string,
  built: ReadonlyArray<BuiltResource>,
  retired: ReadonlyArray<AppliedResourceRecord>,
  appliedResources: ReadonlyArray<AppliedResourceRecord>,
  endsOwnership: ReadonlyArray<ResourceIdType> = [],
) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const appliedById = new Map(appliedResources.map((record) => [record.resource, record]));
    const resources: Array<PublishedResource> = [];
    const desired: Array<DesiredResourceEntry> = [];
    const observations: Array<ObservedResourceEntry> = [];
    const observe = (resource: PublishedResource, desiredResource: DesiredResource, verification: VerificationInput) =>
      Effect.gen(function*() {
        const observed: ObservedResourceState = yield* observeFollowerResource(
          { resource },
          desiredResource,
          verification,
          appliedById.get(resource.id),
        );
        const resolved = yield* machine.normalizePath({ path: resource.target });
        observations.push({ resource: resource.id, resolvedTarget: resolved.absolute, observed });
      });
    for (const item of built) {
      resources.push(item.resource);
      desired.push(item.entry);
      yield* observe(item.resource, item.entry.desired, item.entry.verification);
    }
    const removedResources: Array<ResourceIdType> = [];
    for (const record of retired) {
      const state = removedResourceState(record);
      if (state === undefined) continue;
      const verification = removedResourceVerification(record, state.desired);
      resources.push(state.resource);
      desired.push({ resource: state.resource.id, desired: state.desired, verification });
      removedResources.push(state.resource.id);
      yield* observe(state.resource, state.desired, verification);
    }
    // The run's revision lists every resource whose ownership it ends; the
    // planner sees only the retired ones, so the others are planned as writes.
    const content = {
      origin,
      originDigest: Schema.decodeUnknownSync(ContentDigest)(originDigest),
      resources,
      desired,
      blobs: [],
      removedResources: [...new Set([...removedResources, ...endsOwnership])].sort(),
    };
    const revision: PlanningLocalRevision = {
      ...content,
      id: Schema.decodeUnknownSync(ProfileRevisionId)(
        `local:${sha256Hex(canonicalJson(JSON.parse(JSON.stringify(content))))}`,
      ),
    };
    const plan = yield* planSynchronization({
      revision: { ...revision, removedResources },
      follower: localProjectionFollower,
      observedState: {
        platform: (yield* machine.userDirectories()).home.platform,
        resources: observations,
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources,
    });
    const artifacts = [...new Map(built.flatMap((item) => item.artifacts).map((artifact) => [artifact.digest, artifact])).values()];
    return { revision, plan, artifacts, appliedResources };
  });

export interface FolderPlan extends LocalRevisionPlan {
  /** Surfaces (and config keys) this run takes over, not yet owned. */
  readonly takeovers: ReadonlyArray<TakeoverUnit>;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

/**
 * Whether an applied resource belongs to a held harness: listed but not
 * installed on this run. Its outputs stay as last applied instead of being
 * retired, so a scheduled run whose narrower PATH misses an executable does
 * not undo what an interactive run projected. The shared skills surface is
 * held while a held harness reads it.
 */
const heldResource = (
  held: ReadonlyArray<TargetId>,
  context: RootContext,
  model: LoadedFolder["model"],
) => {
  const harnesses = new Set<string>(held);
  if (held.some((harness) => adapterFor(harness).layout(context, model).sharedSkills)) harnesses.add(sharedSkillsOwner);
  return (record: AppliedResourceRecord) => {
    const parsed = parseSurfaceResourceId(record.resource);
    return parsed !== undefined && harnesses.has(parsed.harness);
  };
};

/**
 * Plan a projection of the folder into its selected harnesses minus `held`
 * ones (listed but not installed). A surface not yet taken over is written
 * with `replace` (`merge` for config keys); afterward the three-way
 * `replace-if-unmodified` rule protects local edits.
 */
export const planFolder = (
  loaded: LoadedFolder,
  context: RootContext,
  takeovers: ReadonlyArray<HarnessTakeover>,
  appliedResources: ReadonlyArray<AppliedResourceRecord>,
  held: ReadonlyArray<TargetId> = [],
) =>
  Effect.gen(function*() {
    const model = { ...loaded.model, harnesses: loaded.model.harnesses.filter((harness) => !held.includes(harness)) };
    const projected = yield* projectSurfaces({ ...loaded, model }, context, takeovers);
    const owned = new Set(takeovers.map((takeover) => `${takeover.harness}\0${takeover.surface}`));
    const units: Array<TakeoverUnit> = [];
    const built: Array<BuiltResource> = [];
    for (const entry of projected.surfaces) {
      const pending = takeoverUnits(entry).filter((unit) => !owned.has(`${unit.harness}\0${unit.surface}`));
      units.push(...pending);
      const id = surfaceResourceId(entry.harness, entry.surface.id);
      const content = entry.content;
      if (content.kind === "file") {
        built.push(fileResource(id, entry.surface.target, pending.length > 0 ? "replace" : "replace-if-unmodified", bytesOf(content.content), content.executable ?? false));
      } else if (content.kind === "directory") {
        built.push(directoryResource(
          id,
          entry.surface.target,
          pending.length > 0 ? "replace" : "replace-if-unmodified",
          content.files.map((file) => ({ path: file.path, content: bytesOf(file.content), executable: file.executable ?? false })),
        ));
      } else if (entry.surface.kind === "config") {
        // One owned key already taken over is enough to protect: the
        // three-way rule compares only keys that were applied before.
        const anyOwned = takeoverUnits(entry).length > pending.length;
        built.push(configResource(id, entry.surface.target, anyOwned ? "replace-if-unmodified" : "merge", entry.surface.format, content.keys));
      }
    }
    const folder = loaded.model.folder;
    const paths = pathsFor(context.platform);
    if (loaded.model.hooks.length > 0) {
      built.push(
        fileResource(Schema.decodeUnknownSync(ResourceId)("runtime:hook-runner"), projected.runtime.hookRunner, "replace", encoder.encode(hookRunnerSource()), false),
        fileResource(Schema.decodeUnknownSync(ResourceId)("runtime:hooks"), paths.join(folder, ".runtime", "hooks.json"), "replace", encoder.encode(hookRegistryJson(loaded.model.hooks)), false),
      );
    }
    const current = new Set(built.map((item) => item.resource.id));
    const isHeld = heldResource(held, context, loaded.model);
    const retired = appliedResources.filter((record) => !current.has(record.resource) && !isHeld(record));
    const planned = yield* planBuilt("folder", loaded.digest, built, retired, appliedResources);
    return { ...planned, takeovers: units, diagnostics: projected.diagnostics, harnesses: projected.harnesses };
  });

/** Group takeover units per harness for plan output. */
export const takeoverSummary = (units: ReadonlyArray<TakeoverUnit>, backup: boolean) =>
  [...new Set(units.map((unit) => unit.harness))].map((harness) => {
    const mine = units.filter((unit) => unit.harness === harness);
    return {
      harness,
      root: mine[0]!.root,
      surfaces: mine.map((unit) => unit.surface),
      backup: backup ? "takeover snapshot" : "no backup",
    };
  });

export interface RestorePlan extends LocalRevisionPlan {
  /** Real harnesses the snapshot holds, which a converged restore excludes. */
  readonly harnesses: ReadonlyArray<string>;
  /** Takeover rows a converged restore releases. */
  readonly released: ReadonlyArray<{ readonly harness: string; readonly surface: string }>;
}

/**
 * Plan writing a snapshot back. Each restored surface must still hold exactly
 * what Canonfig last applied; anything else is drift and the restore is
 * refused before anything is written. The returned revision lists every
 * restored resource as removed, so a converged run also deletes their Applied
 * Resource Records in the same transaction.
 */
export const planRestore = (
  snapshot: Snapshot,
  takeovers: ReadonlyArray<HarnessTakeover>,
  appliedResources: ReadonlyArray<AppliedResourceRecord>,
) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const appliedById = new Map(appliedResources.map((record) => [record.resource, record]));
    const platform = (yield* machine.userDirectories()).home.platform;
    const surfaceOf = (entry: SnapshotEntry) => entry.kind === "config" ? entry.surface.split("#")[0]! : entry.surface;
    const groups = new Map<ResourceIdType, Array<SnapshotEntry>>();
    for (const entry of snapshot.manifest.entries) {
      const id = surfaceResourceId(entry.harness, surfaceOf(entry));
      groups.set(id, [...groups.get(id) ?? [], entry]);
    }

    // Refuse drifted or unowned surfaces before writing anything.
    const problems: Array<string> = [];
    for (const [id, entries] of groups) {
      const applied = appliedById.get(id);
      const target = entries[0]!.target;
      if (applied === undefined) {
        problems.push(`${target}: Canonfig has no applied state for it (it was never applied completely, or was already restored)`);
        continue;
      }
      const state = removedResourceState(applied);
      if (state === undefined) {
        problems.push(`${target}: its applied state cannot be checked`);
        continue;
      }
      const resource = { ...state.resource, policy: "replace-if-unmodified" as const };
      const verification = removedResourceVerification(applied, state.desired);
      const observed = yield* observeFollowerResource({ resource }, state.desired, verification, applied);
      const drafts = planResource({ resource, desired: state.desired, observed, overlayKeys: [], applied, platform });
      if (drafts.some((draft) => draft.kind !== "no-op")) {
        problems.push(`${target}: it changed since Canonfig last applied it`);
      }
    }
    if (problems.length > 0) {
      return yield* new ProjectionHumanActionError({
        message: `restore of snapshot ${snapshot.id} refused, nothing was changed:\n${problems.map((problem) => `  ${problem}`).join("\n")}\nKeep or move the local changes, sync until it converges, then restore again`,
      });
    }

    const built: Array<BuiltResource> = [];
    const retired: Array<AppliedResourceRecord> = [];
    const read = (copy: string) => Effect.tryPromise({
      try: () => readFile(snapshotCopy(snapshot, copy)),
      catch: (error) => new ProjectionHumanActionError({ message: `snapshot ${snapshot.id} is missing ${copy}: ${String(error)}` }),
    });
    for (const [id, entries] of groups) {
      const applied = appliedById.get(id)!;
      const first = entries[0]!;
      if (first.kind === "config") {
        const keys = entries.flatMap((entry) => {
          if (entry.kind !== "config" || entry.state === "absent") return [];
          const value = snapshot.keys.get(entry.harness)?.get(entry.target)?.get(entry.key);
          return value === undefined ? [] : [{ path: entry.key, value }];
        });
        built.push(configResource(id, first.target, "merge", first.format, keys));
        continue;
      }
      if (first.state === "absent") {
        retired.push(applied);
        continue;
      }
      if (first.kind === "file") {
        if (first.object === "symlink") {
          const digest = sha256Hex(first.symlinkTo);
          built.push({
            resource: { id, kind: "file", policy: "replace", target: first.target, dependsOn: [], blobs: [] },
            entry: {
              resource: id,
              desired: { kind: "file", digest, executable: false, mode: 0, symlinkTo: first.symlinkTo },
              verification: { method: "symlink", target: first.symlinkTo },
            },
            artifacts: [],
          });
          continue;
        }
        const content = yield* read(first.copy);
        const digest = sha256BytesHex(content);
        built.push({
          resource: { id, kind: "file", policy: "replace", target: first.target, dependsOn: [], blobs: [] },
          entry: {
            resource: id,
            desired: { kind: "file", digest, executable: (first.mode & 0o100) !== 0, mode: first.mode & 0o7777 },
            verification: { method: "digest", digest },
          },
          artifacts: [{ digest, content }],
        });
        continue;
      }
      const files: Array<{ path: string; digest: ContentDigest; executable: boolean; mode: number; symlinkTo?: string }> = [];
      const artifacts: Array<SynchronizationArtifact> = [];
      const directories: Array<{ path: string; mode: number }> = [];
      for (const child of first.entries) {
        if (child.object === "directory") {
          directories.push({ path: child.path, mode: child.mode & 0o7777 });
        } else if (child.object === "symlink") {
          files.push({ path: child.path, digest: sha256Hex(child.symlinkTo), executable: false, mode: 0, symlinkTo: child.symlinkTo });
        } else {
          const content = yield* read(child.copy);
          const digest = sha256BytesHex(content);
          files.push({ path: child.path, digest, executable: (child.mode & 0o100) !== 0, mode: child.mode & 0o7777 });
          artifacts.push({ digest, content });
        }
      }
      built.push({
        resource: { id, kind: "directory", policy: "replace", target: first.target, dependsOn: [], blobs: [] },
        entry: {
          resource: id,
          desired: { kind: "directory", mode: first.mode & 0o7777, directories, files },
          verification: { method: "digest", digest: directoryVerificationDigest(files) },
        },
        artifacts,
      });
    }
    const manifestDigest = sha256Hex(canonicalJson(JSON.parse(JSON.stringify(snapshot.manifest))));
    const restored = [...groups.keys()];
    // Every restored surface leaves Canonfig's ownership with this run.
    const planned = yield* planBuilt("snapshot", manifestDigest, built, retired, appliedResources, restored);
    const harnesses = [...new Set(snapshot.manifest.entries.map((entry) => entry.harness))]
      .filter((harness) => harness !== sharedSkillsOwner);
    const restoredSurfaces = new Set(restored.map((id) => {
      const parsed = parseSurfaceResourceId(id)!;
      return `${parsed.harness}\0${parsed.surface}`;
    }));
    const released = takeovers
      .filter((takeover) => restoredSurfaces.has(`${takeover.harness}\0${takeover.surface.split("#")[0]!}`))
      .map((takeover) => ({ harness: takeover.harness, surface: takeover.surface }));
    return { ...planned, harnesses, released };
  });
