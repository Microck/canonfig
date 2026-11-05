import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ContentDigest, FollowerId, ProfileId } from "../src/domain/brand.ts";
import { runtimeStateLayer } from "../src/runtime/state-layer.ts";
import { StateInitializationError } from "../src/runtime/state-initialization.errors.ts";
import { EarlierStateFormatError, EarlierStateUpgradeError } from "../src/state/state-repository.errors.ts";
import { stateRepositoryLayer } from "../src/state/state-repository.layer.ts";
import { StateRepository } from "../src/state/state-repository.service.ts";

// Real state that Canonfig 5.0.1 wrote: generate.mjs drove the 5.0.1 CLI to
// publish twice, enroll a follower, apply, set an overlay and a schedule, and
// apply again. Its homes were fixed placeholders.
const fixtures = resolve(import.meta.dirname, "fixtures", "v5.0.1-state");
const fixtureFollowerHome = "/tmp/canonfig-v501-fixture/follower-home";

const homes: Array<string> = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/**
 * A home holding one fixture as 5.0.1 left it on this machine. The follower
 * configuration records its own absolute state path, so it is moved to this
 * home; files get the modes 5.0.1 wrote, which git does not keep.
 */
const install = (fixture: "follower" | "source" | "multi-profile") => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-earlier-state-"));
  homes.push(home);
  cpSync(join(fixtures, fixture), fixture === "follower" ? home : join(home, ".canonfig"), { recursive: true });
  const state = join(home, ".canonfig", "state.sqlite");
  if (fixture === "follower") {
    const database = new DatabaseSync(state);
    database.prepare("UPDATE follower_sync_configuration SET configuration_json = replace(configuration_json, ?, ?)")
      .run(fixtureFollowerHome, home);
    database.close();
    const restoreModes = (directory: string): void => {
      chmodSync(directory, 0o700);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) restoreModes(path);
        else chmodSync(path, 0o600);
      }
    };
    for (const harness of [".claude", ".codex", ".agents"]) restoreModes(join(home, harness));
  }
  return { home, state };
};

const rows = (state: string, query: string) => {
  const database = new DatabaseSync(state, { readOnly: true });
  try {
    return database.prepare(query).all();
  } finally {
    database.close();
  }
};

const backups = (state: string): ReadonlyArray<string> =>
  readdirSync(join(state, "..")).filter((name) => name.startsWith("state-before-format-6-"));

const digest = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const withRepository = <A, E>(state: string, home: string, effect: Effect.Effect<A, E, StateRepository>) =>
  Effect.runPromise(effect.pipe(Effect.provide(stateRepositoryLayer(state, { home }))));

const canonfig = (home: string, args: ReadonlyArray<string>) =>
  spawnSync(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "../src/runtime/main.ts"), ...args, "--json"], {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      CANONFIG_LOG: "off",
    },
  });

/** Every table, index and trigger definition, to compare two schemas. */
const schemaOf = (state: string) =>
  rows(state, "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");

/** Schema and every row: what the database holds, apart from page layout. */
const contentOf = (state: string) =>
  schemaOf(state).map((entry) => ({
    ...entry,
    rows: entry["type"] === "table" ? rows(state, `SELECT * FROM "${String(entry["name"])}"`) : [],
  }));

