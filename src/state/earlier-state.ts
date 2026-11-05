import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { SqliteMigrator } from "@canonfig/effect-sql-sqlite-node";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { ContentDigest } from "../domain/brand.ts";
import { configPathsOverlap } from "../domain/config-path.ts";
import { ProfileRevisionSchema } from "../domain/profile.ts";
import { AppliedResourceRecordSchema, type AppliedResourceRecord } from "../domain/synchronization.ts";
import { buildIdentity } from "../runtime/build-identity.ts";
import { FollowerSynchronizationConfiguration } from "../synchronization/follower-sync-config.ts";
import {
  desiredDirectoryEntries,
  desiredResourceDigest,
  relativePathAncestors,
} from "../synchronization/resource-plans.ts";
import { EarlierStateUpgradeError, RepositorySqlError } from "./state-repository.errors.ts";
import { currentStateHistory, stateMigrations } from "./state-schema.ts";

/**
 * In-place upgrade of state that Canonfig 4.0.0 through 5.0.1 wrote (state
 * format 4, the 21-migration history below) to state format 6.
 *
 * Enrollment, run journals, receipts, approvals, blobs and schedules carry
 * over unchanged. What changed meaning is mapped to its current equivalent:
 *
 * - An Applied Resource Record of an authored `file`, `directory` or
 *   `config` resource becomes the record of the authored resource
 *   `resources.<id>` in `canonfig.jsonc` (`harness:resources:<id>`), with an
 *   absolute target and a harness takeover row, so the first projection of
 *   that resource is an ordinary update of a surface Canonfig already owns,
 *   not a fresh takeover.
 * - The follower configuration's `selectedProfile` becomes `profile`.
 * - A Local Overlay entry is dropped and listed in the audit record. In
 *   state 5.0.1 accepted, an overlay key never overlaps a key Canonfig owns
 *   (that is Human Action Required), and this release leaves every key
 *   Canonfig does not own to the follower, so nothing changes on disk.
 * - A published revision keeps its id, profile, sequence, digest, signature
 *   and signed bytes, and lists no resources: this release cannot apply its
 *   resources, and the Source publishes from `~/.canonfig/` from now on.
 * - Unchunked blobs move into chunks; runs from before 3.2.0 get the same
 *   unrecorded build identity their 3.2.0 receipt names.
 *
 * Items with no equivalent stop the upgrade before anything is written,
 * naming the item and its recovery: an unfinished run, a Source that
 * published more than one profile, a `skill` resource with its own target, a
 * symlink, a target outside home, an overlay over a managed key, or a row
 * this release cannot decode.
 *
 * The upgrade is one transaction, preceded by a full copy of the database
 * next to it, and recorded in `state_upgrades`. A database already at
 * format 6 is never touched again, so a repeat is a no-op.
 */

/** The migration history Canonfig 4.0.0 through 5.0.1 wrote. */
const stateFormat4History = [
  "state_repository",
  "enrollment",
  "follower_synchronization_configuration",
  "applied_resource_owned_files",
  "applied_resource_schedule",
  "applied_resource_removal_ownership",
  "applied_resource_file_ownership",
  "action_journal_removed_resource",
  "recoverable_run_blocks_new_runs",
  "transactional_enrollment_and_local_overlays",
  "profile_revision_blob_index",
  "applied_resource_modes",
  "drop_applied_resource_schedule",
  "deployment_receipts",
  "revision_approvals",
  "resource_blobs",
  "mcp_qualification_receipts",
  "enrollment_source_credential_namespace",
  "legacy_revision_blobs",
  "legacy_deployment_receipts",
  "resource_blob_chunks",
] as const;

const MigrationRow = Schema.Struct({ migration_id: Schema.Number, name: Schema.String });
export type MigrationRecord = typeof MigrationRow.Type;

