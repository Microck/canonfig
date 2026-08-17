import { request as httpsRequest } from "node:https";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  CertificateFingerprint,
  FollowerId,
  GroupName,
} from "../../src/domain/brand.ts";
import {
  DuplicateFollowerIdentityError,
  EnrollmentFingerprintMismatchError,
  EnrollmentSourceMismatchError,
  InvitationExpiredError,
  InvitationReplayError,
  InvalidFollowerCredentialError,
  RevokedFollowerCredentialError,
  type EnrollmentError,
} from "../../src/enrollment/enrollment.errors.ts";
import { EnrollmentLive } from "../../src/enrollment/enrollment.layer.ts";
import { Enrollment } from "../../src/enrollment/enrollment.service.ts";
import {
  authenticateFollower,
  enrollFollower,
} from "../../src/enrollment/follower-client.ts";
import { startSourceServer } from "../../src/enrollment/source-server.ts";
import type {
  EnrollmentInvitationGrant,
  FollowerEnrollment,
  SourceServerHandle,
} from "../../src/enrollment/enrollment.types.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import { stateRepositoryLayer } from "../../src/state/state-repository.layer.ts";

const decode = Schema.decodeUnknownSync;
const temporaryDirectories: Array<string> = [];
const openServers: Array<SourceServerHandle> = [];
const sourceRuntimes: Array<SourceRuntime> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  await Promise.all(sourceRuntimes.splice(0).map((runtime) => runtime.dispose()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly root: string;
  readonly sourceDatabase: string;
  readonly sourceMachine: ReturnType<typeof linuxMachineStateLayer>;
  readonly followerMachine: ReturnType<typeof linuxMachineStateLayer>;
  readonly sourceRuntime: SourceRuntime;
}

interface SourceRuntime {
  readonly runPromise: <Value, Failure>(
    effect: Effect.Effect<Value, Failure, Enrollment | MachineState>,
  ) => Promise<Value>;
  readonly dispose: () => Promise<void>;
}

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

const sourceApplicationLayer = (
  database: string,
  machine: ReturnType<typeof linuxMachineStateLayer>,
) =>
  EnrollmentLive.pipe(
    Layer.provideMerge(stateRepositoryLayer(database)),
    Layer.provideMerge(machine),
  );

const fixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-enrollment-"));
  temporaryDirectories.push(root);
  const sourceDatabase = join(root, "source.sqlite");
  const sourceMachine = machineLayer(join(root, "source"));
  const followerMachine = machineLayer(join(root, "follower"));
  const sourceRuntime = ManagedRuntime.make(
    sourceApplicationLayer(sourceDatabase, sourceMachine),
  );
  sourceRuntimes.push(sourceRuntime);
  return {
    root,
    sourceDatabase,
    sourceMachine,
    followerMachine,
    sourceRuntime,
  };
};

const runSource = <Value, Failure>(
  setup: Fixture,
  effect: Effect.Effect<Value, Failure, Enrollment | MachineState>,
): Promise<Value> => setup.sourceRuntime.runPromise(effect);

const runFollower = <Value, Failure>(
  setup: Fixture,
  effect: Effect.Effect<Value, Failure, MachineState>,
): Promise<Value> => Effect.runPromise(effect.pipe(Effect.provide(setup.followerMachine)));

const start = async (setup: Fixture): Promise<SourceServerHandle> => {
  const server = await runSource(
    setup,
    Effect.gen(function*() {
      const enrollment = yield* Enrollment;
      yield* enrollment.initializeSource();
      return yield* startSourceServer();
    }),
  );
  openServers.push(server);
  return server;
};

const invitation = (
  setup: Fixture,
  server: SourceServerHandle,
  expiresInMilliseconds = 60_000,
  groups: ReadonlyArray<typeof GroupName.Type> = [],
): Promise<EnrollmentInvitationGrant> =>
  runSource(
    setup,
    Effect.gen(function*() {
      const enrollment = yield* Enrollment;
      return yield* enrollment.createInvitation({
        endpoint: server.endpoint,
        expiresInMilliseconds,
        groups,
      });
    }),
  );

