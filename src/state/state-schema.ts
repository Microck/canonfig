import { Effect } from "effect";
import { SqliteMigrator } from "@effect/sql-sqlite-node";
import { SqlClient } from "effect/unstable/sql";

/**
 * Explicit, append-only migration set. Migrations are tracked by Effect SQL,
 * while each DDL statement remains idempotent for interrupted initialization.
 */
export const stateMigrations = SqliteMigrator.fromRecord({
  "0001_state_repository": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`PRAGMA foreign_keys = ON`;

    yield* sql`
      CREATE TABLE IF NOT EXISTS source_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        key_id TEXT NOT NULL,
        public_key_fingerprint TEXT NOT NULL
      )
    `;

    yield* sql`
      CREATE TABLE IF NOT EXISTS followers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        groups_json TEXT NOT NULL,
        revoked INTEGER NOT NULL CHECK (revoked IN (0, 1)),
        credential_reference TEXT NOT NULL,
        enrolled_at TEXT NOT NULL
      )
    `;

    yield* sql`
      CREATE TABLE IF NOT EXISTS profile_revisions (
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
      CREATE TRIGGER IF NOT EXISTS profile_revisions_immutable_update
      BEFORE UPDATE ON profile_revisions
      BEGIN
        SELECT RAISE(ABORT, 'profile revisions are immutable');
      END
    `;

    yield* sql`
      CREATE TRIGGER IF NOT EXISTS profile_revisions_immutable_delete
      BEFORE DELETE ON profile_revisions
      BEGIN
        SELECT RAISE(ABORT, 'profile revisions are immutable');
      END
    `;

    yield* sql`
      CREATE TABLE IF NOT EXISTS synchronization_runs (
        id TEXT PRIMARY KEY,
        follower_id TEXT NOT NULL REFERENCES followers(id),
        revision_id TEXT NOT NULL REFERENCES profile_revisions(id),
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
        outcome_json TEXT
      )
    `;

    yield* sql`
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_applying_run_per_follower
      ON synchronization_runs(follower_id)
      WHERE status = 'applying'
    `;

    yield* sql`
      CREATE TABLE IF NOT EXISTS run_actions (
        run_id TEXT NOT NULL REFERENCES synchronization_runs(id) ON DELETE RESTRICT,
        action_id TEXT NOT NULL,
        plan_ordinal INTEGER NOT NULL,
        PRIMARY KEY (run_id, action_id),
        UNIQUE (run_id, plan_ordinal)
      )
    `;

    yield* sql`
      CREATE TABLE IF NOT EXISTS action_journal (
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
        FOREIGN KEY (run_id, action_id)
          REFERENCES run_actions(run_id, action_id),
        UNIQUE (run_id, sequence)
      )
    `;

    yield* sql`
      CREATE TABLE IF NOT EXISTS drift_records (
        id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES synchronization_runs(id),
        sequence INTEGER NOT NULL,
        conflict_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE (run_id, sequence)
      )
    `;

    yield* sql`
      CREATE TABLE IF NOT EXISTS applied_resources (
        follower_id TEXT NOT NULL REFERENCES followers(id),
        resource_id TEXT NOT NULL,
        revision_id TEXT NOT NULL REFERENCES profile_revisions(id),
        digest TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY (follower_id, resource_id)
      )
    `;
  }),
  "0002_enrollment": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE IF NOT EXISTS enrollment_source (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        signing_key_reference TEXT NOT NULL,
        tls_key_reference TEXT NOT NULL,
        tls_certificate_reference TEXT NOT NULL,
        tls_fingerprint TEXT NOT NULL
      )
    `;

    yield* sql`
      CREATE TABLE IF NOT EXISTS enrollment_invitations (
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
      CREATE TABLE IF NOT EXISTS follower_credentials (
        follower_id TEXT PRIMARY KEY REFERENCES followers(id) ON DELETE RESTRICT,
        credential_digest TEXT NOT NULL UNIQUE,
        credential_reference TEXT NOT NULL UNIQUE
      )
    `;
  }),
  "0003_follower_synchronization_configuration": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE IF NOT EXISTS follower_sync_configuration (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        follower_id TEXT NOT NULL REFERENCES followers(id) ON DELETE RESTRICT,
        configuration_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
  }),
});