/** The Effect SQL migration history, empty for a new database. */
export const readStateHistory = Effect.fn("StateRepository.readStateHistory")(function*() {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `.pipe(
    Effect.flatMap((tables) => tables.length === 0
      ? Effect.succeed([])
      : sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`),
    Effect.flatMap((rows) => Schema.decodeUnknownEffect(Schema.Array(MigrationRow))(rows)),
    Effect.mapError((error) => new RepositorySqlError({ operation: "read state schema history", message: String(error) })),
  );
});

export type StateHistory =
  | "current"
  | "state-format-4"
  | "before-state-format-4"
  | "unrecognized";

const matches = (
  history: ReadonlyArray<MigrationRecord>,
  names: ReadonlyArray<string>,
): boolean => history.every((row, index) => row.migration_id === index + 1 && row.name === names[index]);

/** Which release wrote a migration history; an empty history is a new database. */
export const classifyStateHistory = (history: ReadonlyArray<MigrationRecord>): StateHistory => {
  if (history.length <= currentStateHistory.length && matches(history, currentStateHistory.map((entry) => entry.name))) {
    return "current";
  }
  if (history.length === stateFormat4History.length && matches(history, stateFormat4History)) return "state-format-4";
  if (history.length < stateFormat4History.length && matches(history, stateFormat4History)) return "before-state-format-4";
  return "unrecognized";
};

/**
 * The tables state format 4 holds, parents before the tables that reference
 * them. `copy` tables mean the same in both formats and copy column for
 * column; the others are rewritten by `applyUpgrade`.
 */
const earlierTables: ReadonlyArray<readonly [table: string, rows: "copy" | "rewrite"]> = [
  ["source_identity", "copy"],
  ["followers", "copy"],
  ["enrollment_source", "copy"],
  ["enrollment_invitations", "copy"],
  ["follower_credentials", "copy"],
  ["pending_enrollments", "copy"],
  ["follower_sync_configuration", "rewrite"],
  ["profile_revisions", "rewrite"],
  ["profile_revision_blobs", "copy"],
  ["revision_approvals", "copy"],
  ["resource_blobs", "rewrite"],
  ["resource_blob_manifests", "copy"],
  ["resource_blob_chunks", "copy"],
  ["synchronization_runs", "rewrite"],
  ["run_actions", "copy"],
  ["action_journal", "copy"],
  ["drift_records", "copy"],
  ["deployment_receipts", "copy"],
  ["mcp_qualification_receipts", "copy"],
  ["applied_resources", "rewrite"],
];

/** Bytes per chunk; matches `resourceBlobChunkBytes` in the repository layer. */
const chunkBytes = 1024 * 1024;

const UnfinishedRunRow = Schema.Struct({ id: Schema.String, status: Schema.String });
const ProfileRow = Schema.Struct({ profile_id: Schema.String });
const RevisionRow = Schema.Struct({
  id: Schema.String,
  profile_id: Schema.String,
  sequence: Schema.Number,
  canonical_bytes: Schema.String,
  digest: Schema.String,
  signature: Schema.String,
  published_at: Schema.String,
});
const ConfigurationRow = Schema.Struct({
  follower_id: Schema.String,
  configuration_json: Schema.String,
  updated_at: Schema.String,
});
const AppliedRow = Schema.Struct({
  follower_id: Schema.String,
  resource_id: Schema.String,
  revision_id: Schema.String,
  digest: Schema.String,
  applied_at: Schema.String,
  owned_files_json: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(Schema.String),
  policy: Schema.NullOr(Schema.String),
  target: Schema.NullOr(Schema.String),
  owned_keys_json: Schema.NullOr(Schema.String),
  config_format: Schema.NullOr(Schema.String),
  executable: Schema.NullOr(Schema.Number),
  symlink_target: Schema.NullOr(Schema.String),
  mode: Schema.NullOr(Schema.Number),
  installer_recipe_json: Schema.NullOr(Schema.String),
});
type AppliedRow = typeof AppliedRow.Type;
const LatestRunRow = Schema.Struct({ follower_id: Schema.String, id: Schema.String });
/** The two 5.0.1 follower configuration fields that changed. */
const EarlierConfiguration = Schema.Struct({
  selectedProfile: Schema.String,
  localOverlay: Schema.optional(Schema.Array(Schema.Struct({
    resource: Schema.String,
    target: Schema.optional(Schema.String),
    keys: Schema.Array(Schema.String),
  }))),
});
const OwnedFiles = Schema.Array(Schema.Struct({
  path: Schema.String,
  digest: ContentDigest,
  executable: Schema.optional(Schema.Boolean),
  mode: Schema.optional(Schema.Number),
  objectKind: Schema.optional(Schema.String),
  symlinkTo: Schema.optional(Schema.String),
}));
const OwnedKeys = Schema.Array(Schema.String);
const ForeignKeyViolation = Schema.Struct({ table: Schema.String, rowid: Schema.NullOr(Schema.Number), parent: Schema.String });
const NamedRow = Schema.Struct({ type: Schema.String, name: Schema.String });
const ColumnRow = Schema.Struct({ name: Schema.String });
const DatabaseRow = Schema.Struct({ name: Schema.String, file: Schema.String });

