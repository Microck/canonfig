import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";

import { Effect, Option, Schema } from "effect";

import {
  AgentResolution,
  executableAllowed,
  isNestedCommandLauncher,
  pathWithin,
} from "../agent/agent-resolution.service.ts";
import type { AgentResolutionOutcome } from "../agent/agent-resolution.types.ts";
import {
  ContentDigest,
  ProfileId,
  ProfileRevisionId,
  ResourceId,
  SourceSignature,
} from "../domain/brand.ts";
import {
  type ProfileRevision,
  type PublishedResourceSpec,
  type VerificationInput,
} from "../domain/profile.ts";
import type { AppliedResourceRecord } from "../domain/synchronization.ts";
import {
  fetchRevision,
  listRevisions,
} from "../enrollment/follower-client.ts";
import type {
  FetchedRevision,
  RevisionMetadata,
} from "../enrollment/enrollment.types.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { detectHarnesses } from "../projection/detect.ts";
import {
  CanonicalFolderError,
  LocalItemCollisionError,
  loadCanonicalFolder,
  type FolderFile,
} from "../projection/folder.ts";
import { mirrorItem, renderMirrorConfig, type MirrorEntry } from "../projection/mirror.ts";
import {
  buildProjection,
  fileResource,
  parseSurfaceResourceId,
  planBuilt,
  rootContext,
  takeoverSummary,
  type BuiltResource,
} from "../projection/plan.ts";
import {
  discardRunArtifacts,
  finishProjectionRun,
  loadRunArtifacts,
  releaseUnappliedTakeovers,
  runProjection,
  type LocalSyncOptions,
} from "../projection/sync.ts";
import { ScheduleManager } from "../schedule/schedule-manager.service.ts";
import {
  desiredScheduleInput,
  scheduleAvailableDetail,
  type ScheduleSyncReport,
  unmanagedScheduleDetail,
} from "../schedule/schedule-manager.types.ts";
import {
  canonicalJson,
  directoryVerificationDigest,
  sha256BytesHex,
  sha256Hex,
} from "../profile/profile-codec.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import { Synchronization } from "./synchronization.service.ts";
import { renderConfigDocument } from "./config-codec.ts";
import {
  defaultLocalExecution,
  FollowerSynchronizationConfigurationError,
  type FollowerSynchronizationConfiguration,
  type FollowerAgentHarnessConfiguration,
} from "./follower-sync-config.ts";
import {
  cleanupRollbackSnapshots,
  preflightPathLengths,
  removeRunTemporaryEntries,
} from "./executor.ts";
import { withRunLock } from "./run-lock.ts";
import { assertUpgradeGate } from "./upgrade-gate.ts";
import { installerRefusals } from "./installer-bindings.ts";
import { clientReviewSteps, plannedFileChanges } from "./client-review.ts";
import type {
  DesiredResource,
  PlannedSynchronization,
  PlanningLocalRevision,
  SynchronizationArtifact,
  SynchronizationAgentConfiguration,
} from "./synchronization.types.ts";

/**
 * The bound on a process Canonfig starts on this machine. Installers and
 * `command` verifications routinely outlast an HTTP request, so this is
 * deliberately not the transport timeout.
 */
const localProcessTimeout = (
  configuration: FollowerSynchronizationConfiguration,
): number =>
  configuration.localExecution?.processTimeoutMilliseconds
    ?? defaultLocalExecution.processTimeoutMilliseconds;

const configurationError = (
  reason: "missing" | "stale" | "invalid-profile" | "invalid-reference",
  message: string,
) => new FollowerSynchronizationConfigurationError({ reason, message });

