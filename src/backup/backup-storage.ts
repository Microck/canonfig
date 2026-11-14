import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { isAbsolute, join, parse } from "node:path";
import { Schema } from "effect";
import { openAnchoredDirectory } from "../machine/anchored-directory.ts";
import { BackupName, BackupSnapshot, SnapshotId, type BackupDestination } from "./backup.types.ts";
import { BackupIoError, hashBackupFile, readBackupMetadata, runBackupTool } from "./backup-io.ts";

const partBytes = 48 * 1024 * 1024;
const snapshotName = /^[0-9a-f]{64}\.json$/u;
const digestName = /^[0-9a-f]{64}$/u;

export interface BackupStorage {
  readonly list: () => Promise<ReadonlyArray<BackupSnapshot>>;
  /** Parts become durable and are read back before the snapshot record is published. */
  readonly save: (snapshot: Omit<BackupSnapshot, "parts">, archive: string) => Promise<BackupSnapshot>;
  readonly download: (snapshot: BackupSnapshot, output: string) => Promise<void>;
  readonly prune: (removed: ReadonlyArray<BackupSnapshot>, kept: ReadonlyArray<BackupSnapshot>) => Promise<void>;
  readonly close: () => Promise<void>;
}

const splitArchive = async (archive: string, directory: string): Promise<ReadonlyArray<{ readonly path: string; readonly sha256: string; readonly bytes: number }>> => {
  const input = await open(archive, "r");
  const parts: Array<{ path: string; sha256: string; bytes: number }> = [];
  const buffer = Buffer.alloc(Math.min(partBytes, (await input.stat()).size));
  try {
    for (;;) {
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = await input.read(buffer, bytes, buffer.length - bytes);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
      }
      if (bytes === 0) return parts;
      const content = buffer.subarray(0, bytes);
      const sha256 = createHash("sha256").update(content).digest("hex");
      const path = join(directory, `part-${parts.length}`);
      await writeFile(path, content, { flag: "wx", mode: 0o600 });
      parts.push({ path, sha256, bytes });
    }
  } finally { await input.close(); }
};

const assemble = async (snapshot: BackupSnapshot, output: string, read: (digest: string, index: number) => Promise<string>): Promise<void> => {
  const destination = await open(output, "wx", 0o600);
  const archiveHash = createHash("sha256");
  let total = 0;
  try {
    for (const [index, part] of snapshot.parts.entries()) {
      const path = await read(part.sha256, index);
      const digest = createHash("sha256");
      let size = 0;
      const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      for await (const chunk of source.createReadStream()) {
        size += chunk.length;
        total += chunk.length;
        if (size > part.bytes || total > snapshot.bytes) throw new BackupIoError("BACKUP_VERIFY_FAILED", "Stored backup exceeds its declared size");
        digest.update(chunk);
        archiveHash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await destination.write(chunk, offset);
          if (bytesWritten === 0) throw new BackupIoError("BACKUP_INVALID", "Backup download made no write progress");
          offset += bytesWritten;
        }
      }
      if (size !== part.bytes || digest.digest("hex") !== part.sha256) throw new BackupIoError("BACKUP_VERIFY_FAILED", "Stored backup part does not match its checksum");
    }
    if (total !== snapshot.bytes || archiveHash.digest("hex") !== snapshot.archiveSha256) {
      throw new BackupIoError("BACKUP_VERIFY_FAILED", "Stored archive does not match its checksum");
    }
    await destination.sync();
  } finally { await destination.close(); }
};

const checkedSnapshot = (snapshot: BackupSnapshot, policy: string, owner: string): BackupSnapshot => {
  if (snapshot.policy !== policy || snapshot.owner !== owner || snapshot.parts.length === 0
    || snapshot.parts.some(part => part.bytes > partBytes)
    || snapshot.parts.reduce((sum, part) => sum + part.bytes, 0) !== snapshot.bytes) {
    throw new BackupIoError("BACKUP_VERIFY_FAILED", "Snapshot metadata does not match its repository or archive size");
  }
  return snapshot;
};

