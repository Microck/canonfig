import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Effect, Redacted, Schema } from "effect";

import { AgentResolution } from "../agent/agent-resolution.service.ts";
import type { AgentResolutionOutcome } from "../agent/agent-resolution.types.ts";
import {
  BlobId,
  ContentDigest,
  CredentialReference,
  ProfileId,
  ProfileRevisionId,
  ResourceId,
  RunId,
  SourceSignature,
} from "../domain/brand.ts";
import {
  ResourceSpecInputSchema,
  type ProfileRevision,
  type ResourceSpecInput,
} from "../domain/profile.ts";
import type { ObservedResourceState } from "../domain/synchronization.ts";
import {
  fetchRevision,
  listRevisions,
} from "../enrollment/follower-client.ts";
import type {
  FetchedRevision,
  RevisionMetadata,
} from "../enrollment/enrollment.types.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import {
  canonicalJson,
  sha256BytesHex,
  sha256Hex,
} from "../profile/profile-codec.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import { Synchronization } from "./synchronization.service.ts";
import {
  FollowerSynchronizationConfigurationError,
  type FollowerSynchronizationConfiguration,
  type FollowerAgentHarnessConfiguration,
} from "./follower-sync-config.ts";
import { planSynchronization } from "./planner.ts";
import type {
  AvailableBlob,
  DesiredFile,
  DesiredResource,
  PlanningProfileRevision,
  PlannedSynchronization,
  SynchronizationArtifact,
} from "./synchronization.types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
    .filter((revision) => revision.profileId === configuration.selectedProfile)
    .sort((left, right) => right.sequence - left.sequence);
  const selected = requestedRevision === undefined
    ? matching[0]
    : matching.find((revision) => revision.id === requestedRevision);
  if (selected === undefined) {
    return yield* configurationError(
      "invalid-profile",
      requestedRevision === undefined
        ? `selected profile ${configuration.selectedProfile} has no authorized revision`
        : `recovery revision ${requestedRevision} is no longer authorized`,
    );
  }
  return selected;
});

interface DecodedSpec {
  readonly resource: RevisionMetadata["resources"][number];
  readonly spec: ResourceSpecInput;
  readonly blob: FetchedRevision["blobs"][number];
  readonly blobBytes: Uint8Array;
}

const decodeSpecs = (
  fetched: FetchedRevision,
): Effect.Effect<ReadonlyArray<DecodedSpec>, FollowerSynchronizationConfigurationError> =>
  Effect.forEach(fetched.metadata.resources, (resource) =>
    Effect.gen(function*() {
      if (resource.blobs.length !== 1) {
        return yield* configurationError(
          "stale",
          `resource ${resource.id} does not have one canonical content blob`,
        );
      }
      const blob = fetched.blobs.find((entry) => entry.id === resource.blobs[0]);
      if (blob === undefined) {
        return yield* configurationError(
          "stale",
          `resource ${resource.id} is missing its verified content blob`,
        );
      }
      const blobBytes = yield* Effect.tryPromise({
        try: () => readFile(blob.path),
        catch: () =>
          configurationError(
            "stale",
            `verified cache blob for ${resource.id} is unavailable`,
          ),
      });
      const spec = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(ResourceSpecInputSchema)(
            JSON.parse(decoder.decode(blobBytes)),
          ),
        catch: () =>
          configurationError(
            "stale",
            `verified content blob for ${resource.id} is malformed`,
          ),
      });
      if (spec.kind !== resource.kind) {
        return yield* configurationError(
          "stale",
          `resource ${resource.id} kind does not match its verified content`,
        );
      }
      return { resource, spec, blob, blobBytes };
    })
  );

const fileDigest = (content: string): typeof ContentDigest.Type =>
  Schema.decodeUnknownSync(ContentDigest)(sha256BytesHex(encoder.encode(content)));

const filesDigest = (files: ReadonlyArray<DesiredFile>): typeof ContentDigest.Type =>
  Schema.decodeUnknownSync(ContentDigest)(sha256Hex(
    [...files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => `${file.path}\0${file.digest}`)
      .join("\n"),
  ));

const configDocument = (
  spec: Extract<ResourceSpecInput, { readonly kind: "config" }>,
): Uint8Array => encoder.encode(JSON.stringify(
  Object.fromEntries(
    [...spec.keys]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => [entry.path, entry.value]),
  ),
));

