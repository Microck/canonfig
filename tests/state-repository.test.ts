import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  ActionId,
  CertificateFingerprint,
  BlobId,
  CredentialReference,
  ContentDigest,
  ProfileId,
  ResourceId,
  RunId,
  type FollowerId,
  ProfileRevisionId,
} from "../src/domain/brand.ts";
import {
  FollowerIdentity,
  SourceIdentity,
  type FollowerIdentity as FollowerIdentityType,
} from "../src/domain/identity.ts";
import {
  ProfileRevisionSchema,
  type ProfileRevision,
} from "../src/domain/profile.ts";
import {
  SynchronizationPlanSchema,
  SynchronizationOutcomeSchema,
  type SynchronizationOutcome,
  type SynchronizationPlan,
} from "../src/domain/synchronization.ts";
import {
  installerRecipeProvenance,
  McpQualificationReceipt,
} from "../src/domain/mcp-qualification.ts";
import {
  ActiveRunExistsError,
  EarlierStateFormatError,
  MachineRoleConflictError,
  RepositoryDecodeError,
  RepositorySqlError,
  RevisionImmutableError,
} from "../src/state/state-repository.errors.ts";
import {
  resourceBlobChunkBytes,
  stateRepositoryLayer,
} from "../src/state/state-repository.layer.ts";
import { sha256BytesHex } from "../src/profile/profile-codec.ts";
import { StateRepository } from "../src/state/state-repository.service.ts";
import { runtimeStateLayer } from "../src/runtime/state-layer.ts";
import { StateInitializationError } from "../src/runtime/state-initialization.errors.ts";
import {
  defaultScheduledInvocation,
  FollowerSynchronizationConfiguration,
} from "../src/synchronization/follower-sync-config.ts";

const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const databasePath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "canonfig-state-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.sqlite");
};

const runWithRepository = <A, E>(
  path: string,
  effect: Effect.Effect<A, E, StateRepository>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(stateRepositoryLayer(path))));

const decode = Schema.decodeUnknownSync;
const digestA = decode(ContentDigest)("a".repeat(64));
const digestB = decode(ContentDigest)("b".repeat(64));
const digestC = decode(ContentDigest)("c".repeat(64));
const asRunId = decode(RunId);
const asActionId = decode(ActionId);
const asResourceId = decode(ResourceId);

const follower = (id = "follower-1"): FollowerIdentityType =>
  decode(FollowerIdentity)({
    id,
    name: `Follower ${id}`,
    groups: ["base"],
    revoked: false,
    credentialReference: "secure-store://canonfig/follower",
    enrolledAt: "2026-08-15T12:00:00Z",
  });

const revision = (
  id = "revision-1",
  sequence = 1,
  canonicalBytes = '{"profile":"one"}',
): ProfileRevision =>
  decode(ProfileRevisionSchema)({
    id,
    profileId: "profile-1",
    sequence,
    canonicalBytes,
    digest: digestA,
    signature: "ed25519:test-signature",
    publishedAt: "2026-08-15T12:00:01Z",
    resources: [],
    groups: [{ name: "base" }],
  });

const plan = (
  followerId = "follower-1",
  revisionId = "revision-1",
  actionIds: ReadonlyArray<string> = ["action-1", "action-2"],
): SynchronizationPlan =>
  decode(SynchronizationPlanSchema)({
    follower: followerId,
    revision: revisionId,
    encoded: `plan:${followerId}:${revisionId}`,
    actions: actionIds.map((id) => ({
      id,
      resource: `resource-${id}`,
      kind: "verify-only",
      detail: { kind: "verify-only", method: "digest" },
      before: [],
    })),
  });

const seed = (
  followerId = "follower-1",
  revisionId = "revision-1",
  sequence = 1,
) =>
  Effect.gen(function*() {
    const repository = yield* StateRepository;
    yield* repository.registerFollower({ follower: follower(followerId) });
    yield* repository.publishRevision({
      revision: revision(revisionId, sequence),
    });
  });

const start = (
  repository: StateRepository["Service"],
  run: string,
  followerId: FollowerId,
  revisionId: ProfileRevisionId,
  runPlan = plan(followerId, revisionId),
) =>
  repository.startRun({
    id: asRunId(run),
    follower: followerId,
    revision: revisionId,
    plan: runPlan,
    startedAt: "2026-08-15T12:01:00Z",
  });

const followerConfigurationFixture = (path: string) => decode(FollowerSynchronizationConfiguration)({
  schemaVersion: 1, lifecycle: { _tag: "Active" },
  follower: follower(), profile: "profile-1",
  source: { endpoint: "https://127.0.0.1:17342", tlsFingerprint: "tls-source", signingFingerprint: "source" },
  credentialReference: follower().credentialReference,
  cacheDirectory: join(dirname(path), "cache"), stateLocation: path,
  agentPolicy: "deterministic-only", scheduledInvocation: defaultScheduledInvocation,
  updatedAt: "2026-08-15T12:00:00Z",
});

