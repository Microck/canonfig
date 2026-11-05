import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";

import { Effect, Schema } from "effect";

import { ContentDigest, ProfileRevisionId, ResourceId } from "../domain/brand.ts";
import type {
  FollowerId,
  ProfileRevisionId as ProfileRevisionIdType,
  ResourceId as ResourceIdType,
} from "../domain/brand.ts";
import { configPathSegments } from "../domain/config-path.ts";
import type { PublishedResource, VerificationInput } from "../domain/profile.ts";
import type { ApplyPolicy } from "../domain/resource.ts";
import { ConfigValue } from "../domain/resource.ts";
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
import { getConfigPath, parseConfigDocument, renderConfigDocument } from "../synchronization/config-codec.ts";
import type { ConfigJson } from "../synchronization/config-value.ts";
import {
  observeFollowerResource,
  removedResourceState,
  removedResourceVerification,
} from "../synchronization/observation.ts";
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
  HarnessAdapter,
  HarnessLayout,
  OwnedSurface,
  RootContext,
  SurfaceContent,
} from "./harness.ts";
import { modelFor, SURFACE_CATEGORIES, type SurfaceCategory, TARGET_IDS, type TargetId } from "./model.ts";
import { hookRegistryJson, hookRunnerSource } from "./templates/runtime.ts";
import type { Snapshot, SnapshotEntry, TakeoverUnit } from "./takeover.ts";
import { snapshotCopy } from "./takeover.ts";

/**
 * The `surfaces` categories a harness can be given: every feature its adapter
 * does not mark unsupported, plus `settings` when it owns a settings file.
 * ui/src/shared/data.ts keeps a copy for the harness list; a test holds them equal.
 */
