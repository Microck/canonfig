import {
  createPrivateKey,
  sign,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { AgentResolutionLive } from "../../src/agent/agent-resolution.layer.ts";
import { AgentResolution } from "../../src/agent/agent-resolution.service.ts";
import {
  ActionId,
  AgentTaskId,
  BlobId,
  ProfileId,
  ProfileRevisionId,
  ResourceId,
  RunId,
  SourceSignature,
} from "../../src/domain/brand.ts";
import type {
  MachineProfile,
  ProfileRevision,
} from "../../src/domain/profile.ts";
import { EnrollmentLive } from "../../src/enrollment/enrollment.layer.ts";
import { Enrollment } from "../../src/enrollment/enrollment.service.ts";
import { enrollFollower } from "../../src/enrollment/follower-client.ts";
import { startSourceServer } from "../../src/enrollment/source-server.ts";
import type { SourceServerHandle } from "../../src/enrollment/enrollment.types.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import {
  canonicalJson,
  digestOf,
  sha256Hex,
} from "../../src/profile/profile-codec.ts";
import { revisionSigningPayload } from "../../src/profile/publication.ts";
import { stateRepositoryLayer } from "../../src/state/state-repository.layer.ts";
import { StateRepository } from "../../src/state/state-repository.service.ts";
import {
  defaultScheduledInvocation,
  FollowerSynchronizationConfiguration,
} from "../../src/synchronization/follower-sync-config.ts";
import {
  recoverFollower,
  resolveAgentTasks,
  synchronizeFollower,
} from "../../src/synchronization/follower-orchestration.ts";
import { SynchronizationLive } from "../../src/synchronization/synchronization.layer.ts";

const decode = Schema.decodeUnknownSync;
const directories: Array<string> = [];
const servers: Array<SourceServerHandle> = [];
const runtimes: Array<ManagedRuntime.ManagedRuntime<Enrollment | MachineState | StateRepository, never>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const machineLayer = (root: string) =>
  linuxMachineStateLayer({
    environment: [
      { name: "HOME", value: join(root, "home") },
      { name: "PATH", value: join(root, "bin") },
    ],
    credentialPolicy: {
      kind: "local-file",
      path: join(root, "credentials"),
    },
  });

const asJson = <Value>(value: Value) =>
  decode(Schema.MutableJson)(JSON.parse(JSON.stringify(value)));