describe("StateRepository SQLite adapter", () => {
  it("runs idempotent migrations and persists identities as references", async () => {
    const path = databasePath();
    const program = Effect.gen(function*() {
      const repository = yield* StateRepository;
      yield* repository.saveSourceIdentity(decode(SourceIdentity)({
        keyId: "source-signing-key",
        publicKeyFingerprint: "sha256:source",
      }));
      yield* repository.registerFollower({ follower: follower() });
      return yield* repository.loadState(follower().id);
    });

    const first = await runWithRepository(path, program);
    const second = await runWithRepository(path, program);

    expect(first.sourceIdentity?.keyId).toBe("source-signing-key");
    expect(second.follower.credentialReference).toBe(
      "secure-store://canonfig/follower",
    );

    const database = new DatabaseSync(path, { readOnly: true });
    const columns = database.prepare("PRAGMA table_info(followers)").all()
      .map((row) => String(row.name));
    database.close();
    expect(columns).toContain("credential_reference");
    expect(columns.some((name) => name.includes("value") || name.includes("secret")))
      .toBe(false);
  });

  it("atomically persists typed follower synchronization configuration without secrets", async () => {
    const path = databasePath();
    const sourceIdentity = decode(SourceIdentity)({
      keyId: "ed25519:source-fingerprint",
      publicKeyFingerprint: "source-fingerprint",
    });
    const credentialReference = decode(CredentialReference)(
      "secure-store://canonfig/follower",
    );
    const configuredFollower = {
      ...follower(),
      credentialReference,
    };
    await runWithRepository(path, Effect.gen(function*() {
      const repository = yield* StateRepository;
      yield* repository.saveFollowerSynchronizationConfiguration({
        sourceIdentity,
        configuration: {
          schemaVersion: 1,
          lifecycle: { _tag: "Active" },
          follower: configuredFollower,
          profile: decode(ProfileId)("profile-1"),
          source: {
            endpoint: "https://127.0.0.1:17342",
            tlsFingerprint: "tls-fingerprint",
            signingFingerprint: sourceIdentity.publicKeyFingerprint,
          },
          credentialReference,
          cacheDirectory: join(dirname(path), "cache"),
          stateLocation: path,
          agentPolicy: "deterministic-only",
          scheduledInvocation: defaultScheduledInvocation,
          updatedAt: "2026-08-15T12:00:00Z",
        },
      });
    }));

    const stored = await runWithRepository(
      path,
      Effect.flatMap(StateRepository, (repository) =>
        repository.getFollowerSynchronizationConfiguration()
      ),
    );
    expect(stored).toMatchObject({
      follower: { id: configuredFollower.id },
      profile: "profile-1",
      credentialReference,
      agentPolicy: "deterministic-only",
      scheduledInvocation: { mode: "apply", noInput: true },
    });

    const database = new DatabaseSync(path, { readOnly: true });
    const row = decode(Schema.Struct({
      configuration_json: Schema.String,
    }))(database.prepare(`
      SELECT configuration_json FROM follower_sync_configuration
    `).get());
    database.close();
    expect(row.configuration_json).toContain(credentialReference);
    expect(row.configuration_json).not.toContain("credentialValue");
    expect(row.configuration_json).not.toContain("secret");
  });

  it("saves one role record at a time and refuses the other inside its write transaction", async () => {
    const followedSource = decode(SourceIdentity)({ keyId: "ed25519:followed", publicKeyFingerprint: "followed" });
    const credentialReference = decode(CredentialReference)("secure-store://canonfig/follower");
    const followerConfiguration = (path: string) => ({
      sourceIdentity: followedSource,
      configuration: {
        schemaVersion: 1 as const,
        follower: { ...follower(), credentialReference },
        profile: decode(ProfileId)("profile-1"),
        source: { endpoint: "https://127.0.0.1:17342", tlsFingerprint: "tls-followed", signingFingerprint: "followed" },
        credentialReference,
        cacheDirectory: join(dirname(path), "cache"),
        stateLocation: path,
        agentPolicy: "deterministic-only" as const,
        lifecycle: { _tag: "Finalizing" as const },
        scheduledInvocation: defaultScheduledInvocation,
        updatedAt: "2026-08-15T12:00:00Z",
      },
    });
    const ownSource = decode(Schema.Struct({
      identity: SourceIdentity,
      signingKeyReference: CredentialReference,
      tlsKeyReference: CredentialReference,
      tlsCertificateReference: CredentialReference,
      tlsFingerprint: CertificateFingerprint,
    }))({
      identity: { keyId: "ed25519:own", publicKeyFingerprint: "own" },
      signingKeyReference: "secure-store://canonfig/signing",
      tlsKeyReference: "secure-store://canonfig/tls-key",
      tlsCertificateReference: "secure-store://canonfig/tls-certificate",
      tlsFingerprint: "tls-own",
    });
    const rows = (path: string) => {
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        const count = (table: string) => Number(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count);
        return {
          source: count("enrollment_source"),
          follower: count("follower_sync_configuration"),
          followers: count("followers"),
          signingKey: database.prepare("SELECT public_key_fingerprint AS key FROM source_identity").get()?.key,
        };
      } finally {
        database.close();
      }
    };

    // A pending enrollment already makes the machine a Follower.
    const enrolling = databasePath();
    const refusedSource = await runWithRepository(enrolling, Effect.gen(function*() {
      const repository = yield* StateRepository;
      yield* repository.saveFollowerSynchronizationConfiguration(followerConfiguration(enrolling));
      return yield* Effect.flip(repository.saveEnrollmentSource(ownSource));
    }));
    expect(refusedSource).toBeInstanceOf(MachineRoleConflictError);
    expect(refusedSource.message).toContain("is enrolling with the Source at https://127.0.0.1:17342");
    expect(refusedSource.message).toContain("so it cannot be a Source");
    expect(rows(enrolling)).toEqual({ source: 0, follower: 1, followers: 1, signingKey: "followed" });

    const sourcePath = databasePath();
    const refusedFollower = await runWithRepository(sourcePath, Effect.gen(function*() {
      const repository = yield* StateRepository;
      yield* repository.saveEnrollmentSource(ownSource);
      return yield* Effect.flip(repository.saveFollowerSynchronizationConfiguration(followerConfiguration(sourcePath)));
    }));
    expect(refusedFollower).toBeInstanceOf(MachineRoleConflictError);
    expect(refusedFollower.message).toContain("this machine is a Source (signing key own), so it cannot be a Follower");
    expect(refusedFollower.message).toContain(`move ${dirname(sourcePath)} aside`);
    expect(rows(sourcePath)).toEqual({ source: 1, follower: 0, followers: 0, signingKey: "own" });
  });

  it("refuses replacing an initialized Source identity", async () => {
    const path = databasePath();
    const first = {
      identity: decode(SourceIdentity)({ keyId: "first", publicKeyFingerprint: "first" }),
      signingKeyReference: decode(CredentialReference)("secure-store://first/signing"),
      tlsKeyReference: decode(CredentialReference)("secure-store://first/tls"),
      tlsCertificateReference: decode(CredentialReference)("secure-store://first/cert"),
      tlsFingerprint: decode(CertificateFingerprint)("first-tls"),
    };
    const second = { ...first, identity: decode(SourceIdentity)({ keyId: "second", publicKeyFingerprint: "second" }) };
    const result = await runWithRepository(path, Effect.gen(function*() {
      const repository = yield* StateRepository;
      yield* repository.saveEnrollmentSource(first);
      const refused = yield* Effect.result(repository.saveEnrollmentSource(second));
      return { refused, stored: yield* repository.getEnrollmentSource() };
    }));
    expect(result.refused._tag).toBe("Failure");
    expect(result.stored).toEqual(first);
  });
  it("refuses a stale settings write after unenrollment instead of recreating the enrollment", async () => {
    const path = databasePath();
    const sourceIdentity = decode(SourceIdentity)({ keyId: "source", publicKeyFingerprint: "source" });
    const stale = followerConfigurationFixture(path);
    const result = await runWithRepository(path, Effect.gen(function*() {
      const repository = yield* StateRepository;
      yield* repository.saveFollowerSynchronizationConfiguration({ sourceIdentity, configuration: stale });
      const retiring = { ...stale, lifecycle: { _tag: "Unenrolling" as const } };
      yield* repository.saveFollowerSynchronizationConfiguration({
        sourceIdentity, configuration: retiring, expectedConfiguration: stale,
      });
      yield* repository.removeFollowerSynchronizationConfiguration(retiring);
      const refused = yield* Effect.result(repository.saveFollowerSynchronizationConfiguration({
        sourceIdentity, configuration: { ...stale, agentPolicy: "agent-apply" }, expectedConfiguration: stale,
      }));
      return { refused, configuration: yield* repository.getFollowerSynchronizationConfiguration() };
    }));
    expect(result.refused._tag).toBe("Failure");
    expect(result.configuration).toBeUndefined();
  });

  it.each([false, true])("migrates released follower state without guessing pending ownership (pending=%s)", async (pending) => {
    const path = databasePath();
    const sourceIdentity = decode(SourceIdentity)({ keyId: "source", publicKeyFingerprint: "source" });
    await runWithRepository(path, Effect.flatMap(StateRepository, (repository) =>
      repository.saveFollowerSynchronizationConfiguration({ sourceIdentity, configuration: followerConfigurationFixture(path) })));
    const database = new DatabaseSync(path);
    database.exec(`
      DELETE FROM effect_sql_migrations WHERE migration_id = 4;
      DROP TABLE enrollment_credential_retirements;
      UPDATE follower_sync_configuration SET configuration_json = json_set(
        json_remove(configuration_json, '$.lifecycle'), '$.enrollmentPending', json('${pending}')
      );
    `);
    database.close();
    const loaded = await runWithRepository(path, Effect.flatMap(StateRepository, (repository) =>
      Effect.result(repository.getFollowerSynchronizationConfiguration())));
    if (pending) {
      expect(loaded._tag).toBe("Failure");
      if (loaded._tag === "Failure") expect(loaded.failure.message).toContain("move this Canonfig state directory aside");
    } else {
      expect(loaded).toMatchObject({ _tag: "Success", success: { lifecycle: { _tag: "Active" } } });
    }
  });

  it("refuses state an earlier release created and asks to reinitialize", async () => {
    // A release before state format 6 recorded a different migration history.
    const path = databasePath();
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE effect_sql_migrations (
        migration_id integer PRIMARY KEY NOT NULL,
        created_at datetime NOT NULL DEFAULT current_timestamp,
        name VARCHAR(255) NOT NULL
      );
      INSERT INTO effect_sql_migrations (migration_id, name) VALUES (1, 'state_repository'), (22, 'local_projection');
    `);
    database.close();

    const refused = await Effect.runPromise(Effect.flip(
      Effect.flatMap(StateRepository, () => Effect.void).pipe(Effect.provide(stateRepositoryLayer(path))),
    ));
    expect(refused).toBeInstanceOf(EarlierStateFormatError);
    expect(refused).toMatchObject({ migrations: ["0001_state_repository", "0022_local_projection"] });

    const runtime = await Effect.runPromise(Effect.flip(
      Effect.flatMap(StateRepository, () => Effect.void).pipe(Effect.provide(runtimeStateLayer(path))),
    ));
    expect(runtime).toBeInstanceOf(StateInitializationError);
    expect(runtime.message).toContain("created by an earlier Canonfig version");
    expect(runtime.message).toContain(`move ${path} aside`);
  });

  it("journals exports and imports apart from runs, so the last sync stays the last sync", async () => {
    const path = databasePath();
    const latest = await runWithRepository(path, Effect.gen(function*() {
      yield* seed();
      const repository = yield* StateRepository;
      yield* start(repository, "run-sync", follower().id, revision().id);
      yield* repository.completeRun({
        run: asRunId("run-sync"),
        completedAt: "2026-08-15T12:03:00Z",
        outcome: decode(SynchronizationOutcomeSchema)({ outcome: "Converged", run: "run-sync", verified: [] }),
        appliedResources: [],
      });
      yield* repository.recordArchiveEvent({
        occurredAt: "2026-08-15T12:04:00Z",
        command: "export",
        outcome: "Exported",
        archive: "/home/user/setup.tar.gz",
        sha256: digestC,
        signer: "unsigned",
      });
      return yield* repository.latestDeploymentReceipt(follower().id);
    }));
    expect(latest).toMatchObject({ run: "run-sync", outcome: "Converged" });

    const database = new DatabaseSync(path);
    try {
      expect(database.prepare("SELECT occurred_at, command, outcome, archive, sha256, signer FROM archive_events").all().map((row) => ({ ...row }))).toEqual([{
        occurred_at: "2026-08-15T12:04:00Z",
        command: "export",
        outcome: "Exported",
        archive: "/home/user/setup.tar.gz",
        sha256: digestC,
        signer: "unsigned",
      }]);
      expect(database.prepare("SELECT COUNT(*) AS count FROM synchronization_runs").get()?.count).toBe(1);
      // The journal is append-only.
      expect(() => database.exec("UPDATE archive_events SET outcome = 'Error'")).toThrow("append-only");
      expect(() => database.exec("DELETE FROM archive_events")).toThrow("append-only");
    } finally {
      database.close();
    }
  });

  it("publishes immutable revisions idempotently and rejects changed content", async () => {
    const path = databasePath();
    const changed = revision("revision-1", 1, '{"profile":"changed"}');
    const error = await runWithRepository(
      path,
      Effect.gen(function*() {
        const repository = yield* StateRepository;
        yield* repository.publishRevision({ revision: revision() });
        yield* repository.publishRevision({ revision: revision() });
        return yield* Effect.flip(
          repository.publishRevision({ revision: changed }),
        );
      }),
    );
    expect(error).toBeInstanceOf(RevisionImmutableError);

    const database = new DatabaseSync(path);
    expect(() =>
      database.prepare(
        "UPDATE profile_revisions SET signature = 'changed' WHERE id = ?",
      ).run("revision-1")
    ).toThrow(/immutable/u);
    database.close();
  });

  it("stores blobs as fixed-size chunks and serves ranges without joining them", async () => {
    const path = databasePath();
    const chunk = resourceBlobChunkBytes;
    const large = randomBytes(chunk * 2 + 17);
    const largePath = join(dirname(path), "large.bin");
    writeFileSync(largePath, large);
    const onDisk = randomBytes(chunk + 5);
    const filePath = join(dirname(path), "source.bin");
    writeFileSync(filePath, onDisk);
    const largeId = decode(BlobId)(sha256BytesHex(large));
    const fileId = decode(BlobId)(sha256BytesHex(onDisk));
    const ranges = await runWithRepository(
      path,
      Effect.gen(function*() {
        const repository = yield* StateRepository;
        const blobs = [
          { id: largeId, bytes: large.byteLength, path: largePath },
          { id: fileId, bytes: onDisk.byteLength, path: filePath },
        ];
        yield* repository.publishRevision({ revision: revision(), blobs });
        // Republishing verifies the stored chunks instead of writing again.
        yield* repository.publishRevision({ revision: revision(), blobs });
        return {
          spanning: yield* repository.readResourceBlobRange({
            blob: largeId,
            offset: chunk - 3,
            maximumBytes: chunk + 10,
          }),
          tail: yield* repository.readResourceBlobRange({
            blob: fileId,
            offset: chunk,
            maximumBytes: chunk,
          }),
          whole: yield* repository.readResourceBlobRange({
            blob: fileId,
            offset: 0,
            maximumBytes: chunk * 4,
          }),
        };
      }),
    );
    expect(ranges.spanning?.chunks.length).toBe(3);
    expect(ranges.spanning?.byteLength).toBe(chunk + 10);
    expect(ranges.spanning?.totalBytes).toBe(large.byteLength);
    expect(Buffer.concat(ranges.spanning!.chunks))
      .toEqual(large.subarray(chunk - 3, chunk * 2 + 7));
    expect(Buffer.concat(ranges.tail!.chunks)).toEqual(onDisk.subarray(chunk));
    expect(ranges.whole?.chunks.length).toBe(2);
    expect(Buffer.concat(ranges.whole!.chunks)).toEqual(onDisk);

    const database = new DatabaseSync(path);
    try {
      expect(database.prepare(`
        SELECT blob_id, count(*) AS chunks, max(length(content)) AS largest, sum(length(content)) AS bytes
        FROM resource_blob_chunks GROUP BY blob_id ORDER BY bytes
      `).all().map((row) => ({ ...row }))).toEqual([
        { blob_id: fileId, chunks: 2, largest: chunk, bytes: onDisk.byteLength },
        { blob_id: largeId, chunks: 3, largest: chunk, bytes: large.byteLength },
      ]);
    } finally {
      database.close();
    }
  });

  it("refuses a source file that changed after it was hashed and stores nothing", async () => {
    const path = databasePath();
    const filePath = join(dirname(path), "source.bin");
    const hashed = randomBytes(resourceBlobChunkBytes + 3);
    const changed = Buffer.from(hashed);
    changed[10] = changed[10]! ^ 0xff;
    writeFileSync(filePath, changed);
    const error = await runWithRepository(
      path,
      Effect.gen(function*() {
        const repository = yield* StateRepository;
        return yield* Effect.flip(repository.publishRevision({
          revision: revision(),
          blobs: [{
            id: decode(BlobId)(sha256BytesHex(hashed)),
            bytes: hashed.byteLength,
            path: filePath,
          }],
        }));
      }),
    );
    expect(error).toBeInstanceOf(RevisionImmutableError);
    expect(error.message).toContain("changed while it was being published");
    const database = new DatabaseSync(path);
    try {
      expect(database.prepare(`
        SELECT
          (SELECT count(*) FROM resource_blob_manifests) AS manifests,
          (SELECT count(*) FROM resource_blob_chunks) AS chunks,
          (SELECT count(*) FROM profile_revisions) AS revisions
      `).get()).toEqual({ manifests: 0, chunks: 0, revisions: 0 });
    } finally {
      database.close();
    }
  });

  it("persists publication approval atomically with its exact revision", async () => {
    const path = databasePath();
    const approved = await runWithRepository(
      path,
      Effect.gen(function*() {
        const repository = yield* StateRepository;
        const published = revision();
        yield* repository.publishRevision({
          revision: published,
          approval: {
            proposalDigest: digestB,
            reviewer: "operator",
            reviewedAt: "2026-08-15T12:00:00Z",
            recordedAt: "2026-08-15T12:00:01Z",
          },
        });
        return yield* repository.loadRevisionApproval(published.id);
      }),
    );
    expect(approved).toEqual({
      revision: "revision-1",
      proposalDigest: digestB,
      revisionDigest: digestA,
      reviewer: "operator",
      reviewedAt: "2026-08-15T12:00:00Z",
      recordedAt: "2026-08-15T12:00:01Z",
    });

    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TRIGGER reject_revision_approval
      BEFORE INSERT ON revision_approvals
      BEGIN
        SELECT RAISE(ABORT, 'reject approval fixture');
      END
    `);
    database.close();
    const rolledBack = await runWithRepository(
      path,
      Effect.gen(function*() {
        const repository = yield* StateRepository;
        const failed = yield* Effect.exit(repository.publishRevision({
          revision: revision("revision-2", 2),
          approval: {
            proposalDigest: digestC,
            reviewer: "operator",
            reviewedAt: "2026-08-15T12:01:00Z",
            recordedAt: "2026-08-15T12:01:01Z",
          },
        }));
        const stored = yield* repository.findRevision(
          decode(ProfileRevisionId)("revision-2"),
        );
        return { failed, stored };
      }),
    );
    expect(rolledBack.failed._tag).toBe("Failure");
    expect(rolledBack.stored).toBeUndefined();
  });

  it("rolls back a failed run-start transaction", async () => {
    const path = databasePath();
    const duplicatePlan = plan(
      "follower-1",
      "revision-1",
      ["duplicate", "duplicate"],
    );
    const result = await runWithRepository(
      path,
      Effect.gen(function*() {
        yield* seed();
        const repository = yield* StateRepository;
        const failed = yield* Effect.flip(start(
          repository,
          "run-rollback",
          follower().id,
          revision().id,
          duplicatePlan,
        ));
        yield* start(
          repository,
          "run-rollback",
          follower().id,
          revision().id,
          plan(),
        );
        const recovery = yield* repository.loadRecovery(follower().id);
        return { failed, recovery };
      }),
    );

    expect(result.failed).toBeInstanceOf(RepositorySqlError);
    expect(result.recovery?.run.id).toBe("run-rollback");
    expect(result.recovery?.actions).toHaveLength(2);
  });

  it("enforces one active applying run per follower with a database constraint", async () => {
    const path = databasePath();
    const result = await runWithRepository(
      path,
      Effect.gen(function*() {
        yield* seed();
        const repository = yield* StateRepository;
        yield* start(
          repository,
          "run-active",
          follower().id,
          revision().id,
        );
        const duplicate = yield* Effect.flip(start(
          repository,
          "run-blocked",
          follower().id,
          revision().id,
        ));
        const outcome = decode(SynchronizationOutcomeSchema)({
          outcome: "Interrupted",
          run: "run-active",
          completedActions: [],
        }) satisfies SynchronizationOutcome;
        yield* repository.completeRun({
          run: asRunId("run-active"),
          completedAt: "2026-08-15T12:02:00Z",
          outcome,
          appliedResources: [],
        });
        const blockedDuringRecovery = yield* Effect.flip(start(
          repository,
          "run-after-interruption",
          follower().id,
          revision().id,
        ));
        // Explicitly abandon the interrupted run before allowing a new run.
        yield* repository.completeRun({
          run: asRunId("run-active"),
          completedAt: "2026-08-15T12:03:00Z",
          outcome: {
            outcome: "Failed",
            run: asRunId("run-active"),
            reason: "test abandonment",
          },
          appliedResources: [],
        });
        yield* start(
          repository,
          "run-after-completion",
          follower().id,
          revision().id,
        );
        return { duplicate, blockedDuringRecovery };
      }),
    );

    expect(result.duplicate).toBeInstanceOf(ActiveRunExistsError);
    expect(result.blockedDuringRecovery).toBeInstanceOf(ActiveRunExistsError);

    const database = new DatabaseSync(path, { readOnly: true });
    const indexes = database.prepare(
      "SELECT sql FROM sqlite_master WHERE name = ?",
    ).get("one_active_applying_run_per_follower");
    database.close();
    expect(String(indexes?.sql)).toContain("WHERE status = 'applying'");
  });

  it("blocks a new run after restart until interrupted recovery is terminal", async () => {
    const path = databasePath();
    await runWithRepository(
      path,
      Effect.gen(function*() {
        yield* seed();
        const repository = yield* StateRepository;
        yield* start(repository, "run-restart", follower().id, revision().id);
        yield* repository.completeRun({
          run: asRunId("run-restart"),
          completedAt: "2026-08-15T12:02:00Z",
          outcome: decode(SynchronizationOutcomeSchema)({
            outcome: "Interrupted",
            run: "run-restart",
            completedActions: [],
          }),
          appliedResources: [],
        });
      }),
    );

    const blocked = await runWithRepository(
      path,
      Effect.gen(function*() {
        const repository = yield* StateRepository;
        return yield* Effect.flip(start(
          repository,
          "run-after-restart",
          follower().id,
          revision().id,
        ));
      }),
    );
    expect(blocked).toBeInstanceOf(ActiveRunExistsError);

    const state = await runWithRepository(
      path,
      Effect.flatMap(StateRepository, (repository) =>
        repository.loadState(follower().id)
      ),
    );
    expect(state.activeRecovery?.run.id).toBe("run-restart");
  });

  it("maps malformed persisted plan JSON into a contextual decoding error", async () => {
    const path = databasePath();
    await runWithRepository(
      path,
      Effect.gen(function*() {
        yield* seed();
        const repository = yield* StateRepository;
        yield* start(
          repository,
          "run-malformed",
          follower().id,
          revision().id,
        );
      }),
    );

    const database = new DatabaseSync(path);
    database.prepare(
      "UPDATE synchronization_runs SET plan_json = ? WHERE id = ?",
    ).run('{"actions":', "run-malformed");
    database.close();

    const error = await runWithRepository(
      path,
      Effect.gen(function*() {
        const repository = yield* StateRepository;
        return yield* Effect.flip(repository.loadRecovery(follower().id));
      }),
    );
    expect(error).toBeInstanceOf(RepositoryDecodeError);
    if (error instanceof RepositoryDecodeError) {
      expect(error.entity).toBe("synchronization plan");
      expect(error.id).toBe("run-malformed");
    }
  });

  it("loads interruption recovery with ordered action journal and drift", async () => {
    const path = databasePath();
    const recovery = await runWithRepository(
      path,
      Effect.gen(function*() {
        yield* seed();
        const repository = yield* StateRepository;
        yield* start(
          repository,
          "run-interrupted",
          follower().id,
          revision().id,
        );
        yield* repository.journalAction({
          run: asRunId("run-interrupted"),
          action: asActionId("action-1"),
          state: "running",
          recordedAt: "2026-08-15T12:01:01Z",
          attempt: 1,
          rollbackReference: "rollback://run-interrupted/action-1",
        });
        yield* repository.journalAction({
          run: asRunId("run-interrupted"),
          action: asActionId("action-1"),
          state: "succeeded",
          recordedAt: "2026-08-15T12:01:02Z",
          attempt: 1,
          verification: {
            status: "passed",
            method: "digest",
            observedDigest: digestA,
          },
        });
        yield* repository.recordDrift({
          run: asRunId("run-interrupted"),
          recordedAt: "2026-08-15T12:01:03Z",
          conflict: {
            resource: asResourceId("resource-action-2"),
            target: "~/.canonfig/skill",
            desiredDigest: digestA,
            observedDigest: digestB,
            lastAppliedDigest: digestC,
          },
        });
        return yield* repository.loadRecovery(follower().id);
      }),
    );

    expect(recovery?.run.id).toBe("run-interrupted");
    expect(recovery?.actions.map((event) => [
      event.ordinal,
      event.action,
      event.state,
    ])).toEqual([
      [0, "action-1", "pending"],
      [1, "action-2", "pending"],
      [2, "action-1", "running"],
      [3, "action-1", "succeeded"],
    ]);
    expect(recovery?.actions[3]?.verification?.status).toBe("passed");
    expect(recovery?.drift[0]?.conflict.observedDigest).toBe(digestB);
  });

  it("retains removed ownership metadata in the recovery journal", async () => {
    const path = databasePath();
    const removed = {
      resource: asResourceId("resource-action-1"),
      revision: revision().id,
      digest: digestA,
      appliedAt: "2026-08-15T12:00:59Z",
      kind: "file" as const,
      policy: "replace" as const,
      target: "~/.canonfig/removed",
      executable: false,
    };
    const recovery = await runWithRepository(
      path,
      Effect.gen(function*() {
        yield* seed();
        const repository = yield* StateRepository;
        yield* start(
          repository,
          "run-removed-resource",
          follower().id,
          revision().id,
        );
        const database = new DatabaseSync(path);
        database.prepare(`
          INSERT INTO applied_resources (
            follower_id, resource_id, revision_id, digest, applied_at,
            kind, policy, target, executable
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          follower().id,
          removed.resource,
          removed.revision,
          removed.digest,
          removed.appliedAt,
          removed.kind,
          removed.policy,
          removed.target,
          0,
        );
        database.close();
        yield* repository.journalAction({
          run: asRunId("run-removed-resource"),
          action: asActionId("action-1"),
          state: "succeeded",
          recordedAt: "2026-08-15T12:01:01Z",
          attempt: 1,
          verification: {
            status: "passed",
            method: "owned-resource-removed",
          },
          removedResource: removed.resource,
          removedResourceRecord: removed,
        });
        return yield* repository.loadRecovery(follower().id);
      }),
    );

    expect(recovery?.appliedResources).toEqual([]);
    expect(recovery?.removedResources).toEqual([removed]);
    expect(recovery?.actions.at(-1)?.removedResource).toEqual(removed);
    const database = new DatabaseSync(path, { readOnly: true });
    // SAFETY: The SELECT projects exactly one nullable removed_resource_json column.
    const row = database.prepare(`
      SELECT removed_resource_json
      FROM action_journal
      WHERE run_id = ? AND action_id = ?
      ORDER BY sequence DESC
      LIMIT 1
    `).get("run-removed-resource", "action-1") as {
      removed_resource_json: string | null;
    };
    database.close();
    expect(row.removed_resource_json).toContain("\"target\":\"~/.canonfig/removed\"");
  });

  it("completes runs transactionally and exposes applied records to later recovery", async () => {
    const path = databasePath();
    const result = await runWithRepository(
      path,
      Effect.gen(function*() {
        yield* seed();
        const repository = yield* StateRepository;
        yield* start(
          repository,
          "run-complete",
          follower().id,
          revision().id,
        );
        yield* repository.completeRun({
          run: asRunId("run-complete"),
          completedAt: "2026-08-15T12:03:00Z",
          outcome: decode(SynchronizationOutcomeSchema)({
            outcome: "Converged",
            run: "run-complete",
            verified: ["resource-action-1"],
          }),
          appliedResources: [{
            resource: asResourceId("resource-action-1"),
            revision: revision().id,
            digest: digestA,
            appliedAt: "2026-08-15T12:03:00Z",
            mode: 0o644,
            ownedFiles: [{
              path: "nested/file",
              digest: digestB,
              executable: false,
              mode: 0o640,
            }],
          }],
        });
        const completedRecovery = yield* repository.loadRecovery(follower().id);
        yield* start(
          repository,
          "run-next",
          follower().id,
          revision().id,
        );
        const nextRecovery = yield* repository.loadRecovery(follower().id);
        return { completedRecovery, nextRecovery };
      }),
    );

    expect(result.completedRecovery).toBeUndefined();
    expect(result.nextRecovery?.appliedResources).toEqual([{
      resource: "resource-action-1",
      revision: "revision-1",
      digest: digestA,
      appliedAt: "2026-08-15T12:03:00Z",
      mode: 0o644,
      ownedFiles: [{
        path: "nested/file",
        digest: digestB,
        executable: false,
        mode: 0o640,
      }],
    }]);
  });

  it("records deployment, verification, client-load, and no-op evidence separately", async () => {
    const path = databasePath();
    const result = await runWithRepository(
      path,
      Effect.gen(function*() {
        yield* seed();
        const repository = yield* StateRepository;
        const firstPlan = decode(SynchronizationPlanSchema)({
          follower: "follower-1",
          revision: "revision-1",
          encoded: "first-run",
          actions: [
            {
              id: "write",
              resource: "resource-write",
              kind: "write-file",
              detail: {
                kind: "write-file",
                target: "~/.config/client",
                digest: digestA,
              },
              before: [],
            },
            {
              id: "load",
              resource: "resource-load",
              kind: "verify-only",
              detail: { kind: "verify-only", method: "command" },
              before: ["write"],
            },
            {
              id: "transfer",
              resource: "resource-transfer",
              kind: "transfer-blob",
              detail: { kind: "transfer-blob", blob: digestA, bytes: 1 },
              before: [],
            },
          ],
        });
        yield* start(
          repository,
          "run-evidence",
          follower().id,
          revision().id,
          firstPlan,
        );
        const recipe = installerRecipeProvenance({
          upstream: "https://registry.npmjs.org/example-mcp",
          version: "1.2.3",
          platform: "linux",
          architecture: process.arch,
          artifactDigest: digestA,
          entrypoint: "/opt/example/bin/example-mcp",
          dependencyPolicy: "scripts-disabled",
          executionContext: "follower-local",
          method: "npm",
          package: "example-mcp",
          compatibility: "mcp-2025-11-25",
          target: "codex",
        });
        const qualification = McpQualificationReceipt.make({
          schema: "canonfig.mcp-qualification/v1",
          resource: "resource-load",
          target: "codex",
          recipe,
          stages: ([
            "installed",
            "launches",
            "protocol-compatible",
            "authenticated",
            "functional",
            "client-loaded",
            "canonfig-managed",
          ] as const).map((stage) => ({
            stage,
            status: stage === "authenticated" ? "not-required" : "passed",
            method: "fixture",
            operation: "harmless fixture probe",
          })),
          prerequisites: [],
          ready: true,
          recordedAt: "2026-08-15T12:01:30Z",
        });
        for (const [action, method] of [
          ["write", "sha256"],
          ["load", "client-load:codex"],
          ["transfer", "sha256-and-size"],
        ] as const) {
          yield* repository.journalAction({
            run: asRunId("run-evidence"),
            action: asActionId(action),
            state: "succeeded",
            recordedAt: "2026-08-15T12:02:00Z",
            attempt: 1,
            verification: { status: "passed", method },
            qualification: action === "load" ? qualification : undefined,
          });
        }
        yield* repository.completeRun({
          run: asRunId("run-evidence"),
          completedAt: "2026-08-15T12:03:00Z",
          outcome: decode(SynchronizationOutcomeSchema)({
            outcome: "Converged",
            run: "run-evidence",
            verified: ["resource-write", "resource-load"],
          }),
          appliedResources: [],
        });
        const firstReceipt = yield* repository.loadDeploymentReceipt(
          asRunId("run-evidence"),
        );
        const firstEvidence = yield* repository.loadRunEvidence(
          asRunId("run-evidence"),
        );

        const secondPlan = decode(SynchronizationPlanSchema)({
          follower: "follower-1",
          revision: "revision-1",
          encoded: "second-run",
          actions: [{
            id: "noop",
            resource: "resource-write",
            kind: "no-op",
            detail: { kind: "no-op" },
            before: [],
          }],
        });
        yield* start(
          repository,
          "run-noop",
          follower().id,
          revision().id,
          secondPlan,
        );
        yield* repository.journalAction({
          run: asRunId("run-noop"),
          action: asActionId("noop"),
          state: "succeeded",
          recordedAt: "2026-08-15T12:04:00Z",
          attempt: 1,
          verification: { status: "passed", method: "sha256" },
        });
        yield* repository.completeRun({
          run: asRunId("run-noop"),
          completedAt: "2026-08-15T12:05:00Z",
          outcome: decode(SynchronizationOutcomeSchema)({
            outcome: "Converged",
            run: "run-noop",
            verified: ["resource-write"],
          }),
          appliedResources: [],
        });
        const latestReceipt = yield* repository.latestDeploymentReceipt(
          follower().id,
        );
        const secondEvidence = yield* repository.loadRunEvidence(
          asRunId("run-noop"),
        );
        return { firstReceipt, firstEvidence, latestReceipt, secondEvidence };
      }),
    );

    expect(result.firstReceipt).toMatchObject({
      run: "run-evidence",
      follower: "follower-1",
      revision: "revision-1",
      outcome: "Converged",
    });
    expect(result.firstEvidence).toMatchObject({
      totalActions: 3,
      mutatingActions: 1,
      verifiedActions: 3,
      passedVerifications: 3,
      passedVerificationMethods: [
        "client-load:codex",
        "sha256",
        "sha256-and-size",
      ],
    });
    expect(result.firstEvidence?.mcpQualifications).toEqual([
      expect.objectContaining({
        target: "codex",
        ready: true,
        recipe: expect.objectContaining({
          version: "1.2.3",
          architecture: process.arch,
          entrypoint: "/opt/example/bin/example-mcp",
        }),
      }),
    ]);
    expect(result.latestReceipt?.run).toBe("run-noop");
    expect(result.secondEvidence).toMatchObject({
      totalActions: 1,
      mutatingActions: 0,
      verifiedActions: 1,
      passedVerifications: 1,
    });
  });
  it("returns safe enrollment summaries without local projection or bearer material", async () => {
    const rows = await runWithRepository(databasePath(), Effect.gen(function*() {
      const repository = yield* StateRepository;
      yield* repository.registerFollower({ follower: follower("local") });
      yield* repository.registerFollower({ follower: follower() });
      yield* repository.createEnrollmentInvitation({
        codeDigest: digestA, nonceDigest: digestB,
        intendedSourceFingerprint: decode(CertificateFingerprint)("sha256:" + "a".repeat(64)),
        tlsFingerprint: decode(CertificateFingerprint)("sha256:" + "b".repeat(64)),
        endpoint: "https://127.0.0.1:7341", groups: [],
        expiresAt: "2030-01-01T00:00:00Z",
      });
      yield* repository.revokeFollower(follower().id);
      return {
        followers: yield* repository.listEnrollmentFollowers(),
        invitations: yield* repository.listEnrollmentInvitations(),
      };
    }));
    expect(rows.followers).toEqual([{
      id: "follower-1", name: "Follower follower-1", groups: ["base"],
      enrolledAt: "2026-08-15T12:00:00Z", revoked: true,
      pending: false, credentialPresent: false,
      credentialLifecycle: { _tag: "Retiring" },
    }]);
    expect(rows.invitations).toEqual([{
      endpoint: "https://127.0.0.1:7341", groups: [],
      expiresAt: "2030-01-01T00:00:00Z", consumed: false,
    }]);
    expect(JSON.stringify(rows)).not.toMatch(/credentialReference|codeDigest|nonce|keyId/);
  });
});
