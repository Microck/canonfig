import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  BlobId,
  CertificateFingerprint,
  GroupName,
  ProfileId,
  ProfileRevisionId,
  ResourceId,
  SourceSignature,
} from "../../src/domain/brand.ts";
import type {
  MachineProfile,
  ProfileRevision,
  PublishedResource,
} from "../../src/domain/profile.ts";
import {
  RevokedFollowerCredentialError,
  EnrollmentTransportError,
  TransportIntegrityError,
  TransportInterruptedError,
  TransportResourceNotFoundError,
  TransportSizeLimitError,
} from "../../src/enrollment/enrollment.errors.ts";
import { EnrollmentLive } from "../../src/enrollment/enrollment.layer.ts";
import { Enrollment } from "../../src/enrollment/enrollment.service.ts";
import {
  enrollFollower,
  atomicCacheWrite,
  fetchRevision,
  getRevisionMetadata,
  listRevisions,
  retrieveBlob,
} from "../../src/enrollment/follower-client.ts";
import { startSourceServer } from "../../src/enrollment/source-server.ts";
import type {
  FollowerEnrollment,
  SourceServerHandle,
} from "../../src/enrollment/enrollment.types.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import {
  canonicalJson,
  digestOf,
  sha256BytesHex,
  sha256Hex,
  type JsonValue,
} from "../../src/profile/profile-codec.ts";
import { revisionSigningPayload } from "../../src/profile/publication.ts";
import { stateRepositoryLayer } from "../../src/state/state-repository.layer.ts";
import { StateRepository } from "../../src/state/state-repository.service.ts";

const decode = Schema.decodeUnknownSync;
const temporaryDirectories: Array<string> = [];
const openServers: Array<SourceServerHandle> = [];
const runtimes: Array<SourceRuntime> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface SourceRuntime {
  readonly runPromise: <Value, Failure>(
    effect: Effect.Effect<
      Value,
      Failure,
      Enrollment | MachineState | StateRepository
    >,
  ) => Promise<Value>;
  readonly dispose: () => Promise<void>;
}

interface Fixture {
  readonly root: string;
  readonly database: string;
  readonly sourceMachine: ReturnType<typeof linuxMachineStateLayer>;
  readonly followerMachine: ReturnType<typeof linuxMachineStateLayer>;
  readonly runtime: SourceRuntime;
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

const sourceLayer = (
  database: string,
  machine: ReturnType<typeof linuxMachineStateLayer>,
) =>
  EnrollmentLive.pipe(
    Layer.provideMerge(stateRepositoryLayer(database)),
    Layer.provideMerge(machine),
  );

const fixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-transport-"));
  temporaryDirectories.push(root);
  const database = join(root, "source.sqlite");
  const sourceMachine = machineLayer(join(root, "source"));
  const followerMachine = machineLayer(join(root, "follower"));
  const runtime = ManagedRuntime.make(sourceLayer(database, sourceMachine));
  runtimes.push(runtime);
  return { root, database, sourceMachine, followerMachine, runtime };
};

const asJson = <Value>(value: Value): JsonValue =>
  decode(Schema.MutableJson)(JSON.parse(JSON.stringify(value)));

const group = (name: string) => decode(GroupName)(name);

