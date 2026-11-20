import { constants as filesystemConstants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { AnchoredMutationUnconfirmedError } from "./machine-state.errors.ts";
import { holdWindowsDirectories } from "./windows-directory-lease.ts";

/**
 * A directory reached from an anchor through real directories only, never a
 * link, for reads and writes that must not leave the anchor
 * (`ReadFileInput.anchor`, `AtomicWriteInput.anchor`).
 *
 * On Linux every component is opened relative to the previous one's
 * descriptor (`/proc/self/fd/<n>/<name>` with O_NOFOLLOW), and `base` names
 * the last opened directory itself: an ancestor swapped for a link after the
 * walk cannot redirect anything done through `base`.
 *
 * Windows holds native handles without delete sharing for the anchor and
 * each component below it. Reparse points are rejected on the open handle.
 *
 * macOS performs rooted operations in a worker with a pinned working
 * directory. See `posix-anchored-process.ts`.
 */
export interface AnchoredDirectory {
  /** Join an entry name to this to reach the entry inside the directory. */
  readonly base: string;
  /** Throw when a component changed since the directory was opened. */
  readonly verify: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/** Two lstat or fstat results name the same filesystem object. */
interface FilesystemIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

export const sameIdentity = (left: FilesystemIdentity, right: FilesystemIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const componentsBelow = (anchor: string, directory: string): ReadonlyArray<string> => {
  const remainder = relative(anchor, directory);
  if (remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error(`${directory} is not below ${anchor}`);
  }
  return remainder === "" ? [] : remainder.split(sep);
};

interface DescriptorDirectoryOptions {
  readonly createMode?: number | undefined;
  readonly beforeWalk?: (() => Promise<void>) | undefined;
  readonly ignoreMissingDescendant?: boolean | undefined;
}

// Linux O_PATH holds an inode without requesting permission to read its data.
export const linuxPathOnly = 0o10000000;

/** Open a Linux directory relative to descriptors without renaming the anchor. */
export function openDescriptorDirectory(
  anchor: string, directory: string,
  options?: DescriptorDirectoryOptions & { readonly ignoreMissingDescendant?: false | undefined },
): Promise<AnchoredDirectory>;
export function openDescriptorDirectory(
  anchor: string, directory: string, options: DescriptorDirectoryOptions,
): Promise<AnchoredDirectory | undefined>;
export async function openDescriptorDirectory(
  anchor: string, directory: string, options: DescriptorDirectoryOptions = {},
): Promise<AnchoredDirectory | undefined> {
  const components = componentsBelow(anchor, directory);
  const flags = linuxPathOnly | filesystemConstants.O_DIRECTORY | filesystemConstants.O_NOFOLLOW;
  const handles: Array<FileHandle> = [];
  const close = async () => {
    for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
  };
  try {
    const root = await open(anchor, flags);
    handles.push(root);
    if (options.beforeWalk !== undefined) {
      const identity = await root.stat({ bigint: true });
      await options.beforeWalk();
      const visible = await lstat(anchor, { bigint: true });
      if (visible.isSymbolicLink() || !sameIdentity(identity, visible)) {
        throw new Error("managed root identity changed before mutation");
      }
    }
    for (const component of components) {
      const candidate = join(`/proc/self/fd/${handles.at(-1)!.fd}`, component);
      try {
        handles.push(await open(candidate, flags));
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
        if (options.ignoreMissingDescendant) {
          await close();
          return undefined;
        }
        if (options.createMode === undefined) throw cause;
        await mkdir(candidate, { mode: options.createMode });
        handles.push(await open(candidate, flags));
      }
    }
  } catch (error) {
    await close();
    throw error;
  }
  const handle = handles.at(-1)!;
  const verify = async () => {
    for (const [index, opened] of handles.entries()) {
      const directory = index === 0 ? anchor : join(`/proc/self/fd/${handles[index - 1]!.fd}`, components[index - 1]!);
      const visible = await lstat(directory, { bigint: true });
      if (!visible.isDirectory() || !sameIdentity(await opened.stat({ bigint: true }), visible)) {
        throw new Error(`directory identity changed during anchored operation: ${directory}`);
      }
    }
  };
  return { base: `/proc/self/fd/${handle.fd}`, verify, close };
};

const windowsPaths = (anchor: string, path: string): ReadonlyArray<string> => {
  const walked = [anchor];
  let current = anchor;
  for (const component of componentsBelow(anchor, path)) {
    current = join(current, component);
    walked.push(current);
  }
  return walked;
};

/** Hold a native Windows file or directory while a path-only API uses it. */
export const holdAnchoredWindowsEntry = (anchor: string, path: string) =>
  holdWindowsDirectories(windowsPaths(anchor, path), undefined, true);

/** Open `directory`, which must lie below or be `anchor`, refusing a link anywhere from `anchor` down. */
export const openAnchoredDirectory = (
  anchor: string,
  directory: string,
  createWindowsDirectory?: (path: string) => Promise<void>,
): Promise<AnchoredDirectory> => {
  if (process.platform === "linux") return openDescriptorDirectory(anchor, directory);
  if (process.platform === "win32") {
    return holdWindowsDirectories(windowsPaths(anchor, directory), createWindowsDirectory)
      .then((lease) => ({ base: directory, ...lease }));
  }
  return Promise.reject(new Error("this platform must use a process with a pinned working directory"));
};

export const verifyAnchoredMutation = async (
  verify: (() => Promise<void>) | undefined, path: string, operation: string,
): Promise<void> => {
  try {
    await verify?.();
  } catch (cause) {
    throw new AnchoredMutationUnconfirmedError({
      path, operation, message: cause instanceof Error ? cause.message : String(cause),
    });
  }
};

/** Hold the existing parent throughout an operation on its final entry. */
export const withAnchoredEntry = async <A>(
  path: string,
  anchor: string | undefined,
  operation: (path: string) => Promise<A>,
  mutation?: string,
): Promise<A> => {
  if (anchor === undefined) return operation(path);
  const parent = await openAnchoredDirectory(anchor, dirname(path));
  try {
    await parent.verify();
    const result = await operation(join(parent.base, basename(path)));
    if (mutation === undefined) await parent.verify();
    else await verifyAnchoredMutation(parent.verify, path, mutation);
    return result;
  } finally {
    await parent.close();
  }
};
