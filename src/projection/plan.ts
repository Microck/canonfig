import { readFile } from "node:fs/promises";

import { Effect, Redacted, Schema } from "effect";

import { ContentDigest, parseSurfaceResourceId, ProfileRevisionId, ResourceId, resourcesOwner, surfaceResourceId } from "../domain/brand.ts";
import type {
  FollowerId,
  ProfileRevisionId as ProfileRevisionIdType,
  ResourceId as ResourceIdType,
} from "../domain/brand.ts";
import { configPathSegments, configPathsOverlap } from "../domain/config-path.ts";
import type { PublishedResource, VerificationInput } from "../domain/profile.ts";
import type { ApplyPolicy } from "../domain/resource.ts";
import { ConfigValue } from "../domain/resource.ts";
import {
  localProjectionFollower,
  type AppliedResourceRecord,
  type ObservedResourceState,
} from "../domain/synchronization.ts";
import { TaggedError } from "../domain/tagged-error.ts";
import { sourceBytesIssue } from "../domain/text-composition.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import {
  canonicalJson,
  directoryEntriesDigest,
  directoryVerificationDigest,
  sha256BytesHex,
  sha256Hex,
} from "../profile/profile-codec.ts";
import { loadNamedSecret } from "../secrets/secret-bindings.ts";
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
import { assertAuthoredTargetPath } from "../synchronization/resource-executors.ts";
import type {
  DesiredResource,
  DesiredResourceEntry,
  ObservedResourceEntry,
  PlannedSynchronization,
  PlanningLocalRevision,
  SynchronizationArtifact,
} from "../synchronization/synchronization.types.ts";
import { adapterFor } from "./adapters/index.ts";
import { commandSkill, groupProjectedSkillNames, skillDirectoryFiles } from "./adapters/shared-documents.ts";
import { CanonicalFolderError, itemResourceId, type KeyClaim, type LoadedFolder, mapStoredSecrets, storedSecretNames } from "./folder.ts";
import { diagnoseMcpConfiguration } from "./mcp-diagnostics.ts";
import { mcpProxyBindingFile, proxyMcpServer, readMcpProxyBinding } from "./mcp-launcher.ts";
import { pathsFor, reservedResourcePaths, settingsSurfaceOf, supportedCategories, within } from "./layout-metadata.ts";
import type {
  ConfigFormat,
  Diagnostic,
  HarnessLayout,
  OwnedSurface,
  RootContext,
  SurfaceContent,
} from "./harness.ts";
import { type CanonicalModel, modelFor, type SettingsKey, type SkillTree, type SurfaceCategory, TARGET_IDS, type TargetId } from "./model.ts";
import { hookRegistryJson, hookRunnerSource } from "./templates/runtime.ts";
import type { Snapshot, SnapshotEntry, TakeoverUnit } from "./takeover.ts";
import { canonicalFolderOwner, snapshotCopy } from "./takeover.ts";

/**
 * Why `selected` is not a valid `surfaces.<harness>` entry, or undefined.
 * Projection checks it on every machine and publication before signing, so a
 * Source can never publish a selection its followers would refuse.
 */
