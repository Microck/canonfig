import { randomBytes } from "node:crypto";
import { lstat, readdir, rename, rm, rmdir } from "node:fs/promises";
import type { posix, win32 } from "node:path";

import { Schema } from "effect";

/**
 * Names of the entries Canonfig creates next to the paths it mutates.
 *
 * They have a short, fixed length on purpose. Deriving them from the target
 * name (`.<name>.canonfig-<24 hex>`) added 35 bytes, so a valid name of 221 to
 * 255 bytes published fine and then failed on every follower with
 * ENAMETOOLONG. A fixed shape also lets recovery recognize its own leftovers
 * after a killed run without knowing which target they belonged to.
 */
export const temporaryEntryName = (): string =>
  `.cf-${randomBytes(6).toString("hex")}.tmp`;

/** A guard directory holds a managed entry while it is mutated in isolation. */
export const guardEntryName = (): string =>
  `.cf-${randomBytes(6).toString("hex")}.guard`;

/** Characters in every `temporaryEntryName()` and `guardEntryName()`. */
export const temporaryEntryNameLength = ".cf-000000000000.tmp".length;
export const guardEntryNameLength = ".cf-000000000000.guard".length;

/** The file a staged write creates inside its private staging directory. */
export const stagedContentName = "content";

/** Windows records a path's semantic mode in this alternate data stream. */
export const permissionIntentStream = ":canonfig.mode";

/** What a planned mutation does at one path. */
export type PathMutationKind = "write" | "directory" | "remove";

/**
 * The longest file path and the longest new directory path one mutation hands
 * to native tools. Windows checks the two against different limits.
 */
export interface MutationPathLengths {
  readonly file: number;
  readonly directory: number;
}

/**
 * The longest paths a mutation of `path` makes Canonfig hand to the operating
 * system and its native tools (icacls, PowerShell). A write stages its content
 * at `<parent>\.cf-<hex>.tmp\content` and records the semantic mode in
 * `<path>:canonfig.mode`; a directory also gets that stream. A guarded
 * mutation inside a managed root first moves the top entry into a guard
 * directory beside it (`<root>\.cf-<hex>.guard\<top>...`), which adds one
 * component to every path below the root. Each new parent is staged beside
 * itself, which is never longer than the target's own staging directory.
 */
export const mutationPathLengths = (
  path: string,
  pathApi: typeof posix | typeof win32,
  kind: PathMutationKind,
  guarded: boolean,
): MutationPathLengths => {
  const guard = guarded ? 1 + guardEntryNameLength : 0;
  const target = path.length + guard;
  if (kind === "remove") return { file: target, directory: 0 };
  if (kind === "directory") {
    return { file: target + permissionIntentStream.length, directory: target };
  }
  const staging = pathApi.dirname(path).length + guard + 1 + temporaryEntryNameLength;
  return {
    file: Math.max(target + permissionIntentStream.length, staging + 1 + stagedContentName.length),
    directory: staging,
  };
};

const temporaryPattern = /^\.cf-[0-9a-f]{12}\.tmp$/u;
const guardPattern = /^\.cf-[0-9a-f]{12}\.guard$/u;
// Names written by releases before the fixed-length shape. Only a run those
// releases left open can still contain them, and recovering or abandoning that
// run after the upgrade has to clean them up the same way.
const legacyTemporaryPattern =
  /^(?:\..+\.canonfig-[0-9a-f]{24}|\.canonfig-(?:write|directory)-[0-9A-Za-z]{6})$/u;
const legacyGuardPattern = /^(?:\..+\.canonfig-guard-|\.canonfig-guard-)[0-9a-f]{24}$/u;

export type TemporaryEntryKind = "temporary" | "guard";

export const temporaryEntryKind = (name: string): TemporaryEntryKind | undefined =>
  guardPattern.test(name) || legacyGuardPattern.test(name)
    ? "guard"
    : temporaryPattern.test(name) || legacyTemporaryPattern.test(name)
    ? "temporary"
    : undefined;

const ErrorWithCode = Schema.Struct({ code: Schema.String });

const errorCode = (cause: unknown): string | undefined =>
  Schema.is(ErrorWithCode)(cause) ? cause.code : undefined;

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return false;
    throw cause;
  }
};

/**
 * A guard left by a killed mutation still holds the managed entry it isolated.
 * Put that entry back where it was, then drop the guard. When something new
 * already occupies the entry's name, neither copy is discarded: the guard
 * stays and the failure names both paths.
 */
const releaseGuard = async (
  guard: string,
  directory: string,
  path: typeof posix | typeof win32,
): Promise<void> => {
  for (const name of await readdir(guard)) {
    const held = path.join(guard, name);
    const visible = path.join(directory, name);
    if (await exists(visible)) {
      throw new Error(
        `${held} holds an entry an interrupted run isolated, and ${visible} exists again; keep one of them and remove the other`,
      );
    }
    await rename(held, visible);
  }
  await rmdir(guard);
};

/**
 * Remove Canonfig's own temporary entries from one directory, and from every
 * directory beneath it when `recursive`. Nothing else is touched, links are
 * never followed, and a missing directory has nothing to clean. Returns the
 * entries it removed or released.
 */
export const removeTemporaryEntriesAt = async (
  directory: string,
  recursive: boolean,
  path: typeof posix | typeof win32,
): Promise<ReadonlyArray<string>> => {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    const code = errorCode(cause);
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw cause;
  }
  const removed: Array<string> = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const kind = temporaryEntryKind(entry.name);
    if (kind === "temporary") {
      await rm(entryPath, { recursive: true, force: true });
      removed.push(entryPath);
    } else if (kind === "guard" && entry.isDirectory()) {
      await releaseGuard(entryPath, directory, path);
      removed.push(entryPath);
    } else if (recursive && entry.isDirectory()) {
      removed.push(...await removeTemporaryEntriesAt(entryPath, true, path));
    }
  }
  return removed;
};