export const loadFollowerSynchronizationConfiguration = Effect.fn(
  "FollowerOrchestration.loadConfiguration",
)(function*(
  stateLocation: string,
): Effect.fn.Return<
  FollowerSynchronizationConfiguration,
  FollowerSynchronizationConfigurationError,
  StateRepository
> {
  const repository = yield* StateRepository;
  const configuration = yield* repository
    .getFollowerSynchronizationConfiguration()
    .pipe(
      Effect.mapError(() =>
        configurationError("stale", "follower synchronization configuration is unreadable")
      ),
    );
  if (configuration === undefined) {
    return yield* configurationError(
      "missing",
      "follower synchronization configuration is not enrolled",
    );
  }
  if (configuration.stateLocation !== stateLocation) {
    return yield* configurationError(
      "stale",
      "follower synchronization configuration belongs to another state repository",
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(configuration.source.endpoint);
  } catch {
    return yield* configurationError(
      "stale",
      "configured source endpoint is malformed",
    );
  }
  if (
    endpoint.protocol !== "https:"
    || (
      endpoint.hostname !== "127.0.0.1"
      && endpoint.hostname !== "[::1]"
      && endpoint.hostname !== "::1"
    )
  ) {
    return yield* configurationError(
      "stale",
      "configured source endpoint is not pinned loopback HTTPS",
    );
  }
  const state = yield* repository.loadState(configuration.follower.id).pipe(
    Effect.mapError(() =>
      configurationError("stale", "configured follower identity is unavailable")
    ),
  );
  if (
    state.follower.id !== configuration.follower.id
    || state.follower.credentialReference !== configuration.credentialReference
    || state.follower.revoked
    || state.sourceIdentity?.publicKeyFingerprint
      !== configuration.source.signingFingerprint
  ) {
    return yield* configurationError(
      "stale",
      "configured follower, source, or credential reference is stale",
    );
  }
  return configuration;
});

const transportInput = (
  configuration: FollowerSynchronizationConfiguration,
  signal?: AbortSignal,
) => ({
  endpoint: configuration.source.endpoint,
  tlsFingerprint: configuration.source.tlsFingerprint,
  credentialReference: configuration.credentialReference,
  sourceFingerprint: configuration.source.signingFingerprint,
  timeoutMilliseconds: configuration.scheduledInvocation.timeoutMilliseconds,
  signal,
});

const selectedRevision = Effect.fn(
  "FollowerOrchestration.selectedRevision",
)(function*(
  configuration: FollowerSynchronizationConfiguration,
  requestedRevision?: string,
  signal?: AbortSignal,
) {
  const revisions = yield* listRevisions(transportInput(configuration, signal));
  const matching = revisions.revisions
    .filter((revision) => revision.profileId === configuration.profile)
    .sort((left, right) => right.sequence - left.sequence);
  const selected = requestedRevision === undefined
    ? matching[0]
    : matching.find((revision) => revision.id === requestedRevision);
  if (selected === undefined) {
    return yield* configurationError(
      "invalid-profile",
      requestedRevision === undefined
        ? `profile ${configuration.profile} has no authorized revision`
        : `recovery revision ${requestedRevision} is no longer authorized`,
    );
  }
  return selected;
});

interface DecodedSpec {
  readonly resource: RevisionMetadata["resources"][number];
  readonly spec: PublishedResourceSpec;
  readonly content: ReadonlyMap<string, Uint8Array>;
}

const decodeSpecs = (
  fetched: FetchedRevision,
): Effect.Effect<ReadonlyArray<DecodedSpec>, FollowerSynchronizationConfigurationError> =>
  Effect.forEach(fetched.metadata.resources, (resource) =>
    Effect.gen(function*() {
      if (resource.spec.kind !== resource.kind) {
        return yield* configurationError(
          "stale",
          `resource ${resource.id} kind does not match its signed metadata`,
        );
      }
      const content = new Map<string, Uint8Array>();
      for (const id of resource.blobs) {
        const blob = fetched.blobs.find((entry) => entry.id === id);
        if (blob === undefined) {
          return yield* configurationError(
            "stale",
            `resource ${resource.id} is missing verified blob ${id}`,
          );
        }
        const bytes = yield* Effect.tryPromise({
          try: () => readFile(blob.path),
          catch: () =>
            configurationError(
              "stale",
              `verified cache blob for ${resource.id} is unavailable`,
            ),
        });
        content.set(id, bytes);
      }
      return { resource, spec: resource.spec, content };
    })
  );

const contentFor = (
  content: ReadonlyMap<string, Uint8Array>,
  blob: string,
): Uint8Array => {
  const bytes = content.get(blob);
  if (bytes === undefined) throw new Error(`verified blob ${blob} is unavailable`);
  return bytes;
};

interface HydratedDesiredResource {
  readonly desired: DesiredResource;
  readonly artifacts: ReadonlyArray<SynchronizationArtifact>;
}

const desiredFor = (
  spec: PublishedResourceSpec,
  contentByBlob: ReadonlyMap<string, Uint8Array>,
  verification: VerificationInput,
): HydratedDesiredResource => {
  switch (spec.kind) {
    case "file": {
      const digest = Schema.decodeUnknownSync(ContentDigest)(spec.blob);
      return {
        desired: {
          kind: "file",
          digest,
          executable: spec.executable,
          mode: spec.mode ?? (spec.executable ? 0o700 : 0o600),
        },
        artifacts: [{ digest, content: contentFor(contentByBlob, spec.blob) }],
      };
    }
    case "skill": {
      const files = spec.files.map((file) => ({
        path: file.path,
        digest: Schema.decodeUnknownSync(ContentDigest)(file.blob),
        executable: file.executable,
        mode: file.mode ?? (file.executable ? 0o700 : 0o600),
      }));
      return {
        desired: { kind: "skill", digest: directoryVerificationDigest(files), mode: 0o700, directories: [], files },
        artifacts: spec.files.map((file, index) => ({
          digest: files[index]!.digest,
          content: contentFor(contentByBlob, file.blob),
        })),
      };
    }
    case "config": {
      const content = renderConfigDocument(spec);
      const digest = Schema.decodeUnknownSync(ContentDigest)(sha256BytesHex(content));
      return {
        desired: {
          kind: "config",
          digest,
          format: spec.format,
          keys: spec.keys
            .map((entry) => entry.path)
            .sort((left, right) => left.localeCompare(right)),
        },
        artifacts: [{ digest, content }],
      };
    }
    case "tool":
      return {
        desired: {
          kind: "tool",
          toolId: spec.toolId,
          recipes: spec.recipes,
          loginRequired: spec.login?.required ?? false,
          loginInstructions: spec.login?.required === true
            ? spec.login.howTo
            : undefined,
          agentInstall: spec.agentInstall,
          qualification: verification.method === "mcp-qualification"
            ? verification
            : undefined,
        },
        artifacts: [],
      };
    case "credential":
      return {
        desired: {
          kind: "credential",
          reference: spec.reference,
          instructions:
            `Store credential ${spec.reference} in this machine's secure credential store, then run synchronization again.`,
        },
        artifacts: [],
      };
  }
};

/** The resource id of a follower's rendered `canonfig.jsonc`. */
const mirrorConfigResource = Schema.decodeUnknownSync(ResourceId)("mirror:canonfig.jsonc");

const McpRequires = Schema.Struct({ requires: Schema.optional(Schema.Array(Schema.String)) });

const encoder = new TextEncoder();

/**
 * Plan one follower run from a verified Source revision, in three parts:
 *
 * 1. The managed mirror: every authorized file and skill item at the same
 *    place in this machine's `~/.canonfig/`, plus a `canonfig.jsonc` rendered
 *    from the authorized JSON items. Mirror items use the three-way
 *    `replace-if-unmodified` rule, so a local edit is Follower Drift: kept,
 *    reported, and the run stops before anything projected from it changes.
 * 2. Tools and credentials, applied as published.
 * 3. The projection of the mirror (as this run writes it, read from memory)
 *    plus `local/` into the listed, installed and not excluded harnesses.
 *    Every projected resource depends on the mirror and on the tools its MCP
 *    servers require, so those apply first. Every retirement outside the
 *    folder (a projected output or tool the revision no longer has) depends
 *    on the mirror too, so mirror drift stops the run before it as well.
 *    Retirements inside the folder stay first: a mirror path handed from one
 *    item to another is removed before it is written.
 */
const planFollowerRun = Effect.fn("FollowerOrchestration.planRun")(function*(
  fetched: FetchedRevision,
  configuration: FollowerSynchronizationConfiguration,
  appliedResources: ReadonlyArray<AppliedResourceRecord>,
  environment: (name: string) => string | undefined,
) {
  const machine = yield* MachineState;
  const repository = yield* StateRepository;
  const folder = dirname(configuration.stateLocation);
  const folderPath = yield* machine.normalizePath({ path: folder });
  const inFolder = (path: string) => machine.normalizePath({ path, base: folderPath }).pipe(Effect.map((resolved) => resolved.absolute));
  const decoded = yield* decodeSpecs(fetched);
  const built: Array<BuiltResource> = [];
  const mirrorFiles = new Map<string, FolderFile>();
  const entries: Array<MirrorEntry> = [];
  const mirrored: Array<ResourceId> = [];
  for (const entry of decoded) {
    const item = mirrorItem({ ...entry.resource, spec: entry.spec });
    if (item === undefined) {
      return yield* configurationError(
        "invalid-profile",
        `revision ${fetched.metadata.id} holds resource ${entry.resource.id}, which is not a Canonical Folder item; publish ~/.canonfig/ again on the Source with this release`,
      );
    }
    if (item.kind === "entry") {
      entries.push(item);
      continue;
    }
    const { verify, ...published } = entry.resource;
    const hydration = desiredFor(entry.spec, entry.content, verify);
    if (item.kind === "file") {
      built.push({
        resource: { ...published, spec: undefined, target: yield* inFolder(item.path), dependsOn: [], blobs: [], groups: undefined },
        entry: { resource: published.id, desired: hydration.desired, verification: verify },
        artifacts: hydration.artifacts,
      });
      mirrored.push(published.id);
      const files = entry.spec.kind === "file"
        ? [{ path: item.path, blob: entry.spec.blob, executable: entry.spec.executable }]
        : entry.spec.kind === "skill"
        ? entry.spec.files.map((file) => ({ path: `${item.path}/${file.path}`, blob: file.blob, executable: file.executable }))
        : [];
      for (const file of files) {
        mirrorFiles.set(file.path, { content: contentFor(entry.content, file.blob), executable: file.executable });
      }
      continue;
    }
    const tool = hydration.desired.kind === "tool" ? hydration.desired : undefined;
    // `agentInstall.paths` are authored once for every follower, so `~`
    // means this follower's home. Resolving them here gives the Agent Task,
    // the harness bounds check and the agent itself the absolute paths the
    // follower's `--allow-path` values are stored as.
    const desired = tool?.agentInstall === undefined ? hydration.desired : {
      ...tool,
      agentInstall: {
        ...tool.agentInstall,
        paths: yield* Effect.forEach(tool.agentInstall.paths, (path) =>
          machine.normalizePath({ path }).pipe(Effect.map((normalized) => normalized.absolute))
        ).pipe(Effect.mapError(() =>
          configurationError("invalid-profile", `Cannot resolve agentInstall paths for ${published.id}`)
        )),
      },
    };
    built.push({
      resource: { ...published, groups: undefined, dependsOn: [], blobs: [] },
      entry: { resource: published.id, desired, verification: verify },
      artifacts: [],
    });
  }
  const configContent = encoder.encode(renderMirrorConfig(entries));
  mirrorFiles.set("canonfig.jsonc", { content: configContent, executable: false });
  built.push(fileResource(mirrorConfigResource, yield* inFolder("canonfig.jsonc"), "replace-if-unmodified", configContent, false));
  mirrored.push(mirrorConfigResource);

  const loaded = yield* Effect.tryPromise({
    try: () => loadCanonicalFolder(folder, mirrorFiles),
    catch: (error) =>
      error instanceof CanonicalFolderError || error instanceof LocalItemCollisionError
        ? error
        : new CanonicalFolderError({ path: folder, message: String(error) }),
  });
  const context = yield* rootContext(environment);
  const takeovers = yield* repository.loadHarnessTakeovers();
  // A listed harness projects only once installed; until then it is reported
  // and its earlier outputs are held, and the run can still converge.
  const installed = new Set((yield* detectHarnesses(context, folder))
    .filter((entry) => entry.installed)
    .map((entry) => entry.harness));
  const notInstalled = loaded.model.harnesses.filter((harness) => !installed.has(harness));
  const projection = yield* buildProjection(loaded, context, takeovers, appliedResources, notInstalled);
  const authorized = new Set<string>(built.map((item) => item.resource.id));
  const requiredTools = entries.flatMap((entry) =>
    entry.key.startsWith("mcp.")
      ? Option.match(Schema.decodeUnknownOption(McpRequires)(entry.value), {
        onNone: () => [],
        onSome: (server) => (server.requires ?? []).map((reference) => reference.replace("/", ":")),
      })
      : []
  ).filter((id) => authorized.has(id));
  const prerequisites = [...new Set([...mirrored, ...requiredTools.map((id) => Schema.decodeUnknownSync(ResourceId)(id))])].sort();
  built.push(...projection.built.map((item) => ({
    ...item,
    resource: { ...item.resource, dependsOn: [...new Set([...item.resource.dependsOn, ...prerequisites])] },
  })));
  const current = new Set(built.map((item) => item.resource.id));
  const heldConsumers = appliedResources.some((record) => parseSurfaceResourceId(record.resource) !== undefined && projection.isHeld(record));
  // Generated instructions link to rules; hook runners execute scripts in place.
  // Keep both until every retained consumer can stop referencing them.
  const isLinkedFile = (target: string | undefined) => {
    if (target === undefined) return false;
    const path = relative(folderPath.absolute, target);
    return path.startsWith(`hooks${sep}`) || path.startsWith(`rules${sep}`);
  };
  const retired = appliedResources.filter((record) =>
    !current.has(record.resource) && !projection.isHeld(record) && !(heldConsumers && isLinkedFile(record.target))
  );
  const consumers = [...projection.built.map((item) => item.resource.id), ...retired.map((record) => record.resource)]
    .filter((id) => parseSurfaceResourceId(id) !== undefined);
  const planned = yield* planBuilt({
    follower: configuration.follower.id,
    origin: "revision",
    originDigest: fetched.metadata.metadataDigest,
    sourceRevision: Schema.decodeUnknownSync(ProfileRevisionId)(fetched.metadata.id),
    built,
    retired,
    retiredDependsOn: (record) => {
      if (isLinkedFile(record.target)) return consumers;
      if (record.target === undefined || !isAbsolute(record.target)) return mirrored;
      const fromFolder = relative(folderPath.absolute, record.target);
      const inside = fromFolder !== ".." && !fromFolder.startsWith(`..${sep}`) && !isAbsolute(fromFolder);
      return inside ? [] : mirrored;
    },
    appliedResources,
  });
  return {
    ...planned,
    takeovers: projection.takeovers,
    diagnostics: projection.diagnostics,
    harnesses: projection.harnesses,
    notInstalled,
    backups: loaded.local.backups,
    home: context.home,
  };
});

/**
 * The follower's record of a run's revision as a profile revision, under the
 * run's revision id: what `status` reports as the published revision this
 * machine applied. The id is content-addressed, so equal runs store equal
 * records.
 */
const persistableRevision = (
  revision: PlanningLocalRevision,
  metadata: RevisionMetadata,
): ProfileRevision => {
  const canonicalBytes = canonicalJson(
    Schema.decodeUnknownSync(Schema.MutableJson)({
      sourceRevision: metadata.id,
      metadataDigest: metadata.metadataDigest,
      resources: metadata.resources,
    }),
  );
  return {
    id: revision.id,
    // One record per run revision (`<source revision>:view:<digest>`), so its
    // profile carries the same suffix: two runs of one Source revision that
    // project differently must not share a (profile, sequence) row.
    profileId: Schema.decodeUnknownSync(ProfileId)(`${metadata.profileId}${revision.id.slice(metadata.id.length)}`),
    sequence: metadata.sequence,
    canonicalBytes,
    digest: sha256Hex(canonicalBytes),
    signature: Schema.decodeUnknownSync(SourceSignature)(metadata.sourceSignature),
    publishedAt: metadata.publishedAt,
    resources: revision.resources.filter((resource) => !revision.removedResources?.includes(resource.id)),
    groups: [],
    scheduleDefault: metadata.scheduleDefault,
  };
};

const originWithinHarnessBounds = (
  origin: string,
  configuration: FollowerAgentHarnessConfiguration,
): boolean => {
  try {
    const normalized = new URL(origin).origin;
    return configuration.allowedOrigins.some((allowed) =>
      new URL(allowed).origin === normalized
    );
  } catch {
    return false;
  }
};

const harnessConfigurationIssue = (
  configuration: FollowerAgentHarnessConfiguration,
): string | undefined => {
  if (configuration.executable.trim() !== configuration.executable) {
    return "agent harness executable reference is invalid";
  }
  if (
    configuration.environment?.some((entry) =>
      entry.name.trim() !== entry.name || entry.name.includes("=")
    ) === true
  ) {
    return "agent harness environment overrides are invalid";
  }
  if (configuration.allowedPaths.some((path) => path.trim() !== path)) {
    return "agent harness path bounds are invalid";
  }
  if (
    configuration.allowedExecutables.some((executable) =>
      executable.trim() !== executable
    )
    || configuration.executableAuthorizations?.some((authorization) =>
      authorization.executable.trim() !== authorization.executable
    ) === true
  ) {
    return "agent harness executable bounds are invalid";
  }
  if (
    configuration.executableAuthorizations?.some((authorization) =>
      isNestedCommandLauncher(authorization.executable)
    ) === true
  ) {
    return "agent harness executable bounds include an unboundable nested-command launcher";
  }
  if (
    configuration.executableAuthorizations?.some((authorization) =>
      authorization.behavior === "script-interpreter"
    ) === true
  ) {
    return "agent harness script-interpreter execution requires an unavailable cross-platform sandbox";
  }
  for (const origin of configuration.allowedOrigins) {
    try {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.origin !== origin) {
        return "agent harness origin bounds must be exact HTTPS origins";
      }
    } catch {
      return "agent harness origin bounds are invalid";
    }
  }
  return undefined;
};