const publishFixtureRevision = (
  setup: Fixture,
  includeCrossGroupDependent = false,
  includeShared = true,
  revisionSequence = 1,
): Promise<{
  readonly revision: ProfileRevision;
  readonly blobs: ReadonlyArray<typeof BlobId.Type>;
}> =>
  setup.runtime.runPromise(Effect.gen(function*() {
    const enrollment = yield* Enrollment;
    const machine = yield* MachineState;
    const repository = yield* StateRepository;
    const source = yield* enrollment.initializeSource();
    const storedKey = yield* machine.loadCredential({
      reference: source.signingKeyReference,
    });
    const privateKey = createPrivateKey(Redacted.value(storedKey));
    const publicKey = createPublicKey(privateKey);
    const specs = [
      {
        kind: "file" as const,
        content: "shared\n",
        executable: false,
      },
      {
        kind: "file" as const,
        content: `alpha-${revisionSequence}\n`,
        executable: false,
      },
      {
        kind: "file" as const,
        content: `beta-${revisionSequence}\n`,
        executable: false,
      },
      {
        kind: "file" as const,
        content: `cross-group-${revisionSequence}\n`,
        executable: false,
      },
    ];
    const profile: MachineProfile = {
      id: decode(ProfileId)("transport-profile"),
      version: 2,
      name: "Transport profile",
      groups: [
        { name: group("alpha") },
        { name: group("beta") },
      ],
      resources: [
        ...(includeShared
          ? [{
            id: decode(ResourceId)("shared"),
            kind: "file" as const,
            policy: "replace" as const,
            target: "~/.shared",
            dependsOn: [],
            spec: specs[0]!,
            verify: { method: "digest" as const, digest: sha256Hex(specs[0].content) },
          }]
          : []),
        {
          id: decode(ResourceId)("alpha-only"),
          kind: "file",
          policy: "replace",
          target: "~/.alpha",
          groups: [group("alpha")],
          dependsOn: includeShared ? [decode(ResourceId)("shared")] : [],
          spec: specs[1],
          verify: { method: "digest", digest: sha256Hex(specs[1].content) },
        },
        {
          id: decode(ResourceId)("beta-only"),
          kind: "file",
          policy: "replace",
          target: "~/.beta",
          groups: [group("beta")],
          dependsOn: includeShared ? [decode(ResourceId)("shared")] : [],
          spec: specs[2],
          verify: { method: "digest", digest: sha256Hex(specs[2].content) },
        },
        ...(includeCrossGroupDependent
          ? [{
            id: decode(ResourceId)("alpha-needs-beta"),
            kind: "file" as const,
            policy: "replace" as const,
            target: "~/.alpha-needs-beta",
            groups: [group("alpha")],
            dependsOn: [decode(ResourceId)("beta-only")],
            spec: specs[3]!,
            verify: {
              method: "digest" as const,
              digest: sha256Hex(specs[3].content),
            },
          }]
          : []),
      ],
      scheduleDefault: {
        type: "daily",
        at: "00:00",
        timezone: "local",
      },
    };
    const canonicalBytes = canonicalJson(asJson(profile));
    const digest = sha256Hex(canonicalBytes);
    const resources: ReadonlyArray<PublishedResource> = profile.resources.map(
      (resource) => ({
        id: decode(ResourceId)(resource.id),
        kind: resource.kind,
        policy: resource.policy ?? "replace",
        target: resource.target,
        groups: resource.groups,
        dependsOn: (resource.dependsOn ?? []).map((dependency) =>
          decode(ResourceId)(dependency)
        ),
        blobs: [decode(BlobId)(digestOf(asJson(resource.spec)))],
      }),
    );
    const id = decode(ProfileRevisionId)(`${profile.id}:${digest}`);
    const unsigned = {
      id,
      profileId: profile.id,
      sequence: revisionSequence,
      canonicalBytes,
      digest,
      publishedAt: "2026-08-15T12:00:00Z",
      resources,
      groups: profile.groups,
      signingKeyId: source.source.keyId,
    };
    const signature = decode(SourceSignature)(
      `ed25519:${
        sign(
          null,
          Buffer.from(revisionSigningPayload(unsigned)),
          privateKey,
        ).toString("base64url")
      }`,
    );
    expect(verify(
      null,
      Buffer.from(revisionSigningPayload(unsigned)),
      publicKey,
      Buffer.from(signature.slice("ed25519:".length), "base64url"),
    )).toBe(true);
    const revision: ProfileRevision = {
      id,
      profileId: profile.id,
      sequence: revisionSequence,
      canonicalBytes,
      digest,
      signature,
      publishedAt: unsigned.publishedAt,
      resources,
      groups: profile.groups,
    };
    yield* repository.publishRevision({ revision });
    return {
      revision,
      blobs: resources.flatMap((resource) =>
        resource.blobs.map((blob) => decode(BlobId)(blob))
      ),
    };
  }));