export const supportedCategories = (adapter: HarnessAdapter, layout: HarnessLayout): ReadonlyArray<SurfaceCategory> =>
  SURFACE_CATEGORIES.filter((category) =>
    category === "settings"
      ? layout.surfaces.some((surface) => surface.kind === "config" && surface.settings !== undefined)
      : adapter.descriptor.capabilities[category] !== "unsupported"
  );

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
    const registry = hookRegistryJson(model.hooks);
    const runtimeVersion = sha256Hex(`${hookRunnerSource("hooks.json")}\n${registry}`);
    const runtime = {
      folder: model.folder,
      hookRunner: paths.join(model.folder, ".runtime", `hook-runner.${runtimeVersion}.mjs`),
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
    // A category a harness cannot take would silently do nothing; refuse it for
    // every listed harness, including ones not installed or excluded here, so
    // the mistake shows on the Source before any follower runs it.
    for (const harness of TARGET_IDS) {
      const selected = model.surfaces[harness];
      if (selected === undefined) continue;
      const adapter = adapterFor(harness);
      const supported = supportedCategories(adapter, adapter.layout(context, model));
      const unsupported = selected.filter((category) => !supported.includes(category));
      if (unsupported.length > 0) {
        return yield* new CanonicalFolderError({
          path: configPath,
          message: `surfaces.${harness}: ${adapter.descriptor.name} does not support ${unsupported.join(", ")}; it supports ${supported.join(", ")}`,
        });
      }
    }
    const harnesses: Array<HarnessPlan> = [];
    // Set when a harness that reads the shared skills directory is given skills.
    let sharesSkills = false;
    for (const harness of model.harnesses) {
      const adapter = adapterFor(harness);
      const scoped = modelFor(model, harness);
      const layout = adapter.layout(context, scoped);
      yield* checkRoot(harness, layout.root);
      harnesses.push({ harness, layout });
      if (layout.sharedSkills && scoped.skills.length > 0) sharesSkills = true;
      const projection = adapter.project(scoped, layout, runtime);
      diagnostics.push(...projection.diagnostics);
      const contents = yield* Effect.try({
        try: () => withSettings(harness, layout, projection.contents, scoped.settings[harness] ?? [], configPath),
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
        if (!within(paths, context.home, resolved.target)) {
          return yield* new ProjectionHumanActionError({
            harness,
            message: `${harness} surface ${resolved.id} resolves to ${resolved.target}, outside the home directory ${context.home}; Canonfig projects only inside the home directory`,
          });
        }
        surfaces.push({ harness, root: layout.root, surface: resolved, content });
      }
    }
    if (sharesSkills) {
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
    return { surfaces, harnesses, diagnostics, runtime, runtimeVersion };
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

/** A resource a run writes: its metadata, desired state and content. */
export interface BuiltResource {
  readonly resource: PublishedResource;
  readonly entry: DesiredResourceEntry;
  readonly artifacts: ReadonlyArray<SynchronizationArtifact>;
}

export const fileResource = (
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

export const directoryResource = (
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
  keys: ReadonlyArray<{ readonly path: string; readonly value: ConfigJson }>,
  releases?: ReadonlyArray<string>,
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
        releases: releases === undefined ? undefined : [...releases].sort((left, right) => left.localeCompare(right)),
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

export interface PlanBuiltInput {
  readonly follower: FollowerId;
  readonly origin: PlanningLocalRevision["origin"];
  readonly originDigest: string;
  /**
   * The Source revision a follower run was built from. Its id then names
   * that revision (`<revision>:view:<digest>`); a local run is `local:<digest>`.
   */
  readonly sourceRevision?: ProfileRevisionIdType | undefined;
  readonly built: ReadonlyArray<BuiltResource>;
  /** Applied resources this run removes. */
  readonly retired: ReadonlyArray<AppliedResourceRecord>;
  /** The resources a retirement runs after; none unless given. */
  readonly retiredDependsOn?: ((record: AppliedResourceRecord) => ReadonlyArray<ResourceIdType>) | undefined;
  readonly appliedResources: ReadonlyArray<AppliedResourceRecord>;
  /** Resources whose ownership the run ends although it writes them (restore). */
  readonly endsOwnership?: ReadonlyArray<ResourceIdType> | undefined;
  /** See `SynchronizationPlannerInput.noReplace`; only import sets it. */
  readonly noReplace?: boolean | undefined;
}

/**
 * Observe and plan a set of built resources, plus removal of every retired
 * applied resource, through the shared planner. The revision is
 * content-addressed and holds no file content.
 */
export const planBuilt = (input: PlanBuiltInput) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const appliedById = new Map(input.appliedResources.map((record) => [record.resource, record]));
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
        // A tool's target is its executable name and a credential's its
        // reference, not paths.
        const resolvedTarget = resource.kind === "tool" || resource.kind === "credential"
          ? undefined
          : (yield* machine.normalizePath({ path: resource.target })).absolute;
        observations.push({ resource: resource.id, resolvedTarget, observed });
      });
    for (const item of input.built) {
      resources.push(item.resource);
      desired.push(item.entry);
      yield* observe(item.resource, item.entry.desired, item.entry.verification);
    }
    const removedResources: Array<ResourceIdType> = [];
    const runtimeConsumers = [...input.built.map((item) => item.resource.id), ...input.retired.map((record) => record.resource)]
      .filter((id) => parseSurfaceResourceId(id) !== undefined);
    for (const record of input.retired) {
      const state = removedResourceState(record);
      if (state === undefined) continue;
      const prerequisites = input.retiredDependsOn?.(record) ?? [];
      const retiresRuntime = record.resource.startsWith("runtime:");
      const resource = {
        ...state.resource,
        // Drift and human-action stops do not roll back earlier deletions.
        dependsOn: retiresRuntime ? [...new Set([...prerequisites, ...runtimeConsumers])] : prerequisites,
      };
      const verification = removedResourceVerification(record, state.desired);
      resources.push(resource);
      desired.push({ resource: resource.id, desired: state.desired, verification });
      removedResources.push(resource.id);
      yield* observe(resource, state.desired, verification);
    }
    // The run's revision lists every resource whose ownership it ends; the
    // planner sees only the retired ones, so the others are planned as writes.
    const content = {
      origin: input.origin,
      originDigest: Schema.decodeUnknownSync(ContentDigest)(input.originDigest),
      resources,
      desired,
      blobs: [],
      removedResources: [...new Set([...removedResources, ...input.endsOwnership ?? []])].sort(),
    };
    const digest = sha256Hex(canonicalJson(JSON.parse(JSON.stringify(content))));
    const revision: PlanningLocalRevision = {
      ...content,
      id: Schema.decodeUnknownSync(ProfileRevisionId)(
        input.sourceRevision === undefined ? `local:${digest}` : `${input.sourceRevision}:view:${digest}`,
      ),
    };
    const plan = yield* planSynchronization({
      revision: { ...revision, removedResources },
      follower: input.follower,
      observedState: {
        platform: (yield* machine.userDirectories()).home.platform,
        resources: observations,
        availableBlobs: [],
      },
      appliedResources: input.appliedResources,
      noReplace: input.noReplace,
    });
    const artifacts = [...new Map(input.built.flatMap((item) => item.artifacts).map((artifact) => [artifact.digest, artifact])).values()];
    return { revision, plan, artifacts, appliedResources: input.appliedResources } satisfies LocalRevisionPlan;
  });

export interface FolderPlan extends LocalRevisionPlan {
  /** Surfaces (and config keys) this run takes over, not yet owned. */
  readonly takeovers: ReadonlyArray<TakeoverUnit>;
}

/**
 * Whether an applied resource belongs to a held harness: locally excluded or
 * listed but not installed on this run. Keep its outputs and ownership so
 * exclusion after a partial restore cannot retire other snapshots' surfaces,
 * and a scheduled run with a narrower PATH cannot undo an earlier projection.
 * Shared skills are held while a held harness reads them.
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

/** What a projection run writes: built resources plus the takeovers they perform. */
export interface Projection {
  readonly built: ReadonlyArray<BuiltResource>;
  /** Surfaces (and config keys) this run takes over, not yet owned. */
  readonly takeovers: ReadonlyArray<TakeoverUnit>;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly harnesses: ReadonlyArray<HarnessPlan>;
  /** Applied projection records kept although this run does not project them. */
  readonly isHeld: (record: AppliedResourceRecord) => boolean;
}

/**
 * Project the folder into its selected harnesses minus `held` ones (listed
 * but not installed). A surface not yet taken over is written with `replace`
 * (`merge` for config keys); afterward the three-way `replace-if-unmodified`
 * rule protects local edits.
 */
export const buildProjection = (
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
    const isHeldHarness = heldResource([...held, ...loaded.local.excludeHarnesses], context, loaded.model);
    const holdsOutputs = appliedResources.some(isHeldHarness);
    const applied = new Map(appliedResources.map((record) => [record.resource, record]));
    const units: Array<TakeoverUnit> = [];
    const built: Array<BuiltResource> = [];
    for (const entry of projected.surfaces) {
      const pending = takeoverUnits(entry).filter((unit) => !owned.has(`${unit.harness}\0${unit.surface}`));
      units.push(...pending);
      const id = surfaceResourceId(entry.harness, entry.surface.id);
      const previousTarget = applied.get(id)?.target;
      if (previousTarget !== undefined && previousTarget !== entry.surface.target) {
        return yield* new ProjectionHumanActionError({
          harness: entry.harness,
          message: `${entry.harness} surface ${entry.surface.id} was applied at ${previousTarget} but now resolves to ${entry.surface.target}; restore the original location before syncing`,
        });
      }
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
        // Protect previously applied keys even when this revision drops all of
        // them: removing a locally edited key must still report drift.
        const anyOwned = (applied.get(id)?.ownedKeys?.length ?? 0) > 0 || takeoverUnits(entry).length > pending.length;
        built.push(configResource(id, entry.surface.target, anyOwned ? "replace-if-unmodified" : "merge", entry.surface.format, content.keys));
      }
    }
    const folder = loaded.model.folder;
    const paths = pathsFor(context.platform);
    if (loaded.model.hooks.length > 0) {
      // Install the runtime before any harness output can begin referring to it.
      const version = projected.runtimeVersion;
      const runtimeDependencies = [`runtime:hook-runner:${version}`, `runtime:hooks:${version}`].map((id) => Schema.decodeUnknownSync(ResourceId)(id));
      for (let index = 0; index < built.length; index += 1) {
        const item = built[index]!;
        built[index] = { ...item, resource: { ...item.resource, dependsOn: runtimeDependencies } };
      }
      built.push(
        fileResource(runtimeDependencies[0]!, projected.runtime.hookRunner, "replace", encoder.encode(hookRunnerSource(`hooks.${version}.json`)), false),
        fileResource(runtimeDependencies[1]!, paths.join(folder, ".runtime", `hooks.${version}.json`), "replace", encoder.encode(hookRegistryJson(loaded.model.hooks)), false),
      );
    }
    return {
      built,
      takeovers: units,
      diagnostics: projected.diagnostics,
      harnesses: projected.harnesses,
      isHeld: (record) => isHeldHarness(record)
        || (holdsOutputs && record.resource.startsWith("runtime:")),
    } satisfies Projection;
  });

