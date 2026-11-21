import { chmod, link, lstat, mkdir, open, rename, rm, rmdir, symlink, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join } from "node:path";
import { linuxPathOnly, sameIdentity, verifyAnchoredMutation } from "./anchored-directory.ts";
import { writeFileContent } from "./file-content.ts";
import { temporaryEntryName } from "./temporary-entries.ts";
import { AnchoredMutationUnconfirmedError, UnconfirmedPublicationError } from "./machine-state.errors.ts";
import type { FileContent, FileIdentity, SafeRootMutation } from "./machine-state.types.ts";

const errorCode = (cause: unknown): string | undefined =>
  cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export const removeManagedLeaf = async (path: string): Promise<void> => {
  try {
    const metadata = await lstat(path);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      await rmdir(path);
    } else {
      await unlink(path);
    }
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") throw cause;
  }
};

export const prepareManagedLeafKind = async (
  path: string,
  kind: "directory" | "non-directory",
): Promise<void> => {
  try {
    const metadata = await lstat(path);
    const directory = metadata.isDirectory() && !metadata.isSymbolicLink();
    if (kind === "directory" ? !directory : directory) {
      await removeManagedLeaf(path);
    }
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") throw cause;
  }
};

export const syncHandle = (
  handle: Awaited<ReturnType<typeof open>>,
): Promise<void> =>
  handle.sync().then(
    () => undefined,
    // Windows raises EPERM for fsync on some filesystems and directory
    // handles; durability there relies on the rename, not the flush.
    (cause: NodeJS.ErrnoException) => {
      if (
        process.platform === "win32"
        && (cause.code === "EPERM" || cause.code === "EINVAL")
      ) {
        return undefined;
      }
      throw cause;
    },
  );

/** Write only the named leaf in a directory the caller already holds. */
export const atomicWriteLeaf = async (
  parent: string, path: string, content: FileContent, mode: number,
  { noReplace, verify }: {
    readonly noReplace?: boolean | undefined;
    readonly verify?: (() => Promise<void>) | undefined;
  } = {},
): Promise<FileIdentity> => {
  const target = join(parent, basename(path));
  const temporary = join(parent, temporaryEntryName());
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", mode);
    await writeFileContent(handle, content);
    await syncHandle(handle);
    await handle.chmod(mode);
    const written = await handle.stat({ bigint: true });
    await handle.close();
    handle = undefined;
    await verify?.();
    if (noReplace === true) {
      // A hard link fails with EEXIST when the name exists, even when
      // another process created it after any earlier check.
      await link(temporary, target);
    } else {
      await prepareManagedLeafKind(target, "non-directory");
      await rename(temporary, target);
    }
    // From here the file is visible at `path`, so a failure must say
    // what the name holds now instead of reading as nothing written.
    const published: FileIdentity = { dev: written.dev, ino: written.ino };
    const unconfirmed = (state: "in-place" | "replaced", cause: unknown) =>
      new UnconfirmedPublicationError({ path, state, published, message: messageOf(cause) });
    let flushProblem: string | undefined;
    try {
      const directory = await open(parent, "r");
      try {
        await syncHandle(directory);
      } finally {
        await directory.close();
      }
    } catch (cause) {
      flushProblem = messageOf(cause);
    }
    if (verify !== undefined) {
      try {
        await verify();
        if (!sameIdentity(await lstat(target, { bigint: true }), written)) {
          throw new Error(`${path} no longer names the file Canonfig published`);
        }
      } catch (cause) {
        throw unconfirmed("replaced", cause);
      }
    }
    if (flushProblem !== undefined) {
      throw unconfirmed("in-place", `the directory entry could not be flushed to disk: ${flushProblem}`);
    }
    return published;
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

/** Mutate the final entry under a parent already held by the caller. */
export const mutatePosixLeaf = async (
  parent: string,
  path: string,
  mutation: SafeRootMutation,
  defaultMode: number,
  verify?: () => Promise<void>,
): Promise<FileIdentity | undefined> => {
  const target = join(parent, basename(path));
  await verify?.();
  if (mutation.kind === "write") {
    await atomicWriteLeaf(parent, path, mutation.content, mutation.permissions?.mode ?? mutation.mode ?? defaultMode, { verify });
    return;
  }
  let identity: FileIdentity | undefined;
  try {
    switch (mutation.kind) {
      case "remove":
        await removeManagedLeaf(target);
        break;
      case "directory": {
        await prepareManagedLeafKind(target, "directory");
        const mode = mutation.permissions === undefined ? mutation.mode : mutation.permissions.mode;
        await mkdir(target, { recursive: true, mode: mode | 0o700 });
        await changePosixLeafMode(target, mode, constants.O_DIRECTORY, undefined, (opened) => { identity = opened; });
        break;
      }
      case "symlink": {
        const temporary = join(parent, temporaryEntryName());
        try {
          await symlink(mutation.target, temporary);
          await verify?.();
          await prepareManagedLeafKind(target, "non-directory");
          await rename(temporary, target);
        } finally {
          await unlink(temporary).catch(() => undefined);
        }
        break;
      }
    }
    const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await syncHandle(directory);
    } finally {
      await directory.close();
    }
  } finally {
    if (verify !== undefined) {
      await verifyAnchoredMutation(async () => {
        await verify();
        if (identity !== undefined && !sameIdentity(await lstat(target, { bigint: true }), identity)) {
          throw new Error("the path no longer names the directory Canonfig prepared");
        }
      }, path, mutation.kind);
    }
  }
  return identity;
};

export const removeMatchingFile = async (path: string, identity?: FileIdentity): Promise<void> => {
  if (identity !== undefined) {
    const current = await lstat(path, { bigint: true }).catch((cause: unknown) => {
      if (errorCode(cause) === "ENOENT" || errorCode(cause) === "ENOTDIR") return undefined;
      throw cause;
    });
    if (current === undefined || !sameIdentity(current, identity)) return;
  }
  await rm(path, { force: true });
};

const changePosixLeafMode = async (
  path: string,
  mode: number,
  extraFlags: number,
  expected?: FileIdentity,
  opened?: (identity: FileIdentity) => void,
): Promise<void> => {
  const linux = process.platform === "linux";
  const access = linux ? linuxPathOnly : constants.O_RDONLY | constants.O_NONBLOCK;
  const handle = await open(path, access | constants.O_NOFOLLOW | extraFlags);
  try {
    const entry = await handle.stat({ bigint: true });
    if (expected !== undefined && !sameIdentity(entry, expected)) {
      throw new AnchoredMutationUnconfirmedError({
        path, operation: "set permissions", message: "the path no longer names the directory Canonfig prepared",
      });
    }
    if (!entry.isDirectory() && !entry.isFile()) throw new Error("permissions require a regular file or directory");
    opened?.({ dev: entry.dev, ino: entry.ino });
    // Linux fchmod cannot use an O_PATH descriptor directly. The procfs
    // name refers to the held inode even when the original name changes.
    if (linux) await chmod(`/proc/self/fd/${handle.fd}`, mode);
    else await handle.chmod(mode);
  } finally {
    await handle.close();
  }
};

export const setPosixLeafMode = (path: string, mode: number, identity?: FileIdentity): Promise<void> =>
  changePosixLeafMode(path, mode, 0, identity);