const checkGitRemote = (remote: string): void => {
  if (isAbsolute(remote) || remote.startsWith("file:///") || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9/_~.-]+$/u.test(remote)) return;
  try {
    const url = new URL(remote);
    if ((url.protocol === "https:" && url.username === "" && url.password === "")
      || (url.protocol === "ssh:" && url.password === "")) return;
  } catch { /* Report one safe message without echoing a credential-bearing URL. */ }
  throw new BackupIoError("BACKUP_INVALID", "Git backup needs an HTTPS, SSH, file URL or absolute local repository path. Keep tokens in the Git credential helper, never in the URL.");
};

/** One writer owns one namespace. A restored machine gets a new owner id, never a copied lease. */
export const openBackupStorage = async (input: {
  readonly destination: BackupDestination;
  readonly policy: string;
  readonly owner: string;
  readonly scratch: string;
  readonly signal: AbortSignal;
}): Promise<BackupStorage> => {
  const policy = Schema.decodeUnknownSync(BackupName)(input.policy);
  const owner = Schema.decodeUnknownSync(BackupName)(input.owner);
  const namespace = `canonfig-backup/${policy}/${owner}`;
  const tool = (name: string, args: ReadonlyArray<string>, extra: { readonly output?: string; readonly text?: string; readonly environment?: NodeJS.ProcessEnv } = {}) =>
    runBackupTool(name, args, { cwd: input.scratch, signal: input.signal, ...extra });
  if (input.destination.kind === "git") {
    const remote = input.destination.remote;
    checkGitRemote(remote);
    const repository = join(input.scratch, "git");
    await tool("git", ["init", "--bare", "--quiet", repository]);
    const git = (args: ReadonlyArray<string>, extra: Parameters<typeof tool>[2] = {}) => tool("git", [
      "--git-dir", repository, "-c", `core.hooksPath=${devNull}`, "-c", "protocol.ext.allow=never", ...args,
    ], extra);
    const refs = new Map<string, string>();
    const fetch = async (id: string): Promise<void> => {
      Schema.decodeUnknownSync(SnapshotId)(id);
      await git(["fetch", "--quiet", "--no-tags", "--", remote, `refs/heads/${namespace}/${id}`]);
    };
    const list = async (): Promise<ReadonlyArray<BackupSnapshot>> => {
      const listed = await git(["ls-remote", "--refs", "--", remote, `refs/heads/${namespace}/*`]);
      const snapshots: Array<BackupSnapshot> = [];
      for (const line of listed.trim().split("\n").filter(line => line !== "")) {
        const match = /^([0-9a-f]{40,64})\s+(.+)$/u.exec(line);
        const ref = match?.[2];
        const id = ref?.slice(`refs/heads/${namespace}/`.length);
        if (match === null || ref === undefined || !ref.startsWith(`refs/heads/${namespace}/`) || id === undefined || !digestName.test(id)) {
          throw new BackupIoError("BACKUP_VERIFY_FAILED", "Git returned an invalid backup ref");
        }
        refs.set(id, match[1] ?? "");
        await fetch(id);
        const text = await git(["show", "FETCH_HEAD:snapshot.json"]);
        const snapshot = checkedSnapshot(Schema.decodeUnknownSync(BackupSnapshot)(JSON.parse(text)), policy, owner);
        if (snapshot.id !== id) throw new BackupIoError("BACKUP_VERIFY_FAILED", "Git snapshot ref does not match its record");
        snapshots.push(snapshot);
      }
      return snapshots;
    };
    const download = async (snapshot: BackupSnapshot, output: string): Promise<void> => {
      await fetch(snapshot.id);
      await assemble(snapshot, output, async (_digest, index) => {
        const path = join(input.scratch, `download-${snapshot.id}-${index}`);
        await git(["show", `FETCH_HEAD:part-${index}`], { output: path });
        return path;
      });
    };
    return {
      list, download,
      save: async (metadata, archive) => {
        const parts = await splitArchive(archive, input.scratch);
        const snapshot: BackupSnapshot = { ...metadata, parts: parts.map(({ sha256, bytes }) => ({ sha256, bytes })) };
        const entries: Array<string> = [];
        for (const [index, part] of parts.entries()) {
          const object = (await git(["hash-object", "-w", "--", part.path])).trim();
          entries.push(`100644 blob ${object}\tpart-${index}`);
        }
        const record = (await git(["hash-object", "-w", "--stdin"], { text: JSON.stringify(snapshot) })).trim();
        entries.push(`100644 blob ${record}\tsnapshot.json`);
        const tree = (await git(["mktree"], { text: `${entries.join("\n")}\n` })).trim();
        const commit = (await git(["commit-tree", tree], {
          text: `Canonfig backup ${snapshot.id}\n`,
          environment: { ...process.env, GIT_AUTHOR_NAME: "Canonfig", GIT_AUTHOR_EMAIL: "backup@canonfig.invalid", GIT_COMMITTER_NAME: "Canonfig", GIT_COMMITTER_EMAIL: "backup@canonfig.invalid" },
        })).trim();
        await git(["push", "--porcelain", "--", remote, `${commit}:refs/heads/${namespace}/${snapshot.id}`]);
        await download(snapshot, join(input.scratch, "remote-proof"));
        return snapshot;
      },
      prune: async removed => {
        for (const snapshot of removed) {
          const ref = `refs/heads/${namespace}/${snapshot.id}`;
          const expected = refs.get(snapshot.id);
          if (expected === undefined) throw new BackupIoError("BACKUP_CONFLICT", "List the snapshot refs before pruning");
          await git(["push", `--force-with-lease=${ref}:${expected}`, "--", remote, `:${ref}`]);
        }
      },
      close: async () => undefined,
    };
  }

  let anchor: Awaited<ReturnType<typeof openAnchoredDirectory>> | undefined;
  let root: string;
  const destination = input.destination;
  if (destination.kind === "local") {
    if (!isAbsolute(destination.path)) throw new BackupIoError("BACKUP_INVALID", "Local backup destination must be an absolute path");
    const directory = join(destination.path, namespace);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    anchor = await openAnchoredDirectory(parse(directory).root, directory);
    root = anchor.base;
    await mkdir(join(root, "objects"), { mode: 0o700 }).catch(async error => { if (!(await lstat(join(root, "objects"))).isDirectory()) throw error; });
    await mkdir(join(root, "snapshots"), { mode: 0o700 }).catch(async error => { if (!(await lstat(join(root, "snapshots"))).isDirectory()) throw error; });
  } else {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*:[^\r\n\0]*$/u.test(destination.remote)) {
      throw new BackupIoError("BACKUP_INVALID", "Choose a named rclone remote such as drive:canonfig; inline credentials and backend connection strings are not accepted");
    }
    root = `${destination.remote.replace(/\/+$/u, "")}/${namespace}`;
    await tool("rclone", ["mkdir", `${root}/objects`]);
    await tool("rclone", ["mkdir", `${root}/snapshots`]);
  }
  const listNames = async (directory: string): Promise<ReadonlyArray<string>> => destination.kind === "local"
    ? readdir(join(root, directory))
    : (await tool("rclone", ["lsf", "--files-only", "--max-depth", "1", `${root}/${directory}`])).split("\n").filter(name => name !== "");
  const get = async (name: string, output: string): Promise<void> => {
    if (destination.kind === "local") await copyFile(join(root, name), output, constants.COPYFILE_EXCL);
    else await tool("rclone", ["copyto", "--immutable", `${root}/${name}`, output]);
  };
  const put = async (name: string, source: string): Promise<void> => {
    if (destination.kind === "local") {
      try { await copyFile(source, join(root, name), constants.COPYFILE_EXCL); }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        const [existing, intended] = await Promise.all([hashBackupFile(join(root, name)), hashBackupFile(source)]);
        if (existing.sha256 !== intended.sha256) throw new BackupIoError("BACKUP_VERIFY_FAILED", "An immutable backup object already exists with different content");
      }
    } else await tool("rclone", ["copyto", "--immutable", source, `${root}/${name}`]);
  };
  const remove = async (name: string): Promise<void> => {
    if (destination.kind === "local") await rm(join(root, name));
    else await tool("rclone", ["deletefile", `${root}/${name}`]);
  };
  const download = (snapshot: BackupSnapshot, output: string): Promise<void> => assemble(snapshot, output, async (digest, index) => {
    const path = join(input.scratch, `download-${snapshot.id}-${index}`);
    await get(`objects/${digest}`, path);
    return path;
  });
  return {
    list: async () => {
      const snapshots: Array<BackupSnapshot> = [];
      for (const name of await listNames("snapshots")) {
        if (!snapshotName.test(name)) throw new BackupIoError("BACKUP_VERIFY_FAILED", "Unexpected file in the backup snapshot namespace");
        const path = join(input.scratch, name);
        await get(`snapshots/${name}`, path);
        const snapshot = checkedSnapshot(await readBackupMetadata(path, BackupSnapshot), policy, owner);
        if (`${snapshot.id}.json` !== name) throw new BackupIoError("BACKUP_VERIFY_FAILED", "Snapshot filename does not match its record");
        snapshots.push(snapshot);
      }
      return snapshots;
    },
    save: async (metadata, archive) => {
      const parts = await splitArchive(archive, input.scratch);
      for (const part of parts) await put(`objects/${part.sha256}`, part.path);
      const snapshot: BackupSnapshot = { ...metadata, parts: parts.map(({ sha256, bytes }) => ({ sha256, bytes })) };
      await download(snapshot, join(input.scratch, "remote-proof"));
      const record = join(input.scratch, "snapshot.json");
      await writeFile(record, `${JSON.stringify(snapshot)}\n`, { flag: "wx", mode: 0o600 });
      await put(`snapshots/${snapshot.id}.json`, record);
      await anchor?.verify();
      return snapshot;
    },
    download,
    prune: async (removed, kept) => {
      // The caller holds this owner's cross-process lease. Other machines have different namespaces.
      for (const snapshot of removed) await remove(`snapshots/${snapshot.id}.json`);
      const referenced = new Set(kept.flatMap(snapshot => snapshot.parts.map(part => part.sha256)));
      for (const name of await listNames("objects")) {
        if (!digestName.test(name)) throw new BackupIoError("BACKUP_VERIFY_FAILED", "Unexpected file in the backup object namespace");
        if (!referenced.has(name)) await remove(`objects/${name}`);
      }
      await anchor?.verify();
    },
    close: async () => { await anchor?.close(); },
  };
};