/** Plan a projection of this machine's own folder as a local run. */
export const planFolder = (
  loaded: LoadedFolder,
  context: RootContext,
  takeovers: ReadonlyArray<HarnessTakeover>,
  appliedResources: ReadonlyArray<AppliedResourceRecord>,
  held: ReadonlyArray<TargetId> = [],
) =>
  Effect.gen(function*() {
    const projection = yield* buildProjection(loaded, context, takeovers, appliedResources, held);
    const current = new Set(projection.built.map((item) => item.resource.id));
    const planned = yield* planBuilt({
      follower: localProjectionFollower,
      origin: "folder",
      originDigest: loaded.digest,
      built: projection.built,
      retired: appliedResources.filter((record) => !current.has(record.resource) && !projection.isHeld(record)),
      appliedResources,
    });
    return { ...planned, takeovers: projection.takeovers, diagnostics: projection.diagnostics, harnesses: projection.harnesses };
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
}

/**
 * Plan writing a snapshot back. Each restored surface must still hold exactly
 * what Canonfig last applied; anything else is drift and the restore is
 * refused before anything is written. The returned revision lists every
 * restored resource as removed, so a converged run also deletes their Applied
 * Resource Records in the same transaction. A config file whose owned keys
 * the snapshot captured only in part (a later run took over more) keeps the
 * others: its resource writes them unchanged and releases only the captured
 * keys, so its record then names just the kept keys.
 */
export const planRestore = (
  snapshot: Snapshot,
  appliedResources: ReadonlyArray<AppliedResourceRecord>,
  follower: FollowerId,
) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const appliedById = new Map(appliedResources.map((record) => [record.resource, record]));
    const platform = (yield* machine.userDirectories()).home.platform;
    const readConfig = (target: string, format: ConfigFormat) =>
      machine.normalizePath({ path: target }).pipe(
        Effect.flatMap((path) => machine.readFile({ path, maximumBytes: 8 * 1024 * 1024 })),
        Effect.flatMap((bytes) => Effect.try(() => parseConfigDocument(format, new TextDecoder().decode(bytes)))),
        Effect.mapError((error) => new ProjectionHumanActionError({ message: `${target}: cannot read the keys Canonfig keeps: ${String(error)}` })),
      );
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
      const released = entries.filter((entry) => entry.kind === "config" && !applied.ownedKeys?.includes(entry.key));
      if (released.length > 0) {
        problems.push(`${target}: snapshot contains config keys Canonfig no longer owns (already restored or released)`);
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
      const drafts = planResource({ resource, desired: state.desired, observed, applied, platform });
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
    const restored: Array<ResourceIdType> = [];
    const read = (copy: string) => Effect.tryPromise({
      try: () => readFile(snapshotCopy(snapshot, copy)),
      catch: (error) => new ProjectionHumanActionError({ message: `snapshot ${snapshot.id} is missing ${copy}: ${String(error)}` }),
    });
    for (const [id, entries] of groups) {
      const applied = appliedById.get(id)!;
      const first = entries[0]!;
      if (first.kind === "config") {
        const captured = new Set(entries.flatMap((entry) => entry.kind === "config" ? [entry.key] : []));
        const keys = entries.flatMap((entry) => {
          if (entry.kind !== "config" || entry.state === "absent") return [];
          const value = snapshot.keys.get(entry.harness)?.get(entry.target)?.get(entry.key);
          return value === undefined ? [] : [{ path: entry.key, value }];
        });
        const kept = (applied.ownedKeys ?? []).filter((key) => !captured.has(key));
        if (kept.length === 0) {
          built.push(configResource(id, first.target, "merge", first.format, keys));
          restored.push(id);
          continue;
        }
        // The drift check above proved the kept keys still hold what Canonfig
        // applied, so their current values are written back unchanged.
        const current = yield* readConfig(first.target, first.format);
        const keptValues = yield* Effect.forEach(kept, (key) => {
          const value = getConfigPath(current, key);
          return value === undefined
            ? Effect.succeed([])
            : Schema.decodeUnknownEffect(ConfigValue)(value).pipe(
              Effect.map((decoded) => [{ path: key, value: decoded }]),
              Effect.mapError(() => new ProjectionHumanActionError({ message: `${first.target}: ${key} holds a value Canonfig cannot write back (null)` })),
            );
        });
        built.push(configResource(id, first.target, "merge", first.format, [...keys, ...keptValues.flat()], [...captured]));
        continue;
      }
      restored.push(id);
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
    // Every restored surface leaves Canonfig's ownership with this run; a
    // config file restored in part leaves only through its released keys.
    const planned = yield* planBuilt({
      follower,
      origin: "snapshot",
      originDigest: manifestDigest,
      built,
      retired,
      appliedResources,
      endsOwnership: restored,
    });
    const harnesses = [...new Set(snapshot.manifest.entries.map((entry) => entry.harness))]
      .filter((harness) => harness !== sharedSkillsOwner);
    return { ...planned, harnesses } satisfies RestorePlan;
  });