const start = async (setup: Fixture): Promise<SourceServerHandle> => {
  const server = await setup.runtime.runPromise(startSourceServer());
  openServers.push(server);
  return server;
};

const enroll = async (
  setup: Fixture,
  server: SourceServerHandle,
): Promise<FollowerEnrollment> => {
  const invitation = await setup.runtime.runPromise(
    Effect.gen(function*() {
      const enrollment = yield* Enrollment;
      return yield* enrollment.createInvitation({
        endpoint: server.endpoint,
        expiresInMilliseconds: 60_000,
        groups: [group("alpha")],
      });
    }),
  );
  return Effect.runPromise(
    enrollFollower({
      invitation,
      followerName: "Transport Follower",
    }).pipe(Effect.provide(setup.followerMachine)),
  );
};

const transportInput = (
  server: SourceServerHandle,
  enrolled: FollowerEnrollment,
) => ({
  endpoint: server.endpoint,
  tlsFingerprint: enrolled.tlsFingerprint,
  credentialReference: enrolled.credentialReference,
  sourceFingerprint: enrolled.source.publicKeyFingerprint,
});

const runFollower = <Value, Failure>(
  setup: Fixture,
  effect: Effect.Effect<Value, Failure, MachineState>,
): Promise<Value> =>
  Effect.runPromise(effect.pipe(Effect.provide(setup.followerMachine)));

