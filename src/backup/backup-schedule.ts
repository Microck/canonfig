import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { MachineState } from "../machine/machine-state.service.ts";
import { caseCollision } from "../projection/archive.ts";
import { calendarFor, validateSchedule } from "../schedule/schedule-manager.layer.ts";
import { stableRuntimeExecutable } from "../schedule/schedule-command.ts";
import { SyncScheduleSchema } from "../schedule/schedule-manager.types.ts";
import { withRunLock } from "../synchronization/run-lock.ts";
import { BackupError, backupPassword, backupWork, localBackupPath, missingBackupFile, readBackupPolicies, requireCapturePermission } from "./backup-config.ts";
import { readBackupMetadata } from "./backup-io.ts";
import { BackupName } from "./backup.types.ts";

const BackupJob = Schema.Struct({ name: BackupName, action: Schema.Literals(["run", "drill"]), schedule: SyncScheduleSchema });
type BackupJob = typeof BackupJob.Type;
const keyOf = (job: BackupJob): string => `${job.name}/${job.action}`;
const journalPath = (folder: string): string => join(folder, ".backup-jobs.json");

const render = (job: BackupJob) => Effect.gen(function*() {
  const machine = yield* MachineState;
  const platform = (yield* machine.userDirectories()).home.platform;
  const schedule = yield* validateSchedule(job.schedule);
  return yield* machine.renderSchedulerJob({
    name: `canonfig-backup-${job.name}-${job.action}`,
    description: `Canonfig backup ${job.action}: ${job.name}`,
    executable: yield* machine.normalizePath({ path: stableRuntimeExecutable() }),
    arguments: [fileURLToPath(new URL("../runtime/main.js", import.meta.url)), "backup", job.action, job.name, "--scheduled", "--json"],
    calendar: yield* calendarFor(platform, schedule),
  });
});

const readJobs = (folder: string) => backupWork("Read backup schedule journal", async (): Promise<ReadonlyArray<BackupJob>> => {
  try { return await readBackupMetadata(journalPath(folder), Schema.Array(BackupJob)); }
  catch (cause) { if (missingBackupFile(cause)) return []; throw cause; }
});
const writeJobs = (folder: string, jobs: ReadonlyArray<BackupJob>) => Effect.gen(function*() {
  const machine = yield* MachineState;
  yield* machine.atomicWrite({ path: yield* machine.normalizePath({ path: journalPath(folder) }),
    anchor: yield* machine.normalizePath({ path: folder }), content: Buffer.from(`${JSON.stringify(jobs)}\n`), mode: 0o600 });
});

export const backupScheduleStatus = (folder: string) => Effect.gen(function*() {
  const machine = yield* MachineState;
  return yield* Effect.forEach(yield* readJobs(folder), job => Effect.gen(function*() {
    const definition = yield* render(job);
    return { name: job.name, action: job.action, schedule: job.schedule, inspection: yield* machine.inspectSchedulerJob(definition) };
  }));
});

/** Only this namespace is reconciled. Synchronization schedules remain locally controlled. */
export const reconcileBackupSchedules = Effect.fn("Backup.reconcileSchedules")(function*(folder: string) {
  return yield* withRunLock(localBackupPath(folder), "reconcile backup schedules", Effect.gen(function*() {
    const machine = yield* MachineState;
    const { local, policies } = yield* readBackupPolicies(folder);
    if (caseCollision(Object.keys(policies)) !== undefined) return yield* new BackupError({ code: "BACKUP_INVALID", message: "Backup policy names must be unique on case-insensitive machines" });
    const desired: Array<BackupJob> = [];
    for (const [name, policy] of Object.entries(policies)) {
      if (local.disabled.includes(name) || (policy.schedule === undefined && policy.drillSchedule === undefined)) continue;
      yield* requireCapturePermission(name, policy, local);
      yield* backupPassword(policy, local);
      if (policy.schedule !== undefined) desired.push({ name, action: "run", schedule: policy.schedule });
      if (policy.drillSchedule !== undefined) desired.push({ name, action: "drill", schedule: policy.drillSchedule });
    }
    const previous = yield* readJobs(folder);
    if (desired.length === 0 && previous.length === 0) return { installed: 0, removed: 0 };
    // Persist ownership before native writes. An interrupted install/removal remains discoverable on retry.
    const pending = new Map([...previous, ...desired].map(job => [keyOf(job), job]));
    const definitions = yield* Effect.forEach(desired, job => render(job).pipe(Effect.map(definition => ({ job, definition }))));
    yield* writeJobs(folder, [...pending.values()]);
    let installed = 0;
    let removed = 0;
    for (const { definition } of definitions) {
      const before = yield* machine.inspectSchedulerJob(definition);
      if (before.installed && before.enabled && before.matches && before.active !== false && (before.overrides?.length ?? 0) === 0) continue;
      if ((before.overrides?.length ?? 0) > 0) return yield* new BackupError({ code: "BACKUP_CONFLICT", message: "A native override changes a backup job. Remove the override before reconciling backup schedules." });
      yield* machine.installSchedulerJob(definition);
      const after = yield* machine.inspectSchedulerJob(definition);
      if (!after.installed || !after.enabled || !after.matches || after.active === false) return yield* new BackupError({ code: "BACKUP_VERIFY_FAILED", message: "The native scheduler did not arm the backup job. Its ownership journal is retained for retry." });
      installed += 1;
    }
    const kept = new Set(desired.map(keyOf));
    for (const job of previous) {
      if (kept.has(keyOf(job))) continue;
      const definition = yield* render(job);
      yield* machine.removeSchedulerJob(definition);
      if ((yield* machine.inspectSchedulerJob(definition)).installed) return yield* new BackupError({ code: "BACKUP_VERIFY_FAILED", message: "The native scheduler did not remove the retired backup job" });
      removed += 1;
    }
    yield* writeJobs(folder, desired);
    return { installed, removed };
  }));
});