/** Recovery can discover old owners without adopting their writer namespace. */
export const listBackupOwners = async (input: {
  readonly destination: BackupDestination; readonly policy: string; readonly scratch: string; readonly signal: AbortSignal;
}): Promise<ReadonlyArray<string>> => {
  Schema.decodeUnknownSync(BackupName)(input.policy);
  const namespace = `canonfig-backup/${input.policy}`;
  let names: ReadonlyArray<string>;
  if (input.destination.kind === "git") {
    checkGitRemote(input.destination.remote);
    const refs = await runBackupTool("git", ["-c", "protocol.ext.allow=never", "ls-remote", "--refs", "--", input.destination.remote, `refs/heads/${namespace}/*`], { cwd: input.scratch, signal: input.signal });
    names = refs.trim().split("\n").filter(Boolean).map(line => line.split(`refs/heads/${namespace}/`)[1]?.split("/")[0] ?? "");
  } else if (input.destination.kind === "local") {
    names = await readdir(join(input.destination.path, namespace)).catch((cause: unknown) => {
      if (Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(cause)) return [];
      throw cause;
    });
  } else {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*:[^\r\n\0]*$/u.test(input.destination.remote)) throw new BackupIoError("BACKUP_INVALID", "Choose a named rclone remote");
    const listed = await runBackupTool("rclone", ["lsf", "--dirs-only", "--max-depth", "1", `${input.destination.remote.replace(/\/+$/u, "")}/${namespace}`], { cwd: input.scratch, signal: input.signal });
    names = listed.split("\n").filter(Boolean).map(name => name.replace(/\/$/u, ""));
  }
  return [...new Set(names.map(name => Schema.decodeUnknownSync(BackupName)(name)))].sort();
};
