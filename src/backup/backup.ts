import { randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { Effect, Redacted, Schema } from "effect";
import { ContentDigest, CredentialReference, Timestamp } from "../domain/brand.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { adapterFor } from "../projection/adapters/index.ts";
import { ArchiveIntegrityError, collectArchiveConfiguration, machineIdentity, MANIFEST_PATH, manifestSigningPayload, MAXIMUM_MANIFEST_BYTES, SIGNATURE_PATH, verifyArchiveStream, type ArchiveSigner, type ArchiveSignerError, type ExportManifest, type ManifestFile } from "../projection/archive.ts";
import { encodeTar, type TarSource } from "../projection/archive-tar.ts";
import { emptyModel } from "../projection/detect.ts";
import { rootContext } from "../projection/plan.ts";
import { importLocal } from "../projection/sync.ts";
import { sha256BytesHex } from "../profile/profile-codec.ts";
import { packageVersion } from "../runtime/build-identity.ts";
import { withRunLock } from "../synchronization/run-lock.ts";
import { captureBackupFiles, below, scanPlaintextGitBackup } from "./backup-capture.ts";
import { decodeBackup, encodeBackup } from "./backup-codec.ts";
import { backupOwner, backupPassword, BackupError, backupWork, localBackupPath, readBackupPolicies, readBackupRuns, readLocalBackups, recordBackupOutcome, requireCapturePermission, validateBackupPolicy, writeLocalBackups } from "./backup-config.ts";
import { BackupIoError, hashBackupFile, readBackupMetadata } from "./backup-io.ts";
import { captureRecovery, readRecovery, restoreRecovery, withRecoveryCredentials, type Recovery } from "./backup-recovery.ts";
import { backupScheduleStatus, reconcileBackupSchedules } from "./backup-schedule.ts";
import { listBackupOwners, openBackupStorage, type BackupStorage } from "./backup-storage.ts";
import { BackupName, BackupPolicy, retainedSnapshots, type BackupOutcome, type BackupRequest, type BackupSnapshot, type LocalBackups } from "./backup.types.ts";

interface BackupContext {
  readonly statePath: string;
  readonly sourceSigner: Effect.Effect<ArchiveSigner, ArchiveSignerError>;
  readonly environment: (name: string) => string | undefined;
}
interface OpenBackup {
  readonly name: string; readonly owner: string; readonly policy: BackupPolicy; readonly local: LocalBackups;
  readonly scratch: string; readonly storage: BackupStorage;
}
const unpackedLimit = (policy: BackupPolicy): number => policy.maximumBytes + policy.maximumFiles * 4096 + 64 * 1024 * 1024;
const tarFile = (path: string, content: Uint8Array): TarSource => ({ path, content, size: content.length, mode: 0o600 });
const stagedSource = (directory: string, file: ManifestFile): TarSource => ({
  path: file.path, size: file.size, mode: Number.parseInt(file.mode, 8),
  content: (async function*() { yield* createReadStream(join(directory, file.path)); })(),
});

const readPasswordInput = () => backupWork("Read backup password", async () => {
  if (process.stdin.isTTY) throw new BackupIoError("BACKUP_INVALID", "Pipe the password to 'canonfig backup password NAME --stdin'; it is never accepted as an argument");
  const chunks: Array<Buffer> = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 16 * 1024) throw new BackupIoError("BACKUP_INVALID", "Backup passwords must be at most 16 KiB");
    chunks.push(value);
  }
  const value = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)).replace(/\r?\n$/u, "");
  if (value.length === 0 || value.includes("\0")) throw new BackupIoError("BACKUP_INVALID", "Backup password must be non-empty UTF-8 without NUL characters");
  return Redacted.make(value);
});

const configure = (folder: string, request: Extract<BackupRequest, { readonly action: "configure" }>) => Effect.gen(function*() {
  const policy = yield* Schema.decodeUnknownEffect(BackupPolicy)(request.policy).pipe(Effect.mapError(() => new BackupError({ code: "BACKUP_INVALID", message: "The backup policy does not match the documented schema" })));
  const problem = validateBackupPolicy(policy);
  if (problem !== undefined) return yield* new BackupError({ code: "BACKUP_INVALID", message: problem });
  yield* withRunLock(localBackupPath(folder), "configure backup", Effect.gen(function*() {
    const local = yield* readLocalBackups(folder);
    yield* writeLocalBackups(folder, { ...local, policies: { ...local.policies, [request.name]: policy },
      disabled: local.disabled.filter(name => name !== request.name),
      allowCredentials: request.allowCredentials === undefined ? local.allowCredentials
        : request.allowCredentials ? [...new Set([...local.allowCredentials, request.name])]
        : local.allowCredentials.filter(name => name !== request.name) });
  }));
  return { configured: request.name, schedules: yield* reconcileBackupSchedules(folder) };
});

