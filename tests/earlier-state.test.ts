import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Layer, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ContentDigest, FollowerId, ProfileId, SourceSignature } from "../src/domain/brand.ts";
import { TransportResourceNotFoundError } from "../src/enrollment/enrollment.errors.ts";
import { EnrollmentLive } from "../src/enrollment/enrollment.layer.ts";
import { Enrollment } from "../src/enrollment/enrollment.service.ts";
import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { profileCatalogLayer } from "../src/profile/profile-catalog.layer.ts";
import { ProfileCatalog } from "../src/profile/profile-catalog.service.ts";
import type { ProfileRevisionSigner } from "../src/profile/publication.ts";
import { adapterFor } from "../src/projection/adapters/index.ts";
import { synchronizeLocal } from "../src/projection/sync.ts";
import { readSnapshot, snapshotCopy } from "../src/projection/takeover.ts";
import { runtimeStateLayer } from "../src/runtime/state-layer.ts";
import { StateInitializationError } from "../src/runtime/state-initialization.errors.ts";
import { EarlierStateFormatError, EarlierStateUpgradeError } from "../src/state/state-repository.errors.ts";
import { stateRepositoryLayer } from "../src/state/state-repository.layer.ts";
import { StateRepository } from "../src/state/state-repository.service.ts";
import { SynchronizationLive } from "../src/synchronization/synchronization.layer.ts";

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

const withRepository = <A, E>(state: string, effect: Effect.Effect<A, E, StateRepository>) =>
  Effect.runPromise(effect.pipe(Effect.provide(stateRepositoryLayer(state))));

const write = (path: string, content: string, mode?: number) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
};

/** A real machine layer for a fixture home: its HOME and PATH, credentials in a local file. */
const machineOf = (home: string, environment: Readonly<Record<string, string>>) =>
  linuxMachineStateLayer({
    environment: Object.entries(environment).map(([name, value]) => ({ name, value })),
    credentialPolicy: { kind: "local-file", path: join(home, "credentials") },
  });