describe("authenticated content-addressed transport", () => {
  it("writes cache files atomically with private POSIX permissions", async () => {
    const setup = fixture();
    const directory = join(setup.root, "atomic-cache");
    await mkdir(directory);
    const path = join(directory, "blob");
    await atomicCacheWrite(path, Buffer.from("verified"));
    expect(await readdir(directory)).toEqual(["blob"]);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it.runIf(process.platform === "win32")(
    "uses a Windows-compatible flush and rename path for verified cache files",
    async () => {
      const setup = fixture();
      const directory = join(setup.root, "windows-atomic-cache");
      await mkdir(directory);
      const path = join(directory, "blob");
      await atomicCacheWrite(path, Buffer.from("verified"));
      await atomicCacheWrite(join(directory, "second"), Buffer.from("second"));
      expect((await readdir(directory)).sort()).toEqual(["blob", "second"]);
    },
  );

  it("preserves the filesystem cause when cache creation fails", async () => {
    const setup = fixture();
    const published = await publishFixtureRevision(setup);
    const server = await start(setup);
    const enrolled = await enroll(setup, server);
    const blocked = join(setup.root, "blocked-cache");
    writeFileSync(blocked, "not a directory");
    const error = await Effect.runPromise(Effect.flip(
      fetchRevision({
        ...transportInput(server, enrolled),
        revisionId: published.revision.id,
        cacheDirectory: blocked,
      }).pipe(Effect.provide(setup.followerMachine)),
    ));
    expect(error).toBeInstanceOf(EnrollmentTransportError);
    expect(error).toMatchObject({
      operation: "create follower transport cache",
      message: expect.stringMatching(/E(?:NOTDIR|EXIST)/u),
    });
  });

  it("filters groups, incrementally caches blobs, resumes, and converges without downloads", async () => {
    const setup = fixture();
    const published = await publishFixtureRevision(setup);
    const server = await start(setup);
    const enrolled = await enroll(setup, server);
    const input = transportInput(server, enrolled);
    const cacheDirectory = join(setup.root, "cache");

    const listed = await runFollower(setup, listRevisions(input));
    expect(listed.revisions.map((revision) => revision.id)).toEqual([
      published.revision.id,
    ]);

    const first = await runFollower(setup, fetchRevision({
      ...input,
      revisionId: published.revision.id,
      cacheDirectory,
    }));
    expect(first.metadata.resources.map((resource) => resource.id)).toEqual([
      "shared",
      "alpha-only",
    ]);
    expect(first.downloadedBlobs).toBe(2);
    expect(first.reusedBlobs).toBe(0);
    expect(server.blobRequests()).toBe(2);

    writeFileSync(first.blobs[1]!.path, "tampered cache content");
    const resumed = await runFollower(setup, fetchRevision({
      ...input,
      revisionId: published.revision.id,
      cacheDirectory,
    }));
    expect(resumed.downloadedBlobs).toBe(1);
    expect(resumed.reusedBlobs).toBe(1);
    expect(server.blobRequests()).toBe(3);

    const converged = await runFollower(setup, fetchRevision({
      ...input,
      revisionId: published.revision.id,
      cacheDirectory,
    }));
    expect(converged.downloadedBlobs).toBe(0);
    expect(converged.reusedBlobs).toBe(2);
    expect(server.blobRequests()).toBe(3);
  });

  it("uses the persisted blob index across historical revisions and invalidates cached validation", async () => {
    const setup = fixture();
    const history: Array<Awaited<ReturnType<typeof publishFixtureRevision>>> = [];
    for (let sequence = 1; sequence <= 64; sequence += 1) {
      history.push(await publishFixtureRevision(setup, false, true, sequence));
    }
    const latest = history.at(-1)!;
    const database = new DatabaseSync(setup.database);
    const indexedCandidates = database.prepare(
      "SELECT count(*) AS count FROM profile_revision_blobs WHERE blob_id = ?",
    ).get(latest.blobs[1]!);
    database.close();
    expect(indexedCandidates).toMatchObject({ count: 1 });

    const server = await start(setup);
    const enrolled = await enroll(setup, server);
    const input = transportInput(server, enrolled);
    const first = await runFollower(setup, retrieveBlob({
      ...input,
      blobId: latest.blobs[1]!,
    }));
    const second = await runFollower(setup, retrieveBlob({
      ...input,
      blobId: latest.blobs[1]!,
    }));
    expect(Buffer.from(first)).toEqual(Buffer.from(second));

    const missing = await Effect.runPromise(Effect.flip(
      retrieveBlob({
        ...input,
        blobId: decode(BlobId)("e".repeat(64)),
      }).pipe(Effect.provide(setup.followerMachine)),
    ));
    expect(missing).toBeInstanceOf(TransportResourceNotFoundError);

    const tamperedDatabase = new DatabaseSync(setup.database);
    tamperedDatabase.exec("DROP TRIGGER profile_revisions_immutable_update");
    const stored = decode(Schema.Struct({ revision_json: Schema.String }))(
      tamperedDatabase.prepare(
        "SELECT revision_json FROM profile_revisions WHERE id = ?",
      ).get(latest.revision.id),
    );
    const tampered = JSON.parse(stored.revision_json);
    tampered.signature = `ed25519:${"A".repeat(86)}`;
    tamperedDatabase.prepare(
      "UPDATE profile_revisions SET signature = ?, revision_json = ? WHERE id = ?",
    ).run(tampered.signature, JSON.stringify(tampered), latest.revision.id);
    tamperedDatabase.close();

    const invalidated = await Effect.runPromise(Effect.flip(
      retrieveBlob({
        ...input,
        blobId: latest.blobs[1]!,
      }).pipe(Effect.provide(setup.followerMachine)),
    ));
    expect(invalidated).toBeInstanceOf(TransportIntegrityError);
  });

  it("invalidates signing-key and authorization caches after source key rotation", async () => {
    const setup = fixture();
    const published = await publishFixtureRevision(setup);
    const server = await start(setup);
    const enrolled = await enroll(setup, server);
    const input = transportInput(server, enrolled);
    await runFollower(setup, retrieveBlob({
      ...input,
      blobId: published.blobs[1]!,
    }));

    await setup.runtime.runPromise(Effect.gen(function*() {
      const enrollment = yield* Enrollment;
      const machine = yield* MachineState;
      const repository = yield* StateRepository;
      const current = yield* enrollment.source();
      const generated = generateKeyPairSync("ed25519");
      const privateKey = generated.privateKey.export({
        type: "pkcs8",
        format: "pem",
      }).toString();
      const publicKeyDer = generated.publicKey.export({
        type: "spki",
        format: "der",
      });
      const fingerprint = decode(CertificateFingerprint)(
        sha256BytesHex(publicKeyDer),
      );
      const signingKeyReference = yield* machine.storeCredential({
        name: "canonfig-rotated-source-signing-key",
        value: Redacted.make(privateKey),
      });
      yield* repository.saveEnrollmentSource({
        identity: {
          keyId: `ed25519:${fingerprint}`,
          publicKeyFingerprint: fingerprint,
        },
        signingKeyReference,
        tlsKeyReference: current.tlsKeyReference,
        tlsCertificateReference: current.tlsCertificateReference,
        tlsFingerprint: current.tlsFingerprint,
      });
    }));

    const rotated = await Effect.runPromise(Effect.flip(
      retrieveBlob({
        ...input,
        blobId: published.blobs[1]!,
      }).pipe(Effect.provide(setup.followerMachine)),
    ));
    expect(rotated).toBeInstanceOf(TransportIntegrityError);
  });

  it("omits dependents whose cross-group dependency is unavailable", async () => {
    const setup = fixture();
    const published = await publishFixtureRevision(setup, true);
    const server = await start(setup);
    const enrolled = await enroll(setup, server);
    const metadata = await runFollower(setup, getRevisionMetadata({
      ...transportInput(server, enrolled),
      revisionId: published.revision.id,
    }));

    expect(metadata.resources.map((resource) => resource.id)).toEqual([
      "shared",
      "alpha-only",
    ]);
    expect(metadata.resources.some((resource) =>
      resource.id === "alpha-needs-beta"
    )).toBe(false);
  });

  it("keeps an empty authorized view selectable after access is removed", async () => {
    const setup = fixture();
    const published = await publishFixtureRevision(setup, false, false);
    const server = await start(setup);
    const enrolled = await enroll(setup, server);
    const input = transportInput(server, enrolled);

    const authorized = await runFollower(setup, getRevisionMetadata({
      ...input,
      revisionId: published.revision.id,
    }));
    expect(authorized.resources.map((resource) => resource.id)).toEqual([
      "alpha-only",
    ]);

    await setup.runtime.runPromise(Effect.gen(function*() {
      const enrollment = yield* Enrollment;
      yield* enrollment.updateFollowerGroups(enrolled.follower.id, []);
    }));
    const listed = await runFollower(setup, listRevisions(input));
    expect(listed.revisions.map((revision) => revision.id)).toEqual([
      published.revision.id,
    ]);
    const empty = await runFollower(setup, getRevisionMetadata({
      ...input,
      revisionId: published.revision.id,
    }));
    expect(empty.resources).toEqual([]);
    expect(empty.scheduleDefault).toEqual({
      type: "daily",
      at: "00:00",
      timezone: "local",
    });
  });

  it("rechecks current groups and revocation without revealing unauthorized blobs", async () => {
    const setup = fixture();
    const published = await publishFixtureRevision(setup);
    const server = await start(setup);
    const enrolled = await enroll(setup, server);
    const input = transportInput(server, enrolled);

    const metadata = await runFollower(setup, getRevisionMetadata({
      ...input,
      revisionId: published.revision.id,
    }));
    expect(metadata.resources).toHaveLength(2);

    await setup.runtime.runPromise(Effect.gen(function*() {
      const enrollment = yield* Enrollment;
      yield* enrollment.updateFollowerGroups(enrolled.follower.id, []);
    }));
    const updated = await runFollower(setup, getRevisionMetadata({
      ...input,
      revisionId: published.revision.id,
    }));
    expect(updated.resources.map((resource) => resource.id)).toEqual(["shared"]);

    const unauthorized = await Effect.runPromise(Effect.flip(
      retrieveBlob({
        ...input,
        blobId: published.blobs[1]!,
      }).pipe(Effect.provide(setup.followerMachine)),
    ));
    const missing = await Effect.runPromise(Effect.flip(
      retrieveBlob({
        ...input,
        blobId: decode(BlobId)("f".repeat(64)),
      }).pipe(Effect.provide(setup.followerMachine)),
    ));
    expect(unauthorized).toBeInstanceOf(TransportResourceNotFoundError);
    expect(missing).toBeInstanceOf(TransportResourceNotFoundError);

    await setup.runtime.runPromise(Effect.gen(function*() {
      const enrollment = yield* Enrollment;
      yield* enrollment.revokeFollower(enrolled.follower.id);
    }));
    const revoked = await Effect.runPromise(Effect.flip(
      listRevisions(input).pipe(Effect.provide(setup.followerMachine)),
    ));
    expect(revoked).toBeInstanceOf(RevokedFollowerCredentialError);
  });

  it("rejects tampered signatures, oversized metadata, and interrupted requests", async () => {
    const setup = fixture();
    const published = await publishFixtureRevision(setup);
    const server = await start(setup);
    const enrolled = await enroll(setup, server);
    const input = transportInput(server, enrolled);

    const oversized = await Effect.runPromise(Effect.flip(
      getRevisionMetadata({
        ...input,
        revisionId: published.revision.id,
        maximumMetadataBytes: 32,
      }).pipe(Effect.provide(setup.followerMachine)),
    ));
    expect(oversized).toBeInstanceOf(TransportSizeLimitError);

    const oversizedBlob = await Effect.runPromise(Effect.flip(
      retrieveBlob({
        ...input,
        blobId: published.blobs[0]!,
        maximumBlobBytes: 2,
      }).pipe(Effect.provide(setup.followerMachine)),
    ));
    expect(oversizedBlob).toBeInstanceOf(TransportSizeLimitError);

    const controller = new AbortController();
    controller.abort();
    const interrupted = await Effect.runPromise(Effect.flip(
      listRevisions({
        ...input,
        signal: controller.signal,
      }).pipe(Effect.provide(setup.followerMachine)),
    ));
    expect(interrupted).toBeInstanceOf(TransportInterruptedError);

    const database = new DatabaseSync(setup.database);
    database.exec("DROP TRIGGER profile_revisions_immutable_update");
    const stored = decode(Schema.Struct({ revision_json: Schema.String }))(
      database.prepare(
      "SELECT revision_json FROM profile_revisions WHERE id = ?",
      ).get(published.revision.id),
    );
    const revision = JSON.parse(stored.revision_json);
    revision.signature = `ed25519:${"A".repeat(86)}`;
    database.prepare(
      "UPDATE profile_revisions SET signature = ?, revision_json = ? WHERE id = ?",
    ).run(revision.signature, JSON.stringify(revision), published.revision.id);
    database.close();

    const tampered = await Effect.runPromise(Effect.flip(
      getRevisionMetadata({
        ...input,
        revisionId: published.revision.id,
      }).pipe(Effect.provide(setup.followerMachine)),
    ));
    expect(tampered).toBeInstanceOf(TransportIntegrityError);
  });

  it("persists verified cache blobs across source restart", async () => {
    const setup = fixture();
    const published = await publishFixtureRevision(setup);
    const firstServer = await start(setup);
    const enrolled = await enroll(setup, firstServer);
    const cacheDirectory = join(setup.root, "restart-cache");
    await runFollower(setup, fetchRevision({
      ...transportInput(firstServer, enrolled),
      revisionId: published.revision.id,
      cacheDirectory,
    }));
    await firstServer.close();
    openServers.splice(openServers.indexOf(firstServer), 1);

    const secondServer = await start(setup);
    const result = await runFollower(setup, fetchRevision({
      ...transportInput(secondServer, enrolled),
      revisionId: published.revision.id,
      cacheDirectory,
    }));
    expect(result.downloadedBlobs).toBe(0);
    expect(result.reusedBlobs).toBe(2);
    expect(secondServer.blobRequests()).toBe(0);
  });
});