/** What the upgrade changed beyond copying rows, kept in its audit record. */
interface UpgradeChanges {
  readonly renamedRecords: Array<{ readonly from: string; readonly to: string }>;
  readonly droppedOverlays: Array<{ readonly resource: string; readonly keys: ReadonlyArray<string> }>;
  readonly revisionsWithoutResources: Array<string>;
}

interface UpgradePlan {
  readonly configuration: { readonly followerId: string; readonly json: string; readonly updatedAt: string } | undefined;
  readonly revisions: ReadonlyArray<{ readonly row: typeof RevisionRow.Type; readonly json: string }>;
  readonly applied: ReadonlyArray<{ readonly followerId: string; readonly record: AppliedResourceRecord }>;
  readonly takeovers: ReadonlyArray<{ readonly surface: string; readonly runId: string; readonly takenOverAt: string }>;
  readonly changes: UpgradeChanges;
}

const refuse = (item: string, reason: string, recovery: string) =>
  new EarlierStateUpgradeError({ item, reason, recovery });

const firstLine = (cause: string): string => cause.split("\n")[0] ?? cause;

const finishWith501 =
  "Install Canonfig 5.0.1 again, finish or remove it there, then install this version and run it again. The state has not been changed.";

/**
 * `~/...` and absolute targets inside `home`, as the absolute path the
 * projection records. Anything else has no equivalent: this release never
 * writes outside the home directory.
 */
const homeTarget = (home: string, target: string): string | undefined => {
  const absolute = target === "~" || target.startsWith("~/") || target.startsWith("~\\")
    ? join(home, target.slice(1))
    : isAbsolute(target) ? resolve(target) : undefined;
  if (absolute === undefined) return undefined;
  const inside = relative(home, absolute);
  return inside === "" || inside.startsWith("..") || isAbsolute(inside) ? undefined : absolute;
};

const decodeRows = <S extends Schema.Constraint>(schema: S, rows: ReadonlyArray<unknown>, entity: string) =>
  Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(
    Effect.mapError((error) => refuse(entity, `a stored row does not have the 5.0.1 shape: ${firstLine(String(error))}`, finishWith501)),
  );

const sqlFailure = (operation: string) => (error: SqlError) =>
  new RepositorySqlError({ operation, message: String(error) });

const removeWith501 = (resource: string) =>
  `On the Source, with Canonfig 5.0.1, remove resource ${resource} from the profile and publish, then run \`canonfig sync --apply\` here with 5.0.1 so it releases it. Then install this version and run it again. The state has not been changed.`;

type EarlierRecord =
  | { readonly record: unknown; readonly renamed: boolean }
  | { readonly reason: string; readonly recovery: string };

/**
 * One 5.0.1 Applied Resource Record as this release records it. An authored
 * `file`, `directory` or `config` resource becomes the record the projection
 * keeps for `resources.<id>`; tools and credentials keep their record, since
 * their meaning did not change. Throws on stored JSON 5.0.1 never wrote.
 */