/** Publish `folder` into `state` with a real Ed25519 key, as `canonfig source publish` does. */
const publishFolder = (state: string, folder: string) => {
  const keys = generateKeyPairSync("ed25519");
  const signer: ProfileRevisionSigner = {
    keyId: "upgraded-source-key",
    sign: (payload) => Effect.sync(() => Schema.decodeUnknownSync(SourceSignature)(
      `ed25519:${sign(null, Buffer.from(payload), keys.privateKey).toString("base64url")}`,
    )),
    verify: () => Effect.succeed(true),
  };
  return Effect.runPromise(Effect.flatMap(ProfileCatalog, (catalog) =>
    catalog.publish({ folder, reviewer: "reviewer@example.test", publishedAt: "2026-11-05T12:00:00Z" })
  ).pipe(Effect.provide(profileCatalogLayer(signer)), Effect.provide(stateRepositoryLayer(state))));
};

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
    // The fixture applied no tool or credential. Records of both, as 5.0.1
    // stores them, must come through unchanged, installer recipe and mode
    // included.
    const provenance = {
      schema: "canonfig.recipe-provenance/v1",
      upstream: "https://registry.npmjs.org/@biomejs/biome",
      version: "1.9.4",
      platform: "linux",
      architecture: "x64",
      artifactDigest: `sha512-${"c".repeat(86)}`,
      entrypoint: "biome",
      dependencyPolicy: "lockfile",
      executionContext: "user",
      method: "npm",
      package: "@biomejs/biome",
      compatibility: "linux-x64",
      target: "~/.local/bin/biome",
      fingerprint: "d".repeat(64),
    };
    const seeding = new DatabaseSync(state);
    const seed = seeding.prepare(`
      INSERT INTO applied_resources (follower_id, resource_id, revision_id, digest, applied_at, kind, policy, target, mode, installer_recipe_json)
      SELECT follower_id, ?, revision_id, ?, applied_at, ?, ?, ?, ?, ? FROM applied_resources ORDER BY resource_id LIMIT 1
    `);
    seed.run("biome", "a".repeat(64), "tool", "ensure", "biome", 0o755, JSON.stringify(provenance));
    seed.run("docs-token", "b".repeat(64), "credential", "require-local", "DOCS_MCP_TOKEN", null, null);
    seeding.close();
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
    const upgraded = await withRepository(state, Effect.gen(function*() {
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
    const revision = upgraded.records[0]?.revision;
    expect([...upgraded.records].sort((left, right) => left.resource.localeCompare(right.resource))).toEqual([
      { resource: "biome", revision, digest: "a".repeat(64), appliedAt: expect.any(String), kind: "tool", policy: "ensure", target: "biome", mode: 0o755, installerRecipe: provenance },
      { resource: "docs-token", revision, digest: "b".repeat(64), appliedAt: expect.any(String), kind: "credential", policy: "require-local", target: "DOCS_MCP_TOKEN" },
    ]);
    expect(upgraded.takeovers).toEqual([]);
    // The revisions this follower applied keep their identity and list no
    // resources this release could apply.
    expect(upgraded.revisions.map((revision) => [revision.sequence, revision.resources.length]).sort()).toEqual([[1, 0], [2, 0]]);

    const [upgrade] = rows(state, "SELECT * FROM state_upgrades");
    const backup = String(upgrade?.["backup"]);
    expect(backups(state)).toEqual([basename(backup)]);
    // Windows does not keep POSIX permission bits.
    if (process.platform !== "win32") expect(statSync(backup).mode & 0o777).toBe(0o600);
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

    // A 5.0.1 process still running after the upgrade cannot write its own
    // configuration shape, which this release could no longer read.
    const earlierWriter = new DatabaseSync(state);
    try {
      expect(() => earlierWriter.prepare(`
        UPDATE follower_sync_configuration
        SET configuration_json = json_set(json_remove(configuration_json, '$.profile'), '$.selectedProfile', 'workstation')
      `).run()).toThrow(/configuration_names_profile/u);
    } finally {
      earlierWriter.close();
    }
    expect(digest(state)).toBe(before.database);
  }, 120_000);

  it("takes over the paths it released on the first current sync, snapshot first", async () => {
    const { home, state } = install("follower");
    await withRepository(state, Effect.flatMap(StateRepository, () => Effect.void));
    const released = {
      codex: readFileSync(join(home, ".codex", "AGENTS.md"), "utf8"),
      claude: readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8"),
    };
    // The folder the current release projects, holding what this follower
    // would mirror from a Source that now publishes from `~/.canonfig/`.
    const folder = join(home, ".canonfig");
    write(join(folder, "canonfig.jsonc"), JSON.stringify({ version: 1, harnesses: ["claude-code", "codex"] }));
    write(join(folder, "AGENTS.md"), "Current instructions.\n");
    const bin = join(home, "bin");
    for (const harness of ["claude-code", "codex"] as const) {
      write(join(bin, adapterFor(harness).descriptor.executables[0]!), "#!/bin/sh\nexit 0\n", 0o755);
    }
    const environment = { HOME: home, PATH: bin, XDG_CACHE_HOME: join(home, ".cache") };
    const variables = new Map(Object.entries(environment));

    const applied = await Effect.runPromise(
      synchronizeLocal(state, "apply", { noBackup: false, environment: (name) => variables.get(name) }).pipe(
        Effect.provide(SynchronizationLive.pipe(
          Layer.provideMerge(stateRepositoryLayer(state)),
          Layer.provideMerge(machineOf(home, environment)),
        )),
      ),
    );
    expect(applied.outcome).toMatchObject({ outcome: "Converged" });
    expect(applied.takeovers.map((entry) => `${entry.harness} ${entry.backup}`).sort()).toMatchInlineSnapshot(`
      [
        "claude-code takeover snapshot",
        "codex takeover snapshot",
      ]
    `);
    expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8")).toContain("Current instructions.");
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toContain("Current instructions.");

    // The takeover snapshot holds the bytes 5.0.1 wrote there.
    const snapshot = await Effect.runPromise(readSnapshot(join(folder, ".backups"), undefined));
    const copied = (target: string) => {
      const entry = snapshot.manifest.entries.find((candidate) => candidate.target === target);
      return entry !== undefined && "copy" in entry ? readFileSync(snapshotCopy(snapshot, entry.copy), "utf8") : undefined;
    };
    expect(copied(join(home, ".codex", "AGENTS.md"))).toBe(released.codex);
    expect(copied(join(home, ".claude", "CLAUDE.md"))).toBe(released.claude);
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

    const upgraded = await withRepository(state, Effect.gen(function*() {
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
    expect(upgraded.latest?.sequence).toBe(2);
    expect(upgraded.approval).toMatchObject({ reviewer: "fixture" });
    expect(upgraded.candidates).toEqual(upgraded.revisions.map((revision) => revision.id));
    expect(upgraded.blob?.byteLength).toBeGreaterThan(0);
    expect(rows(state, "SELECT * FROM followers")).toEqual(followers);
    expect(readFileSync(join(home, ".canonfig", "secrets.json"), "utf8")).toContain("docs-token");

    // The upgraded schema is exactly the one a new database gets.
    await withRepository(fresh, Effect.flatMap(StateRepository, () => Effect.void));
    expect(schemaOf(state)).toEqual(schemaOf(fresh));

    // The next publication from ~/.canonfig/ continues the sequence under the
    // same profile, so followers take it as newer.
    const folder = join(home, ".canonfig");
    write(join(folder, "canonfig.jsonc"), JSON.stringify({ version: 1, profile: { id: "workstation", name: "Workstation" }, harnesses: ["codex"] }));
    write(join(folder, "AGENTS.md"), "Current instructions.\n");
    const published = await publishFolder(state, folder);
    expect([published.profileId, published.sequence]).toEqual(["workstation", 3]);
  });

  it("never serves a carried-over revision and serves the first publication after the upgrade", async () => {
    const { home, state } = install("source");
    const carried = rows(state, "SELECT id FROM profile_revisions ORDER BY sequence").map((row) => String(row["id"]));
    expect(carried).toHaveLength(2);
    // 5.0.1 kept the follower's credential in a secret store the fixture
    // does not copy; give the enrolled follower one this test knows.
    const credential = "earlier-state-follower-credential-0123456789";
    const enrolled = new DatabaseSync(state);
    enrolled.prepare("UPDATE follower_credentials SET credential_digest = ?")
      .run(createHash("sha256").update(credential).digest("hex"));
    enrolled.close();
    const source = EnrollmentLive.pipe(
      Layer.provideMerge(stateRepositoryLayer(state)),
      Layer.provideMerge(machineOf(home, { HOME: home, PATH: join(home, "bin") })),
    );
    const serve = <A, E>(effect: Effect.Effect<A, E, Enrollment>) => Effect.runPromise(effect.pipe(Effect.provide(source)));

    // Their signed bytes name 5.0.1 resources this release does not apply,
    // so a follower is offered nothing until the Source publishes.
    expect(await serve(Effect.flatMap(Enrollment, (enrollment) => enrollment.listAuthorizedRevisions(credential))))
      .toEqual({ revisions: [] });
    for (const id of carried) {
      const refused = await serve(Effect.flip(Effect.flatMap(Enrollment, (enrollment) => enrollment.getAuthorizedRevision(credential, id))));
      expect(refused, id).toBeInstanceOf(TransportResourceNotFoundError);
    }

    const folder = join(home, ".canonfig");
    write(join(folder, "canonfig.jsonc"), JSON.stringify({ version: 1, profile: { id: "workstation", name: "Workstation" }, harnesses: ["codex"] }));
    write(join(folder, "AGENTS.md"), "Current instructions.\n");
    const published = await publishFolder(state, folder);
    const listed = await serve(Effect.flatMap(Enrollment, (enrollment) => enrollment.listAuthorizedRevisions(credential)));
    expect(listed.revisions.map((revision) => [revision.id, revision.sequence])).toEqual([[published.id, 3]]);
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
    const { state } = install("follower");
    const database = new DatabaseSync(state);
    database.prepare(`
      INSERT INTO synchronization_runs (id, follower_id, revision_id, status, plan_json, started_at)
      SELECT 'run-unfinished', follower_id, revision_id, 'Interrupted', '{}', '2026-11-05T00:00:00.000Z'
      FROM synchronization_runs LIMIT 1
    `).run();
    database.close();
    const before = contentOf(state);
    const open = () => Effect.runPromise(Effect.flip(
      Effect.flatMap(StateRepository, () => Effect.void).pipe(Effect.provide(stateRepositoryLayer(state))),
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
    await withRepository(state, Effect.flatMap(StateRepository, () => Effect.void));
    expect(rows(state, "SELECT count(*) AS count FROM effect_sql_migrations")).toEqual([{ count: 2 }]);
    expect(backups(state)).toHaveLength(1);
  });

  it("checks what another writer committed while the upgrade waited for the write lock", async () => {
    const { state } = install("follower");
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
      Effect.flatMap(StateRepository, () => Effect.void).pipe(Effect.provide(stateRepositoryLayer(state))),
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
        Effect.flatMap(StateRepository, () => Effect.void).pipe(Effect.provide(stateRepositoryLayer(state))),
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