const boundedTask = (
  task: PlannedSynchronization["agentTasks"][number],
  configuration: FollowerAgentHarnessConfiguration,
) =>
  Effect.gen(function*() {
    const allowedExecutables: Array<string> = [];
    for (const executable of task.allowedExecutables) {
      if (yield* executableAllowed(
        executable,
        configuration.allowedExecutables,
        configuration.environment,
        task.allowedPaths[0] ?? process.cwd(),
      )) {
        allowedExecutables.push(executable);
      }
    }
    // Authorizations may only claim executables that survived the harness
    // allowlist; otherwise the bounded task would over-claim its bounds.
    const boundedAuthorizations = task.executableAuthorizations?.filter(
      (authorization) => allowedExecutables.includes(authorization.executable),
    );
    return {
      ...task,
      allowedPaths: task.allowedPaths.filter((path) =>
        configuration.allowedPaths.some((root) => pathWithin(path, root))
      ),
      allowedExecutables,
      executableAuthorizations: boundedAuthorizations,
      allowedOrigins: task.allowedOrigins.filter((origin) =>
        originWithinHarnessBounds(origin, configuration)
      ),
      forbidden: [...new Set([
        ...task.forbidden,
        ...(["elevation", "login", "restart", "reboot"] as const).filter(
          (capability) => !configuration.allowedCapabilities.includes(capability),
        ),
      ])],
    };
  });