const changeConfiguration = (folder: string, request: Extract<BackupRequest, { readonly action: "disable" | "enable" | "allow-credentials" | "deny-credentials" }>) => Effect.gen(function*() {
  yield* withRunLock(localBackupPath(folder), "change backup policy", Effect.gen(function*() {
    const { local, policies } = yield* readBackupPolicies(folder);
    if (policies[request.name] === undefined) return yield* new BackupError({ code: "BACKUP_INVALID", message: "No backup policy has that name" });
    const disabled = new Set(local.disabled);
    const allowed = new Set(local.allowCredentials);
    if (request.action === "disable") disabled.add(request.name);
    if (request.action === "enable") disabled.delete(request.name);
    if (request.action === "allow-credentials") allowed.add(request.name);
    if (request.action === "deny-credentials") allowed.delete(request.name);
    yield* writeLocalBackups(folder, { ...local, disabled: [...disabled], allowCredentials: [...allowed] });
  }));
  return { changed: request.name, action: request.action, schedules: yield* reconcileBackupSchedules(folder) };
});

const withStorage = <A, E, R>(folder: string, name: string, owner: string | undefined, use: (opened: OpenBackup) => Effect.Effect<A, E, R>) =>
  withRunLock(localBackupPath(folder), "access backup repository", Effect.gen(function*() {
    const { local, policies } = yield* readBackupPolicies(folder);
    const policy = policies[name];
    if (policy === undefined) return yield* new BackupError({ code: "BACKUP_INVALID", message: "No backup policy has that name" });
    const identity = owner ?? (yield* backupOwner(folder));
    return yield* Effect.acquireUseRelease(
      backupWork("Create private backup staging", () => mkdtemp(join(tmpdir(), "canonfig-backup-"))),
      scratch => Effect.acquireUseRelease(
        backupWork("Open backup destination", signal => openBackupStorage({ destination: policy.destination, policy: name, owner: identity, scratch, signal })),
        storage => use({ name, owner: identity, policy, local, scratch, storage }),
        storage => Effect.promise(() => storage.close()),
      ),
      scratch => Effect.promise(() => rm(scratch, { recursive: true, force: true })),
    );
  }));