const earlierRecord = (row: AppliedRow, home: string): EarlierRecord => {
  if (row.kind === "skill") {
    return {
      reason: "a skill resource with its own target has no equivalent: skills now come from ~/.canonfig/skills/ and go to each harness's own skills directory",
      recovery: removeWith501(row.resource_id),
    };
  }
  if (row.kind !== "file" && row.kind !== "directory" && row.kind !== "config") {
    return {
      renamed: false,
      record: {
        resource: row.resource_id,
        revision: row.revision_id,
        digest: row.digest,
        appliedAt: row.applied_at,
        kind: row.kind ?? undefined,
        policy: row.policy ?? undefined,
        target: row.target ?? undefined,
        mode: row.mode ?? undefined,
        installerRecipe: row.installer_recipe_json === null ? undefined : JSON.parse(row.installer_recipe_json),
      },
    };
  }
  const target = row.target === null ? undefined : homeTarget(home, row.target);
  if (target === undefined) {
    return {
      reason: `its target ${row.target ?? "(none)"} is outside the home directory, which this release never writes`,
      recovery: removeWith501(row.resource_id),
    };
  }
  const owned = Schema.decodeUnknownSync(OwnedFiles)(JSON.parse(row.owned_files_json ?? "[]"));
  if (row.symlink_target !== null || owned.some((file) => file.objectKind === "symlink" || file.symlinkTo !== undefined)) {
    return { reason: "it is or holds a symlink, which authored resources no longer create", recovery: removeWith501(row.resource_id) };
  }
  const base = {
    resource: `harness:resources:${row.resource_id}`,
    revision: row.revision_id,
    appliedAt: row.applied_at,
    kind: row.kind,
    target,
    // The Source's section of an append-local file keeps its policy; every
    // other surface is compared three ways, as the projection records it.
    policy: row.policy === "append-local" ? "append-local" : "replace-if-unmodified",
  };
  if (row.kind === "file") {
    return {
      renamed: true,
      record: { ...base, digest: row.digest, executable: row.executable === 1, mode: row.mode ?? undefined },
    };
  }
  if (row.kind === "config") {
    return {
      renamed: true,
      record: {
        ...base,
        digest: row.digest,
        ownedKeys: Schema.decodeUnknownSync(OwnedKeys)(JSON.parse(row.owned_keys_json ?? "[]")),
        configFormat: row.config_format ?? undefined,
      },
    };
  }
  // The projection owns a directory's files, every ancestor directory of one
  // (0700) and the root, and records the digest of exactly those entries, so
  // the record is rebuilt that way from the tree 5.0.1 wrote.
  const files = owned.filter((file) => file.objectKind !== "directory").map((file) => ({
    path: file.path,
    digest: file.digest,
    executable: file.executable === true,
    mode: file.mode ?? (file.executable === true ? 0o700 : 0o600),
  }));
  const directories = new Map(owned.filter((file) => file.objectKind === "directory").map((file) => [file.path, file.mode ?? 0o700]));
  for (const ancestor of relativePathAncestors(files.map((file) => file.path))) {
    if (!directories.has(ancestor)) directories.set(ancestor, 0o700);
  }
  const desired = {
    kind: "directory" as const,
    mode: row.mode ?? 0o700,
    directories: [...directories.keys()].sort().map((path) => ({ path, mode: directories.get(path) ?? 0o700 })),
    files,
  };
  return {
    renamed: true,
    record: {
      ...base,
      digest: desiredResourceDigest(desired),
      mode: desired.mode,
      ownedFiles: desiredDirectoryEntries(desired).map((entry) => ({ objectKind: "regular", ...entry })),
    },
  };
};