const failure = <Value>(
  effect: Effect.Effect<Value, EnrollmentError>,
): Promise<EnrollmentError> => Effect.runPromise(Effect.flip(effect));

const malformedRequest = (
  server: SourceServerHandle,
): Promise<{ readonly status: number; readonly body: string }> =>
  new Promise((resolveRequest, rejectRequest) => {
    const endpoint = new URL(server.endpoint);
    const request = httpsRequest({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: "/v1/enrollment",
      method: "POST",
      rejectUnauthorized: false,
      headers: {
        "content-type": "application/json",
        "content-length": 1,
      },
    }, (response) => {
      const chunks: Array<Buffer> = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolveRequest({
          status: response.statusCode ?? 500,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.once("error", rejectRequest);
    request.end("{");
  });

describe("loopback HTTPS enrollment", () => {
  it("enrolls a deterministic follower with pinned source identity and initial groups", async () => {
    const setup = fixture();
    const server = await start(setup);
    const groups = [
      decode(GroupName)("base"),
      decode(GroupName)("operators"),
    ];
    const grant = await invitation(setup, server, 60_000, groups);

    const enrolled = await runFollower(
      setup,
      enrollFollower({ invitation: grant, followerName: "Build Host" }),
    );
    const authenticated = await runFollower(
      setup,
      authenticateFollower({
        endpoint: server.endpoint,
        tlsFingerprint: grant.tlsFingerprint,
        credentialReference: enrolled.credentialReference,
      }),
    );

    expect(server.endpoint).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/u);
    expect(server.fingerprint).toBe(grant.tlsFingerprint);
    expect(enrolled.follower.id).toMatch(/^follower-[a-f0-9]{32}$/u);
    expect(enrolled.follower.groups).toEqual(groups);
    expect(enrolled.source.publicKeyFingerprint).toBe(grant.sourceFingerprint);
    expect(authenticated.follower).toEqual(enrolled.follower);
  });

  it("fails closed across a source restart after prepare and permits a safe retry", async () => {
    const setup = fixture();
    const server = await start(setup);
    const grant = await invitation(setup, server);
    const prepared = await runFollower(
      setup,
      enrollFollower({
        invitation: grant,
        followerName: "Restart-safe Host",
        finalize: false,
      }),
    );
    const preparedCredential = await runFollower(
      setup,
      Effect.flatMap(MachineState, (machine) =>
        machine.loadCredential({ reference: prepared.credentialReference })
      ),
    );
    const beforeRestart = await runSource(
      setup,
      Effect.flip(Effect.flatMap(Enrollment, (enrollment) =>
        enrollment.authenticate(Redacted.value(preparedCredential))
      )),
    );
    expect(beforeRestart).toBeInstanceOf(InvalidFollowerCredentialError);

    const port = Number(new URL(server.endpoint).port);
    await server.close();
    openServers.splice(openServers.indexOf(server), 1);
    await setup.sourceRuntime.dispose();
    sourceRuntimes.splice(sourceRuntimes.indexOf(setup.sourceRuntime), 1);
    const restartedRuntime = ManagedRuntime.make(
      sourceApplicationLayer(setup.sourceDatabase, setup.sourceMachine),
    );
    sourceRuntimes.push(restartedRuntime);
    const restartedSetup: Fixture = { ...setup, sourceRuntime: restartedRuntime };
    const restartedServer = await runSource(
      restartedSetup,
      Effect.gen(function*() {
        const enrollment = yield* Enrollment;
        yield* enrollment.initializeSource();
        return yield* startSourceServer({ port });
      }),
    );
    openServers.push(restartedServer);

    const retried = await runFollower(
      setup,
      enrollFollower({ invitation: grant, followerName: "Restart-safe Host" }),
    );
    const authenticated = await runFollower(
      setup,
      authenticateFollower({
        endpoint: restartedServer.endpoint,
        tlsFingerprint: grant.tlsFingerprint,
        credentialReference: retried.credentialReference,
      }),
    );
    expect(authenticated.follower.id).toBe(prepared.follower.id);
  });

  it("rejects expired invitations, replay, nonce mismatch, and duplicate identity misuse", async () => {
    const setup = fixture();
    const server = await start(setup);
    const expired = await invitation(setup, server, 1);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    const expiredError = await failure(
      enrollFollower({ invitation: expired, followerName: "Expired Host" }).pipe(
        Effect.provide(setup.followerMachine),
      ),
    );
    expect(expiredError).toBeInstanceOf(InvitationExpiredError);

    const first = await invitation(setup, server);
    const primary = await runFollower(
      setup,
      enrollFollower({ invitation: first, followerName: "Primary Host" }),
    );
    const replayError = await failure(
      enrollFollower({ invitation: first, followerName: "Other Host" }).pipe(
        Effect.provide(setup.followerMachine),
      ),
    );
    expect(replayError).toBeInstanceOf(InvitationReplayError);

    const nonceGrant = await invitation(setup, server);
    const nonceError = await failure(
      enrollFollower({
        invitation: { ...nonceGrant, nonce: "wrong-nonce" },
        followerName: "Nonce Host",
      }).pipe(Effect.provide(setup.followerMachine)),
    );
    expect(nonceError).toBeInstanceOf(EnrollmentSourceMismatchError);

    const duplicateGrant = await invitation(setup, server);
    const duplicateError = await failure(
      enrollFollower({
        invitation: duplicateGrant,
        followerName: "Primary Host",
      }).pipe(Effect.provide(setup.followerMachine)),
    );
    expect(duplicateError).toBeInstanceOf(DuplicateFollowerIdentityError);

    // A rejected duplicate enrollment must not destroy the enrolled
    // follower's stored credential: the credential key is deterministic per
    // follower identity, so any overwrite would lock out the real follower.
    const primaryCredential = await runFollower(
      setup,
      Effect.flatMap(MachineState, (machine) =>
        machine.loadCredential({
          reference: primary.credentialReference,
        })
      ),
    );
    const stillAuthenticated = await runSource(
      setup,
      Effect.flatMap(Enrollment, (enrollment) =>
        enrollment.authenticate(Redacted.value(primaryCredential))),
    );
    expect(stillAuthenticated.follower.id).toBe(primary.follower.id);
  });

  it("rejects TLS pin and intended source identity mismatches before enrollment", async () => {
    const setup = fixture();
    const server = await start(setup);
    const grant = await invitation(setup, server);
    const wrongFingerprint = decode(CertificateFingerprint)("0".repeat(64));
    const pinError = await failure(
      enrollFollower({
        invitation: { ...grant, tlsFingerprint: wrongFingerprint },
        followerName: "Pinned Host",
      }).pipe(Effect.provide(setup.followerMachine)),
    );
    expect(pinError).toBeInstanceOf(EnrollmentFingerprintMismatchError);

    const wrongSource = decode(CertificateFingerprint)("1".repeat(64));
    const sourceError = await failure(
      enrollFollower({
        invitation: { ...grant, sourceFingerprint: wrongSource },
        followerName: "Source Host",
      }).pipe(Effect.provide(setup.followerMachine)),
    );
    expect(sourceError).toBeInstanceOf(EnrollmentSourceMismatchError);
  });

  it("durably revokes follower credentials and updates group membership", async () => {
    const setup = fixture();
    const server = await start(setup);
    const grant = await invitation(setup, server, 60_000, [
      decode(GroupName)("base"),
    ]);
    const enrolled = await runFollower(
      setup,
      enrollFollower({ invitation: grant, followerName: "Mutable Host" }),
    );
    const updatedGroups = [
      decode(GroupName)("production"),
      decode(GroupName)("audited"),
    ];
    await runSource(
      setup,
      Effect.gen(function*() {
        const enrollment = yield* Enrollment;
        yield* enrollment.updateFollowerGroups(enrolled.follower.id, updatedGroups);
      }),
    );
    const updated = await runFollower(
      setup,
      authenticateFollower({
        endpoint: server.endpoint,
        tlsFingerprint: grant.tlsFingerprint,
        credentialReference: enrolled.credentialReference,
      }),
    );
    expect(updated.follower.groups).toEqual(updatedGroups);

    await runSource(
      setup,
      Effect.gen(function*() {
        const enrollment = yield* Enrollment;
        yield* enrollment.revokeFollower(enrolled.follower.id);
      }),
    );
    const revoked = await failure(
      authenticateFollower({
        endpoint: server.endpoint,
        tlsFingerprint: grant.tlsFingerprint,
        credentialReference: enrolled.credentialReference,
      }).pipe(Effect.provide(setup.followerMachine)),
    );
    expect(revoked).toBeInstanceOf(RevokedFollowerCredentialError);

    const follower = await runSource(
      setup,
      Effect.gen(function*() {
        const enrollment = yield* Enrollment;
        return yield* enrollment.getFollower(decode(FollowerId)(enrolled.follower.id));
      }),
    );
    expect(follower.revoked).toBe(true);
    expect(follower.groups).toEqual(updatedGroups);
  });

  it("rotates revoked credentials for explicit re-enrollment and persists it across restart", async () => {
    const setup = fixture();
    const server = await start(setup);
    const firstGrant = await invitation(setup, server, 60_000, [
      decode(GroupName)("base"),
    ]);
    const first = await runFollower(
      setup,
      enrollFollower({ invitation: firstGrant, followerName: "Rotating Host" }),
    );
    const firstCredential = await runFollower(
      setup,
      Effect.flatMap(MachineState, (machine) =>
        machine.loadCredential({ reference: first.credentialReference })
      ),
    );
    await runSource(
      setup,
      Effect.flatMap(Enrollment, (enrollment) =>
        enrollment.revokeFollower(first.follower.id)
      ),
    );

    const secondGrant = await invitation(setup, server, 60_000, [
      decode(GroupName)("production"),
      decode(GroupName)("audited"),
    ]);
    const second = await runFollower(
      setup,
      enrollFollower({ invitation: secondGrant, followerName: "Rotating Host" }),
    );
    expect(second.follower.id).toBe(first.follower.id);
    expect(second.follower.revoked).toBe(false);
    expect(second.follower.groups).toEqual(secondGrant.groups);
    const secondCredential = await runFollower(
      setup,
      Effect.flatMap(MachineState, (machine) =>
        machine.loadCredential({ reference: second.credentialReference })
      ),
    );
    expect(Redacted.value(secondCredential)).not.toBe(Redacted.value(firstCredential));
    expect(Redacted.value(firstCredential)).toHaveLength(43);

    const oldCredentialError = await runSource(
      setup,
      Effect.flip(Effect.flatMap(Enrollment, (enrollment) =>
        enrollment.authenticate(Redacted.value(firstCredential))
      )),
    );
    expect(oldCredentialError).toBeInstanceOf(InvalidFollowerCredentialError);
    const authenticated = await runSource(
      setup,
      Effect.flatMap(Enrollment, (enrollment) =>
        enrollment.authenticate(Redacted.value(secondCredential))
      ),
    );
    expect(authenticated.follower.groups).toEqual(secondGrant.groups);

    const replayError = await failure(
      enrollFollower({
        invitation: secondGrant,
        followerName: "Rotating Host",
      }).pipe(Effect.provide(setup.followerMachine)),
    );
    expect(replayError).toBeInstanceOf(InvitationReplayError);

    await server.close();
    openServers.splice(openServers.indexOf(server), 1);
    await setup.sourceRuntime.dispose();
    sourceRuntimes.splice(sourceRuntimes.indexOf(setup.sourceRuntime), 1);
    const restartedRuntime = ManagedRuntime.make(
      sourceApplicationLayer(setup.sourceDatabase, setup.sourceMachine),
    );
    sourceRuntimes.push(restartedRuntime);
    const restartedSetup: Fixture = { ...setup, sourceRuntime: restartedRuntime };
    const restartedServer = await start(restartedSetup);
    const afterRestart = await runFollower(
      setup,
      authenticateFollower({
        endpoint: restartedServer.endpoint,
        tlsFingerprint: secondGrant.tlsFingerprint,
        credentialReference: second.credentialReference,
      }),
    );
    expect(afterRestart.follower.revoked).toBe(false);
    expect(afterRestart.follower.groups).toEqual(secondGrant.groups);
  });

  it("reloads source trust and follower authorization after restart", async () => {
    const setup = fixture();
    const firstServer = await start(setup);
    const grant = await invitation(setup, firstServer);
    const enrolled = await runFollower(
      setup,
      enrollFollower({ invitation: grant, followerName: "Persistent Host" }),
    );
    await firstServer.close();
    openServers.splice(openServers.indexOf(firstServer), 1);
    await setup.sourceRuntime.dispose();
    sourceRuntimes.splice(sourceRuntimes.indexOf(setup.sourceRuntime), 1);

    const restartedRuntime = ManagedRuntime.make(
      sourceApplicationLayer(setup.sourceDatabase, setup.sourceMachine),
    );
    sourceRuntimes.push(restartedRuntime);
    const restartedSetup: Fixture = {
      ...setup,
      sourceRuntime: restartedRuntime,
    };
    const secondServer = await start(restartedSetup);
    const authenticated = await runFollower(
      setup,
      authenticateFollower({
        endpoint: secondServer.endpoint,
        tlsFingerprint: grant.tlsFingerprint,
        credentialReference: enrolled.credentialReference,
      }),
    );

    expect(secondServer.fingerprint).toBe(firstServer.fingerprint);
    expect(authenticated.follower.id).toBe(enrolled.follower.id);
  });

  it("rejects malformed HTTPS requests with a typed redacted response", async () => {
    const setup = fixture();
    const server = await start(setup);
    const response = await malformedRequest(server);

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: "MalformedEnrollmentRequestError",
      message: "the enrollment request is malformed",
    });
  });

  it("stores only credential references and digests in durable records and errors", async () => {
    const setup = fixture();
    const server = await start(setup);
    const grant = await invitation(setup, server);
    const enrolled: FollowerEnrollment = await runFollower(
      setup,
      enrollFollower({ invitation: grant, followerName: "Secret Host" }),
    );
    const rawCredential = await runFollower(
      setup,
      Effect.gen(function*() {
        const machine = yield* MachineState;
        return Redacted.value(yield* machine.loadCredential({
          reference: enrolled.credentialReference,
        }));
      }),
    );
    const replay = await failure(
      enrollFollower({ invitation: grant, followerName: "Replay Host" }).pipe(
        Effect.provide(setup.followerMachine),
      ),
    );

    const database = new DatabaseSync(setup.sourceDatabase, { readOnly: true });
    const durableText = [
      ...database.prepare("SELECT * FROM source_identity").all(),
      ...database.prepare("SELECT * FROM enrollment_source").all(),
      ...database.prepare("SELECT * FROM enrollment_invitations").all(),
      ...database.prepare("SELECT * FROM followers").all(),
      ...database.prepare("SELECT * FROM follower_credentials").all(),
    ].map((row) => JSON.stringify(row)).join("\n");
    database.close();

    expect(durableText).not.toContain(grant.code);
    expect(durableText).not.toContain(grant.nonce);
    expect(durableText).not.toContain(rawCredential);
    expect(JSON.stringify(replay)).not.toContain(grant.code);
    expect(JSON.stringify(replay)).not.toContain(grant.nonce);
    expect(JSON.stringify(replay)).not.toContain(rawCredential);
  });
});