const recanonicalizePlan = (
  plan: PlannedSynchronization,
  actions: PlannedSynchronization["actions"],
): PlannedSynchronization => {
  const body = {
    revision: plan.revision,
    follower: plan.follower,
    requiredBlobs: plan.requiredBlobs,
    actions,
    agentTasks: plan.agentTasks,
  };
  const encoded = canonicalJson(Schema.decodeUnknownSync(Schema.MutableJson)(
    JSON.parse(JSON.stringify(body)),
  ));
  return { ...body, encoded, digest: sha256Hex(encoded) };
};

const agentConfigurationFor = (
  configuration: FollowerSynchronizationConfiguration,
  scheduled: boolean,
  signal?: AbortSignal,
): SynchronizationAgentConfiguration => ({
  policy: configuration.agentPolicy,
  harness: configuration.agentHarness === undefined
    ? undefined
    : {
      harness: configuration.agentHarness.kind,
      executable: configuration.agentHarness.executable,
      model: configuration.agentHarness.model,
      arguments: configuration.agentHarness.arguments,
      environment: configuration.agentHarness.environment,
      secretBindings: configuration.agentHarness.secretBindings,
      maximumInputBytes: configuration.agentHarness.maximumInputBytes,
      allowedPaths: configuration.agentHarness.allowedPaths,
      allowedExecutables: configuration.agentHarness.allowedExecutables,
      executableAuthorizations: configuration.agentHarness.executableAuthorizations,
      allowedOrigins: configuration.agentHarness.allowedOrigins,
      allowedCapabilities: configuration.agentHarness.allowedCapabilities,
    },
  scheduled,
  signal,
});