export const surfaceSelectionIssue = (
  harness: TargetId,
  selected: ReadonlyArray<SurfaceCategory>,
  context: RootContext,
  model: CanonicalModel,
): string | undefined => {
  const adapter = adapterFor(harness);
  const supported = supportedCategories(adapter, adapter.layout(context, model));
  const unsupported = selected.filter((category) => !supported.includes(category));
  return unsupported.length === 0
    ? undefined
    : `surfaces.${harness}: ${adapter.descriptor.name} does not support ${unsupported.join(", ")}; it supports ${supported.join(", ")}`;
};

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
  /**
   * Canonfig shares the surface with the machine (`append-local`): a marked
   * Source section in a text file, only its own entries in a directory.
   */
  readonly appendLocal: boolean;
}

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
  const surface = settingsSurfaceOf(layout);
  if (surface === undefined) {
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

/**
 * Why a key claim (`settings/<harness>#<key>` in `local/local.jsonc`) cannot
 * apply on this machine, or undefined. The harness needs a settings file
 * Canonfig writes, and the key must not be one the harness keeps for itself:
 * Canonfig never writes those, so claiming one would only hide a typo.
 * Projection checks every claim, listed harness or not, and `canonfig overlay
 * set` checks one before it records it.
 */
export const keyClaimIssue = (claim: KeyClaim, context: RootContext, model: CanonicalModel): string | undefined => {
  const item = `settings/${claim.harness}#${claim.key}`;
  const surface = settingsSurfaceOf(adapterFor(claim.harness).layout(context, model));
  if (surface === undefined) return `overlay ${item}: ${claim.harness} has no settings file Canonfig writes`;
  const reserved = (surface.settings?.reserved ?? []).find((pattern) => reservedOverlap(claim.key, pattern));
  return reserved === undefined
    ? undefined
    : `overlay ${item}: ${claim.key} overlaps ${reserved}, which ${claim.harness} keeps for itself and Canonfig never writes`;
};

/** Whether config key `key` is the claimed key itself or a key inside it. */
const claimCovers = (claimed: string, key: string): boolean =>
  configPathsOverlap(claimed, key) && configPathSegments(key).length >= configPathSegments(claimed).length;

export interface HarnessPlan {
  readonly harness: TargetId;
  readonly layout: HarnessLayout;
}

/**
 * Authored `resources.<id>` as surfaces of the `resources` pseudo-harness.
 * A target resolves under this machine's home directory and must stay clear
 * of the Canonical Folder, the shared `~/.agents/`, and every place any
 * harness adapter owns or keeps state in (its root, surfaces and never-touch
 * paths), whether or not that harness is listed. Harness configuration is
 * the adapters' alone; a resource cannot reach `~/.codex/auth.json`.
 */
export const projectResources = (model: CanonicalModel, context: RootContext, configPath: string) =>
  Effect.gen(function*() {
    if (model.resources.length === 0) return [];
    const paths = pathsFor(context.platform);
    const reserved = reservedResourcePaths(context, model);
    // macOS and Windows file systems ignore case by default, so `~/.Codex`
    // is `~/.codex` there; compare folded paths on those platforms.
    const fold = (path: string) => context.platform === "linux" ? path : path.toLowerCase();
    const overlaps = (left: string, right: string) =>
      within(paths, fold(left), fold(right)) || within(paths, fold(right), fold(left));
    const surfaces: Array<ProjectedSurface> = [];
    for (const resource of model.resources) {
      const target = paths.join(context.home, ...resource.target.slice("~/".length).split("/"));
      const clash = reserved.find((entry) => overlaps(entry.path, target));
      if (clash !== undefined) {
        return yield* new CanonicalFolderError({
          path: configPath,
          message: `resources.${resource.id}.target ${resource.target} overlaps ${clash.path}, which belongs to ${clash.owner}; author harness configuration through the folder instead`,
        });
      }
      const sibling = surfaces.find((other) => overlaps(other.surface.target, target));
      if (sibling !== undefined) {
        return yield* new CanonicalFolderError({
          path: configPath,
          message: `resources.${resource.id}.target ${resource.target} overlaps resources.${sibling.surface.id} at ${sibling.surface.target} on this machine's file system`,
        });
      }
      const base = { harness: resourcesOwner, root: context.home };
      if (resource.kind === "config") {
        surfaces.push({
          ...base,
          surface: { id: resource.id, kind: "config", target, format: resource.format, keys: resource.keys.map((key) => key.path) },
          content: { kind: "config", surface: resource.id, keys: resource.keys },
          appendLocal: false,
        });
      } else if (resource.kind === "file") {
        const appendLocal = resource.policy === "append-local";
        const issue = appendLocal ? sourceBytesIssue(resource.file.content) : undefined;
        if (issue !== undefined) {
          return yield* new CanonicalFolderError({ path: configPath, message: `resources.${resource.id} cannot use append-local: ${issue}` });
        }
        surfaces.push({
          ...base,
          surface: { id: resource.id, kind: "file", target },
          content: { kind: "file", surface: resource.id, content: resource.file.content, executable: resource.file.executable },
          appendLocal,
        });
      } else {
        surfaces.push({
          ...base,
          surface: { id: resource.id, kind: "directory", target },
          content: { kind: "directory", surface: resource.id, files: resource.files },
          appendLocal: resource.policy === "append-local",
        });
      }
    }
    return surfaces;
  });

/**
 * Every surface this run projects, with harness roots checked: inside the
 * home directory, and equal to the root pinned at takeover.
 */
export const projectSurfaces = (
  loaded: LoadedFolder,
  context: RootContext,
  takeovers: ReadonlyArray<HarnessTakeover>,
  excludedSkills: ReadonlySet<string>,
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
    const proxyBinding = yield* Effect.cached(Effect.tryPromise({
      try: () => readMcpProxyBinding(model.folder),
      catch: () => new CanonicalFolderError({
        path: paths.join(model.folder, mcpProxyBindingFile),
        message: "Cannot read the private MCP proxy binding. Check it in this machine's login session.",
      }),
    }));
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
    const diagnostics: Array<Diagnostic> = [
      ...loaded.ignoredLocal.map((path) => ({
        level: "warning" as const,
        code: "LOCAL_NOT_ALLOWED",
        message: `${path} is not admitted by canonfig.jsonc local.allow and was not projected`,
      })),
      ...loaded.overlays.flatMap((overlay) => overlay.kind === "item" && !overlay.local ? [overlay] : []).map((overlay) => ({
        level: "warning" as const,
        code: "OVERLAY_UNUSED",
        message: `overlay ${overlay.item} finds no admitted local/ item of that name, so ${overlay.published ? "the published item is projected" : "it changes nothing"}; add the local item or run 'canonfig overlay remove ${overlay.item}'`,
      })),
      ...(yield* diagnoseMcpConfiguration(loaded.mcpDiagnostics, context)),
    ];
    // Append-local text keeps Canonfig's section between reserved markers, so
    // the projected text must not hold them; refuse it before any write.
    const shared = (harness: string, surface: string, content: SurfaceContent, appendLocal: boolean) => {
      if (!appendLocal || content.kind !== "file") return Effect.succeed(appendLocal);
      const issue = sourceBytesIssue(bytesOf(content.content));
      return issue === undefined
        ? Effect.succeed(true)
        : Effect.fail(new CanonicalFolderError({ path: configPath, message: `${harness} ${surface} cannot keep this machine's text: ${issue}` }));
    };
    const sharedCategory = (surface: string): boolean =>
      (surface === "instructions" || surface === "skills") && model.appendLocal.includes(surface);
    // A category a harness cannot take would silently do nothing; refuse it for
    // every listed harness, including ones not installed or excluded here, so
    // the mistake shows on the Source before any follower runs it.
    for (const harness of TARGET_IDS) {
      const selected = model.surfaces[harness];
      if (selected === undefined) continue;
      const issue = surfaceSelectionIssue(harness, selected, context, model);
      if (issue !== undefined) return yield* new CanonicalFolderError({ path: configPath, message: issue });
    }
    const harnesses: Array<HarnessPlan> = [];
    let sharedAuthoredSkills: ReadonlyArray<SkillTree> = [];
    type CompiledCommand = { readonly id: string; readonly skill: SkillTree };
    let sharedCommands: ReadonlyArray<CompiledCommand> = [];
    let compiledCommands: ReadonlyArray<CompiledCommand> | undefined;
    const checkSkillNames = (skills: ReadonlyArray<SkillTree>, generated: ReadonlyArray<CompiledCommand>, destination: string) => {
      if (generated.length === 0) return Effect.void;
      const names = groupProjectedSkillNames([
        ...skills.map(({ name }) => ({ category: "skills" as const, name, source: `skills/${name}` })),
        ...generated.map(({ id }) => ({ category: "commands" as const, name: id, source: `commands/${id}.md` })),
      ], excludedSkills);
      for (const [name, group] of names) {
        const [other, item] = group;
        if (other !== undefined && item !== undefined) return Effect.fail(new CanonicalFolderError({
          path: configPath,
          message: `${item.source} and ${other.source} both project to skill '${name}' in ${destination}; rename one of these items`,
        }));
      }
      return Effect.void;
    };
    const requiredMcpTools = new Set<string>();
    for (const harness of model.harnesses) {
      const adapter = adapterFor(harness);
      const scoped = modelFor(model, harness);
      let mcp = scoped.mcp.filter(([, server]) => server.harnesses?.includes(harness) ?? true);
      for (const [, server] of mcp) {
        for (const reference of server.requires ?? []) requiredMcpTools.add(itemResourceId(reference));
      }
      if (!loaded.local.preserveMcp.has(harness)
        && mcp.some(([, server]) => server.transport !== "stdio" && server.proxy)) {
        const binding = yield* proxyBinding;
        if (binding === undefined) return yield* new CanonicalFolderError({
          path: configPath,
          message: "Start 'canonfig mcp proxy' on this machine before projecting proxied MCP servers.",
        });
        mcp = mcp.map(([name, server]) => [
          name, server.transport !== "stdio" && server.proxy ? proxyMcpServer(name, server, binding) : server,
        ]);
      }
      // The command category controls translation independently of authored skills.
      const generated = adapter.descriptor.capabilities.commands === "translated" && scoped.commands.length > 0
        ? compiledCommands ??= scoped.commands.map((command) => ({ id: command.id, skill: commandSkill(command) }))
        : [];
      const input = generated.length > 0
        ? { ...scoped, commands: [], skills: [...scoped.skills, ...generated.map(({ skill }) => skill)] }
        : scoped;
      const layout = adapter.layout(context, input);
      if (layout.sharedSkills) {
        if (scoped.skills.length > 0) sharedAuthoredSkills = scoped.skills;
        if (generated.length > 0) sharedCommands = generated;
      } else {
        yield* checkSkillNames(scoped.skills, generated, harness);
      }
      yield* checkRoot(harness, layout.root);
      harnesses.push({ harness, layout });
      // A native map may still contain a scoped-out server if Canonfig does not
      // own the map or drift blocks the write. Keep its agent permissions.
      const projection = adapter.project({
        ...input,
        mcpPermissionNames: scoped.mcp.map(([name]) => name),
        mcp,
      }, layout, runtime);
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
        surfaces.push({
          harness,
          root: layout.root,
          surface: resolved,
          content,
          appendLocal: yield* shared(harness, resolved.id, content, sharedCategory(resolved.id) && resolved.kind !== "config"),
        });
      }
    }
    if (sharedAuthoredSkills.length > 0 || sharedCommands.length > 0) {
      const root = paths.join(context.home, ".agents");
      yield* checkRoot(sharedSkillsOwner, root);
      const target = paths.join(root, "skills");
      // Different harnesses can request either category on this same directory.
      yield* checkSkillNames(sharedAuthoredSkills, sharedCommands, target);
      const skills = [...sharedAuthoredSkills, ...sharedCommands.map(({ skill }) => skill)];
      surfaces.push({
        harness: sharedSkillsOwner,
        root,
        surface: { id: "skills", kind: "directory", target },
        content: { kind: "directory", surface: "skills", files: skillDirectoryFiles(skills) },
        appendLocal: sharedCategory("skills"),
      });
    }
    for (const resource of yield* projectResources(model, context, configPath)) {
      // Lexical containment is not enough: a linked parent could carry the
      // target outside home or into a harness's files. Refuse before anything
      // reads, snapshots or takes over the target.
      yield* assertAuthoredTargetPath(resource.surface.target).pipe(
        Effect.mapError((error) => new ProjectionHumanActionError({
          harness: resourcesOwner,
          message: `resources.${resource.surface.id}: ${error.message}`,
        })),
      );
      surfaces.push(resource);
    }
    return { surfaces, harnesses, requiredMcpTools, diagnostics, runtime, runtimeVersion };
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
  holdsSecrets = false,
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
        // Omitted unless true, so revisions without secrets keep their digests.
        holdsSecrets: holdsSecrets || undefined,
      },
      verification: { method: "digest", digest },
    },
    artifacts: [{ digest, content }],
  };
};