const readEarlierState = Effect.fn("StateRepository.readEarlierState")(function*(home: string) {
  const sql = yield* SqlClient.SqlClient;
  const read = <S extends Schema.Constraint>(schema: S, entity: string, query: Effect.Effect<ReadonlyArray<unknown>, SqlError>) =>
    query.pipe(Effect.mapError(sqlFailure(`read ${entity} from earlier state`)), Effect.flatMap((rows) => decodeRows(schema, rows, entity)));

  const unfinished = yield* read(UnfinishedRunRow, "synchronization runs", sql`
    SELECT id, status FROM synchronization_runs WHERE status IN ('applying', 'Interrupted') ORDER BY started_at
  `);
  const open = unfinished[0];
  if (open !== undefined) {
    return yield* refuse(
      `synchronization run ${open.id} (${open.status})`,
      "this release cannot recover or roll back a run an earlier release left unfinished",
      `Install Canonfig 5.0.1 again, run \`canonfig recover\` (or \`canonfig abandon\`) there, then install this version and run it again. The state has not been changed.`,
    );
  }

  // A follower stores views of the one profile it follows (`<id>:view:<digest>`);
  // only a Source's own revisions name the profiles it publishes.
  const profiles = yield* read(ProfileRow, "profile revisions", sql`
    SELECT DISTINCT profile_id FROM profile_revisions WHERE instr(profile_id, ':view:') = 0 ORDER BY profile_id
  `);
  if (profiles.length > 1) {
    return yield* refuse(
      `published profiles ${profiles.map((row) => row.profile_id).join(", ")}`,
      "a Source of this release publishes exactly one Machine Profile; publishing several from one Source is tracked in https://github.com/Microck/canonfig/issues/254",
      "Keep this Source on Canonfig 5.0.1, or move the state database aside and set this machine up again as the Source of one profile; its followers then enroll again. The state has not been changed.",
    );
  }

  const revisions = (yield* read(RevisionRow, "profile revisions", sql`
    SELECT id, profile_id, sequence, canonical_bytes, digest, signature, published_at
    FROM profile_revisions ORDER BY profile_id, sequence
  `)).map((row) => ({
    row,
    revision: {
      id: row.id,
      profileId: row.profile_id,
      sequence: row.sequence,
      canonicalBytes: row.canonical_bytes,
      digest: row.digest,
      signature: row.signature,
      publishedAt: row.published_at,
      resources: [],
      groups: [],
    },
  }));
  for (const { row, revision } of revisions) {
    yield* Schema.decodeUnknownEffect(ProfileRevisionSchema)(revision).pipe(
      Effect.mapError((error) => refuse(`profile revision ${row.id}`, `its identity does not fit this release: ${firstLine(String(error))}`, finishWith501)),
    );
  }

  const appliedRows = yield* read(AppliedRow, "applied resources", sql`SELECT * FROM applied_resources ORDER BY follower_id, resource_id`);
  const latestRuns = new Map((yield* read(LatestRunRow, "synchronization runs", sql`
    SELECT follower_id, id FROM synchronization_runs AS run
    WHERE started_at = (SELECT MAX(started_at) FROM synchronization_runs WHERE follower_id = run.follower_id)
  `)).map((row) => [row.follower_id, row.id]));
  const changes: UpgradeChanges = { renamedRecords: [], droppedOverlays: [], revisionsWithoutResources: revisions.map(({ row }) => row.id) };
  const applied: Array<{ readonly followerId: string; readonly record: AppliedResourceRecord }> = [];
  const ownedKeysByEarlierId = new Map<string, ReadonlyArray<string>>();
  const takeovers: Array<{ readonly surface: string; readonly runId: string; readonly takenOverAt: string }> = [];
  for (const row of appliedRows) {
    const item = `applied resource ${row.resource_id} (${row.kind ?? "unknown kind"} at ${row.target ?? "no target"})`;
    const notStored = (cause: string) => refuse(item, `the record does not fit this release: ${firstLine(cause)}`, finishWith501);
    const earlier = yield* Effect.try({ try: () => earlierRecord(row, home), catch: (error) => notStored(String(error)) });
    if ("reason" in earlier) return yield* refuse(item, earlier.reason, earlier.recovery);
    const record = yield* Schema.decodeUnknownEffect(AppliedResourceRecordSchema)(earlier.record).pipe(Effect.mapError((error) => notStored(String(error))));
    applied.push({ followerId: row.follower_id, record });
    ownedKeysByEarlierId.set(row.resource_id, record.ownedKeys ?? []);
    if (!earlier.renamed) continue;
    const runId = latestRuns.get(row.follower_id);
    if (runId === undefined) return yield* refuse(item, "no synchronization run of this follower applied it", finishWith501);
    changes.renamedRecords.push({ from: row.resource_id, to: record.resource });
    takeovers.push({ surface: row.resource_id, runId, takenOverAt: row.applied_at });
  }

  const configurationRows = yield* read(ConfigurationRow, "follower synchronization configuration", sql`
    SELECT follower_id, configuration_json, updated_at FROM follower_sync_configuration
  `);
  let configuration: UpgradePlan["configuration"];
  for (const row of configurationRows) {
    const item = "follower synchronization configuration";
    const notEarlier = (cause: string) => refuse(item, `it does not have the 5.0.1 shape: ${firstLine(cause)}`, finishWith501);
    const { selectedProfile, localOverlay, ...rest } = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(JSON.parse(row.configuration_json)),
      catch: (error) => notEarlier(String(error)),
    });
    const earlier = yield* Schema.decodeUnknownEffect(EarlierConfiguration)({ selectedProfile, localOverlay }).pipe(
      Effect.mapError((error) => notEarlier(String(error))),
    );
    for (const overlay of earlier.localOverlay ?? []) {
      const owned = ownedKeysByEarlierId.get(overlay.resource) ?? [];
      const managed = overlay.keys.filter((key) => owned.some((ownedKey) => configPathsOverlap(key, ownedKey)));
      if (managed.length > 0) {
        return yield* refuse(
          `local overlay on ${overlay.resource} (${managed.join(", ")})`,
          "it claims keys Canonfig manages, which this release has no way to hand to the follower",
          `Install Canonfig 5.0.1 again, run \`canonfig overlay remove ${overlay.resource}\` there and resolve the keys, then install this version and run it again. The state has not been changed.`,
        );
      }
      changes.droppedOverlays.push({ resource: overlay.resource, keys: overlay.keys });
    }
    const upgraded = yield* Schema.decodeUnknownEffect(FollowerSynchronizationConfiguration)({
      ...rest,
      profile: earlier.selectedProfile,
    }).pipe(Effect.mapError((error) => refuse(item, `it does not fit this release: ${firstLine(String(error))}`, finishWith501)));
    configuration = { followerId: row.follower_id, json: JSON.stringify(upgraded), updatedAt: row.updated_at };
  }

  return {
    configuration,
    revisions: revisions.map(({ row, revision }) => ({ row, json: JSON.stringify(revision) })),
    applied,
    takeovers,
    changes,
  } satisfies UpgradePlan;
});