const capture = (context: BackupContext, opened: OpenBackup) => Effect.gen(function*() {
  yield* requireCapturePermission(opened.name, opened.policy, opened.local);
  if (opened.local.disabled.includes(opened.name)) return yield* new BackupError({ code: "BACKUP_INVALID", message: "This backup policy is disabled locally" });
  const password = yield* backupPassword(opened.policy, opened.local);
  const captured = yield* withRunLock(context.statePath, "capture backup", Effect.gen(function*() {
    const folder = dirname(context.statePath);
    const identity = yield* machineIdentity;
    const roots = yield* rootContext(context.environment);
    const configuration = opened.policy.folder || opened.policy.harnesses.mode === "managed"
      ? yield* collectArchiveConfiguration({ folder, includeFolder: opened.policy.folder, includeHarnesses: opened.policy.harnesses.mode === "managed" })
      : { folderFiles: [], harnesses: { files: [], skipped: [] } };
    const recovery = yield* captureRecovery({ folder, statePath: context.statePath, policy: opened.policy, scratch: opened.scratch });
    // A full capture takes the harness root plus what the adapter keeps outside it: state folders (OpenCode keeps
    // opencode.db under the XDG data directory) and config files (Claude's ~/.claude.json), each path once.
    // Paths that don't exist yet are skipped.
    const full = opened.policy.harnesses.mode === "full" ? opened.policy.harnesses.targets.flatMap(harness => {
      const layout = adapterFor(harness).layout(roots, emptyModel(folder));
      const configs = layout.surfaces.flatMap(surface => surface.kind === "config" ? [surface.target, ...(surface.alternatives ?? [])] : []);
      const outside = [...new Set([...layout.neverTouch, ...configs])].filter(path => !below(layout.root, path));
      const extra = outside.filter(path => !outside.some(other => other !== path && below(other, path)));
      return [{ harness, root: layout.root, optional: false }, ...extra.map(root => ({ harness, root, optional: true }))];
    }) : [];
    const managed = configuration.harnesses.files.filter(file => opened.policy.harnesses.targets.some(target => target === file.harness));
    const staged = yield* backupWork("Capture backup files", signal => captureBackupFiles({
      policy: opened.policy, scratch: opened.scratch, home: roots.home, files: [...configuration.folderFiles, ...managed, ...recovery.files], roots: full, signal,
    }));
    const files = [...staged.files];
    if (recovery.sourceDatabase !== undefined) {
      const database = recovery.sourceDatabase;
      const file = yield* backupWork("Stage Source database", async () => {
        const path = "recovery/source-state.sqlite";
        await copyFile(database, join(staged.directory, path), constants.COPYFILE_EXCL);
        const digest = await hashBackupFile(join(staged.directory, path));
        return { path, size: digest.bytes, sha256: Schema.decodeUnknownSync(ContentDigest)(digest.sha256), mode: "0600" };
      });
      files.push(file);
    }
    if (files.length > opened.policy.maximumFiles || files.reduce((sum, file) => sum + file.size, 0) > opened.policy.maximumBytes) {
      return yield* new BackupError({ code: "BACKUP_INVALID", message: "Recovery extras exceed maximumBytes or maximumFiles" });
    }
    const manifest: ExportManifest = { format: "canonfig-export", version: 2, canonfigVersion: packageVersion,
      createdAt: Schema.decodeUnknownSync(Timestamp)(new Date().toISOString()), role: identity.role,
      files: files.sort((left, right) => left.path.localeCompare(right.path)) };
    const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    if (bytes.length > MAXIMUM_MANIFEST_BYTES) {
      return yield* new BackupError({ code: "BACKUP_INVALID", message: `The backup lists too many files to restore (${files.length}). Exclude caches or histories with exclude globs, or capture fewer harness folders.` });
    }
    const prefix = [tarFile(MANIFEST_PATH, bytes)];
    if (identity.role === "source") {
      const signer = yield* context.sourceSigner;
      const signature = yield* signer.sign(manifestSigningPayload(sha256BytesHex(bytes)));
      prefix.push(tarFile(SIGNATURE_PATH, Buffer.from(JSON.stringify({ fingerprint: signer.fingerprint, publicKey: signer.publicKey, signature }))));
    }
    return { staged, manifest, prefix, skippedManagedSurfaces: configuration.harnesses.skipped };
  }));
  if (opened.policy.destination.kind === "git" && password === undefined) {
    yield* backupWork("Scan plaintext Git backup", signal => scanPlaintextGitBackup(captured.staged.directory, opened.scratch, signal));
  }
  const archive = join(opened.scratch, "archive");
  const codec = yield* backupWork("Encode backup", signal => encodeBackup({ preset: opened.policy.compression, password, scratch: opened.scratch, output: archive,
    maximumBytes: unpackedLimit(opened.policy), signal, bytes: encodeTar([...captured.prefix, ...captured.manifest.files.map(file => stagedSource(captured.staged.directory, file))]) }));
  const digest = yield* backupWork("Hash backup archive", () => hashBackupFile(archive));
  if (digest.bytes > unpackedLimit(opened.policy)) return yield* new BackupError({ code: "BACKUP_INVALID", message: "Encoded backup exceeds the policy's archive size budget" });
  const snapshot = yield* backupWork("Publish and read back backup", () => opened.storage.save({
    version: 1, id: digest.sha256, archiveSha256: digest.sha256, bytes: digest.bytes,
    owner: opened.owner, policy: opened.name, createdAt: captured.manifest.createdAt,
    compression: opened.policy.compression, codec, encrypted: password !== undefined, files: captured.manifest.files.length,
  }, archive));
  const retention = yield* backupWork("Apply retention after verified publication", async () => {
    const snapshots = await opened.storage.list();
    const retained = retainedSnapshots(snapshots, opened.policy.retention);
    const removed = snapshots.filter(candidate => !retained.has(candidate.id));
    await opened.storage.prune(removed, snapshots.filter(candidate => retained.has(candidate.id)));
    return { removed: removed.map(candidate => candidate.id), retained: retained.size };
  });
  return { snapshot, retention, verifiedRemote: true, skippedCredentials: captured.staged.skippedCredentials,
    skippedLinks: captured.staged.skippedLinks, skippedManagedSurfaces: captured.skippedManagedSurfaces };
});

