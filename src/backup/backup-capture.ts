import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { basename, dirname, isAbsolute, join, matchesGlob, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Schema } from "effect";
import { ContentDigest } from "../domain/brand.ts";
import { openAnchoredDirectory, sameIdentity } from "../machine/anchored-directory.ts";
import { archivePathProblem, caseCollision, type ArchiveFile, type ManifestFile } from "../projection/archive.ts";
import type { BackupPolicy } from "./backup.types.ts";
import { BackupIoError, hashBackupFile, runBackupTool } from "./backup-io.ts";

export interface BackupCapture {
  readonly files: ReadonlyArray<ManifestFile>;
  readonly directory: string;
  readonly skippedCredentials: number;
  readonly skippedLinks: number;
}

/**
 * Credential names are an exclusion list, not proof that an arbitrary history/database is safe. Files adapters
 * document as credentials under generic names arrive separately as `credentials`.
 */
const credentialPath = (path: string): boolean => path.split("/").some(part =>
  /^(?:\.?env(?:\..*)?|\.?credentials?(?:\..*)?|auth(?:\.json)?|oauth(?:[-_].*)?|tokens?|secrets|id_rsa|id_ed25519)$/iu.test(part)
  || /\.(?:pem|key|p12|pfx)$/iu.test(part));

export const below = (root: string, path: string): boolean => {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
};

