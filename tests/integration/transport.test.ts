import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  X509Certificate,
} from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SqliteClient, SqliteMigrator } from "@canonfig/effect-sql-sqlite-node";
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { generate } from "selfsigned";
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
import {
  type MachineProfile,
  type ProfileRevision,
  type PublishedResource,
} from "../../src/domain/profile.ts";
import {
  RevokedFollowerCredentialError,
  EnrollmentTransportError,
  LegacyRevisionFormatError,
  TransportIntegrityError,
  TransportInterruptedError,
  TransportResourceNotFoundError,
  TransportSizeLimitError,
} from "../../src/enrollment/enrollment.errors.ts";
import { SourceVersionMismatchError } from "../../src/enrollment/enrollment.errors.ts";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { buildIdentity } from "../../src/runtime/build-identity.ts";
import { peerVersionCompatible } from "../../src/enrollment/version-handshake.ts";
import { EnrollmentLive } from "../../src/enrollment/enrollment.layer.ts";
import { Enrollment } from "../../src/enrollment/enrollment.service.ts";
import {
  enrollFollower,
  atomicCacheWrite,
  fetchRevision,
  getRevisionMetadata,
  listRevisions,
  retrieveBlob,
  probeSourceDescriptor,
} from "../../src/enrollment/follower-client.ts";
import {
  BlobTransferProgress,
  type BlobTransferEvent,
} from "../../src/enrollment/blob-transfer-progress.ts";
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
import { stateMigrations as v220StateMigrations } from "../fixtures/upgrade/v2.2.0-state-schema.ts";
import { StateRepository } from "../../src/state/state-repository.service.ts";
import { describeRuntimeError } from "../../src/cli/failure-taxonomy.ts";
import { stateMigrations as v315StateMigrations } from "../fixtures/upgrade/v3.1.5-state-schema.ts";

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
  readonly blobBytes: ReadonlyArray<number>;
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
    const resources: ReadonlyArray<PublishedResource> = profile.resources.map(
      (resource) => {
        if (resource.spec.kind !== "file" || resource.spec.content === undefined) {
          throw new Error("transport fixture resources must be inline files");
        }
        const content = Buffer.from(resource.spec.content);
        const blob = decode(BlobId)(sha256BytesHex(content));
        return {
          id: decode(ResourceId)(resource.id),
          kind: resource.kind,
          policy: resource.policy ?? "replace",
          target: resource.target,
          groups: resource.groups,
          dependsOn: (resource.dependsOn ?? []).map((dependency) =>
            decode(ResourceId)(dependency)
          ),
          spec: {
            kind: "file",
            blob,
            bytes: content.byteLength,
            executable: resource.spec.executable ?? false,
          },
          blobs: [blob],
        };
      },
    );
    const canonicalBytes = canonicalJson(asJson({
      ...profile,
      resources: resources.map((resource, index) => ({
        ...resource,
        verify: profile.resources[index]!.verify,
      })),
    }));
    const digest = sha256Hex(canonicalBytes);
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
    yield* repository.publishRevision({
      revision,
      blobs: profile.resources.map((resource, index) => {
        if (resource.spec.kind !== "file" || resource.spec.content === undefined) {
          throw new Error("transport fixture resources must be inline files");
        }
        return {
          id: resources[index]!.blobs[0]!,
          content: Buffer.from(resource.spec.content),
        };
      }),
    });
    return {
      revision,
      blobs: resources.flatMap((resource) =>
        resource.blobs.map((blob) => decode(BlobId)(blob))
      ),
      blobBytes: resources.map((resource) => {
        if (resource.spec?.kind !== "file" || resource.spec.bytes === undefined) {
          throw new Error("transport fixture published file has no byte length");
        }
        return resource.spec.bytes;
      }),
    };
  }));