/** Storage lists copies in no particular order; callers that pick or show "latest" sort with this. */
const newestFirst = (snapshots: ReadonlyArray<BackupSnapshot>) =>
  [...snapshots].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));

const selectSnapshot = (snapshots: ReadonlyArray<BackupSnapshot>, requested: string | undefined): BackupSnapshot => {
  const snapshot = requested === undefined
    ? newestFirst(snapshots)[0]
    : snapshots.find(candidate => candidate.id === requested);
  if (snapshot === undefined) throw new BackupIoError("BACKUP_INVALID", "No matching backup snapshot exists for this owner");
  return snapshot;
};

const readSnapshot = (opened: OpenBackup, requested: string | undefined, expectKey: string | undefined) => Effect.gen(function*() {
  const password = yield* backupPassword(opened.policy, opened.local);
  return yield* backupWork("Verify backup snapshot", async signal => {
    const snapshot = selectSnapshot(await opened.storage.list(), requested);
    if (snapshot.bytes > unpackedLimit(opened.policy) || snapshot.files > opened.policy.maximumFiles) throw new BackupIoError("BACKUP_INVALID", "Snapshot exceeds this policy's recovery budget; review and raise its limits before restoring");
    const archive = join(opened.scratch, "download");
    await opened.storage.download(snapshot, archive);
    const extracted = join(opened.scratch, "verified");
    await mkdir(extracted, { mode: 0o700 });
    let recovery: Recovery | undefined;
    const verified = await decodeBackup({ archive, encrypted: snapshot.encrypted, codec: snapshot.codec, password, scratch: opened.scratch,
      maximumBytes: unpackedLimit(opened.policy), signal, consume: bytes => verifyArchiveStream({ path: snapshot.id, bytes,
      maximumBytes: opened.policy.maximumBytes, maximumFiles: opened.policy.maximumFiles, consume: async (file, content) => {
        if (!file.path.startsWith("folder/") && !file.path.startsWith("harnesses/")
          && file.path !== "recovery/credentials.json" && file.path !== "recovery/source-state.sqlite") throw new BackupIoError("BACKUP_VERIFY_FAILED", "Backup contains an unsupported recovery entry");
        if (file.path.startsWith("recovery/") && !snapshot.encrypted) throw new BackupIoError("BACKUP_VERIFY_FAILED", "Recovery credentials must be encrypted");
        if (file.path === "recovery/credentials.json") { recovery = await readRecovery(content); return; }
        const path = join(extracted, file.path);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await pipeline(Readable.from(content), createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal });
      } }) }).catch((cause: unknown) => {
        if (cause instanceof ArchiveIntegrityError) throw new BackupIoError("BACKUP_VERIFY_FAILED", "The archive manifest, signature or file digest is invalid; no restore was published");
        throw cause;
      });
    if (expectKey !== undefined && verified.signer !== expectKey) throw new BackupIoError("BACKUP_VERIFY_FAILED", "Backup was not signed by the expected Source key");
    if (snapshot.files !== verified.manifest.files.length) throw new BackupIoError("BACKUP_VERIFY_FAILED", "Snapshot file count differs from its archive");
    return { snapshot, extracted, recovery, ...verified };
  });
});
interface VerifiedBackup {
  readonly snapshot: BackupSnapshot;
  readonly extracted: string;
  readonly recovery: Recovery | undefined;
  readonly manifest: ExportManifest;
  readonly manifestSha256: ContentDigest;
  readonly signer: string | undefined;
}

