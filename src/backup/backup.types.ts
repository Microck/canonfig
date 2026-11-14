import { Schema, type Redacted } from "effect";
import { CredentialReference } from "../domain/brand.ts";
import { TARGET_IDS } from "../projection/model.ts";
import { SyncScheduleSchema } from "../schedule/schedule-manager.types.ts";

export const BackupName = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u));
export const BackupCompression = Schema.Literals(["fast", "balanced", "small", "max"]);
export type BackupCompression = typeof BackupCompression.Type;
export const BackupCodec = Schema.Literals(["zstd", "xz", "zpaq"]);
export type BackupCodec = typeof BackupCodec.Type;
export const BackupDestination = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local"), path: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("git"), remote: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("rclone"), remote: Schema.NonEmptyString }),
]);
export type BackupDestination = typeof BackupDestination.Type;
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Positive = Schema.Int.check(Schema.isGreaterThan(0));
export const BackupPolicy = Schema.Struct({
  destination: BackupDestination,
  folder: Schema.Boolean,
  harnesses: Schema.Struct({ mode: Schema.Literals(["none", "managed", "full"]), targets: Schema.Array(Schema.Literals(TARGET_IDS)) }),
  compression: BackupCompression,
  /** An alias resolved only through this machine's backup credential map. */
  passwordReference: Schema.optional(BackupName),
  sourceIdentity: Schema.Boolean,
  sharedSecrets: Schema.Boolean,
  includeCredentials: Schema.Boolean,
  include: Schema.Array(Schema.String),
  exclude: Schema.Array(Schema.String),
  retention: Schema.Struct({ last: Positive, daily: Count, weekly: Count }),
  schedule: Schema.optional(SyncScheduleSchema),
  drillSchedule: Schema.optional(SyncScheduleSchema),
  maximumBytes: Positive,
  maximumFiles: Positive,
});
export type BackupPolicy = typeof BackupPolicy.Type;
export const BackupPolicies = Schema.Record(BackupName, BackupPolicy);
export type BackupPolicies = typeof BackupPolicies.Type;
export const LocalBackups = Schema.Struct({
  version: Schema.Literal(1),
  policies: BackupPolicies,
  passwords: Schema.Record(BackupName, CredentialReference),
  disabled: Schema.Array(BackupName),
  /** Only this machine can authorize credential-inclusive capture, including Source policies. */
  allowCredentials: Schema.Array(BackupName),
});
export type LocalBackups = typeof LocalBackups.Type;
export const SnapshotId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export const BackupSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  id: SnapshotId,
  createdAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u)),
  policy: BackupName,
  owner: BackupName,
  compression: BackupCompression,
  codec: BackupCodec,
  encrypted: Schema.Boolean,
  archiveSha256: SnapshotId,
  parts: Schema.Array(Schema.Struct({ sha256: SnapshotId, bytes: Positive })),
  bytes: Positive,
  files: Count,
});
export type BackupSnapshot = typeof BackupSnapshot.Type;

export type BackupRequest =
  | { readonly action: "status" }
  | { readonly action: "schedule" }
  | { readonly action: "configure"; readonly name: string; readonly policy: BackupPolicy; readonly allowCredentials?: boolean }
  | { readonly action: "configure-file"; readonly name: string; readonly file: string; readonly allowCredentials: boolean }
  | { readonly action: "disable"; readonly name: string }
  | { readonly action: "enable"; readonly name: string }
  | { readonly action: "allow-credentials"; readonly name: string }
  | { readonly action: "deny-credentials"; readonly name: string }
  | { readonly action: "password"; readonly name: string; readonly value?: Redacted.Redacted<string> }
  | { readonly action: "owners"; readonly name: string }
  | { readonly action: "prune"; readonly name: string; readonly apply: boolean }
  | { readonly action: "run"; readonly name: string; readonly scheduled?: boolean }
  | { readonly action: "list"; readonly name: string; readonly owner?: string }
  | { readonly action: "verify"; readonly name: string; readonly snapshot?: string; readonly owner?: string; readonly expectKey?: string }
  | { readonly action: "drill"; readonly name: string; readonly snapshot?: string; readonly owner?: string; readonly expectKey?: string; readonly scheduled?: boolean }
  | { readonly action: "restore"; readonly name: string; readonly snapshot?: string; readonly owner?: string; readonly expectKey?: string;
    readonly target: { readonly kind: "home"; readonly path: string; readonly recoverCredentials: boolean } | { readonly kind: "apply"; readonly replace: boolean; readonly dryRun: boolean } };

/** Defaults are explicit in saved policy, so a release cannot silently change an existing schedule. */
export const defaultBackupPolicy = (destination: BackupDestination): BackupPolicy => ({
  destination,
  folder: true,
  harnesses: { mode: "none", targets: [] },
  compression: "balanced",
  sourceIdentity: false,
  sharedSecrets: false,
  includeCredentials: false,
  include: [],
  exclude: [],
  retention: { last: 5, daily: 7, weekly: 4 },
  maximumBytes: 50 * 1024 ** 3,
  maximumFiles: 1_000_000,
});

/** Keep the union of newest snapshots, newest per UTC day and newest per ISO week. */
export const retainedSnapshots = (snapshots: ReadonlyArray<BackupSnapshot>, retention: BackupPolicy["retention"]): ReadonlySet<string> => {
  const ordered = [...snapshots].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const keep = new Set(ordered.slice(0, retention.last).map(snapshot => snapshot.id));
  const days = new Set<string>();
  const weeks = new Set<string>();
  for (const snapshot of ordered) {
    const day = snapshot.createdAt.slice(0, 10);
    const date = new Date(snapshot.createdAt);
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    const week = date.toISOString().slice(0, 10);
    if (!days.has(day) && days.size < retention.daily) { days.add(day); keep.add(snapshot.id); }
    if (!weeks.has(week) && weeks.size < retention.weekly) { weeks.add(week); keep.add(snapshot.id); }
  }
  return keep;
};