const start = async (
  setup: Fixture,
  hostname = "127.0.0.1",
): Promise<SourceServerHandle> => {
  const server = await setup.runtime.runPromise(startSourceServer({ hostname }));
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

  it.each(["127.0.0.1", "::1"])("filters groups, caches and resumes authenticated blobs over %s", async (hostname) => {
    const setup = fixture();
    const published = await publishFixtureRevision(setup);
    const server = await start(setup, hostname);
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

  it("rejects a pinned IPv6 endpoint whose certificate only covers IPv4 before HTTP", async () => {
    const certificate = await generate([{ name: "commonName", value: "wrong-ip-source" }], {
      keyType: "ec",
      curve: "P-256",
      extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }],
    });
    let requests = 0;
    const server = createHttpsServer(
      { key: certificate.private, cert: certificate.cert },
      (_request, response) => {
        requests += 1;
        response.writeHead(503);
        response.end();
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "::1", resolve));
    try {
      const address = server.address();
      if (address === null || Schema.is(Schema.String)(address)) throw new Error("no address");
      const refused = await Effect.runPromise(Effect.flip(probeSourceDescriptor({
        endpoint: `https://[::1]:${address.port}`,
        tlsFingerprint: decode(CertificateFingerprint)(
          new X509Certificate(certificate.cert).fingerprint256.replaceAll(":", "").toLowerCase(),
        ),
      })));
      expect(refused).toBeInstanceOf(EnrollmentTransportError);
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports blob progress and resumes an interrupted fetch from the verified cached blobs", async () => {
    const setup = fixture();
    const published = await publishFixtureRevision(setup);
    const server = await start(setup);
    const enrolled = await enroll(setup, server);
    const cacheDirectory = join(setup.root, "cache");
    const request = {
      ...transportInput(server, enrolled),
      revisionId: published.revision.id,
      cacheDirectory,
    };
    const events: Array<BlobTransferEvent> = [];
    const controller = new AbortController();
    // The connection drops right after the first blob arrives.
    const interrupted = await Effect.runPromise(Effect.flip(
      fetchRevision({ ...request, signal: controller.signal }).pipe(
        Effect.provideService(BlobTransferProgress, (event) => {
          events.push(event);
          if (event.blobReceived === event.blobBytes) controller.abort();
        }),
        Effect.provide(setup.followerMachine),
      ),
    ));
    expect(interrupted).toBeInstanceOf(TransportInterruptedError);
    // Smallest blob first, with its own bytes and the fetch's running total.
    const shared = Buffer.byteLength("shared\n");
    const alpha = Buffer.byteLength("alpha-1\n");
    expect(events).toEqual([{
      blob: sha256BytesHex(Buffer.from("shared\n")),
      blobIndex: 1,
      blobCount: 2,
      blobReceived: shared,
      blobBytes: shared,
      received: shared,
      total: shared + alpha,
    }]);
    expect(await readdir(join(cacheDirectory, "blobs"))).toEqual([events[0]!.blob]);

    const resumed = await runFollower(setup, fetchRevision(request));
    expect(resumed).toMatchObject({ downloadedBlobs: 1, reusedBlobs: 1 });
    expect(server.blobRequests()).toBe(2);
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
      revisionId: latest.revision.id,
      blobBytes: latest.blobBytes[1]!,
    }));
    const second = await runFollower(setup, retrieveBlob({
      ...input,
      blobId: latest.blobs[1]!,
      revisionId: latest.revision.id,
      blobBytes: latest.blobBytes[1]!,
    }));
    expect(Buffer.from(first)).toEqual(Buffer.from(second));

    const missing = await Effect.runPromise(Effect.flip(
      retrieveBlob({
        ...input,
        blobId: decode(BlobId)("e".repeat(64)),
        revisionId: latest.revision.id,
        blobBytes: 1,
      }).pipe(Effect.provide(setup.followerMachine)),
    ));
    expect(missing).toBeInstanceOf(TransportResourceNotFoundError);

    const firstRevision = history[0]!;
    const crossRevision = await Effect.runPromise(Effect.flip(
      retrieveBlob({
        ...input,
        blobId: firstRevision.blobs[1]!,
        revisionId: latest.revision.id,
        blobBytes: firstRevision.blobBytes[1]!,
      }).pipe(Effect.provide(setup.followerMachine)),
    ));
    expect(crossRevision).toBeInstanceOf(TransportResourceNotFoundError);

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
        revisionId: latest.revision.id,
        blobBytes: latest.blobBytes[1]!,
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
      revisionId: published.revision.id,
      blobBytes: published.blobBytes[1]!,
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
        revisionId: published.revision.id,
        blobBytes: published.blobBytes[1]!,
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
        revisionId: published.revision.id,
        blobBytes: published.blobBytes[1]!,
      }).pipe(Effect.provide(setup.followerMachine)),
    ));
    const missing = await Effect.runPromise(Effect.flip(
      retrieveBlob({
        ...input,
        blobId: decode(BlobId)("f".repeat(64)),
        revisionId: published.revision.id,
        blobBytes: 1,
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
        revisionId: published.revision.id,
        blobBytes: published.blobBytes[0]!,
        maximumBlobBytes: 0,
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

interface LegacyPublication {
  readonly revisionId: string;
  readonly signature: string;
  readonly contents: Readonly<Record<"plain" | "alpha", string>>;
}

/**
 * Leaves `setup.database` exactly as a 3.1.5 Source left it: that release's
 * schema, a Source identity, and one revision published in its format, with
 * each file body inline in the signed profile and the resource blob index
 * naming the digest of the whole spec.
 */
const legacySourceState = async (
  setup: Fixture,
  options: {
    readonly migrations?: typeof v315StateMigrations;
    readonly alphaSpecKind?: string;
    /** Adds what only v2.x could publish: a schedule resource and a named-timezone default. */
    readonly v2Schedule?: boolean;
  } = {},
): Promise<LegacyPublication> => {
  await Effect.runPromise(
    SqliteMigrator.run({ loader: options.migrations ?? v315StateMigrations }).pipe(
      Effect.provide(SqliteClient.layer({ filename: setup.database })),
    ),
  );
  const signing = generateKeyPairSync("ed25519");
  const fingerprint = sha256BytesHex(
    signing.publicKey.export({ type: "spki", format: "der" }),
  );
  const certificate = await generate([{ name: "commonName", value: "canonfig-loopback" }], {
    algorithm: "sha256",
    keyType: "ec",
    curve: "P-256",
    extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }],
  });
  const store = (name: string, value: string) =>
    Effect.runPromise(
      Effect.flatMap(MachineState, (machine) =>
        machine.storeCredential({ name, value: Redacted.make(value) })).pipe(
          Effect.provide(setup.sourceMachine),
        ),
    );
  const signingKeyReference = await store(
    "canonfig-source-signing-key",
    signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  const tlsKeyReference = await store("canonfig-source-tls-key", certificate.private);
  const tlsCertificateReference = await store(
    "canonfig-source-tls-certificate",
    certificate.cert,
  );
  const contents = { plain: "published by 3.1.5\n", alpha: "alpha group only\n" };
  const scheduleDefault = options.v2Schedule === true
    ? { scheduleDefault: { type: "daily", at: "09:00", timezone: "Europe/Paris" } }
    : {};
  const profile = {
    id: "legacy-profile",
    version: 2,
    name: "Legacy profile",
    groups: [{ name: "alpha" }],
    resources: [
      {
        id: "legacy-plain",
        kind: "file",
        policy: "replace",
        target: "~/.legacy-plain",
        dependsOn: [],
        spec: { kind: "file", content: contents.plain, executable: false },
        verify: { method: "digest", digest: sha256Hex(contents.plain) },
      },
      {
        id: "legacy-alpha",
        kind: "file",
        policy: "replace",
        target: "~/.legacy-alpha",
        groups: ["alpha"],
        dependsOn: ["legacy-plain"],
        spec: {
          kind: options.alphaSpecKind ?? "file",
          content: contents.alpha,
          executable: true,
          mode: 0o755,
        },
        verify: { method: "digest", digest: sha256Hex(contents.alpha) },
      },
      {
        id: "legacy-link",
        kind: "file",
        policy: "replace",
        target: "~/.legacy-link",
        dependsOn: [],
        spec: { kind: "file", content: "", executable: false, symlinkTo: "/etc/hostname" },
        verify: { method: "symlink", target: "/etc/hostname" },
      },
      ...(options.v2Schedule === true
        ? [{
          id: "legacy-schedule",
          kind: "schedule",
          policy: "replace",
          target: "canonfig-sync",
          dependsOn: [],
          spec: {
            kind: "schedule",
            calendar: { type: "daily", at: "09:00" },
            timezone: "Europe/Paris",
          },
          verify: { method: "executable-present", executable: "canonfig" },
        }]
        : []),
    ],
    ...scheduleDefault,
  };
  const resources = profile.resources.map(({ spec, verify: _, ...resource }) => ({
    ...resource,
    blobs: [digestOf(asJson(spec))],
  }));
  // Signed exactly as the old release signed it, retired kinds included.
  const signedResources: ReadonlyArray<PublishedResource> = JSON.parse(JSON.stringify(resources));
  const canonicalBytes = canonicalJson(asJson(profile));
  const digest = sha256Hex(canonicalBytes);
  const unsigned = {
    id: decode(ProfileRevisionId)(`${profile.id}:${digest}`),
    profileId: decode(ProfileId)(profile.id),
    sequence: 1,
    canonicalBytes,
    digest,
    publishedAt: "2026-06-01T09:00:00Z",
    resources: signedResources,
    groups: [{ name: group("alpha") }],
    signingKeyId: `ed25519:${fingerprint}`,
  };
  const signature = `ed25519:${
    sign(null, Buffer.from(revisionSigningPayload(unsigned)), signing.privateKey)
      .toString("base64url")
  }`;
  const { signingKeyId: _, ...stored } = unsigned;
  const database = new DatabaseSync(setup.database);
  try {
    database.prepare(
      "INSERT INTO source_identity (singleton, key_id, public_key_fingerprint) VALUES (1, ?, ?)",
    ).run(`ed25519:${fingerprint}`, fingerprint);
    database.prepare(
      `INSERT INTO enrollment_source (
        singleton, signing_key_reference, tls_key_reference,
        tls_certificate_reference, tls_fingerprint
      ) VALUES (1, ?, ?, ?, ?)`,
    ).run(
      signingKeyReference,
      tlsKeyReference,
      tlsCertificateReference,
      new X509Certificate(certificate.cert).fingerprint256.replaceAll(":", "").toLowerCase(),
    );
    database.prepare(
      `INSERT INTO profile_revisions (
        id, profile_id, sequence, canonical_bytes, digest, signature,
        published_at, revision_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      unsigned.id,
      unsigned.profileId,
      unsigned.sequence,
      canonicalBytes,
      digest,
      signature,
      unsigned.publishedAt,
      JSON.stringify({ ...stored, signature, ...scheduleDefault }),
    );
    for (const resource of resources) {
      database.prepare(
        "INSERT INTO profile_revision_blobs (blob_id, revision_id, resource_id) VALUES (?, ?, ?)",
      ).run(resource.blobs[0]!, unsigned.id, resource.id);
    }
  } finally {
    database.close();
  }
  return { revisionId: unsigned.id, signature, contents };
};

describe("Source upgraded from a release before 3.2.1", () => {
  it("serves a revision the earlier release published", async () => {
    const setup = fixture();
    const legacy = await legacySourceState(setup);
    // The first use of the runtime opens the 3.1.5 state and migrates it.
    const server = await start(setup);
    const enrolled = await enroll(setup, server);
    const fetched = await runFollower(setup, fetchRevision({
      ...transportInput(server, enrolled),
      revisionId: legacy.revisionId,
      cacheDirectory: join(setup.root, "legacy-cache"),
    }));

    expect(fetched.metadata.sourceSignature).toBe(legacy.signature);
    expect(fetched.metadata.resources.map((resource) => resource.id)).toEqual([
      "legacy-plain",
      "legacy-alpha",
      "legacy-link",
    ]);
    const bodies = await Promise.all(
      fetched.blobs.map((blob) => readFile(blob.path, "utf8")),
    );
    expect(bodies.sort()).toEqual([legacy.contents.alpha, legacy.contents.plain].sort());
    const alpha = fetched.metadata.resources.find((resource) => resource.id === "legacy-alpha");
    expect(alpha?.spec).toEqual({
      kind: "file",
      blob: sha256BytesHex(Buffer.from(legacy.contents.alpha)),
      bytes: Buffer.byteLength(legacy.contents.alpha),
      executable: true,
      mode: 0o755,
    });
    const link = fetched.metadata.resources.find((resource) => resource.id === "legacy-link");
    expect(link?.spec).toMatchObject({ kind: "file", symlinkTo: "/etc/hostname" });
    expect(link?.blobs).toEqual([]);
  });

  it("refuses a legacy revision it cannot represent by name, not as tampering", async () => {
    const setup = fixture();
    const legacy = await legacySourceState(setup, { alphaSpecKind: "schedule" });
    const server = await start(setup);
    const enrolled = await enroll(setup, server);
    const refused = await Effect.runPromise(Effect.flip(
      getRevisionMetadata({
        ...transportInput(server, enrolled),
        revisionId: legacy.revisionId,
      }).pipe(Effect.provide(setup.followerMachine)),
    ));
    expect(refused).toBeInstanceOf(LegacyRevisionFormatError);
    const described = describeRuntimeError(refused);
    expect(described.category).toBe("human-action-required");
    expect(described.message).toContain(legacy.revisionId);
    expect(described.message).toContain("canonfig source publish");
  });

  it("lists and serves a v2.2.0 revision carrying a retired schedule resource and timezone", async () => {
    const setup = fixture();
    const legacy = await legacySourceState(setup, {
      migrations: v220StateMigrations,
      v2Schedule: true,
    });
    const server = await start(setup);
    const enrolled = await enroll(setup, server);
    const input = transportInput(server, enrolled);
    const listed = await runFollower(setup, listRevisions(input));
    expect(listed.revisions.map((revision) => revision.id)).toEqual([legacy.revisionId]);
    const fetched = await runFollower(setup, fetchRevision({
      ...input,
      revisionId: legacy.revisionId,
      cacheDirectory: join(setup.root, "v2-cache"),
    }));
    expect(fetched.metadata.resources.map((resource) => resource.id)).toEqual([
      "legacy-plain",
      "legacy-alpha",
      "legacy-link",
    ]);
    expect(fetched.metadata.scheduleDefault).toBeUndefined();
    expect(fetched.downloadedBlobs).toBe(2);
  });
});

describe("Source/follower version handshake", () => {
  it("accepts the 4.0 release line but rejects a 3.2.x peer", () => {
    expect(peerVersionCompatible("4.0.1")).toBe(true);
    expect(peerVersionCompatible("3.2.2")).toBe(false);
  });

  it("refuses a follower from before the handshake with a version message it renders", async () => {
    const setup = fixture();
    await publishFixtureRevision(setup);
    const server = await start(setup);
    const endpoint = new URL(server.endpoint);
    // A follower before 3.2.1 sends no version header and renders only the
    // message of the failures it knows.
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpsRequest({
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: "/v1/transport/revisions",
        method: "GET",
        rejectUnauthorized: false,
        headers: { authorization: `Bearer ${"a".repeat(43)}` },
      }, (incoming) => {
        const chunks: Array<Buffer> = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }));
      });
      request.once("error", reject);
      request.end();
    });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      error: "MalformedEnrollmentRequestError",
      message: expect.stringContaining(
        `source/follower version mismatch: source ${buildIdentity.packageVersion} vs follower before 3.2.1`,
      ),
    });
  });

  it("reports a Source that announces no version as a version mismatch, not tampering", async () => {
    const setup = fixture();
    const certificate = await generate([{ name: "commonName", value: "old-source" }], {
      keyType: "ec",
      curve: "P-256",
      extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }],
    });
    const oldSource = createHttpsServer(
      { key: certificate.private, cert: certificate.cert },
      (request, response) => {
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ revisions: [] }));
      },
    );
    await new Promise<void>((resolve) => oldSource.listen(0, "127.0.0.1", resolve));
    try {
      const address = oldSource.address();
      if (address === null || Schema.is(Schema.String)(address)) throw new Error("no address");
      const credentialReference = await runFollower(
        setup,
        Effect.flatMap(MachineState, (machine) =>
          machine.storeCredential({
            name: "canonfig-follower-skew",
            value: Redacted.make("b".repeat(43)),
          })),
      );
      const refused = await Effect.runPromise(Effect.flip(
        listRevisions({
          endpoint: `https://127.0.0.1:${address.port}`,
          tlsFingerprint: decode(CertificateFingerprint)(
            new X509Certificate(certificate.cert).fingerprint256.replaceAll(":", "").toLowerCase(),
          ),
          credentialReference,
          sourceFingerprint: "c".repeat(64),
        }).pipe(Effect.provide(setup.followerMachine)),
      ));
      expect(refused).toBeInstanceOf(SourceVersionMismatchError);
      const described = describeRuntimeError(refused);
      expect(described.category).toBe("usage-or-configuration");
      expect(described.message).toContain(
        `source/follower version mismatch: source before 3.2.1 vs follower ${buildIdentity.packageVersion}`,
      );
    } finally {
      await new Promise<void>((resolve) => oldSource.close(() => resolve()));
    }
  });
});