/** A new private HOME only. No path from a remote manifest can reach the running machine's HOME. */
const restoreHome = async (verified: VerifiedBackup, output: string, scratch: string, references: ReadonlyMap<string, CredentialReference>) => {
  const stagedHome = join(scratch, "restore-home");
  await mkdir(stagedHome, { mode: 0o700 });
  let restoredFiles = 0;
  for (const file of verified.manifest.files) {
    let path: string;
    if (file.path.startsWith("folder/")) path = `.canonfig/${file.path.slice("folder/".length)}`;
    else if (file.path.startsWith("harnesses/")) {
      const expected = file.path.split("/").slice(2).join("/");
      if (file.target !== `~/${expected}` || expected.length === 0) throw new BackupIoError("BACKUP_VERIFY_FAILED", "Harness recovery target does not match its archived path");
      path = expected;
    } else continue;
    const target = join(stagedHome, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(verified.extracted, file.path), target, constants.COPYFILE_EXCL);
    const restored = await hashBackupFile(target);
    if (restored.sha256 !== file.sha256 || restored.bytes !== file.size) throw new BackupIoError("BACKUP_VERIFY_FAILED", "Restored bytes differ from the archive");
    // Private recovery tree first; restore only execute intent until the owner moves it into service.
    const mode = Number.parseInt(file.mode, 8) & 0o100 ? 0o700 : 0o600;
    await chmod(target, mode);
    restoredFiles += 1;
  }
  const recovery = await restoreRecovery({ extracted: verified.extracted, home: stagedHome, recovery: verified.recovery, references });
  // Every payload has been verified before the destination becomes visible. mkdir refuses existing paths.
  await mkdir(output, { mode: 0o700 });
  const publish = async (directory: string, relativePath: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(relativePath, entry.name);
      if (entry.isDirectory()) { await mkdir(join(output, path), { mode: 0o700 }); await publish(join(directory, entry.name), path); }
      else await copyFile(join(directory, entry.name), join(output, path), constants.COPYFILE_EXCL);
    }
  };
  try { await publish(stagedHome, ""); }
  catch (cause) { await rm(output, { recursive: true, force: true }); throw cause; }
  return { output, files: restoredFiles, ...recovery };
};

const importArchive = (verified: VerifiedBackup, scratch: string) => backupWork("Prepare Canonical Folder import", async signal => {
  const files = verified.manifest.files.filter(file => file.path.startsWith("folder/"));
  if (files.length === 0) throw new BackupIoError("BACKUP_INVALID", "This snapshot has no Canonical Folder to apply");
  // The original archive was already authenticated. This private, reduced archive is only the input to the existing import planner.
  const manifest: ExportManifest = { ...verified.manifest, role: "standalone", files };
  const output = join(scratch, "import.tar.gz");
  await pipeline(Readable.from(encodeTar([tarFile(MANIFEST_PATH, Buffer.from(JSON.stringify(manifest))),
    ...files.map(file => stagedSource(verified.extracted, file))])), createGzip(), createWriteStream(output, { flags: "wx", mode: 0o600 }), { signal });
  return output;
});