/** Stage each regular file once; metadata is hashed from the staged bytes, never from a second live read. */
export const captureBackupFiles = async (input: {
  readonly policy: BackupPolicy;
  readonly scratch: string;
  readonly home: string;
  readonly files: ReadonlyArray<ArchiveFile>;
  /**
   * Harness roots, plus state folders and files outside them. A missing one is skipped: a harness can be installed
   * with no configuration folder yet (OpenCode with only ~/.local/share/opencode), and that must not stop the backup.
   */
  readonly roots: ReadonlyArray<{ readonly harness: string; readonly root: string }>;
  /** Absolute paths the selected adapters declare as credentials (HarnessLayout.credentials). */
  readonly credentials: ReadonlyArray<string>;
  readonly signal: AbortSignal;
}): Promise<BackupCapture> => {
  const directory = join(input.scratch, "capture");
  await mkdir(directory, { mode: 0o700 });
  const files: Array<ManifestFile> = [];
  let bytes = 0;
  let skippedCredentials = 0;
  const captured = new Set<string>();
  /** Databases taken through SQLite's online backup; only their sidecars are already inside the copy. */
  const snapshotted = new Set<string>();
  const SQLITE_SIDECAR = /-(?:wal|shm|journal)$/u;
  /** SQLite databases start with this 16-byte header, whatever their file name. */
  const isSqliteDatabase = async (path: string): Promise<boolean> => {
    const header = Buffer.alloc(16);
    const probe = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { return (await probe.read(header, 0, 16, 0)).bytesRead === 16 && header.toString("latin1") === "SQLite format 3\0"; }
    finally { await probe.close(); }
  };
  let skippedLinks = 0;
  const selected = (path: string): boolean => {
    if (!input.policy.includeCredentials && credentialPath(path)) { skippedCredentials += 1; return false; }
    return (input.policy.include.length === 0 || input.policy.include.some(pattern => matchesGlob(path, pattern)))
      && !input.policy.exclude.some(pattern => matchesGlob(path, pattern));
  };
  const reserve = (path: string, size: number): void => {
    if (archivePathProblem(path) !== undefined) throw new BackupIoError("BACKUP_INVALID", "A captured filename cannot be restored portably. Exclude or rename it before backing up.");
    bytes += size;
    if (files.length >= input.policy.maximumFiles || bytes > input.policy.maximumBytes) {
      throw new BackupIoError("BACKUP_INVALID", "Capture exceeds this policy's maximumFiles or maximumBytes");
    }
  };
  const record = (file: Omit<ManifestFile, "sha256">, sha256: string): void => {
    files.push({ ...file, sha256: Schema.decodeUnknownSync(ContentDigest)(sha256) });
  };
  for (const file of input.files) {
    // Recovery selections are explicit and encrypted-only. Globs must not silently remove half an identity.
    if (!file.path.startsWith("recovery/") && !selected(file.path)) continue;
    reserve(file.path, file.content.length);
    const destination = join(directory, file.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.content, { flag: "wx", mode: 0o600 });
    record({ path: file.path, size: file.content.length, mode: `0${(file.mode & 0o777).toString(8).padStart(3, "0")}`,
      harness: file.harness, target: file.target, keys: file.keys }, createHash("sha256").update(file.content).digest("hex"));
  }
  for (const root of input.roots) {
    // A root may be a folder or a single file such as ~/.claude.json; a missing one is skipped. The empty-capture
    // check below still refuses a selection that found no files at all.
    const info = await lstat(root.root).catch((error) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info === undefined || (!info.isDirectory() && !info.isFile())) continue;
    const only = info.isFile() ? basename(root.root) : undefined;
    if (root.root === input.home || !below(input.home, root.root) || below(root.root, input.scratch)
      || (input.policy.destination.kind === "local" && below(root.root, input.policy.destination.path))) {
      throw new BackupIoError("BACKUP_INVALID", "A full harness root must be below HOME and cannot contain the backup destination or staging directory");
    }
    const walk = async (path: string, name?: string): Promise<void> => {
      input.signal.throwIfAborted();
      const anchor = await openAnchoredDirectory(input.home, path);
      try {
        for (const entry of (await readdir(anchor.base, { withFileTypes: true })).filter((candidate) => name === undefined || candidate.name === name).sort((a, b) => a.name.localeCompare(b.name))) {
          const source = join(anchor.base, entry.name);
          const absolute = join(path, entry.name);
          const homePath = relative(input.home, absolute).split(sep).join("/");
          const archivePath = `harnesses/${root.harness}/${homePath}`;
          const info = await lstat(source, { bigint: true });
          if (info.isSymbolicLink()) { skippedLinks += 1; continue; }
          // A declared credential database brings its SQLite journal, WAL and shared-memory files with it.
          const declared = input.credentials.some(credential => below(credential, absolute) || ["-wal", "-shm", "-journal"].some(suffix => absolute === `${credential}${suffix}`));
          if (!input.policy.includeCredentials && declared) { skippedCredentials += 1; continue; }
          // Two selected harnesses can resolve to one folder (Pi and Oh My Pi under PI_CODING_AGENT_DIR); each home
          // path is captured once, so a restore never writes the same destination twice.
          if (captured.has(homePath)) continue;
          // A database's journal, WAL and shared memory are already inside its consistent snapshot (below).
          if (SQLITE_SIDECAR.test(entry.name) && snapshotted.has(homePath.replace(SQLITE_SIDECAR, ""))) continue;
          if (info.isDirectory()) {
            if (!input.policy.includeCredentials && credentialPath(archivePath)) { skippedCredentials += 1; continue; }
            if (!input.policy.exclude.some(pattern => matchesGlob(archivePath, pattern))) await walk(absolute);
            continue;
          }
          if (!selected(archivePath)) continue;
          if (!info.isFile()) throw new BackupIoError("BACKUP_INVALID", `Full harness capture found a socket, pipe or device at ${archivePath}. Add it to exclude, then back up again.`);
          if (await isSqliteDatabase(source)) {
            // Copying a live database and its WAL file by file can lose committed rows to a checkpoint between the
            // two reads. SQLite's online backup gives one consistent copy with the WAL folded in, as Source
            // identity capture already does.
            const destination = join(directory, archivePath);
            await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
            const live = new DatabaseSync(source, { readOnly: true });
            try {
              // The snapshot is page_count × page_size bytes with the WAL folded in, so a database the budget can't
              // hold is refused before anything is copied. reserve below still checks the final size.
              const pages = Number(live.prepare("PRAGMA page_count").get()?.["page_count"]);
              const pageSize = Number(live.prepare("PRAGMA page_size").get()?.["page_size"]);
              if (files.length >= input.policy.maximumFiles || bytes + pages * pageSize > input.policy.maximumBytes) {
                throw new BackupIoError("BACKUP_INVALID", "Capture exceeds this policy's maximumFiles or maximumBytes");
              }
              await sqliteBackup(live, destination);
            } catch (error) {
              if (error instanceof BackupIoError) throw error;
              throw new BackupIoError("BACKUP_CONFLICT", `${archivePath} is a database its harness held busy. Close the harness or exclude the file, then back up again.`);
            } finally { live.close(); }
            await chmod(destination, 0o600);
            const snapshot = await hashBackupFile(destination);
            reserve(archivePath, snapshot.bytes);
            captured.add(homePath);
            snapshotted.add(homePath);
            record({ path: archivePath, size: snapshot.bytes, mode: `0${(Number(info.mode) & 0o777).toString(8).padStart(3, "0")}`,
              harness: root.harness, target: `~/${homePath}` }, snapshot.sha256);
            continue;
          }
          reserve(archivePath, Number(info.size));
          captured.add(homePath);
          const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const before = await file.stat({ bigint: true });
            // Same file and same size as when it was listed and reserved, so the copy never runs past the budget.
            if (!before.isFile() || !sameIdentity(info, before) || before.size !== info.size) throw new BackupIoError("BACKUP_CONFLICT", "A harness file changed while it was opened");
            const digest = createHash("sha256");
            const destination = join(directory, archivePath);
            await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
            let copied = 0;
            await pipeline(file.createReadStream({ autoClose: false }), async function*(chunks: AsyncIterable<Uint8Array>) {
              for await (const chunk of chunks) {
                copied += chunk.length;
                if (copied > before.size) throw new BackupIoError("BACKUP_CONFLICT", "A harness file grew during capture");
                digest.update(chunk);
                yield chunk;
              }
            }, createWriteStream(destination, { flags: "wx", mode: 0o600 }), { signal: input.signal });
            const after = await file.stat({ bigint: true });
            const visible = await lstat(source, { bigint: true });
            if (BigInt(copied) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs
              || after.ctimeNs !== before.ctimeNs || !sameIdentity(after, visible)) {
              throw new BackupIoError("BACKUP_CONFLICT", "A harness file changed during capture. Stop the writer or exclude that file, then retry.");
            }
            record({ path: archivePath, size: copied, mode: `0${(Number(before.mode) & 0o777).toString(8).padStart(3, "0")}`,
              harness: root.harness, target: `~/${homePath}` }, digest.digest("hex"));
          } finally { await file.close(); }
        }
        await anchor.verify();
      } finally { await anchor.close(); }
    };
    await (only === undefined ? walk(root.root) : walk(dirname(root.root), only));
  }
  if (files.length === 0) throw new BackupIoError("BACKUP_INVALID", "This policy selected no regular files");
  if (caseCollision(files.map(file => file.path)) !== undefined) throw new BackupIoError("BACKUP_INVALID", "Captured paths collide on a case-insensitive filesystem");
  return { files, directory, skippedCredentials, skippedLinks };
};

/** No captured config, inline allow comment or inherited GITLEAKS variable can disable the required plaintext Git scan. */
export const scanPlaintextGitBackup = async (directory: string, scratch: string, signal: AbortSignal): Promise<void> => {
  const config = join(scratch, "gitleaks.toml");
  const ignore = join(scratch, "gitleaks.ignore");
  await writeFile(config, "[extend]\nuseDefault = true\n", { flag: "wx", mode: 0o600 });
  await writeFile(ignore, "", { flag: "wx", mode: 0o600 });
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GITLEAKS_")));
  await runBackupTool("gitleaks", ["dir", directory, "--config", config, "--gitleaks-ignore-path", ignore,
    "--ignore-gitleaks-allow", "--redact=100", "--no-banner", "--no-color", "--max-decode-depth", "3"], { cwd: scratch, signal, environment });
};
