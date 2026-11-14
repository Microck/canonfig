import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Effect, Schema } from "effect";
import { TaggedError } from "../domain/tagged-error.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { decodeFolderConfig } from "../projection/folder.ts";
import { withRunLock } from "../synchronization/run-lock.ts";
import { BackupIoError, readBackupMetadata } from "./backup-io.ts";
import { BackupName, BackupPolicies, BackupPolicy, BackupRuns, LocalBackups, type BackupOutcome } from "./backup.types.ts";

export class BackupError extends TaggedError<BackupError>()("BackupError", {
  code: Schema.Literals(["BACKUP_INVALID", "BACKUP_TOOL_REQUIRED", "BACKUP_VERIFY_FAILED", "BACKUP_CONFLICT", "BACKUP_CREDENTIAL_REQUIRED"]),
  message: Schema.String,
}) {}

/** Only our own diagnostics cross this boundary. Filesystem and tool errors may contain secrets. */
export const backupWork = <A>(operation: string, work: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({
  try: work,
  catch: cause => new BackupError({
    code: cause instanceof BackupIoError ? cause.code : "BACKUP_INVALID",
    message: cause instanceof BackupIoError ? cause.message : `${operation} failed. Check the private backup files and filesystem permissions.`,
  }),
});

const CodeError = Schema.Struct({ code: Schema.String });
export const missingBackupFile = (cause: unknown): boolean => Schema.is(CodeError)(cause) && cause.code === "ENOENT";
export const localBackupPath = (folder: string): string => join(folder, "backups.json");

export const readLocalBackups = (folder: string) => backupWork("Read local backup configuration", async (): Promise<LocalBackups> => {
  try { return await readBackupMetadata(localBackupPath(folder), LocalBackups); }
  catch (cause) {
    if (missingBackupFile(cause)) return { version: 1, policies: {}, passwords: {}, disabled: [], allowCredentials: [] };
    throw cause;
  }
});

export const writeLocalBackups = (folder: string, configuration: LocalBackups) => Effect.gen(function*() {
  const machine = yield* MachineState;
  const anchor = yield* machine.normalizePath({ path: folder });
  yield* machine.ensureDirectory({ path: anchor, mode: 0o700 });
  yield* machine.atomicWrite({ path: yield* machine.normalizePath({ path: localBackupPath(folder) }), anchor,
    content: new TextEncoder().encode(`${JSON.stringify(configuration, undefined, 2)}\n`), mode: 0o600 });
});

/** Machine-local history of the latest run and drill per policy, beside backups.json. */
export const backupRunsPath = (folder: string): string => join(folder, "backup-runs.json");

export const readBackupRuns = (folder: string) => backupWork("Read backup run history", async (): Promise<BackupRuns> => {
  try { return await readBackupMetadata(backupRunsPath(folder), BackupRuns); }
  catch (cause) {
    if (missingBackupFile(cause)) return {};
    throw cause;
  }
});

/** Scheduled runs of different policies can finish together, so the read-modify-write holds its own lock. */
export const recordBackupOutcome = (folder: string, name: string, kind: "run" | "drill", outcome: BackupOutcome) =>
  withRunLock(backupRunsPath(folder), "record backup outcome", Effect.gen(function*() {
    const machine = yield* MachineState;
    const runs = yield* readBackupRuns(folder);
    const anchor = yield* machine.normalizePath({ path: folder });
    yield* machine.atomicWrite({ path: yield* machine.normalizePath({ path: backupRunsPath(folder) }), anchor,
      content: new TextEncoder().encode(`${JSON.stringify({ ...runs, [name]: { ...runs[name], [kind]: outcome } }, undefined, 2)}\n`), mode: 0o600 });
  }));

export const readBackupPolicies = (folder: string) => Effect.gen(function*() {
  const local = yield* readLocalBackups(folder);
  const declared = yield* backupWork("Read Source backup policies", async (): Promise<BackupPolicies> => {
    let text: string;
    try { text = await readFile(join(folder, "canonfig.jsonc"), "utf8"); }
    catch (cause) { if (missingBackupFile(cause)) return {}; throw cause; }
    return decodeFolderConfig(join(folder, "canonfig.jsonc"), text).backupPolicies ?? {};
  });
  return { local, declared, policies: { ...declared, ...local.policies } };
});
/** Destination passwords are aliases, not credentials embedded in a published policy. */
export const validateBackupPolicy = (policy: BackupPolicy): string | undefined => {
  if (!policy.folder && policy.harnesses.mode === "none" && !policy.sharedSecrets && !policy.sourceIdentity) return "Select the Canonical Folder, Target Harness files, Source identity or shared secrets";
  if (policy.harnesses.mode !== "none" && policy.harnesses.targets.length === 0) return "Select at least one Target Harness";
  if (new Set(policy.harnesses.targets).size !== policy.harnesses.targets.length) return "A Target Harness may be selected only once";
  if (policy.sourceIdentity && !policy.folder) return "Source identity recovery also needs the Canonical Folder";
  if ((policy.sourceIdentity || policy.sharedSecrets || policy.includeCredentials || policy.harnesses.mode === "full") && policy.passwordReference === undefined) return "Source identity, shared secrets and full harness histories require password encryption";
  if (policy.destination.kind === "local" && !isAbsolute(policy.destination.path)) return "Local backup destination must be an absolute path";
  return undefined;
};

export const backupPassword = (policy: BackupPolicy, local: LocalBackups) => Effect.gen(function*() {
  if (policy.passwordReference === undefined) return undefined;
  const reference = local.passwords[policy.passwordReference];
  if (reference === undefined) return yield* new BackupError({ code: "BACKUP_CREDENTIAL_REQUIRED",
    message: `Set the local password alias with 'canonfig backup password ${policy.passwordReference} --stdin' before running this policy.` });
  const machine = yield* MachineState;
  return yield* machine.loadCredential({ reference }).pipe(Effect.mapError(() => new BackupError({
    code: "BACKUP_CREDENTIAL_REQUIRED", message: "The backup password could not be read. Unlock this machine's credential store; no plaintext backup was made.",
  })));
});

export const requireCapturePermission = (name: string, policy: BackupPolicy, local: LocalBackups) => {
  const problem = validateBackupPolicy(policy);
  if (problem !== undefined) return Effect.fail(new BackupError({ code: "BACKUP_INVALID", message: problem }));
  return (policy.includeCredentials || policy.sourceIdentity || policy.sharedSecrets) && !local.allowCredentials.includes(name)
    ? Effect.fail(new BackupError({ code: "BACKUP_CREDENTIAL_REQUIRED",
      message: `Policy ${name} needs local consent. Run 'canonfig backup allow-credentials ${name}' after reviewing what it captures.` }))
    : Effect.void;
};

/** Created once per installation. Never captured or copied into a recovered machine. */
export const backupOwner = (folder: string) => Effect.gen(function*() {
  const machine = yield* MachineState;
  const path = join(folder, ".backup-owner");
  const existing = yield* backupWork("Read backup owner", async () => {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > 64) throw new BackupIoError("BACKUP_INVALID", "Backup owner is not a bounded regular file");
      return Schema.decodeUnknownSync(BackupName)((await readFile(path, "utf8")).trim());
    } catch (cause) { if (missingBackupFile(cause)) return undefined; throw cause; }
  });
  if (existing !== undefined) return existing;
  yield* backupWork("Create backup directory", () => mkdir(folder, { recursive: true, mode: 0o700 }));
  const owner = randomUUID();
  yield* machine.atomicWrite({ path: yield* machine.normalizePath({ path }),
    anchor: yield* machine.normalizePath({ path: folder }), content: new TextEncoder().encode(`${owner}\n`), mode: 0o600, noReplace: true });
  return owner;
});