export const backupCommand = Effect.fn("Backup.command")(function*(context: BackupContext, request: BackupRequest) {
  const folder = dirname(context.statePath);
  const machine = yield* MachineState;
  yield* machine.ensureDirectory({ path: yield* machine.normalizePath({ path: folder }), mode: 0o700 });
  if ("name" in request) yield* Schema.decodeUnknownEffect(BackupName)(request.name).pipe(Effect.mapError(() => new BackupError({ code: "BACKUP_INVALID", message: "Backup names use 1-64 letters, digits, underscores or hyphens" })));
  if (request.action === "status") return { ...yield* readBackupPolicies(folder), runs: yield* readBackupRuns(folder), schedules: yield* backupScheduleStatus(folder) };
  if (request.action === "schedule") return yield* reconcileBackupSchedules(folder);
  if (request.action === "configure-file") {
    const policy = yield* backupWork("Read backup policy", () => readBackupMetadata(resolve(request.file), BackupPolicy));
    return yield* configure(folder, { action: "configure", name: request.name, policy, allowCredentials: request.allowCredentials });
  }
  if (request.action === "configure") return yield* configure(folder, request);
  if (request.action === "disable" || request.action === "enable" || request.action === "allow-credentials" || request.action === "deny-credentials") return yield* changeConfiguration(folder, request);
  if (request.action === "password") return yield* withRunLock(localBackupPath(folder), "set backup password", Effect.gen(function*() {
    const local = yield* readLocalBackups(folder);
    if (local.passwords[request.name] !== undefined) return yield* new BackupError({ code: "BACKUP_CONFLICT", message: "That password alias already protects snapshots. Use a new alias rather than replacing a recovery password." });
    const value = request.value ?? (yield* readPasswordInput());
    const reference = yield* machine.storeCredential({ name: `canonfig-backup-${randomUUID()}`, value });
    yield* writeLocalBackups(folder, { ...local, passwords: { ...local.passwords, [request.name]: reference } }).pipe(
      Effect.tapError(() => machine.removeCredential(reference).pipe(Effect.ignore)),
    );
    return { passwordAlias: request.name, warning: "Keep a separate copy of this password. Losing it makes the encrypted backups unrecoverable." };
  }));
  const owner = "owner" in request ? request.owner : undefined;
  // Runs and drills leave their latest outcome for the GUI. Recording is best-effort: a history write that fails
  // never changes the command's result. Only Canonfig's own diagnostics are kept; other failures may carry tool
  // output, so they are recorded as a generic failure.
  const record = (kind: "run" | "drill", outcome: Omit<BackupOutcome, "at">) =>
    recordBackupOutcome(folder, request.name, kind, { at: new Date().toISOString(), ...outcome }).pipe(Effect.ignore);
  return yield* withStorage(folder, request.name, owner, opened => Effect.gen(function*() {
    if (request.action === "owners") return { owners: yield* backupWork("List backup owners", signal => listBackupOwners({ destination: opened.policy.destination, policy: opened.name, scratch: opened.scratch, signal })) };
    if (request.action === "list") return { owner: opened.owner, snapshots: newestFirst(yield* backupWork("List backup snapshots", () => opened.storage.list())) };
    if (request.action === "run") {
      const captured = yield* capture(context, opened);
      yield* record("run", { ok: true, bytes: captured.snapshot.bytes, files: captured.snapshot.files });
      return captured;
    }
    if (request.action === "prune") return yield* backupWork("Prune backup snapshots", async () => {
      const snapshots = await opened.storage.list();
      const retained = retainedSnapshots(snapshots, opened.policy.retention);
      const removed = snapshots.filter(snapshot => !retained.has(snapshot.id));
      if (request.apply) await opened.storage.prune(removed, snapshots.filter(snapshot => retained.has(snapshot.id)));
      return { owner: opened.owner, applied: request.apply, removed: removed.map(snapshot => snapshot.id), retained: retained.size };
    });
    const verified = yield* readSnapshot(opened, request.snapshot, request.expectKey);
    if (request.action === "verify") return { snapshot: verified.snapshot.id, verified: true, files: verified.manifest.files.length, signer: verified.signer };
    if (request.action === "drill") {
      const restored = yield* withRecoveryCredentials({ recovery: verified.recovery, recoverCredentials: true, keep: false }, references =>
        backupWork("Run restore drill", () => restoreHome(verified, join(opened.scratch, "drill"), opened.scratch, references)));
      yield* record("drill", { ok: true, files: restored.files });
      return { snapshot: verified.snapshot.id, verified: true, restoredFiles: restored.files, sourceIdentity: restored.source, secrets: restored.secrets };
    }
    if (request.target.kind === "apply") {
      const archive = yield* importArchive(verified, opened.scratch);
      return { snapshot: verified.snapshot.id, signer: verified.signer,
        outcome: yield* importLocal(context.statePath, archive, request.target.dryRun ? "plan" : "apply", request.target.replace, undefined) };
    }
    const output = resolve(request.target.path);
    const home = (yield* machine.userDirectories()).home.absolute;
    if (output === home || below(folder, output)) return yield* new BackupError({ code: "BACKUP_INVALID", message: "Offline recovery needs a new HOME directory outside the active Canonical Folder" });
    const recoverCredentials = request.target.recoverCredentials;
    const restored = yield* withRecoveryCredentials({ recovery: verified.recovery, recoverCredentials, keep: true }, references =>
      backupWork("Restore into new private HOME", () => restoreHome(verified, output, opened.scratch, references)));
    return { snapshot: verified.snapshot.id, signer: verified.signer, ...restored };
  })).pipe(Effect.tapError((error) => request.action === "run" || request.action === "drill"
    // withStorage has released its lock by now (a failure may come from opening the destination), so take it
    // again. If another operation holds it, the failure record is skipped.
    ? withRunLock(localBackupPath(folder), "record backup outcome",
      record(request.action, { ok: false, message: error instanceof BackupError ? error.message : "The backup failed. Run it from the command line to see why." })).pipe(Effect.ignore)
    : Effect.void));
});
