import { Schema } from "effect";
import { BackupName, BackupPolicies, BackupPolicy, BackupRuns, BackupSnapshot, LocalBackups, SnapshotId } from "../../backup/backup.types.ts";

export const GuiBackupStatus = Schema.Struct({
  local: LocalBackups,
  declared: BackupPolicies,
  policies: BackupPolicies,
  /** The latest run and restore drill of each policy on this machine. */
  runs: BackupRuns,
  schedules: Schema.Array(Schema.Json),
});
export type GuiBackupStatus = typeof GuiBackupStatus.Type;

const selection = {
  name: BackupName,
  owner: Schema.optional(BackupName),
  snapshot: Schema.optional(SnapshotId),
  expectKey: Schema.optional(SnapshotId),
};
export const GuiBackupRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("configure"), name: BackupName, policy: BackupPolicy, allowCredentials: Schema.Boolean }),
  Schema.Struct({ action: Schema.Literal("password"), name: BackupName,
    password: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096), Schema.isPattern(/^[^\0]+$/u)) }),
  Schema.Struct({ action: Schema.Literal("schedule") }),
  Schema.Struct({ action: Schema.Literals(["run", "enable", "disable", "allow-credentials", "deny-credentials", "owners"]), name: BackupName }),
  Schema.Struct({ action: Schema.Literal("list"), name: BackupName, owner: Schema.optional(BackupName) }),
  Schema.Struct({ action: Schema.Literals(["verify", "drill"]), ...selection }),
  Schema.Struct({ action: Schema.Literal("prune"), name: BackupName, apply: Schema.Boolean }),
  Schema.Struct({ action: Schema.Literal("restore"), ...selection, target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("home"), path: Schema.NonEmptyString, recoverCredentials: Schema.Boolean }),
    Schema.Struct({ kind: Schema.Literal("apply"), replace: Schema.Boolean, dryRun: Schema.Boolean }),
  ]) }),
]);
export type GuiBackupRequest = typeof GuiBackupRequest.Type;
export const GuiBackupList = Schema.Struct({ owner: BackupName, snapshots: Schema.Array(BackupSnapshot) });
export type GuiBackupList = typeof GuiBackupList.Type;
