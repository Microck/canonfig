import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { canonicalJson } from "../profile/profile-codec.ts";
import { AppliedResourceRecordSchema } from "../domain/synchronization.ts";
import { SqliteMigrator } from "@canonfig/effect-sql-sqlite-node";
import { SqlClient } from "effect/unstable/sql";
import { RepositoryDecodeError } from "./state-repository.errors.ts";
const isJsonObject: (value: Schema.MutableJson | undefined) => value is Schema.MutableJsonObject =
  Schema.is(Schema.Record(Schema.String, Schema.MutableJson));
const isString = Schema.is(Schema.String);

/** Released rows are classified from stored evidence, never current target bytes. */
const upgradeAppliedRecord = (value: Schema.Schema.Type<typeof Schema.MutableJson>) => {
  const record = Schema.decodeUnknownSync(Schema.MutableJson)(value);
  const invalid = (message: string) => new RepositoryDecodeError({
    entity: "6.1 ownership migration", id: isJsonObject(record) && isString(record.resource) ? record.resource : "unknown",
    message: `${message}. Preserve state.sqlite and .backups, restore the affected targets from the retained snapshots manually, then move state.sqlite aside and set the machine up again. No managed target was changed by this upgrade.`,
  });
  if (!isJsonObject(record)) return Effect.fail(invalid("Stored ownership is not an object"));
  for (const [key, field] of Object.entries(record)) if (field === null) delete record[key];
  switch (record.kind) {
    case "file":
      if (isString(record.symlinkTo)) {
        record.ownership = "Symlink";
        delete record.executable;
        delete record.mode;
      } else record.ownership = record.policy === "append-local" ? "SourceSection" : "WholeFile";
      break;
    case "directory":
    case "skill": record.ownership = "DirectoryEntries"; break;
    case "config": record.ownership = "ConfigKeys"; break;
    case "tool": record.ownership = "QualifiedTool"; break;
  }
  return Schema.decodeUnknownEffect(AppliedResourceRecordSchema)(record).pipe(
    Effect.mapError((error) => invalid(`Stored ownership cannot be classified safely: ${String(error)}`)));
};

/**
 * The migrations of the state database, in order.
 *
 * State format 6 started a new schema history: this release cannot read a
 * database an earlier release created, so it carries no upgrade path for one.
 * The repository refuses any database whose migration history is not a
 * prefix of this list, and the operator reinitializes the machine instead.
 */
export const stateSchemaMigrations = [
  { id: 1, name: "state_format_6" },
  { id: 2, name: "archive_events" },
  { id: 3, name: "synchronization_lifecycle" },
  { id: 4, name: "enrollment_lifecycle" },
] as const;

/**
 * Explicit, append-only migration set, tracked by Effect SQL. A later change
 * to the schema adds a migration after the last one, and to the list above.
 */