/**
 * Brings the native synchronization job in line with the follower's decision,
 * after a converged run, and says what it did.
 *
 * Deliberately outside the resource transaction, and deliberately failure
 * tolerant. A scheduler that does not work is operational degradation on this
 * machine, not a reason to undo configuration that applied correctly: the
 * schedule used to be a planned action, so a host without a working user
 * scheduler failed the whole run and rolled it back, and could never converge.
 *
 * Only an explicit decision installs a job (`schedule set`, or `schedule set
 * --default` to follow the profile). An armed job whose rendered binding
 * (runtime, entrypoint, argv) went stale is re-rendered with its cadence
 * intact. A job deleted, disabled, stopped, or overridden outside Canonfig is
 * left as is and reported; sync used to recreate and re-enable it silently.
 * A job that exists without any decision (a v2.x `schedule set`, or a v3.x
 * profile default installed without consent) is kept, never deleted.
 */
const reconcileSchedule = Effect.fn(
  "FollowerOrchestration.reconcileSchedule",
)(function*(
  configuration: FollowerSynchronizationConfiguration,
  scheduleDefault: RevisionMetadata["scheduleDefault"],
  scheduleManager: ScheduleManager["Service"] | undefined,
): Effect.fn.Return<ScheduleSyncReport | undefined> {
  const override = configuration.scheduleOverride;
  // `schedule remove` already removed the job; anything there now is the user's.
  if (scheduleManager === undefined || override?.kind === "disabled") return undefined;
  const failed = (error: { readonly message: string }) =>
    Effect.succeed<ScheduleSyncReport>({
      action: "failed",
      detail: `the native schedule could not be reconciled: ${error.message}`,
    });
  const desired = desiredScheduleInput(override, scheduleDefault);
  if (desired !== undefined) {
    return yield* scheduleManager.reconcile(desired).pipe(
      Effect.map((result): ScheduleSyncReport => ({
        action: result.action,
        state: result.status.state,
        detail: result.status.detail,
      })),
      Effect.catch(failed),
    );
  }
  if (override?.kind === "inherit") {
    // The follower chose to follow the profile, and the profile withdrew it.
    return yield* scheduleManager.remove().pipe(
      Effect.map((result): ScheduleSyncReport | undefined =>
        result.change === "removed"
          ? {
            action: "removed",
            detail: "the profile no longer declares a schedule default, so the inherited native schedule was removed; run `canonfig schedule set <calendar>` to keep one",
          }
          : undefined
      ),
      Effect.catch(failed),
    );
  }
  return yield* scheduleManager.status().pipe(
    Effect.map((status): ScheduleSyncReport | undefined =>
      status.state !== "not-installed"
        ? { action: "kept-unmanaged", state: status.state, detail: unmanagedScheduleDetail }
        : scheduleDefault === undefined
        ? undefined
        : { action: "available", detail: scheduleAvailableDetail(scheduleDefault) }
    ),
    Effect.catch(failed),
  );
});