describe("production follower orchestration", () => {
  it("routes emitted agent tasks through configured bounded policy and preserves human fallback", async () => {
    const taskId = decode(AgentTaskId)("agent:tool:0");
    const actionId = decode(ActionId)("action:tool:0:agent-task");
    const resource = decode(ResourceId)("agent-tool");
    const task = {
      id: taskId,
      resource,
      summary: "Resolve agent tool",
      desiredOutcome: "Make agent-tool available",
      observedEvidence: ["Observed state: absent"],
      allowedPaths: ["/tmp/canonfig-agent"],
      allowedExecutables: ["agent-tool"],
      allowedOrigins: ["https://packages.example.test"],
      forbidden: ["elevation", "login", "restart", "reboot"] as const,
      timeLimitSeconds: 30,
      outputLimitBytes: 4096,
      verification: { command: ["agent-tool", "--version"] },
    };
    const body = {
      revision: "revision-agent",
      follower: "follower-agent",
      requiredBlobs: [],
      actions: [{
        id: actionId,
        resource,
        kind: "agent-task" as const,
        detail: {
          kind: "agent-task" as const,
          taskId,
          summary: task.summary,
        },
        before: [],
      }],
      agentTasks: [task],
    };
    const encoded = canonicalJson(asJson(body));
    const plan = {
      ...body,
      encoded,
      digest: sha256Hex(encoded),
    };
    const baseConfiguration = decode(FollowerSynchronizationConfiguration)({
      schemaVersion: 1,
      follower: {
        id: "follower-agent",
        name: "Agent follower",
        groups: [],
        revoked: false,
        credentialReference: "secure-store://agent-follower",
        enrolledAt: "2026-08-16T00:00:00Z",
      },
      selectedProfile: "profile-agent",
      source: {
        endpoint: "https://127.0.0.1:17342",
        tlsFingerprint: "tls-agent",
        signingFingerprint: "signing-agent",
      },
      credentialReference: "secure-store://agent-follower",
      cacheDirectory: "/tmp/canonfig-agent-cache",
      stateLocation: "/tmp/canonfig-agent-state.sqlite",
      agentPolicy: "agent-apply",
      agentHarness: {
        kind: "codex",
        executable: "/opt/codex",
        maximumInputBytes: 8192,
        allowedPaths: ["/tmp/canonfig-agent"],
        allowedExecutables: ["agent-tool"],
        allowedOrigins: ["https://packages.example.test"],
        allowedCapabilities: [],
      },
      scheduledInvocation: defaultScheduledInvocation,
      updatedAt: "2026-08-16T00:00:01Z",
    });
    const recordingAgent = AgentResolution.of({
      resolve: (input) => Effect.succeed({
        outcome: "applied" as const,
        task: input.task,
        proposal: { summary: "Install agent tool", actions: [] },
        harness: {
          executable: "/opt/codex",
          arguments: [],
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
        },
        executions: [],
        verification: {
          command: input.task.verification.command,
          exitCode: 0,
          stdout: "agent-tool 1.0",
          stderr: "",
          matched: true,
        },
      }),
      proposeProfileChange: () => Effect.die("unused"),
    });
    const applied = await Effect.runPromise(
      resolveAgentTasks(baseConfiguration, plan, false).pipe(
        Effect.provideService(AgentResolution, recordingAgent),
      ),
    );
    expect(applied.plan.actions[0]).toMatchObject({
      kind: "no-op",
      detail: { kind: "no-op" },
    });
    expect(applied.agentResolutions).toHaveLength(1);

    const missingHarness = await Effect.runPromise(
      resolveAgentTasks(
        {
          ...baseConfiguration,
          agentHarness: undefined,
        },
        plan,
        true,
      ).pipe(Effect.provideService(AgentResolution, recordingAgent)),
    );
    expect(missingHarness.plan.actions[0]).toMatchObject({
      kind: "human-action",
      detail: {
        kind: "human-action",
        reason: expect.stringContaining("not configured"),
      },
    });
  });

  it("persists enrollment config, transfers a selected revision, converges, reuses cache, detects drift, and rejects revocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-orchestration-"));
    directories.push(root);
    const sourceDatabase = join(root, "source.sqlite");
    const followerDatabase = join(root, "follower.sqlite");
    const sourceMachine = machineLayer(join(root, "source"));
    const followerMachine = machineLayer(join(root, "follower"));
    const sourceLayer = EnrollmentLive.pipe(
      Layer.provideMerge(stateRepositoryLayer(sourceDatabase)),
      Layer.provideMerge(sourceMachine),
    );
    const sourceRuntime = ManagedRuntime.make(sourceLayer);
    runtimes.push(sourceRuntime);
    const target = join(root, "follower", "home", "managed.txt");
    const profileId = decode(ProfileId)("production-profile");
    const content = "canonical follower content\n";
    const spec = {
      kind: "file" as const,
      content,
      executable: false,
    };

    const revision = await sourceRuntime.runPromise(Effect.gen(function*() {
      const enrollment = yield* Enrollment;
      const machine = yield* MachineState;
      const repository = yield* StateRepository;
      const source = yield* enrollment.initializeSource();
      const privateKey = createPrivateKey(Redacted.value(
        yield* machine.loadCredential({
          reference: source.signingKeyReference,
        }),
      ));
      const profile: MachineProfile = {
        id: profileId,
        version: 2,
        name: "Production profile",
        groups: [],
        resources: [{
          id: decode(ResourceId)("managed-file"),
          kind: "file",
          policy: "replace-if-unmodified",
          target,
          dependsOn: [],
          spec,
          verify: {
            method: "digest",
            digest: sha256Hex(content),
          },
        }],
        scheduleDefault: {
          type: "daily",
          at: "00:00",
          timezone: "local",
        },
      };
      const canonicalBytes = canonicalJson(asJson(profile));
      const digest = sha256Hex(canonicalBytes);
      const blob = decode(BlobId)(digestOf(asJson(spec)));
      const id = decode(ProfileRevisionId)(`${profileId}:${digest}`);
      const unsigned = {
        id,
        profileId,
        sequence: 1,
        canonicalBytes,
        digest,
        publishedAt: "2026-08-16T00:00:00Z",
        resources: [{
          id: decode(ResourceId)("managed-file"),
          kind: "file" as const,
          policy: "replace-if-unmodified" as const,
          target,
          dependsOn: [],
          blobs: [blob],
        }],
        groups: [],
        signingKeyId: source.source.keyId,
      };
      const signed: ProfileRevision = {
        id,
        profileId,
        sequence: 1,
        canonicalBytes,
        digest,
        signature: decode(SourceSignature)(
          `ed25519:${
            sign(
              null,
              Buffer.from(revisionSigningPayload(unsigned)),
              privateKey,
            ).toString("base64url")
          }`,
        ),
        publishedAt: unsigned.publishedAt,
        resources: unsigned.resources,
        groups: [],
      };
      yield* repository.publishRevision({ revision: signed });
      return signed;
    }));

    const server = await sourceRuntime.runPromise(
      startSourceServer().pipe(Effect.provide(sourceLayer)),
    );
    servers.push(server);
    const invitation = await sourceRuntime.runPromise(
      Effect.flatMap(Enrollment, (enrollment) =>
        enrollment.createInvitation({
          endpoint: server.endpoint,
          expiresInMilliseconds: 60_000,
        })
      ),
    );
    const enrolled = await Effect.runPromise(
      enrollFollower({
        invitation,
        followerName: "Production follower",
      }).pipe(Effect.provide(followerMachine)),
    );
    const follower = {
      ...enrolled.follower,
      credentialReference: enrolled.credentialReference,
    };
    const followerRepository = stateRepositoryLayer(followerDatabase);
    await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.saveFollowerSynchronizationConfiguration({
          sourceIdentity: enrolled.source,
          configuration: {
            schemaVersion: 1,
            follower,
            selectedProfile: profileId,
            source: {
              endpoint: server.endpoint,
              tlsFingerprint: enrolled.tlsFingerprint,
              signingFingerprint: enrolled.source.publicKeyFingerprint,
            },
            credentialReference: enrolled.credentialReference,
            cacheDirectory: join(root, "follower-cache"),
            stateLocation: followerDatabase,
            agentPolicy: "deterministic-only",
            scheduledInvocation: defaultScheduledInvocation,
            updatedAt: "2026-08-16T00:00:01Z",
          },
        })
      ).pipe(Effect.provide(followerRepository)),
    );
    const synchronization = SynchronizationLive.pipe(
      Layer.provide(Layer.merge(followerRepository, followerMachine)),
    );
    const application = Layer.mergeAll(
      followerRepository,
      followerMachine,
      synchronization,
      AgentResolutionLive,
    );

    const first = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "apply").pipe(
        Effect.provide(application),
      ),
    );
    expect(first).toMatchObject({
      revision: revision.id,
      downloadedBlobs: 1,
      reusedBlobs: 0,
      outcome: { outcome: "Converged" },
    });
    expect(await readFile(target, "utf8")).toBe(content);

    const second = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "apply").pipe(
        Effect.provide(application),
      ),
    );
    expect(second).toMatchObject({
      downloadedBlobs: 0,
      reusedBlobs: 1,
      outcome: { outcome: "Converged" },
    });
    expect(server.blobRequests()).toBe(1);

    const planned = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "plan").pipe(
        Effect.provide(application),
      ),
    );
    await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.startRun({
          id: decode(RunId)("process-restart-run"),
          follower: follower.id,
          revision: revision.id,
          plan: planned.plan,
          startedAt: "2026-08-16T00:01:00Z",
        })
      ).pipe(Effect.provide(followerRepository)),
    );
    const restartedApplication = Layer.mergeAll(
      followerRepository,
      followerMachine,
      SynchronizationLive.pipe(
        Layer.provide(Layer.merge(followerRepository, followerMachine)),
      ),
      AgentResolutionLive,
    );
    const recovered = await Effect.runPromise(
      recoverFollower(followerDatabase).pipe(
        Effect.provide(restartedApplication),
      ),
    );
    expect(recovered).toMatchObject({
      revision: revision.id,
      downloadedBlobs: 0,
      reusedBlobs: 1,
      outcome: { outcome: "Converged", run: "process-restart-run" },
    });

    await writeFile(target, "local drift\n");
    const drifted = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "apply").pipe(
        Effect.provide(application),
      ),
    );
    expect(drifted).toMatchObject({
      outcome: { outcome: "FollowerDrift" },
    });
    expect(await readFile(target, "utf8")).toBe("local drift\n");

    await sourceRuntime.runPromise(
      Effect.flatMap(Enrollment, (enrollment) =>
        enrollment.revokeFollower(follower.id)
      ),
    );
    const revoked = await Effect.runPromise(Effect.flip(
      synchronizeFollower(followerDatabase, "apply").pipe(
        Effect.provide(application),
      ),
    ));
    expect(revoked._tag).toBe("RevokedFollowerCredentialError");
  });
});