/**
 * A full copy of the database, written next to it before anything changes:
 * created exclusively and without following a symlink at that name, readable
 * only by this user, then filled by SQLite's own consistent copy.
 */
const backupDatabase = Effect.fn("StateRepository.backupEarlierState")(function*() {
  const sql = yield* SqlClient.SqlClient;
  const databases = yield* sql`PRAGMA database_list`.pipe(
    Effect.mapError(sqlFailure("resolve state database")),
    Effect.flatMap((rows) => decodeRows(DatabaseRow, rows, "state database")),
  );
  const file = databases.find((row) => row.name === "main")?.file;
  if (file === undefined || file.length === 0) {
    return yield* new RepositorySqlError({ operation: "back up earlier state", message: "upgrading earlier state requires a file-backed state database" });
  }
  const directory = yield* Effect.tryPromise({
    try: () => realpath(dirname(file)),
    catch: (error) => new RepositorySqlError({ operation: "back up earlier state", message: String(error) }),
  });
  const stamp = new Date().toISOString().replaceAll(/[-:.]/gu, "");
  const backup = join(directory, `state-before-format-6-${stamp}.sqlite`);
  yield* Effect.tryPromise({
    try: async () => {
      const handle = await open(
        backup,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.close();
    },
    catch: (error) => new RepositorySqlError({ operation: "back up earlier state", message: `could not create ${backup}: ${String(error)}` }),
  });
  yield* sql`VACUUM INTO ${backup}`.pipe(Effect.mapError(sqlFailure("back up earlier state")));
  return backup;
});

const applyUpgrade = Effect.fn("StateRepository.applyEarlierStateUpgrade")(function*(
  plan: UpgradePlan,
  home: string,
  history: ReadonlyArray<MigrationRecord>,
  backup: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const failure = sqlFailure("upgrade earlier state");
  const run = <A>(statement: Effect.Effect<A, SqlError>) => statement.pipe(Effect.mapError(failure));

  // Another process may have upgraded the state since it was planned; inside
  // the transaction the history cannot change again.
  if (classifyStateHistory(yield* readStateHistory()) !== "state-format-4") return;

  // Foreign keys are checked once, at the end, against the whole new schema.
  yield* run(sql`PRAGMA defer_foreign_keys = ON`);
  // Format 6 recreates every index and trigger under the same names.
  const named = yield* run(sql`
    SELECT type, name FROM sqlite_master
    WHERE type IN ('index', 'trigger') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
  `).pipe(Effect.flatMap((rows) => decodeRows(NamedRow, rows, "schema")));
  for (const entry of named) {
    yield* run(entry.type === "index" ? sql`DROP INDEX ${sql(entry.name)}` : sql`DROP TRIGGER ${sql(entry.name)}`);
  }
  for (const [table] of earlierTables) {
    yield* run(sql`ALTER TABLE ${sql(table)} RENAME TO ${sql(`earlier_${table}`)}`);
  }
  // The format 6 schema and history, exactly as a new database gets them.
  yield* run(sql`DROP TABLE effect_sql_migrations`);
  yield* SqliteMigrator.run({ loader: stateMigrations }).pipe(
    Effect.mapError((error) => new RepositorySqlError({ operation: "upgrade earlier state", message: String(error) })),
  );

  for (const [table, handling] of earlierTables) {
    if (handling === "rewrite") continue;
    const columns = yield* run(sql`SELECT name FROM pragma_table_info(${table})`).pipe(
      Effect.flatMap((rows) => decodeRows(ColumnRow, rows, "schema")),
    );
    // Column names come from this release's own schema, never from input.
    const list = sql.literal(columns.map((column) => `"${column.name}"`).join(", "));
    yield* run(sql`INSERT INTO ${sql(table)} (${list}) SELECT ${list} FROM ${sql(`earlier_${table}`)}`);
  }
  // Blobs stored before 3.2.1 chunking become chunked blobs.
  yield* run(sql`
    INSERT INTO resource_blob_manifests (id, total_bytes, chunk_bytes)
    SELECT id, length(content), ${chunkBytes} FROM earlier_resource_blobs
    WHERE id NOT IN (SELECT id FROM resource_blob_manifests)
  `);
  yield* run(sql`
    WITH RECURSIVE chunk(blob_id, chunk_index) AS (
      SELECT id, 0 FROM earlier_resource_blobs
      WHERE length(content) > 0 AND id NOT IN (SELECT blob_id FROM resource_blob_chunks)
      UNION ALL
      SELECT chunk.blob_id, chunk.chunk_index + 1 FROM chunk
      JOIN earlier_resource_blobs AS blob ON blob.id = chunk.blob_id
      WHERE (chunk.chunk_index + 1) * ${chunkBytes} < length(blob.content)
    )
    INSERT INTO resource_blob_chunks (blob_id, chunk_index, content)
    SELECT chunk.blob_id, chunk.chunk_index, substr(blob.content, chunk.chunk_index * ${chunkBytes} + 1, ${chunkBytes})
    FROM chunk JOIN earlier_resource_blobs AS blob ON blob.id = chunk.blob_id
  `);
  // Runs from before 3.2.0 recorded no build; their receipts already say so.
  yield* run(sql`
    INSERT INTO synchronization_runs (
      id, follower_id, revision_id, status, plan_json, started_at, completed_at,
      outcome_json, creating_version, creating_identity, state_format
    )
    SELECT
      id, follower_id, revision_id, status, plan_json, started_at, completed_at, outcome_json,
      COALESCE(creating_version, 'before 3.2.0'), COALESCE(creating_identity, 'unrecorded'), COALESCE(state_format, 1)
    FROM earlier_synchronization_runs
  `);
  for (const { row, json } of plan.revisions) {
    yield* run(sql`
      INSERT INTO profile_revisions (id, profile_id, sequence, canonical_bytes, digest, signature, published_at, revision_json)
      VALUES (${row.id}, ${row.profile_id}, ${row.sequence}, ${row.canonical_bytes}, ${row.digest}, ${row.signature}, ${row.published_at}, ${json})
    `);
  }
  if (plan.configuration !== undefined) {
    yield* run(sql`
      INSERT INTO follower_sync_configuration (singleton, follower_id, configuration_json, updated_at)
      VALUES (1, ${plan.configuration.followerId}, ${plan.configuration.json}, ${plan.configuration.updatedAt})
    `);
  }
  for (const { followerId, record } of plan.applied) {
    yield* run(sql`
      INSERT INTO applied_resources (
        follower_id, resource_id, revision_id, digest, applied_at, owned_files_json, kind, policy, target,
        owned_keys_json, config_format, executable, symlink_target, mode, installer_recipe_json
      ) VALUES (
        ${followerId}, ${record.resource}, ${record.revision}, ${record.digest}, ${record.appliedAt},
        ${record.ownedFiles === undefined ? null : JSON.stringify(record.ownedFiles)},
        ${record.kind ?? null}, ${record.policy ?? null}, ${record.target ?? null},
        ${record.ownedKeys === undefined ? null : JSON.stringify(record.ownedKeys)},
        ${record.configFormat ?? null},
        ${record.executable === undefined ? null : record.executable ? 1 : 0},
        ${record.symlinkTo ?? null}, ${record.mode ?? null},
        ${record.installerRecipe === undefined ? null : JSON.stringify(record.installerRecipe)}
      )
    `);
  }
  for (const takeover of plan.takeovers) {
    yield* run(sql`
      INSERT INTO harness_takeovers (harness, surface, root, snapshot, run_id, taken_over_at)
      VALUES ('resources', ${takeover.surface}, ${home}, NULL, ${takeover.runId}, ${takeover.takenOverAt})
    `);
  }
  for (const [table] of [...earlierTables].reverse()) {
    yield* run(sql`DROP TABLE ${sql(`earlier_${table}`)}`);
  }

  const violations = yield* run(sql`PRAGMA foreign_key_check`).pipe(
    Effect.flatMap((rows) => decodeRows(ForeignKeyViolation, rows, "foreign keys")),
  );
  const violation = violations[0];
  if (violation !== undefined) {
    return yield* refuse(
      `${violation.table} row ${String(violation.rowid)}`,
      `it references a ${violation.parent} row the state does not hold`,
      finishWith501,
    );
  }

  yield* run(sql`
    INSERT INTO state_upgrades (earlier_history_json, backup, changes_json, package_version, build_identity, upgraded_at)
    VALUES (
      ${JSON.stringify(history)}, ${backup}, ${JSON.stringify(plan.changes)},
      ${buildIdentity.packageVersion}, ${buildIdentity.sourceDigest}, ${new Date().toISOString()}
    )
  `);
});

/**
 * Upgrade a state format 4 database in place, or fail with the item that
 * stops it. Planning reads and checks everything first, so a refusal leaves
 * the database untouched and writes no backup.
 */
export const upgradeStateFormat4 = Effect.fn("StateRepository.upgradeStateFormat4")(function*(
  history: ReadonlyArray<MigrationRecord>,
  home: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const plan = yield* readEarlierState(home);
  const backup = yield* backupDatabase();
  yield* sql.withTransaction(applyUpgrade(plan, home, history, backup)).pipe(
    Effect.mapError((error) => error instanceof EarlierStateUpgradeError || error instanceof RepositorySqlError
      ? error
      : new RepositorySqlError({ operation: "upgrade earlier state", message: String(error) })),
  );
});