describe("state from Canonfig 5.0.1", () => {
  it("carries a follower forward: enrollment, records, journal and schedule survive, once", async () => {
    const { home, state } = install("follower");
    const journal = rows(state, "SELECT * FROM action_journal ORDER BY id");
    const runs = rows(state, "SELECT id, status, plan_json, outcome_json FROM synchronization_runs ORDER BY started_at");
    const earlierRecords = rows(state, "SELECT resource_id, digest, kind FROM applied_resources ORDER BY resource_id");

    const status = canonfig(home, ["status"]);
    expect(status.status, status.stderr).toBe(0);
    const report = JSON.parse(status.stdout).data;
    expect(report.follower).toMatchObject({ name: "laptop", groups: ["work"], revoked: false });
    expect(report.lifecycle.selected).toEqual({ reached: true, detail: "following profile workstation" });
    expect(report.completionReceipt).toMatchObject({
      applied: { status: "verified" },
      build: { packageVersion: "5.0.1", stateFormat: 4 },
    });

    expect(rows(state, "SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")).toEqual([
      { migration_id: 1, name: "state_format_6" },
      { migration_id: 2, name: "state_upgrades" },
    ]);
    // History is kept as it was written, including runs and journal rows.
    expect(rows(state, "SELECT * FROM action_journal ORDER BY id")).toEqual(journal);
    expect(rows(state, "SELECT id, status, plan_json, outcome_json FROM synchronization_runs ORDER BY started_at")).toEqual(runs);

    const [follower] = rows(state, "SELECT id FROM followers");
    const followerId = Schema.decodeUnknownSync(FollowerId)(follower?.["id"]);
    const upgraded = await withRepository(state, home, Effect.gen(function*() {
      const repository = yield* StateRepository;
      return {
        configuration: yield* repository.getFollowerSynchronizationConfiguration(),
        records: yield* repository.loadAppliedResources(followerId),
        takeovers: yield* repository.loadHarnessTakeovers(),
        revisions: yield* repository.listRevisions(),
      };
    }));
    expect(upgraded.configuration).toMatchObject({
      profile: "workstation",
      follower: { id: followerId, name: "laptop" },
      stateLocation: state,
      scheduleOverride: { kind: "schedule", schedule: { kind: "daily", localTime: "09:00", timezone: "UTC" } },
    });
    expect(JSON.stringify(upgraded.configuration)).not.toContain("localOverlay");

    // Every authored resource record is released: no record, no takeover, and
    // its files stay where 5.0.1 wrote them.
    const authored = earlierRecords.filter((record) => ["file", "directory", "config", "skill"].includes(String(record["kind"])));
    expect(authored.map((record) => record["resource_id"])).toEqual([
      "claude-commands", "claude-instructions", "claude-settings", "codex-config", "codex-instructions", "review-skill",
    ]);
    expect(upgraded.records.map((record) => record.resource))
      .toEqual(earlierRecords.map((record) => String(record["resource_id"])).filter((id) => !authored.some((record) => record["resource_id"] === id)));
    expect(upgraded.takeovers).toEqual([]);
    // The revisions this follower applied keep their identity and list no
    // resources this release could apply.
    expect(upgraded.revisions.map((revision) => [revision.sequence, revision.resources.length]).sort()).toEqual([[1, 0], [2, 0]]);

    const [upgrade] = rows(state, "SELECT * FROM state_upgrades");
    const backup = String(upgrade?.["backup"]);
    expect(backups(state)).toEqual([backup.slice(backup.lastIndexOf("/") + 1)]);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(rows(backup, "SELECT count(*) AS count FROM effect_sql_migrations")).toEqual([{ count: 21 }]);
    expect(JSON.parse(String(upgrade?.["changes_json"]))).toEqual({
      releasedResources: expect.arrayContaining([
        { resource: "claude-commands", kind: "directory", target: "~/.claude/commands" },
        { resource: "review-skill", kind: "skill", target: "~/.agents/skills/code-review" },
      ]),
      droppedOverlays: [{ resource: "claude-settings", keys: ["theme"] }],
      revisionsWithoutResources: expect.arrayContaining(upgraded.revisions.map((revision) => revision.id)),
    });
    expect(JSON.parse(String(upgrade?.["changes_json"])).releasedResources).toHaveLength(authored.length);
    expect(JSON.parse(String(upgrade?.["earlier_history_json"]))).toHaveLength(21);
    // Released resources keep their files; the next takeover of those paths backs them up.
    expect(readFileSync(join(home, ".agents", "skills", "code-review", "SKILL.md"), "utf8")).toContain("Review the diff.");
    expect(readdirSync(join(home, ".claude", "commands"))).toContain("review.md");

    // A second run reads format 6 and changes nothing.
    const before = { database: digest(state), backups: backups(state) };
    const again = canonfig(home, ["status"]);
    expect(again.status, again.stderr).toBe(0);
    expect(rows(state, "SELECT count(*) AS count FROM state_upgrades")).toEqual([{ count: 1 }]);
    expect(backups(state)).toEqual(before.backups);
    expect(digest(state)).toBe(before.database);
  }, 120_000);

  it("carries a Source forward: identity, followers, approvals, blobs and the published sequence", async () => {
    const { home, state } = install("source");
    const followers = rows(state, "SELECT * FROM followers");
    // A file both revisions published, so both still name its blob.
    const blob = Schema.decodeUnknownSync(ContentDigest)(rows(state, `
      SELECT blob_id FROM profile_revision_blobs GROUP BY blob_id HAVING count(DISTINCT revision_id) = 2 ORDER BY blob_id
    `)[0]?.["blob_id"]);
    const fresh = join(mkdtempSync(join(tmpdir(), "canonfig-fresh-state-")), "state.sqlite");
    homes.push(join(fresh, ".."));

    const upgraded = await withRepository(state, home, Effect.gen(function*() {
      const repository = yield* StateRepository;
      const revisions = yield* repository.listRevisions();
      const latest = yield* repository.getLatestRevision(Schema.decodeUnknownSync(ProfileId)("workstation"));
      const candidates = yield* repository.listRevisionBlobCandidates(blob);
      return {
        source: yield* repository.getEnrollmentSource(),
        revisions,
        latest,
        approval: latest === undefined ? undefined : yield* repository.loadRevisionApproval(latest.id),
        candidates: [...new Set(candidates.map((candidate) => candidate.revision))],
        blob: yield* repository.readResourceBlobRange({ blob, offset: 0, maximumBytes: 1024 }),
      };
    }));
    expect(upgraded.source?.credentialNamespace).toMatch(/^[0-9a-f]{32}$/u);
    expect(upgraded.revisions.map((revision) => [revision.profileId, revision.sequence])).toEqual([
      ["workstation", 1],
      ["workstation", 2],
    ]);
    // The next publication from ~/.canonfig/ continues at sequence 3 under the
    // same profile, so followers take it as newer.
    expect(upgraded.latest?.sequence).toBe(2);
    expect(upgraded.approval).toMatchObject({ reviewer: "fixture" });
    expect(upgraded.candidates).toEqual(upgraded.revisions.map((revision) => revision.id));
    expect(upgraded.blob?.byteLength).toBeGreaterThan(0);
    expect(rows(state, "SELECT * FROM followers")).toEqual(followers);
    expect(readFileSync(join(home, ".canonfig", "secrets.json"), "utf8")).toContain("docs-token");

    // The upgraded schema is exactly the one a new database gets.
    await withRepository(fresh, home, Effect.flatMap(StateRepository, () => Effect.void));
    expect(schemaOf(state)).toEqual(schemaOf(fresh));
  });

  it("refuses a Source that published two profiles, names them, and changes nothing", async () => {
    const { state } = install("multi-profile");
    const before = contentOf(state);

    const failure = await Effect.runPromise(Effect.flip(
      Effect.flatMap(StateRepository, () => Effect.void).pipe(Effect.provide(runtimeStateLayer(state))),
    ));
    expect(failure).toBeInstanceOf(StateInitializationError);
    expect(failure.message).toContain("published profiles laptop, workstation");
    expect(failure.message).toContain("https://github.com/Microck/canonfig/issues/254");
    expect(failure.message).toContain("Keep this Source on Canonfig 5.0.1");
    expect(failure.message).not.toContain("reinitialize");
    expect(contentOf(state)).toEqual(before);
    expect(backups(state)).toEqual([]);
  });

  it("refuses an unfinished run on every open and upgrades once it is finished", async () => {
    const { home, state } = install("follower");
    const database = new DatabaseSync(state);
    database.prepare(`
      INSERT INTO synchronization_runs (id, follower_id, revision_id, status, plan_json, started_at)
      SELECT 'run-unfinished', follower_id, revision_id, 'Interrupted', '{}', '2026-11-05T00:00:00.000Z'
      FROM synchronization_runs LIMIT 1
    `).run();
    database.close();
    const before = contentOf(state);
    const open = () => Effect.runPromise(Effect.flip(
      Effect.flatMap(StateRepository, () => Effect.void).pipe(Effect.provide(stateRepositoryLayer(state, { home }))),
    ));

    for (const attempt of [1, 2]) {
      const refused = await open();
      expect(refused, `attempt ${attempt}`).toBeInstanceOf(EarlierStateUpgradeError);
      expect(refused).toMatchObject({ item: "synchronization run run-unfinished (Interrupted)" });
      expect(contentOf(state)).toEqual(before);
      expect(backups(state)).toEqual([]);
    }

    const finishing = new DatabaseSync(state);
    finishing.prepare("UPDATE synchronization_runs SET status = 'Failed', completed_at = started_at WHERE id = 'run-unfinished'").run();
    finishing.close();
    await withRepository(state, home, Effect.flatMap(StateRepository, () => Effect.void));
    expect(rows(state, "SELECT count(*) AS count FROM effect_sql_migrations")).toEqual([{ count: 2 }]);
    expect(backups(state)).toHaveLength(1);
  });

  it("checks what another writer committed while the upgrade waited for the write lock", async () => {
    const { home, state } = install("follower");
    // WAL, as a running 5.0.1 leaves it: readers never wait for that writer.
    const wal = new DatabaseSync(state);
    wal.exec("PRAGMA journal_mode = WAL");
    wal.close();
    // A 5.0.1 process that holds the write lock, starts a run, and commits
    // one second later. The upgrade opens while that write is pending. The
    // delay is real on purpose: SQLite's lock lives across processes, and
    // the upgrade's synchronous busy wait (5 s) must see the commit land.
    const writer = spawn(process.execPath, ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.env.STATE);
      db.exec("BEGIN IMMEDIATE");
      db.prepare(\`
        INSERT INTO synchronization_runs (id, follower_id, revision_id, status, plan_json, started_at)
        SELECT 'run-concurrent', follower_id, revision_id, 'applying', '{}', '2026-11-05T00:00:00.000Z'
        FROM synchronization_runs LIMIT 1
      \`).run();
      process.stdout.write("locked\\n");
      setTimeout(() => { db.exec("COMMIT"); db.close(); }, 1000);
    `], { env: { ...process.env, STATE: state }, stdio: ["ignore", "pipe", "inherit"] });
    const exited = once(writer, "exit");
    await once(writer.stdout, "data");

    const refused = await Effect.runPromise(Effect.flip(
      Effect.flatMap(StateRepository, () => Effect.void).pipe(Effect.provide(stateRepositoryLayer(state, { home }))),
    ));
    await exited;
    // Planned before the lock, the upgrade would have missed the run and
    // carried it forward; checked under the lock, it is refused.
    expect(refused).toBeInstanceOf(EarlierStateUpgradeError);
    expect(refused).toMatchObject({ item: "synchronization run run-concurrent (applying)" });
    expect(rows(state, "SELECT count(*) AS count FROM effect_sql_migrations")).toEqual([{ count: 21 }]);
    expect(backups(state)).toEqual([]);
  }, 30_000);

  it("asks state from before 4.0.0 to pass through 5.0.1 and refuses a history it does not know", async () => {
    const histories = [
      { migrations: ["state_repository", "enrollment"], origin: "before-state-format-4", message: "Canonfig 5.0.1" },
      { migrations: ["state_repository", "local_projection"], origin: "unrecognized", message: "does not know" },
    ] as const;
    for (const history of histories) {
      const home = mkdtempSync(join(tmpdir(), "canonfig-earlier-history-"));
      homes.push(home);
      const state = join(home, "state.sqlite");
      const database = new DatabaseSync(state);
      database.exec(`CREATE TABLE effect_sql_migrations (
        migration_id integer PRIMARY KEY NOT NULL,
        created_at datetime NOT NULL DEFAULT current_timestamp,
        name VARCHAR(255) NOT NULL
      )`);
      history.migrations.forEach((name, index) =>
        database.prepare("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)").run(index + 1, name)
      );
      database.close();

      const refused = await Effect.runPromise(Effect.flip(
        Effect.flatMap(StateRepository, () => Effect.void).pipe(Effect.provide(stateRepositoryLayer(state, { home }))),
      ));
      expect(refused).toBeInstanceOf(EarlierStateFormatError);
      expect(refused).toMatchObject({ origin: history.origin });
      const runtime = await Effect.runPromise(Effect.flip(
        Effect.flatMap(StateRepository, () => Effect.void).pipe(Effect.provide(runtimeStateLayer(state))),
      ));
      expect(runtime.message).toContain(history.message);
    }
  });
});