const persistProfileScheduleDefault = Effect.fn(
  "FollowerOrchestration.persistProfileScheduleDefault",
)(function*(
  configuration: FollowerSynchronizationConfiguration,
  scheduleDefault: RevisionMetadata["scheduleDefault"],
) {
  const repository = yield* StateRepository;
  const state = yield* repository.loadState(configuration.follower.id);
  if (state.sourceIdentity === undefined) return;
  yield* repository.saveFollowerSynchronizationConfiguration({
    sourceIdentity: state.sourceIdentity,
    configuration: {
      ...configuration,
      scheduleDefault,
      updatedAt: new Date().toISOString(),
    },
  });
});

export const resolveAgentTasks = Effect.fn("FollowerOrchestration.resolveAgentTasks")(
  function*(
    configuration: FollowerSynchronizationConfiguration,
    plan: PlannedSynchronization,
    scheduled: boolean,
    signal?: AbortSignal,
    planning = false,
  ) {
    const noResolutions: ReadonlyArray<AgentResolutionOutcome> = [];
    if (
      plan.agentTasks.length === 0
      || configuration.agentPolicy === "deterministic-only"
    ) {
      return {
        plan,
        agentResolutions: noResolutions,
      };
    }
    const harness = configuration.agentHarness;
    const harnessIssue = harness === undefined
      ? "Agent harness is not configured"
      : harnessConfigurationIssue(harness);
    if (harness === undefined || harnessIssue !== undefined) {
      const actions = plan.actions.map((action) =>
        action.detail.kind === "agent-task"
          ? {
            ...action,
            kind: "human-action" as const,
            detail: {
              kind: "human-action" as const,
              reason: `${harnessIssue} for ${action.detail.summary}`,
              instructions:
                "Configure a supported bounded agent harness, or switch to deterministic-only policy, then rerun synchronization.",
            },
          }
          : action
      );
      return {
        plan: recanonicalizePlan(plan, actions),
        agentResolutions: noResolutions,
      };
    }
    const agent = yield* AgentResolution;
    const resolutions: Array<AgentResolutionOutcome> = [];
    const replacements = new Map<string, "resolved" | "human">();
    const reasons = new Map<string, string>();
    for (const task of plan.agentTasks) {
      const bounded = yield* boundedTask(task, harness);
      const resolution = yield* agent.resolve({
        policy: planning ? "agent-propose" : configuration.agentPolicy,
        task: bounded,
        harness: {
          harness: harness.kind,
          executable: harness.executable,
          model: harness.model,
          arguments: harness.arguments,
          environment: harness.environment,
          secretBindings: harness.secretBindings,
          maximumInputBytes: harness.maximumInputBytes,
          allowedPaths: harness.allowedPaths,
          allowedExecutables: harness.allowedExecutables,
          executableAuthorizations: harness.executableAuthorizations,
          allowedOrigins: harness.allowedOrigins,
          allowedCapabilities: harness.allowedCapabilities,
        },
        scheduled,
        signal,
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: (outcome) => ({ outcome }),
        }),
      );
      if ("error" in resolution) {
        const reason =
          `Configured agent harness could not safely resolve the task: ${resolution.error.message.slice(0, 1024)}`;
        replacements.set(task.id, "human");
        reasons.set(task.id, reason);
        // Report the refusal rather than dropping it. A plan used to compute
        // this and discard it, so the agent task showed unchanged with an
        // empty agentResolutions and no reason at all.
        resolutions.push({ outcome: "refused", task: bounded, reason });
        continue;
      }
      resolutions.push(resolution.outcome);
      replacements.set(
        task.id,
        resolution.outcome.outcome === "applied" ? "resolved" : "human",
      );
      if (resolution.outcome.outcome === "proposed") {
        reasons.set(
          task.id,
          `Agent proposal requires human review: ${resolution.outcome.proposal.summary}`,
        );
      }
    }
    const actions = plan.actions.map((action) => {
      if (action.detail.kind !== "agent-task") return action;
      if (planning) return action;
      const replacement = replacements.get(action.detail.taskId);
      if (replacement === "resolved") {
        return {
          ...action,
          kind: "no-op" as const,
          detail: { kind: "no-op" as const },
        };
      }
      return {
        ...action,
        kind: "human-action" as const,
        detail: {
          kind: "human-action" as const,
          reason: reasons.get(action.detail.taskId)
            ?? `Bounded agent task requires resolution: ${action.detail.summary}`,
          instructions:
            `Resolve task ${action.detail.taskId} under the configured bounds, then rerun synchronization.`,
        },
      };
    });
    return {
      plan: recanonicalizePlan(plan, actions),
      agentResolutions: resolutions,
    };
  },
);

