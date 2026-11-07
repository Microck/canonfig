import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteClient, SqliteMigrator } from "@canonfig/effect-sql-sqlite-node";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { FollowerId } from "../../src/domain/brand.ts";
import { canonicalJson, sha256Hex } from "../../src/profile/profile-codec.ts";
import { RepositorySqlError } from "../../src/state/state-repository.errors.ts";
import { stateRepositoryLayer } from "../../src/state/state-repository.layer.ts";
import { StateRepository } from "../../src/state/state-repository.service.ts";
import { stateMigrations } from "../../src/state/state-schema.ts";

const roots: Array<string> = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = "a".repeat(64);
const follower = Schema.decodeUnknownSync(FollowerId)("local");
const resource = "harness:codex:instructions";
const at = "2026-08-15T00:00:00Z";

const releasedDatabase = async () => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-61-migration-"));
  roots.push(root);
  const path = join(root, "state.sqlite");
  // Run the unchanged, released migrations, not a hand-built approximation.
  await Effect.runPromise(SqliteMigrator.run({
    loader: stateMigrations.pipe(Effect.map((migrations) => migrations.filter(([id]) => id <= 2))),
  }).pipe(Effect.provide(SqliteClient.layer({ filename: path }))));
  return { root, path };
};

const oldPlan = (details: ReadonlyArray<Record<string, unknown>>) => {
  const body = { revision: "old-revision", follower, requiredBlobs: [], agentTasks: [],
    actions: details.map((detail, index) => ({ id: `action-${index}`, resource,
      kind: detail.kind, detail, before: index === 0 ? [] : [`action-${index - 1}`] })) };
  const encoded = canonicalJson(Schema.decodeUnknownSync(Schema.MutableJson)(body));
  return { ...body, encoded, digest: sha256Hex(encoded) };
};
const oldWrite = { kind: "write-file", target: "/disposable/AGENTS.md", digest, executable: false, mode: 0o600 };
const insertRun = (db: DatabaseSync, id: string, status = "applying", plan = oldPlan([oldWrite]), startedAt = at) => {
  const outcome = status === "applying" ? null : JSON.stringify({ outcome: status, run: id,
    ...(status === "Converged" ? { verified: [resource] } : { completedActions: [] }) });
  db.prepare(`INSERT INTO synchronization_runs
    (id, follower_id, revision_id, status, plan_json, started_at, completed_at, outcome_json, creating_version, creating_identity, state_format)
    VALUES (?, ?, 'old-revision', ?, ?, ?, ?, ?, '6.1.0', 'released', 6)`)
    .run(id, follower, status, JSON.stringify(plan), startedAt, status === "applying" ? null : at, outcome);
  db.prepare("INSERT OR IGNORE INTO local_revisions VALUES ('old-revision', ?, ?, ?)").run(digest,
    JSON.stringify({ origin: "folder", id: "old-revision", originDigest: digest,
      resources: [{ id: resource, kind: "file", policy: "replace", target: oldWrite.target, dependsOn: [], blobs: [] }],
      desired: [{ resource, desired: { kind: "file", digest, executable: false, mode: 0o600 }, verification: { method: "digest", digest } }],
      removedResources: [], groups: [] }), at);
  for (const [index, action] of plan.actions.entries()) {
    db.prepare("INSERT INTO run_actions (run_id, action_id, plan_ordinal) VALUES (?, ?, ?)").run(id, action.id, index);
    db.prepare("INSERT INTO action_journal (run_id, action_id, sequence, state, recorded_at, attempt) VALUES (?, ?, ?, 'pending', ?, 0)")
      .run(id, action.id, index, at);
  }
};
const insertApplied = (db: DatabaseSync, kind: string | null = "file") => {
  db.prepare(`INSERT INTO applied_resources
    (follower_id, resource_id, revision_id, digest, applied_at, kind, policy, target, executable, mode)
    VALUES (?, ?, 'old-revision', ?, ?, ?, 'replace', ?, 0, 384)`)
    .run(follower, resource, digest, at, kind, oldWrite.target);
};
const open = <A, E>(path: string, effect: Effect.Effect<A, E, StateRepository>) =>
  Effect.runPromise(effect.pipe(Effect.provide(stateRepositoryLayer(path))));

