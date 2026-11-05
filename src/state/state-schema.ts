import { Effect } from "effect";
import { SqliteMigrator } from "@canonfig/effect-sql-sqlite-node";
import { SqlClient } from "effect/unstable/sql";

/**
 * The migration history this release writes, in order.
 *
 * State format 6 started a new schema history. A database Canonfig 4.2.0
 * through 5.0.1 wrote (state format 4) is upgraded in place by
 * `earlier-state.ts`, which ends with exactly this history. The repository
 * refuses any other history: an older release's database is upgraded by
 * running 5.0.1 once first, and a newer release's database is not read.
 */
export const currentStateHistory = [
  { id: 1, name: "state_format_6" },
  { id: 2, name: "state_upgrades" },
] as const;

/**
 * Explicit, append-only migration set, tracked by Effect SQL. A later change
 * to the schema adds a migration after these, and to `currentStateHistory`.
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
  // The audit record of each in-place upgrade of an earlier release's state:
  // the history it replaced, where the pre-upgrade copy is, and every record
  // the upgrade renamed, rewrote or dropped. Rows are only ever inserted.
  "0002_state_upgrades": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE state_upgrades (
        id INTEGER PRIMARY KEY,
        earlier_history_json TEXT NOT NULL,
        backup TEXT NOT NULL,
        changes_json TEXT NOT NULL,
        package_version TEXT NOT NULL,
        build_identity TEXT NOT NULL,
        upgraded_at TEXT NOT NULL
      )
    `;

    yield* sql`
      CREATE TRIGGER state_upgrades_append_only_update
      BEFORE UPDATE ON state_upgrades
      BEGIN
        SELECT RAISE(ABORT, 'state upgrade records are append-only');
      END
    `;

    yield* sql`
      CREATE TRIGGER state_upgrades_append_only_delete
      BEFORE DELETE ON state_upgrades
      BEGIN
        SELECT RAISE(ABORT, 'state upgrade records are append-only');
      END
    `;
  }),
});

/** Bumped by every change to what stored state means. */
export const stateFormatVersion = 6;