/**
 * An authored config resource's keys with each `{ "fromSecret": name }`
 * replaced by the value this machine's secret store holds for `name`.
 *
 * Only the file gets the value. The folder, the published revision, plans and
 * the state database keep the reference or a digest; the resolved bytes live
 * in this run's memory and its private artifact directory (0700, files 0600),
 * which the run removes when it finishes. A missing or unreadable secret
 * stops planning, so no file is touched.
 */
const resolveResourceSecrets = (id: string, target: string, keys: ReadonlyArray<SettingsKey>) =>
  Effect.gen(function*() {
    const names = new Set(keys.flatMap((key) => storedSecretNames(key.value)));
    if (names.size === 0) return { keys, holdsSecrets: false };
    const values = new Map<string, string>();
    for (const name of [...names].sort()) {
      const loaded = yield* loadNamedSecret(name).pipe(Effect.mapError(() => new ProjectionHumanActionError({
        harness: resourcesOwner,
        message: `resources.${id} needs secret ${name}, which could not be read. Unlock the native credential store in this session, then sync again. Canonfig has not changed ${target}.`,
      })));
      if (loaded === undefined) {
        return yield* new ProjectionHumanActionError({
          harness: resourcesOwner,
          message: `resources.${id} needs secret ${name}, which is missing on this machine. Run canonfig secrets sync on a follower enrolled in canonfig:secrets, or canonfig secrets set ${name}, then sync again. Canonfig has not changed ${target}.`,
        });
      }
      values.set(name, Redacted.value(loaded));
    }
    return {
      keys: keys.map((key) => ({ path: key.path, value: mapStoredSecrets(key.value, (name) => values.get(name)!) })),
      holdsSecrets: true,
    };
  });

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
    const observe = (
      resource: PublishedResource,
      desiredResource: DesiredResource,
      verification: VerificationInput,
    ) =>
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
      if (state === undefined) {
        // Qualified tools release provenance without uninstalling software.
        removedResources.push(record.resource);
        continue;
      }
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
  readonly requiredMcpTools: ReadonlySet<string>;
  /** Surfaces (and config keys) this run takes over, not yet owned. */
  readonly takeovers: ReadonlyArray<TakeoverUnit>;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly harnesses: ReadonlyArray<HarnessPlan>;
  /** Applied projection records kept although this run does not project them. */
  readonly isHeld: (record: AppliedResourceRecord) => boolean;
}