describe("released 6.1 synchronization migration", () => {
  it("migrates owned surfaces in place and reopens only the newest terminal run for finalization", async () => {
    const value = await releasedDatabase();
    const db = new DatabaseSync(value.path);
    insertRun(db, "older", "Converged");
    insertRun(db, "latest", "Converged", oldPlan([oldWrite]), "2026-08-16T00:00:00Z");
    insertApplied(db);
    db.prepare("INSERT INTO harness_takeovers VALUES ('codex', 'instructions', '/disposable', 'snapshot-61', 'older', ?)").run(at);
    db.close();
    const loaded = await open(value.path, Effect.gen(function*() {
      const repository = yield* StateRepository;
      return { owned: yield* repository.loadAppliedResources(follower), takeovers: yield* repository.loadHarnessTakeovers(),
        recovery: yield* repository.loadRecovery(follower) };
    }));
    expect(loaded.owned).toMatchObject([{ ownership: "WholeFile", mode: 0o600 }]);
    expect(loaded.takeovers).toMatchObject([{ _tag: "Owned", backup: { _tag: "Snapshot", id: "snapshot-61" } }]);
    expect(loaded.recovery?.run).toMatchObject({ id: "latest", lifecycle: { _tag: "Finalizing" } });
    expect(loaded.recovery?.run.plan.actions[0]?.detail).toMatchObject({ textTransition: { kind: "whole-file" } });
    const migrated = new DatabaseSync(value.path);
    expect(migrated.prepare("SELECT phase FROM synchronization_runs WHERE id = 'older'").get()?.phase).toBe("Complete");
    expect(migrated.prepare("SELECT completed_at FROM synchronization_runs WHERE id = 'latest'").get()?.completed_at).toBeNull();
    migrated.close();
  });

  it("keeps never-started writes and installers pending instead of preserving a skipped tail", async () => {
    const value = await releasedDatabase();
    const db = new DatabaseSync(value.path);
    const plan = oldPlan([oldWrite, { kind: "install-tool", toolId: "example", method: "npm", package: "example", version: "1.0.0" }]);
    insertRun(db, "tail", "applying", plan);
    for (const [index, action] of plan.actions.entries()) db.prepare(`INSERT INTO action_journal
      (run_id, action_id, sequence, state, recorded_at, attempt) VALUES ('tail', ?, ?, 'skipped', ?, 1)`)
      .run(action.id, index + 2, at);
    db.close();
    const recovery = await open(value.path, Effect.flatMap(StateRepository, (repository) => repository.loadRecovery(follower)));
    expect(recovery?.actions.map((event) => [event.action, event.state, event.ordinal])).toEqual([
      ["action-0", "pending", 0], ["action-1", "pending", 1],
    ]);
  });

  it("classifies an interrupted pre-write takeover as a reservation with a disabled backup", async () => {
    const value = await releasedDatabase();
    const db = new DatabaseSync(value.path);
    insertRun(db, "reserved");
    db.prepare("INSERT INTO harness_takeovers VALUES ('codex', 'instructions', '/disposable', NULL, 'reserved', ?)").run(at);
    db.close();
    expect(await open(value.path, Effect.flatMap(StateRepository, (repository) => repository.loadHarnessTakeovers())))
      .toMatchObject([{ _tag: "Reserved", backup: { _tag: "Disabled" } }]);
  });

  it.each(["orphan takeover", "unclassifiable ownership"])("refuses %s with recovery steps and rolls the migration back", async (invalid) => {
    const value = await releasedDatabase();
    const evidence = join(value.root, "original-snapshot");
    writeFileSync(evidence, "original private bytes");
    const db = new DatabaseSync(value.path);
    if (invalid === "orphan takeover") db.prepare("INSERT INTO harness_takeovers VALUES ('codex', 'instructions', '/disposable', 'snapshot', 'missing-run', ?)").run(at);
    else insertApplied(db, null);
    db.close();
    const error = await Effect.runPromise(Effect.flip(
      Effect.flatMap(StateRepository, () => Effect.void).pipe(Effect.provide(stateRepositoryLayer(value.path))),
    ));
    expect(error).toBeInstanceOf(RepositorySqlError);
    expect(String(error)).toContain("Preserve state.sqlite and .backups");
    expect(readFileSync(evidence, "utf8")).toBe("original private bytes");
    const unchanged = new DatabaseSync(value.path);
    expect(unchanged.prepare("SELECT COUNT(*) AS count FROM effect_sql_migrations").get()?.count).toBe(2);
    expect(unchanged.prepare("PRAGMA table_info(synchronization_runs)").all().some((column) => column.name === "phase")).toBe(false);
    unchanged.close();
  });

  it("retains ambiguous append-local intent and refuses recovery without inventing current evidence", async () => {
    const value = await releasedDatabase();
    const db = new DatabaseSync(value.path);
    insertRun(db, "ambiguous", "applying", oldPlan([{ ...oldWrite, previousSourceDigest: digest }]));
    db.close();
    await expect(open(value.path, Effect.flatMap(StateRepository, (repository) => repository.loadRecovery(follower))))
      .rejects.toMatchObject({ _tag: "RepositoryDecodeError", message: expect.stringContaining("ambiguous append-local ownership") });
    const migrated = new DatabaseSync(value.path);
    expect(String(migrated.prepare("SELECT plan_json FROM synchronization_runs").get()?.plan_json)).toContain("previousSourceDigest");
    migrated.close();
  });
});