/**
 * `canonfig sync` on a follower: fetch and verify the latest authorized
 * revision, then plan and (with `apply`) run its mirror, tools and
 * projection as one journaled run. See {@link planFollowerRun}.
 */
export const synchronizeFollower = Effect.fn(
  "FollowerOrchestration.synchronize",
)(function*(
  stateLocation: string,
  mode: "plan" | "apply",
  projection: LocalSyncOptions,
  signal?: AbortSignal,
  scheduled = false,
) {
  const repository = yield* StateRepository;
  const machine = yield* MachineState;
  const agentResolution = Option.getOrUndefined(
    yield* Effect.serviceOption(AgentResolution),
  );
  const scheduleManager = Option.getOrUndefined(
    yield* Effect.serviceOption(ScheduleManager),
  );
  const configuration = yield* loadFollowerSynchronizationConfiguration(
    stateLocation,
  );
  if (mode === "apply") {
    yield* assertUpgradeGate(configuration.follower.id);
  }
  const selected = yield* selectedRevision(configuration, undefined, signal);
  const fetched = yield* fetchRevision({
    ...transportInput(configuration, signal),
    revisionId: selected.id,
    cacheDirectory: configuration.cacheDirectory,
    maximumMetadataBytes:
      configuration.scheduledInvocation.maximumMetadataBytes,
    maximumBlobBytes: configuration.scheduledInvocation.maximumBlobBytes,
  }).pipe(Effect.provideService(MachineState, machine));
  const appliedResources = yield* repository.loadAppliedResources(
    configuration.follower.id,
  );
  const followerPlan = yield* planFollowerRun(fetched, configuration, appliedResources, projection.environment);
  // `sync --plan` must not accept a target this machine cannot write; the
  // apply repeats the check before it records the run.
  yield* preflightPathLengths(followerPlan.plan.actions, followerPlan.revision.desired);
  const noAgentResolutions: ReadonlyArray<AgentResolutionOutcome> = [];
  // `agent-propose` records a proposal and stops, which is what the operator
  // documentation and the glossary describe. Apply used to skip resolution
  // entirely and turn every Agent Task straight into a human action without
  // ever invoking the harness, so no proposal was ever recorded.
  //
  // Resolving here is safe for both cases this covers: planning asks the
  // harness to propose, and `agent-propose` proposes by definition, so neither
  // mutates the machine before the run begins. `agent-apply` still resolves
  // inside the run, where its mutation is journaled for recovery.
  const resolveBeforeRun = mode === "plan"
    || configuration.agentPolicy === "agent-propose";
  const planned = resolveBeforeRun
    ? yield* resolveAgentTasks(
      configuration,
      followerPlan.plan,
      scheduled,
      signal,
      mode === "plan",
    )
    : { plan: followerPlan.plan, agentResolutions: noAgentResolutions };
  const appliedAgentResolutions: Array<AgentResolutionOutcome> = [];
  const journaledAgentResolution = mode === "apply" && agentResolution !== undefined
    ? AgentResolution.of({
      resolve: (input) =>
        agentResolution.resolve(input).pipe(
          Effect.tap((outcome) =>
            Effect.sync(() => {
              appliedAgentResolutions.push(outcome);
            })
          ),
        ),
    })
    : undefined;
  const backup = !projection.noBackup && followerPlan.backups;
  const base = {
    mode,
    revision: selected.id,
    downloadedBlobs: fetched.downloadedBlobs,
    reusedBlobs: fetched.reusedBlobs,
    harnesses: followerPlan.harnesses.map((entry) => ({ harness: entry.harness, root: entry.layout.root })),
    notInstalled: followerPlan.notInstalled.length === 0 ? undefined : followerPlan.notInstalled,
    takeovers: takeoverSummary(followerPlan.takeovers, backup),
    diagnostics: followerPlan.diagnostics.length === 0 ? undefined : followerPlan.diagnostics,
  };
  if (mode === "plan") {
    // Planning never touches the native scheduler: it only discloses a
    // profile default the follower has not consented to.
    const schedule: ScheduleSyncReport | undefined =
      configuration.scheduleOverride === undefined && fetched.metadata.scheduleDefault !== undefined
        ? { action: "available", detail: scheduleAvailableDetail(fetched.metadata.scheduleDefault) }
        : undefined;
    // An installer this machine refuses would stop the apply partway; the
    // plan says so now, with the command that fixes it.
    const warnings = yield* installerRefusals(planned.plan.actions.flatMap((action) =>
      action.detail.kind === "install-tool" ? [action.detail.method] : []
    ));
    return {
      ...base,
      plan: planned.plan,
      agentResolutions: planned.agentResolutions,
      schedule,
      warnings: warnings.length === 0 ? undefined : warnings,
      outcome: undefined,
    };
  }
  yield* repository.publishRevision({
    revision: persistableRevision(followerPlan.revision, fetched.metadata),
  });
  const result = yield* runProjection({
    statePath: stateLocation,
    follower: configuration.follower.id,
    planned: { ...followerPlan, plan: planned.plan },
    backup,
    home: followerPlan.home,
    agent: agentConfigurationFor(configuration, scheduled, signal),
    agentResolution: journaledAgentResolution,
    limits: {
      // The transport timeout used to be passed here, which killed any
      // installer or `command` verification that ran longer than 10 seconds.
      processTimeoutMilliseconds: localProcessTimeout(configuration),
    },
  });
  const outcome = result.outcome;
  const schedule = outcome.outcome === "Converged"
    ? yield* persistProfileScheduleDefault(
      configuration,
      fetched.metadata.scheduleDefault,
    ).pipe(Effect.andThen(reconcileSchedule(
      configuration,
      fetched.metadata.scheduleDefault,
      scheduleManager,
    )))
    : undefined;
  // Files a client reads only after its own trust or review step: say which
  // step, since Canonfig cannot see it and `clientLoaded` stays not-verified.
  const clientSteps = outcome.outcome === "Converged"
    ? clientReviewSteps(plannedFileChanges(planned.plan.actions))
    : [];
  return {
    ...base,
    agentResolutions: appliedAgentResolutions,
    snapshot: result.snapshot,
    outcome,
    schedule,
    clientSteps: clientSteps.length === 0 ? undefined : clientSteps,
  };
}, (effect, ...args) =>
  args[1] === "plan" ? effect : withRunLock(args[0], "sync --apply", effect));