export const stateMigrations = SqliteMigrator.fromRecord({
  "0001_state_format_6": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`PRAGMA foreign_keys = ON`;

    yield* sql`
      CREATE TABLE source_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        key_id TEXT NOT NULL,
        public_key_fingerprint TEXT NOT NULL
      )
    `;

    yield* sql`
      CREATE TABLE followers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        groups_json TEXT NOT NULL,
        revoked INTEGER NOT NULL CHECK (revoked IN (0, 1)),
        credential_reference TEXT NOT NULL,
        enrolled_at TEXT NOT NULL
      )
    `;

    yield* sql`
      CREATE TABLE profile_revisions (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        canonical_bytes TEXT NOT NULL,
        digest TEXT NOT NULL,
        signature TEXT NOT NULL,
        published_at TEXT NOT NULL,
        revision_json TEXT NOT NULL,
        UNIQUE (profile_id, sequence)
      )
    `;

    yield* sql`
      CREATE TRIGGER profile_revisions_immutable_update
      BEFORE UPDATE ON profile_revisions
      BEGIN
        SELECT RAISE(ABORT, 'profile revisions are immutable');
      END
    `;

    yield* sql`
      CREATE TRIGGER profile_revisions_immutable_delete
      BEFORE DELETE ON profile_revisions
      BEGIN
        SELECT RAISE(ABORT, 'profile revisions are immutable');
      END
    `;

    yield* sql`
      CREATE TABLE run_actions (
        run_id TEXT NOT NULL REFERENCES synchronization_runs(id) ON DELETE RESTRICT,
        action_id TEXT NOT NULL,
        plan_ordinal INTEGER NOT NULL,
        PRIMARY KEY (run_id, action_id),
        UNIQUE (run_id, plan_ordinal)
      )
    `;

    yield* sql`
      CREATE TABLE action_journal (
        id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('pending', 'running', 'succeeded', 'failed', 'skipped')
        ),
        recorded_at TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt >= 0),
        verification_json TEXT,
        rollback_reference TEXT,
        removed_resource_json TEXT,
        FOREIGN KEY (run_id, action_id)
          REFERENCES run_actions(run_id, action_id),
        UNIQUE (run_id, sequence)
      )
    `;

    yield* sql`
      CREATE TABLE drift_records (
        id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES synchronization_runs(id),
        sequence INTEGER NOT NULL,
        conflict_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE (run_id, sequence)
      )
    `;

    yield* sql`
      CREATE TABLE enrollment_source (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        signing_key_reference TEXT NOT NULL,
        tls_key_reference TEXT NOT NULL,
        tls_certificate_reference TEXT NOT NULL,
        tls_fingerprint TEXT NOT NULL,
        credential_namespace TEXT
      )
    `;

    yield* sql`
      CREATE TABLE enrollment_invitations (
        code_digest TEXT PRIMARY KEY,
        nonce_digest TEXT NOT NULL UNIQUE,
        intended_source_fingerprint TEXT NOT NULL,
        tls_fingerprint TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        groups_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      )
    `;

    yield* sql`
      CREATE TABLE follower_credentials (
        follower_id TEXT PRIMARY KEY REFERENCES followers(id) ON DELETE RESTRICT,
        credential_digest TEXT NOT NULL UNIQUE,
        credential_reference TEXT NOT NULL UNIQUE
      )
    `;

    yield* sql`
      CREATE TABLE follower_sync_configuration (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        follower_id TEXT NOT NULL REFERENCES followers(id) ON DELETE RESTRICT,
        configuration_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;

    yield* sql`
      CREATE TABLE pending_enrollments (
        follower_id TEXT PRIMARY KEY,
        code_digest TEXT NOT NULL UNIQUE,
        credential_digest TEXT NOT NULL UNIQUE,
        credential_reference TEXT NOT NULL UNIQUE,
        follower_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `;

    yield* sql`
      CREATE TABLE profile_revision_blobs (
        blob_id TEXT NOT NULL,
        revision_id TEXT NOT NULL REFERENCES profile_revisions(id) ON DELETE CASCADE,
        resource_id TEXT NOT NULL,
        PRIMARY KEY (blob_id, revision_id, resource_id)
      )
    `;

    yield* sql`
      CREATE INDEX profile_revision_blobs_by_blob
      ON profile_revision_blobs(blob_id, revision_id, resource_id)
    `;

    yield* sql`
      CREATE TABLE deployment_receipts (
        run_id TEXT PRIMARY KEY REFERENCES synchronization_runs(id),
        follower_id TEXT NOT NULL,
        package_version TEXT NOT NULL,
        build_identity TEXT NOT NULL,
        state_format INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      )
    `;

    yield* sql`
      CREATE TABLE revision_approvals (
        revision_id TEXT PRIMARY KEY REFERENCES profile_revisions(id),
        proposal_digest TEXT NOT NULL,
        revision_digest TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        reviewed_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      )
    `;

    yield* sql`
      CREATE TABLE mcp_qualification_receipts (
        run_id TEXT NOT NULL REFERENCES synchronization_runs(id),
        action_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        receipt_json TEXT NOT NULL,
        PRIMARY KEY (run_id, action_id, attempt)
      )
    `;

    yield* sql`
      CREATE TABLE resource_blob_manifests (
        id TEXT PRIMARY KEY,
        total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
        chunk_bytes INTEGER NOT NULL CHECK (chunk_bytes > 0)
      )
    `;

    yield* sql`
      CREATE TABLE resource_blob_chunks (
        blob_id TEXT NOT NULL REFERENCES resource_blob_manifests(id),
        chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
        content BLOB NOT NULL,
        PRIMARY KEY (blob_id, chunk_index)
      )
    `;

    yield* sql`
      CREATE TABLE synchronization_runs (
        id TEXT PRIMARY KEY,
        follower_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN (
            'applying',
            'Converged',
            'HumanActionRequired',
            'FollowerDrift',
            'Failed',
            'Interrupted'
          )
        ),
        plan_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        outcome_json TEXT,
        creating_version TEXT NOT NULL,
        creating_identity TEXT NOT NULL,
        state_format INTEGER NOT NULL
      )
    `;

    yield* sql`
      CREATE UNIQUE INDEX one_active_applying_run_per_follower
      ON synchronization_runs(follower_id)
      WHERE status = 'applying'
    `;

    yield* sql`
      CREATE INDEX recoverable_runs_by_follower
      ON synchronization_runs(follower_id, status)
      WHERE status IN ('applying', 'Interrupted')
    `;

    yield* sql`
      CREATE TRIGGER block_run_while_recoverable
      BEFORE INSERT ON synchronization_runs
      WHEN EXISTS (
        SELECT 1
        FROM synchronization_runs
        WHERE follower_id = NEW.follower_id
          AND status IN ('applying', 'Interrupted')
      )
      BEGIN
        SELECT RAISE(ABORT, 'recoverable synchronization run exists');
      END
    `;

    yield* sql`
      CREATE TABLE applied_resources (
        follower_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        owned_files_json TEXT,
        kind TEXT,
        policy TEXT,
        target TEXT,
        owned_keys_json TEXT,
        config_format TEXT,
        executable INTEGER,
        symlink_target TEXT,
        mode INTEGER,
        installer_recipe_json TEXT,
        PRIMARY KEY (follower_id, resource_id)
      )
    `;

    yield* sql`
      CREATE TABLE local_revisions (
        id TEXT PRIMARY KEY,
        origin_digest TEXT NOT NULL,
        revision_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      )
    `;

    yield* sql`
      CREATE TRIGGER local_revisions_immutable_update
      BEFORE UPDATE ON local_revisions
      BEGIN
        SELECT RAISE(ABORT, 'local revisions are immutable');
      END
    `;

    yield* sql`
      CREATE TABLE harness_takeovers (
        harness TEXT NOT NULL,
        surface TEXT NOT NULL,
        root TEXT NOT NULL,
        snapshot TEXT,
        run_id TEXT NOT NULL,
        taken_over_at TEXT NOT NULL,
        PRIMARY KEY (harness, surface)
      )
    `;
  }),
  // `canonfig export` and `canonfig import`, apart from synchronization_runs:
  // an export changes nothing Canonfig manages, and a row there would become
  // the last sync outcome `status` reports. Append-only, like an audit log.
  "0002_archive_events": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE archive_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        command TEXT NOT NULL CHECK (command IN ('export', 'import')),
        outcome TEXT NOT NULL CHECK (
          outcome IN (
            'Exported',
            'Error',
            'Converged',
            'HumanActionRequired',
            'FollowerDrift',
            'Failed',
            'Interrupted'
          )
        ),
        archive TEXT NOT NULL,
        sha256 TEXT,
        signer TEXT
      )
    `;

    yield* sql`
      CREATE TRIGGER archive_events_immutable_update
      BEFORE UPDATE ON archive_events
      BEGIN
        SELECT RAISE(ABORT, 'archive events are append-only');
      END
    `;

    yield* sql`
      CREATE TRIGGER archive_events_immutable_delete
      BEFORE DELETE ON archive_events
      BEGIN
        SELECT RAISE(ABORT, 'archive events are append-only');
      END
    `;
  }),
  "0003_synchronization_lifecycle": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TRIGGER block_run_while_recoverable`;
    yield* sql`DROP INDEX one_active_applying_run_per_follower`;
    yield* sql`DROP INDEX recoverable_runs_by_follower`;
    yield* sql`ALTER TABLE synchronization_runs ADD COLUMN phase TEXT NOT NULL DEFAULT 'Complete'
      CHECK (phase IN ('Preparing', 'Applying', 'Interrupted', 'Finalizing', 'Abandoning', 'Complete'))`;
    // Only the newest terminal run can still need its post-execution effects.
    // Earlier runs must never replay ownership release over a later takeover.
    yield* sql`UPDATE synchronization_runs SET phase = CASE
      WHEN status = 'applying' THEN 'Applying'
      WHEN status = 'Interrupted' THEN 'Interrupted'
      WHEN id = (SELECT recent.id FROM synchronization_runs recent
        WHERE recent.follower_id = synchronization_runs.follower_id
        ORDER BY recent.started_at DESC, recent.rowid DESC LIMIT 1) THEN 'Finalizing'
      ELSE 'Complete' END`;
    yield* sql`DELETE FROM deployment_receipts WHERE run_id IN
      (SELECT id FROM synchronization_runs WHERE phase != 'Complete')`;
    yield* sql`UPDATE synchronization_runs SET completed_at = NULL WHERE phase != 'Complete'`;
    yield* sql`ALTER TABLE synchronization_runs DROP COLUMN status`;
    yield* sql`CREATE UNIQUE INDEX one_open_run_per_follower ON synchronization_runs(follower_id)
      WHERE phase != 'Complete'`;
    yield* sql`CREATE INDEX recoverable_runs_by_follower ON synchronization_runs(follower_id, phase)
      WHERE phase != 'Complete'`;
    yield* sql`ALTER TABLE harness_takeovers ADD COLUMN phase TEXT NOT NULL DEFAULT 'Reserved'
      CHECK (phase IN ('Reserved', 'Owned', 'Uncertain'))`;
    yield* sql`UPDATE harness_takeovers SET phase = CASE
      WHEN EXISTS (SELECT 1 FROM applied_resources a
        WHERE a.resource_id = 'harness:' || harness_takeovers.harness || ':' ||
          CASE WHEN instr(harness_takeovers.surface, '#') > 0
            THEN substr(harness_takeovers.surface, 1, instr(harness_takeovers.surface, '#') - 1)
            ELSE harness_takeovers.surface END
          AND (SELECT COUNT(*) FROM applied_resources b WHERE b.resource_id = a.resource_id) = 1
          AND (instr(harness_takeovers.surface, '#') = 0 OR EXISTS (
            SELECT 1 FROM json_each(a.owned_keys_json) key
            WHERE key.value = substr(harness_takeovers.surface, instr(harness_takeovers.surface, '#') + 1)))) THEN 'Owned'
      WHEN EXISTS (SELECT 1 FROM synchronization_runs r WHERE r.id = harness_takeovers.run_id AND r.phase IN ('Applying', 'Interrupted')) THEN 'Reserved'
      ELSE 'Uncertain' END`;
    const orphaned = yield* sql`SELECT harness, surface FROM harness_takeovers t
      WHERE NOT EXISTS (SELECT 1 FROM synchronization_runs r WHERE r.id = t.run_id)
        OR t.phase = 'Uncertain' AND NOT EXISTS (
          SELECT 1 FROM synchronization_runs r WHERE r.id = t.run_id AND r.phase = 'Finalizing'
            AND json_extract(r.outcome_json, '$.outcome') = 'Failed' AND json_extract(r.outcome_json, '$.rollbackIncomplete') = 1)`;
    const orphan = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ harness: Schema.String, surface: Schema.String })))(orphaned)[0];
    if (orphan !== undefined) return yield* new RepositoryDecodeError({
      entity: "6.1 takeover migration", id: `${orphan.harness}:${orphan.surface}`,
      message: "This takeover has no safe ownership or recoverable run evidence. Preserve state.sqlite and .backups, recover the original target from its takeover snapshot manually, then move state.sqlite aside and set the machine up again. No managed target was changed by this upgrade.",
    });
    yield* sql`CREATE TABLE harness_takeovers_v3 (
      harness TEXT NOT NULL, surface TEXT NOT NULL, root TEXT NOT NULL, snapshot TEXT,
      run_id TEXT NOT NULL REFERENCES synchronization_runs(id), taken_over_at TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('Reserved', 'Owned', 'Uncertain')),
      backup_mode TEXT NOT NULL CHECK (backup_mode IN ('Disabled', 'Snapshot', 'Pending')),
      CHECK ((backup_mode = 'Snapshot' AND snapshot IS NOT NULL)
        OR (backup_mode IN ('Disabled', 'Pending') AND snapshot IS NULL)),
      CHECK (backup_mode != 'Pending' OR phase = 'Reserved'),
      PRIMARY KEY (harness, surface))`;
    yield* sql`INSERT INTO harness_takeovers_v3
      SELECT harness, surface, root, snapshot, run_id, taken_over_at, phase,
        CASE WHEN snapshot IS NULL THEN 'Disabled' ELSE 'Snapshot' END FROM harness_takeovers`;
    yield* sql`DROP TABLE harness_takeovers`;
    yield* sql`ALTER TABLE harness_takeovers_v3 RENAME TO harness_takeovers`;
    yield* sql`CREATE TABLE applied_resources_v3 (
      follower_id TEXT NOT NULL, resource_id TEXT NOT NULL, revision_id TEXT NOT NULL,
      digest TEXT NOT NULL, applied_at TEXT NOT NULL, record_json TEXT NOT NULL,
      PRIMARY KEY (follower_id, resource_id))`;
    const applied = yield* sql`SELECT follower_id, resource_id, revision_id, digest, applied_at,
      json_object('resource', resource_id, 'revision', revision_id, 'digest', digest, 'appliedAt', applied_at,
        'kind', kind, 'policy', policy, 'target', target, 'ownedFiles', json(owned_files_json),
        'ownedKeys', json(owned_keys_json), 'configFormat', config_format,
        'executable', CASE WHEN executable IS NULL THEN NULL ELSE json(CASE WHEN executable = 1 THEN 'true' ELSE 'false' END) END,
        'symlinkTo', symlink_target, 'mode', mode, 'installerRecipe', json(installer_recipe_json)) AS record_json
      FROM applied_resources`;
    for (const row of Schema.decodeUnknownSync(Schema.Array(Schema.Struct({
      follower_id: Schema.String, resource_id: Schema.String, revision_id: Schema.String,
      digest: Schema.String, applied_at: Schema.String, record_json: Schema.String,
    })))(applied)) {
      const record = yield* upgradeAppliedRecord(JSON.parse(row.record_json));
      yield* sql`INSERT INTO applied_resources_v3 VALUES (${row.follower_id}, ${row.resource_id},
        ${row.revision_id}, ${row.digest}, ${row.applied_at}, ${JSON.stringify(record)})`;
    }
    yield* sql`DROP TABLE applied_resources`;
    yield* sql`ALTER TABLE applied_resources_v3 RENAME TO applied_resources`;
    const previousRecords = yield* sql`SELECT id, removed_resource_json FROM action_journal WHERE removed_resource_json IS NOT NULL`;
    for (const row of Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.Number, removed_resource_json: Schema.String })))(previousRecords)) {
      const record = yield* upgradeAppliedRecord(JSON.parse(row.removed_resource_json));
      yield* sql`UPDATE action_journal SET removed_resource_json = ${JSON.stringify(record)} WHERE id = ${row.id}`;
    }
    yield* sql`ALTER TABLE synchronization_runs ADD COLUMN recovery_error TEXT`;
    yield* sql`CREATE TABLE action_journal_v3 (
      id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, action_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'blocked', 'interrupted', 'rolled-back')),
      recorded_at TEXT NOT NULL, attempt INTEGER NOT NULL CHECK (attempt >= 0),
      verification_json TEXT, rollback_reference TEXT, removed_resource_json TEXT,
      FOREIGN KEY (run_id, action_id) REFERENCES run_actions(run_id, action_id),
      UNIQUE (run_id, sequence))`;
    yield* sql`INSERT INTO action_journal_v3
      SELECT j.id, j.run_id, j.action_id,
        ROW_NUMBER() OVER (PARTITION BY j.run_id ORDER BY j.sequence) - 1,
        CASE WHEN j.state = 'failed' AND json_extract(j.verification_json, '$.method') = 'run-rolled-back' THEN 'rolled-back'
          WHEN j.state = 'failed' AND json_extract(j.verification_json, '$.method') = 'interrupted' THEN 'interrupted'
          WHEN j.state = 'skipped' THEN 'blocked' ELSE j.state END,
        j.recorded_at, j.attempt, j.verification_json, j.rollback_reference, j.removed_resource_json
      FROM action_journal j
      WHERE j.state != 'skipped' OR EXISTS (
        SELECT 1 FROM synchronization_runs r, json_each(r.plan_json, '$.actions') a
        WHERE r.id = j.run_id AND json_extract(a.value, '$.id') = j.action_id
          AND json_extract(a.value, '$.detail.kind') IN ('human-action', 'agent-task', 'drift-conflict'))`;
    yield* sql`DROP TABLE action_journal`;
    yield* sql`ALTER TABLE action_journal_v3 RENAME TO action_journal`;
    // Terminal writes need only historical evidence, never reconstructed intent.
    // Only Applying/Interrupted can replay writes or their inverses.
    const rows = yield* sql`SELECT id, phase, plan_json FROM synchronization_runs`;
    for (const row of Schema.decodeUnknownSync(Schema.Array(Schema.Struct({
      id: Schema.String, phase: Schema.String, plan_json: Schema.String,
    })))(rows)) {
      const plan = Schema.decodeUnknownSync(Schema.MutableJson)(JSON.parse(row.plan_json));
      if (!isJsonObject(plan) || !Array.isArray(plan.actions)) continue;
      let ambiguous = false;
      for (const action of plan.actions) {
        if (!isJsonObject(action)) continue;
        const detail = action.detail;
        if (!isJsonObject(detail) || detail.kind !== "write-file") continue;
        if (row.phase === "Finalizing" || row.phase === "Complete") {
          detail.textTransition = { kind: "completed" };
          delete detail.retainedLocalDigest;
          delete detail.previousSourceDigest;
          continue;
        }
        const policies = yield* sql`SELECT json_extract(resource.value, '$.policy') AS policy
          FROM synchronization_runs run
          JOIN local_revisions revision ON revision.id = run.revision_id,
            json_each(revision.revision_json, '$.resources') resource
          WHERE run.id = ${row.id} AND json_extract(resource.value, '$.id') = ${String(action.resource)}
          UNION ALL SELECT json_extract(resource.value, '$.policy') AS policy
          FROM synchronization_runs run
          JOIN profile_revisions revision ON revision.id = run.revision_id,
            json_each(revision.revision_json, '$.resources') resource
          WHERE run.id = ${row.id} AND json_extract(resource.value, '$.id') = ${String(action.resource)}
          LIMIT 1`;
        const policy = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ policy: Schema.String })))(policies)[0]?.policy;
        if (isString(detail.retainedLocalDigest)) detail.textTransition = { kind: "adopt-local", retainedDigest: detail.retainedLocalDigest };
        else if (policy !== undefined && policy !== "append-local" && detail.previousSourceDigest === undefined) detail.textTransition = { kind: "whole-file" };
        else ambiguous = true;
        delete detail.retainedLocalDigest;
        delete detail.previousSourceDigest;
      }
      if (ambiguous) {
        yield* sql`UPDATE synchronization_runs SET recovery_error =
          'This 6.1 run has ambiguous append-local ownership. Preserve state.sqlite and .backups, restore its affected targets from the retained snapshots manually, then move state.sqlite aside and set the machine up again. No managed target was changed by this upgrade.'
          WHERE id = ${row.id}`;
      } else {
        if (isString(plan.encoded)) {
          const encoded = Schema.decodeUnknownSync(Schema.MutableJson)(JSON.parse(plan.encoded));
          if (isJsonObject(encoded)) {
            encoded.actions = plan.actions;
            plan.encoded = canonicalJson(encoded);
            plan.digest = createHash("sha256").update(plan.encoded).digest("hex");
          }
        }
        yield* sql`UPDATE synchronization_runs SET plan_json = ${JSON.stringify(plan)} WHERE id = ${row.id}`;
      }
    }
  }),
  "0004_enrollment_lifecycle": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    // Released active configurations upgrade in place. Old pending rows lack
    // replacement ownership and must be recovered explicitly, not guessed.
    yield* sql`
      UPDATE follower_sync_configuration
      SET configuration_json = json_remove(
        json_set(configuration_json, '$.lifecycle', json_object(
          '_tag', CASE WHEN json_extract(configuration_json, '$.enrollmentPending') = 1
            THEN 'LegacyPending' ELSE 'Active' END
        )), '$.enrollmentPending'
      )
    `;
    yield* sql`
      CREATE TABLE enrollment_credential_retirements (
        reference TEXT PRIMARY KEY NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('Staged', 'Retiring'))
      )
    `;
    yield* sql`
      INSERT OR IGNORE INTO enrollment_credential_retirements (reference, state)
      SELECT credential_reference, 'Retiring' FROM followers WHERE revoked = 1
    `;
    yield* sql`
      CREATE TABLE scheduled_invocations (
        id TEXT PRIMARY KEY NOT NULL,
        started_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('Running', 'Completed', 'Failed')),
        invocation_json TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE scheduled_invocation_imports (
        path TEXT PRIMARY KEY NOT NULL,
        digest TEXT NOT NULL
      )
    `;
  }),
});

/** Bumped by every change to what stored state means. */
export const stateFormatVersion = 6;