interface HydratedDesiredResource {
  readonly desired: DesiredResource;
  readonly artifacts: ReadonlyArray<SynchronizationArtifact>;
}

const desiredFor = (
  spec: ResourceSpecInput,
): HydratedDesiredResource => {
  switch (spec.kind) {
    case "file": {
      const content = encoder.encode(spec.content);
      const digest = Schema.decodeUnknownSync(ContentDigest)(sha256BytesHex(content));
      return {
        desired: { kind: "file", digest },
        artifacts: [{ digest, content }],
      };
    }
    case "directory":
    case "skill": {
      const files = spec.files.map((file) => ({
        path: file.path,
        digest: fileDigest(file.content),
      }));
      const artifacts = spec.files.map((file, index) => ({
        digest: files[index]!.digest,
        content: encoder.encode(file.content),
      }));
      const digest = filesDigest(files);
      return {
        desired: spec.kind === "skill"
          ? { kind: "skill", digest, files }
          : { kind: "directory", files },
        artifacts,
      };
    }
    case "config": {
      const content = configDocument(spec);
      const digest = Schema.decodeUnknownSync(ContentDigest)(sha256BytesHex(content));
      return {
        desired: {
          kind: "config",
          digest,
          keys: spec.keys.map((entry) => entry.path),
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
        },
        artifacts: [],
      };
    case "credential":
      return {
        desired: {
          kind: "credential",
          reference: spec.reference,
          instructions:
            `Store credential ${spec.reference} in MachineState secure storage, then rerun synchronization.`,
        },
        artifacts: [],
      };
    case "schedule": {
      const content = encoder.encode(canonicalJson(
        Schema.decodeUnknownSync(Schema.MutableJson)(spec),
      ));
      const digest = Schema.decodeUnknownSync(ContentDigest)(sha256BytesHex(content));
      return {
        desired: { kind: "schedule", digest },
        artifacts: [{ digest, content }],
      };
    }
  }
};

const observeFile = (
  target: string,
): Effect.Effect<ObservedResourceState, never, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const path = yield* machine.normalizePath({ path: target });
    return yield* machine.digestFile({ path }).pipe(
      Effect.map((digest): ObservedResourceState => ({
        state: "present",
        digest: digest.value,
        executable: false,
      })),
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
    Effect.catch((error) =>
      Effect.succeed({ state: "unverifiable", reason: String(error) } as const)
    ),
  );

const observe = (
  decoded: DecodedSpec,
  desired: DesiredResource,
): Effect.Effect<ObservedResourceState, never, MachineState> => {
  switch (desired.kind) {
    case "file":
    case "config":
    case "schedule":
      return observeFile(decoded.resource.target);
    case "directory":
    case "skill":
      return Effect.gen(function*() {
        const machine = yield* MachineState;
        const root = yield* machine.normalizePath({ path: decoded.resource.target });
        const files = yield* Effect.forEach(desired.files, (file) =>
          Effect.gen(function*() {
            const path = yield* machine.normalizePath({ path: file.path, base: root });
            return yield* machine.digestFile({ path }).pipe(
              Effect.map((digest) => ({ path: file.path, digest: digest.value })),
              Effect.catch(() => Effect.succeed(undefined)),
            );
          })
        );
        const present = files.filter((file) => file !== undefined);
        return present.length === 0
          ? { state: "absent" } as const
          : { state: "directory", files: present } as const;
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({ state: "unverifiable", reason: String(error) } as const)
        ),
      );
    case "tool":
      return Effect.gen(function*() {
        const machine = yield* MachineState;
        return yield* machine.findExecutable({ name: desired.toolId }).pipe(
          Effect.as({ state: "present", digest: sha256Hex(desired.toolId), executable: true } as const),
          Effect.catch(() => Effect.succeed({ state: "absent" } as const)),
        );
      });
    case "credential":
      return Effect.gen(function*() {
        const machine = yield* MachineState;
        const reference = Schema.decodeUnknownSync(CredentialReference)(
          desired.reference,
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

const hydrateRevision = Effect.fn("FollowerOrchestration.hydrateRevision")(
  function*(fetched: FetchedRevision): Effect.fn.Return<
    {
      readonly revision: PlanningProfileRevision;
      readonly observations: ReadonlyArray<{
        readonly resource: typeof ResourceId.Type;
        readonly observed: ObservedResourceState;
      }>;
      readonly artifacts: ReadonlyArray<SynchronizationArtifact>;
    },
    FollowerSynchronizationConfigurationError,
    MachineState
  > {
    const decoded = yield* decodeSpecs(fetched);
    const desired = [];
    const observations = [];
    const artifacts: Array<SynchronizationArtifact> = [];
    const blobs: Array<AvailableBlob> = [];
    for (const entry of decoded) {
      const hydration = desiredFor(entry.spec);
      desired.push({ resource: entry.resource.id, desired: hydration.desired });
      observations.push({
        resource: entry.resource.id,
        observed: yield* observe(entry, hydration.desired),
      });
      artifacts.push(
        { digest: entry.blob.id, content: entry.blobBytes },
        ...hydration.artifacts,
      );
      blobs.push({
        id: Schema.decodeUnknownSync(BlobId)(entry.blob.id),
        bytes: entry.blobBytes.byteLength,
      });
    }
    const metadata = fetched.metadata;
    const base: ProfileRevision = {
      id: Schema.decodeUnknownSync(ProfileRevisionId)(metadata.id),
      profileId: Schema.decodeUnknownSync(ProfileId)(metadata.profileId),
      sequence: metadata.sequence,
      canonicalBytes: canonicalJson(Schema.decodeUnknownSync(Schema.MutableJson)({
        metadataDigest: metadata.metadataDigest,
        resources: metadata.resources,
      })),
      digest: metadata.digest,
      signature: Schema.decodeUnknownSync(SourceSignature)(
        metadata.sourceSignature,
      ),
      publishedAt: metadata.publishedAt,
      resources: metadata.resources,
      groups: [],
    };
    return {
      revision: { ...base, desired, blobs },
      observations,
      artifacts: [...new Map(artifacts.map((entry) => [entry.digest, entry])).values()],
    };
  },
);

const persistableRevision = (
  revision: PlanningProfileRevision,
): ProfileRevision => ({
  id: revision.id,
  profileId: revision.profileId,
  sequence: revision.sequence,
  canonicalBytes: revision.canonicalBytes,
  digest: revision.digest,
  signature: revision.signature,
  publishedAt: revision.publishedAt,
  resources: revision.resources,
  groups: revision.groups,
});

const portableBasename = (value: string): string =>
  value.replaceAll("\\", "/").split("/").at(-1) ?? value;

const executableWithinHarnessBounds = (
  executable: string,
  configuration: FollowerAgentHarnessConfiguration,
): boolean => configuration.allowedExecutables.some((allowed) =>
  allowed === executable
  || portableBasename(allowed) === portableBasename(executable)
);

const pathWithinHarnessBounds = (
  path: string,
  configuration: FollowerAgentHarnessConfiguration,
): boolean => configuration.allowedPaths.some((root) => {
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/u, "");
  const normalizedPath = path.replaceAll("\\", "/");
  return normalizedPath === normalizedRoot
    || normalizedPath.startsWith(`${normalizedRoot}/`);
});

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
  if (configuration.allowedPaths.some((path) => path.trim() !== path)) {
    return "agent harness path bounds are invalid";
  }
  if (
    configuration.allowedExecutables.some((executable) =>
      executable.trim() !== executable
    )
  ) {
    return "agent harness executable bounds are invalid";
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
) => ({
  ...task,
  allowedPaths: task.allowedPaths.filter((path) =>
    pathWithinHarnessBounds(path, configuration)
  ),
  allowedExecutables: task.allowedExecutables.filter((executable) =>
    executableWithinHarnessBounds(executable, configuration)
  ),
  allowedOrigins: task.allowedOrigins.filter((origin) =>
    originWithinHarnessBounds(origin, configuration)
  ),
  forbidden: [...new Set([
    ...task.forbidden,
    ...(["elevation", "login", "restart", "reboot"] as const).filter(
      (capability) => !configuration.allowedCapabilities.includes(capability),
    ),
  ])],
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

export const resolveAgentTasks = Effect.fn("FollowerOrchestration.resolveAgentTasks")(
  function*(
    configuration: FollowerSynchronizationConfiguration,
    plan: PlannedSynchronization,
    scheduled: boolean,
    signal?: AbortSignal,
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
      const resolution = yield* agent.resolve({
        policy: configuration.agentPolicy,
        task: boundedTask(task, harness),
        harness: {
          harness: harness.kind,
          executable: harness.executable,
          maximumInputBytes: harness.maximumInputBytes,
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
        replacements.set(task.id, "human");
        reasons.set(
          task.id,
          `Configured agent harness could not safely resolve the task: ${resolution.error.message.slice(0, 1024)}`,
        );
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

export const synchronizeFollower = Effect.fn(
  "FollowerOrchestration.synchronize",
)(function*(
  stateLocation: string,
  mode: "plan" | "apply",
  signal?: AbortSignal,
  scheduled = false,
) {
  const repository = yield* StateRepository;
  const machine = yield* MachineState;
  const synchronization = yield* Synchronization;
  const configuration = yield* loadFollowerSynchronizationConfiguration(
    stateLocation,
  );
  const selected = yield* selectedRevision(configuration, undefined, signal);
  const fetched = yield* fetchRevision({
    ...transportInput(configuration, signal),
    revisionId: selected.id,
    cacheDirectory: configuration.cacheDirectory,
    maximumMetadataBytes:
      configuration.scheduledInvocation.maximumMetadataBytes,
    maximumBlobBytes: configuration.scheduledInvocation.maximumBlobBytes,
  }).pipe(Effect.provideService(MachineState, machine));
  const hydrated = yield* hydrateRevision(fetched).pipe(
    Effect.provideService(MachineState, machine),
  );
  yield* repository.publishRevision({
    revision: persistableRevision(hydrated.revision),
  });
  const appliedResources = yield* repository.loadAppliedResources(
    configuration.follower.id,
  );
  const plan = yield* planSynchronization({
    revision: hydrated.revision,
    follower: configuration.follower.id,
    observedState: {
      platform: (yield* machine.userDirectories()).home.platform,
      resources: hydrated.observations,
      availableBlobs: fetched.blobs.map((blob) => blob.id),
    },
    localOverlay: [],
    appliedResources,
  });
  const resolved = yield* resolveAgentTasks(
    configuration,
    plan,
    scheduled,
    signal,
  );
  if (mode === "plan") {
    return {
      mode,
      revision: selected.id,
      downloadedBlobs: fetched.downloadedBlobs,
      reusedBlobs: fetched.reusedBlobs,
      plan: resolved.plan,
      agentResolutions: resolved.agentResolutions,
    };
  }
  const outcome = yield* synchronization.run({
    id: Schema.decodeUnknownSync(RunId)(`run-${randomUUID()}`),
    plan: resolved.plan,
    revision: hydrated.revision,
    appliedResources,
    artifacts: hydrated.artifacts,
    limits: {
      processTimeoutMilliseconds:
        configuration.scheduledInvocation.timeoutMilliseconds,
    },
  });
  return {
    mode,
    revision: selected.id,
    downloadedBlobs: fetched.downloadedBlobs,
    reusedBlobs: fetched.reusedBlobs,
    agentResolutions: resolved.agentResolutions,
    outcome,
  };
});

export const recoverFollower = Effect.fn(
  "FollowerOrchestration.recover",
)(function*(stateLocation: string, signal?: AbortSignal) {
  const repository = yield* StateRepository;
  const machine = yield* MachineState;
  const synchronization = yield* Synchronization;
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
  const selected = yield* selectedRevision(
    configuration,
    recovery.run.revision,
    signal,
  );
  const fetched = yield* fetchRevision({
    ...transportInput(configuration, signal),
    revisionId: selected.id,
    cacheDirectory: configuration.cacheDirectory,
    maximumMetadataBytes:
      configuration.scheduledInvocation.maximumMetadataBytes,
    maximumBlobBytes: configuration.scheduledInvocation.maximumBlobBytes,
  }).pipe(Effect.provideService(MachineState, machine));
  const hydrated = yield* hydrateRevision(fetched).pipe(
    Effect.provideService(MachineState, machine),
  );
  const outcome = yield* synchronization.recover({
    follower: configuration.follower.id,
    revision: hydrated.revision,
    artifacts: hydrated.artifacts,
    limits: {
      processTimeoutMilliseconds:
        configuration.scheduledInvocation.timeoutMilliseconds,
    },
  });
  return {
    revision: selected.id,
    downloadedBlobs: fetched.downloadedBlobs,
    reusedBlobs: fetched.reusedBlobs,
    outcome,
  };
});