/**
 * Closes an interrupted run without recovering it.
 *
 * `recover` needs the run's stored revision, so a follower whose state lost
 * it could not close its run at all: `recover` failed and `sync --apply` was
 * refused with `ActiveRunExistsError` on every attempt, with no way out short
 * of editing the database.
 *
 * This is deliberately not a rollback. Whatever the interrupted run had already
 * applied stays applied, and the next run reconciles it like any other
 * follower state. Abandoning only stops the open run from blocking that, and
 * releases takeovers of surfaces the run never applied, as after an early stop.
 */
export const abandonFollowerRun = Effect.fn(
  "FollowerOrchestration.abandon",
)(function*(stateLocation: string) {
  const repository = yield* StateRepository;
  const configuration = yield* loadFollowerSynchronizationConfiguration(
    stateLocation,
  );
  const recovery = yield* repository.loadRecovery(configuration.follower.id);
  if (recovery === undefined) {
    return yield* configurationError(
      "stale",
      "no durable interrupted synchronization run is available",
    );
  }
  yield* assertUpgradeGate(configuration.follower.id);
  // Canonfig's own temporary files from the killed run go first, so the next
  // run does not see them as foreign content. A failure here leaves the run
  // open with its evidence.
  yield* removeRunTemporaryEntries(recovery.run.plan.actions, recovery.run.id);
  // Abandon explicitly discards recovery, including credential-bearing
  // preimages. Keep the run open if cleanup fails so abandon can be retried.
  yield* cleanupRollbackSnapshots(
    recovery.run.id,
    recovery.run.plan.actions.map((action) => action.id),
    [],
    recovery.actions.flatMap((action) => action.rollbackReference === undefined ? [] : [action.rollbackReference]),
  );
  // Before the run closes, so a failure here leaves it open for another abandon.
  yield* releaseUnappliedTakeovers(stateLocation, configuration.follower.id, recovery.run.id);
  const appliedResources = yield* repository.loadAppliedResources(
    configuration.follower.id,
  );
  yield* repository.completeRun({
    run: recovery.run.id,
    completedAt: new Date().toISOString(),
    outcome: {
      outcome: "Failed",
      run: recovery.run.id,
      reason: "the interrupted run was abandoned by the operator",
    },
    appliedResources,
  });
  yield* discardRunArtifacts(recovery.run.id);
  return {
    run: recovery.run.id,
    revision: recovery.run.revision,
    abandoned: true as const,
  };
}, (effect, ...args) => withRunLock(args[0], "abandon", effect));

/**
 * `canonfig recover` on a follower: resume the interrupted run from the
 * revision and content it stored when it started, so recovery needs neither
 * the Source nor the run's original environment.
 */
export const recoverFollower = Effect.fn(
  "FollowerOrchestration.recover",
)(function*(stateLocation: string, signal?: AbortSignal) {
  const repository = yield* StateRepository;
  const synchronization = yield* Synchronization;
  const agentResolution = Option.getOrUndefined(
    yield* Effect.serviceOption(AgentResolution),
  );
  const configuration = yield* loadFollowerSynchronizationConfiguration(
    stateLocation,
  );
  const recovery = yield* repository.loadRecovery(configuration.follower.id);
  if (recovery === undefined) {
    return yield* configurationError(
      "stale",
      "no durable interrupted synchronization run is available",
    );
  }
  yield* assertUpgradeGate(configuration.follower.id);
  // A run whose revision cannot be read back can only be closed. Saying so
  // ends the loop where recover failed and sync --apply sent the operator
  // back to recover.
  const revision = yield* repository.getLocalRevision(recovery.run.revision).pipe(
    Effect.mapError(() => configurationError(
      "stale",
      `run ${recovery.run.id} cannot be recovered: its revision ${recovery.run.revision} is not stored on this machine. run 'canonfig abandon' to close it without rollback, then 'canonfig sync --apply'`,
    )),
  );
  const artifacts = yield* loadRunArtifacts(recovery.run.id, revision);
  const outcome = yield* synchronization.recover({
    follower: configuration.follower.id,
    revision,
    artifacts,
    agent: agentConfigurationFor(configuration, false, signal),
    agentResolution,
    limits: {
      processTimeoutMilliseconds: localProcessTimeout(configuration),
    },
  });
  yield* finishProjectionRun(stateLocation, configuration.follower.id, recovery.run.id, outcome, revision);
  if (outcome.outcome === "Converged") {
    const published = yield* repository.findRevision(recovery.run.revision);
    yield* persistProfileScheduleDefault(configuration, published?.scheduleDefault);
  }
  return { revision: recovery.run.revision, outcome };
}, (effect, ...args) => withRunLock(args[0], "recover", effect));
