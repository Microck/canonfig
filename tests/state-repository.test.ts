import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  ActionId,
  CredentialReference,
  ContentDigest,
  ProfileId,
  ResourceId,
  RunId,
  type FollowerId,
  type ProfileRevisionId,
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
  ActiveRunExistsError,
  RepositoryDecodeError,
  RepositorySqlError,
  RevisionImmutableError,
} from "../src/state/state-repository.errors.ts";
import { stateRepositoryLayer } from "../src/state/state-repository.layer.ts";
import { StateRepository } from "../src/state/state-repository.service.ts";
import {
  defaultScheduledInvocation,
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
          follower: configuredFollower,
          selectedProfile: decode(ProfileId)("profile-1"),
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
      selectedProfile: "profile-1",
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
    }]);
  });
});