/** Top-level config keys that hold a harness's native MCP server map; Amp writes the dotted `amp.mcpServers`. */
const nativeMcpKeys: ReadonlySet<string> = new Set(["mcp_servers", "mcpServers", "mcp", "amp\\.mcpServers"]);

/** Give excluded skill entries back to the machine before planning or retirement.
 * Only the run's working view changes here; durable ownership changes when the
 * synchronization engine completes the plan, so a failed plan releases nothing.
 */
export const releaseExcludedSkillRecords = (
  records: ReadonlyArray<AppliedResourceRecord>,
  exclusions: ReadonlyArray<string>,
): ReadonlyArray<AppliedResourceRecord> => {
  if (exclusions.length === 0) return records;
  const excluded = new Set(exclusions);
  return records.map((record) => {
    if (record.ownership !== "DirectoryEntries") return record;
    const surface = parseSurfaceResourceId(record.resource);
    if (surface?.surface !== "skills" || surface.harness === resourcesOwner) return record;
    const ownedFiles = record.ownedFiles.filter((file) => !excluded.has(file.path.split("/", 1)[0]!));
    return ownedFiles.length === record.ownedFiles.length ? record : {
      ...record,
      ownedFiles,
      digest: directoryEntriesDigest(ownedFiles),
    };
  });
};

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
    const pendingTakeover = takeovers.find((takeover) => takeover._tag !== "Owned");
    if (pendingTakeover !== undefined) {
      return yield* new ProjectionHumanActionError({
        harness: pendingTakeover.harness,
        message: `${pendingTakeover.harness} surface ${pendingTakeover.surface} has ${pendingTakeover._tag.toLowerCase()} takeover state from run ${pendingTakeover.run}; run 'canonfig recover' before syncing, or explicitly abandon that run after reviewing its recovery evidence`,
      });
    }
    if (loaded.local.excludeSkills.length > 0 && !loaded.model.appendLocal.includes("skills")) {
      return yield* new CanonicalFolderError({
        path: pathsFor(context.platform).join(loaded.model.folder, "local", "local.jsonc"),
        message: "excludeSkills requires the Source to share skill directories with local.appendLocal: [\"skills\"]",
      });
    }
    const excludedSkills = new Set(loaded.local.excludeSkills);
    const model = { ...loaded.model, harnesses: loaded.model.harnesses.filter((harness) => !held.includes(harness)) };
    const projected = yield* projectSurfaces({ ...loaded, model }, context, takeovers, excludedSkills);
    const owned = new Set(takeovers.map((takeover) => `${takeover.harness}\0${takeover.surface}`));
    const isHeldHarness = heldResource([...held, ...loaded.local.excludeHarnesses], context, loaded.model);
    // A resource this machine excludes (as `restore` does) keeps its outputs and ownership too.
    const excludedResources = new Set(loaded.local.excludeResources.map((id) => surfaceResourceId(resourcesOwner, id)));
    // Hermes projects each skill as its own `skill.<name>` surface. An excluded one is not
    // projected, and a copy Canonfig wrote earlier is held as it is: not written, checked or retired.
    const isExcludedSkillSurface = (harness: string, surface: string) =>
      harness !== resourcesOwner && surface.startsWith("skill.") && excludedSkills.has(surface.slice("skill.".length));
    const isHeldSkill = (record: AppliedResourceRecord) => {
      const surface = parseSurfaceResourceId(record.resource);
      return surface !== undefined && isExcludedSkillSurface(surface.harness, surface.surface);
    };
    const isHeldSurface = (record: AppliedResourceRecord) => isHeldHarness(record) || excludedResources.has(record.resource) || isHeldSkill(record);
    // preserveMcp keeps model.mcp (agent files still name its servers) and drops only the native
    // MCP maps: their keys are never written, and keys Canonfig owned before are given back.
    const preservedHarnesses: ReadonlySet<string> = loaded.local.preserveMcp;
    const preservedMcpKeys = (harness: string, keys: ReadonlyArray<string>) =>
      new Set(preservedHarnesses.has(harness) ? keys.filter((key) => nativeMcpKeys.has(key)) : []);
    const holdsOutputs = appliedResources.some(isHeldHarness);
    const applied = new Map(appliedResources.map((record) => [record.resource, record]));
    const folder = loaded.model.folder;
    const paths = pathsFor(context.platform);

    // Key claims. A claimed key leaves its harness's settings file content
    // before takeover units are counted, so Canonfig neither takes it over
    // nor writes it, and a key an Applied Resource Record still owns under a
    // claim is given back as it is (`releases`): not removed, not checked.
    const claims = loaded.local.claims;
    const localPath = paths.join(folder, "local", "local.jsonc");
    for (const claim of claims) {
      const issue = keyClaimIssue(claim, context, loaded.model);
      if (issue !== undefined) return yield* new CanonicalFolderError({ path: localPath, message: issue });
    }
    const usedClaims = new Set<KeyClaim>();
    // The keys of `harness`'s settings file that a claim covers. A claim
    // inside a key Canonfig writes as one value (`mcp_servers.docs` under
    // `mcp_servers`) would need part of that value, so it is refused.
    const claimed = (harness: string, keys: ReadonlyArray<string>) =>
      Effect.gen(function*() {
        const covered = preservedMcpKeys(harness, keys);
        for (const claim of claims) {
          if (claim.harness !== harness) continue;
          for (const key of keys) {
            if (!configPathsOverlap(claim.key, key)) continue;
            if (!claimCovers(claim.key, key)) {
              return yield* new CanonicalFolderError({
                path: localPath,
                message: `overlay settings/${harness}#${claim.key} claims part of ${key}, which Canonfig writes as one value; claim ${key} instead`,
              });
            }
            covered.add(key);
            usedClaims.add(claim);
          }
        }
        return covered;
      });

    const units: Array<TakeoverUnit> = [];
    const built: Array<BuiltResource> = [];
    for (const projectedSurface of projected.surfaces) {
      if (isExcludedSkillSurface(projectedSurface.harness, projectedSurface.surface.id)) continue;
      const id = surfaceResourceId(projectedSurface.harness, projectedSurface.surface.id);
      let entry = projectedSurface;
      let releases: ReadonlyArray<string> = [];
      // Key claims apply to a harness's settings file; preserved MCP keys to every config surface,
      // including the separate MCP files and Hermes's or Qwen's MCP-and-hooks surface.
      if (entry.surface.kind === "config" && entry.content.kind === "config" && (entry.surface.settings !== undefined || preservedHarnesses.has(entry.harness))) {
        const keys = entry.content.keys;
        const previous = applied.get(id);
        const ownedKeys = previous?.ownership === "ConfigKeys" ? previous.ownedKeys : [];
        const keyPaths = [...keys.map((key) => key.path), ...ownedKeys];
        const covered = entry.surface.settings !== undefined ? yield* claimed(entry.harness, keyPaths) : preservedMcpKeys(entry.harness, keyPaths);
        releases = ownedKeys.filter((key) => covered.has(key));
        entry = { ...entry, content: { ...entry.content, keys: keys.filter((key) => !covered.has(key.path)) } };
        // Claims covering every key leave nothing to write or give back.
        if (entry.content.kind === "config" && entry.content.keys.length === 0 && releases.length === 0) continue;
      }
      const pending = takeoverUnits(entry).filter((unit) => !owned.has(`${unit.harness}\0${unit.surface}`));
      units.push(...pending);
      const previousTarget = applied.get(id)?.target;
      if (previousTarget !== undefined && previousTarget !== entry.surface.target) {
        return yield* new ProjectionHumanActionError({
          harness: entry.harness,
          message: entry.harness === resourcesOwner
            ? `resources.${entry.surface.id} was applied at ${previousTarget} but now targets ${entry.surface.target}; to move a resource, give it a new id so its old target retires`
            : `${entry.harness} surface ${entry.surface.id} was applied at ${previousTarget} but now resolves to ${entry.surface.target}; restore the original location before syncing`,
        });
      }
      // A surface shared with the machine keeps its policy from the first
      // write on: append-local never replaces what Canonfig did not write.
      const policy = entry.appendLocal ? "append-local" : pending.length > 0 ? "replace" : "replace-if-unmodified";
      const content = entry.content;
      if (content.kind === "file") {
        built.push(fileResource(id, entry.surface.target, policy, bytesOf(content.content), content.executable ?? false));
      } else if (content.kind === "directory") {
        const files = entry.surface.id === "skills" && entry.harness !== resourcesOwner && excludedSkills.size > 0
          ? content.files.filter((file) => !excludedSkills.has(file.path.split("/", 1)[0]!))
          : content.files;
        built.push(directoryResource(
          id,
          entry.surface.target,
          policy,
          files.map((file) => ({ path: file.path, content: bytesOf(file.content), executable: file.executable ?? false })),
        ));
      } else if (entry.surface.kind === "config") {
        // Protect previously applied keys even when this revision drops all of
        // them: removing a locally edited key must still report drift.
        const previous = applied.get(id);
        const anyOwned = (previous?.ownership === "ConfigKeys" && previous.ownedKeys.length > 0)
          || takeoverUnits(entry).length > pending.length;
        // Only authored resources take `fromSecret`; harness settings keep their values as written.
        const resolved = entry.harness === resourcesOwner
          ? yield* resolveResourceSecrets(entry.surface.id, entry.surface.target, content.keys)
          : { keys: content.keys, holdsSecrets: false };
        built.push(configResource(
          id,
          entry.surface.target,
          anyOwned ? "replace-if-unmodified" : "merge",
          entry.surface.format,
          resolved.keys,
          releases.length > 0 ? releases : undefined,
          resolved.holdsSecrets,
        ));
      }
    }
    // A settings file this run projects nothing into would retire, and
    // retirement removes every key its record owns. Claimed keys stay: the
    // file is planned with no keys, giving the claimed ones back and removing
    // only the others. Preserved MCP keys of any config surface stay the same way.
    const builtIds = new Set(built.map((item) => item.resource.id));
    for (const record of appliedResources) {
      const parsed = parseSurfaceResourceId(record.resource);
      const harness = TARGET_IDS.find((candidate) => candidate === parsed?.harness);
      if (harness === undefined || builtIds.has(record.resource) || isHeldSurface(record) || record.ownership !== "ConfigKeys") continue;
      const settings = parsed?.surface === settingsSurfaceOf(adapterFor(harness).layout(context, loaded.model))?.id;
      const covered = settings ? yield* claimed(harness, record.ownedKeys) : preservedMcpKeys(harness, record.ownedKeys);
      if (covered.size === 0) continue;
      built.push(configResource(record.resource, record.target, "replace-if-unmodified", record.configFormat, [], [...covered]));
    }
    const diagnostics = [
      ...projected.diagnostics,
      ...claims.filter((claim) => !usedClaims.has(claim)).map((claim): Diagnostic => ({
        level: "warning",
        code: "CLAIM_UNUSED",
        harness: claim.harness,
        message: `overlay settings/${claim.harness}#${claim.key} covers no key Canonfig writes in ${claim.harness}'s settings file, so it changes nothing; run 'canonfig overlay remove settings/${claim.harness}#${claim.key}' if you no longer need it`,
      })),
    ];
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
      requiredMcpTools: projected.requiredMcpTools,
      takeovers: units,
      diagnostics,
      harnesses: projected.harnesses,
      isHeld: (record) => isHeldSurface(record)
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
    const projectionApplied = releaseExcludedSkillRecords(appliedResources, loaded.local.excludeSkills);
    const projection = yield* buildProjection(loaded, context, takeovers, projectionApplied, held);
    const current = new Set(projection.built.map((item) => item.resource.id));
    const planned = yield* planBuilt({
      follower: localProjectionFollower,
      origin: "folder",
      originDigest: loaded.digest,
      built: projection.built,
      retired: projectionApplied.filter((record) => !current.has(record.resource) && !projection.isHeld(record)),
      appliedResources: projectionApplied,
    });
    // Planning uses the released view, but the run's rollback must restore what is owned now:
    // excluded skills leave ownership only through records a converged run writes.
    return { ...planned, appliedResources, takeovers: projection.takeovers, diagnostics: projection.diagnostics, harnesses: projection.harnesses };
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
  /** Authored resources the snapshot holds, which a converged restore excludes. */
  readonly resources: ReadonlyArray<string>;
  /** Canonical Folder entries the snapshot holds, which the restore replaces. */
  readonly folderEntries: ReadonlyArray<string>;
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
 *
 * Canonical Folder entries (an `import --replace` backup) are authored
 * content Canonfig never owns, so there is no applied state to check them
 * against: they are written back whatever the folder holds now, and the
 * caller snapshots what they replace first.
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
    const isFolder = (entry: SnapshotEntry) => entry.harness === canonicalFolderOwner;
    const groups = new Map<ResourceIdType, Array<SnapshotEntry>>();
    for (const entry of snapshot.manifest.entries) {
      const id = isFolder(entry)
        ? Schema.decodeUnknownSync(ResourceId)(`folder:${entry.surface}`)
        : surfaceResourceId(entry.harness, surfaceOf(entry));
      groups.set(id, [...groups.get(id) ?? [], entry]);
    }

    // Refuse drifted or unowned surfaces before writing anything.
    const problems: Array<string> = [];
    for (const [id, entries] of groups) {
      const applied = appliedById.get(id);
      const target = entries[0]!.target;
      if (isFolder(entries[0]!)) {
        if (entries[0]!.state === "absent") problems.push(`${target}: the snapshot marks it absent, and restore never deletes Canonical Folder content`);
        continue;
      }
      if (applied === undefined) {
        problems.push(`${target}: Canonfig has no applied state for it (it was never applied completely, or was already restored)`);
        continue;
      }
      const released = entries.filter((entry) =>
        entry.kind === "config" && (applied.ownership !== "ConfigKeys" || !applied.ownedKeys.includes(entry.key))
      );
      if (released.length > 0) {
        problems.push(`${target}: snapshot contains config keys Canonfig no longer owns (already restored or released)`);
        continue;
      }
      const state = removedResourceState(applied);
      if (state === undefined) {
        problems.push(`${target}: its applied state cannot be checked`);
        continue;
      }
      // An append-local surface is compared on Canonfig's part only: the
      // machine's own text or entries beside it are never drift.
      const shared = applied.ownership === "SourceSection"
        || applied.ownership === "DirectoryEntries" && applied.policy === "append-local";
      const resource = { ...state.resource, policy: shared ? "append-local" as const : "replace-if-unmodified" as const };
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
      // Present for every harness group: the check above refused any without.
      // Folder groups have none and never read it: they are never config,
      // append-local or absent.
      const applied = appliedById.get(id)!;
      const first = entries[0]!;
      if (first.kind === "config") {
        const captured = new Set(entries.flatMap((entry) => entry.kind === "config" ? [entry.key] : []));
        const keys = entries.flatMap((entry) => {
          if (entry.kind !== "config" || entry.state === "absent") return [];
          const value = snapshot.keys.get(entry.harness)?.get(entry.target)?.get(entry.key);
          return value === undefined ? [] : [{ path: entry.key, value }];
        });
        // The preflight above requires ConfigKeys ownership for every captured key.
        if (applied.ownership !== "ConfigKeys") {
          return yield* new ProjectionHumanActionError({ message: `${first.target}: its applied state does not own config keys` });
        }
        const kept = applied.ownedKeys.filter((key) => !captured.has(key));
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
      // An append-local surface already holds the machine's content beside
      // Canonfig's (first adoption kept everything that was there), so giving
      // it back means removing only Canonfig's part, not writing the snapshot
      // over the machine's later edits.
      if (!isFolder(first) && (applied.ownership === "SourceSection"
        || applied.ownership === "DirectoryEntries" && applied.policy === "append-local")) {
        retired.push(applied);
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
    const owners = [...new Set(snapshot.manifest.entries.map((entry) => entry.harness))];
    const harnesses = owners.filter((owner) => owner !== sharedSkillsOwner && owner !== resourcesOwner && owner !== canonicalFolderOwner);
    const resources = [...new Set(snapshot.manifest.entries.filter((entry) => entry.harness === resourcesOwner).map(surfaceOf))].sort();
    const folderEntries = snapshot.manifest.entries.filter(isFolder).map((entry) => entry.surface);
    return { ...planned, harnesses, resources, folderEntries } satisfies RestorePlan;
  });
