import fs from "node:fs/promises";
import path from "node:path";
import { assertRealPathInside } from "./path.ts";
import { CanonfigError } from "./errors.ts";

let temporarySequence = 0;

function relativeInside(root: string, candidate: string): { root: string; relative: string } {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new CanonfigError("PATH_ESCAPE", `Path escapes repository root: ${candidate}`);
  }
  return { root: resolvedRoot, relative };
}

async function lstatOptional(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try { return await fs.lstat(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function openExclusiveTemporary(
  filePath: string,
  mode?: number,
): Promise<{ temporary: string; handle: Awaited<ReturnType<typeof fs.open>> }> {
  for (;;) {
    const temporary = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${temporarySequence++}.tmp`,
    );
    try {
      return { temporary, handle: await fs.open(temporary, "wx", mode) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export async function assertNoSymlinkPathComponents(root: string, candidate: string): Promise<void> {
  const confined = relativeInside(root, candidate);
  if (!confined.relative) return;
  let current = confined.root;
  for (const component of confined.relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stats = await lstatOptional(current);
    if (stats === undefined) return;
    if (stats.isSymbolicLink()) {
      throw new CanonfigError("SYMLINK_ESCAPE", `Path component is a symbolic link: ${current}`);
    }
  }
}

export async function ensureDirectoryNoFollow(root: string, directory: string): Promise<void> {
  const confined = relativeInside(root, directory);
  if (!confined.relative) return;
  let current = confined.root;
  for (const component of confined.relative.split(path.sep).filter(Boolean)) {
    await assertNoSymlinkPathComponents(confined.root, current);
    current = path.join(current, component);
    let stats = await lstatOptional(current);
    if (stats === undefined) {
      try { await fs.mkdir(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stats = await lstatOptional(current);
    }
    if (stats === undefined) {
      throw new CanonfigError("PATH_CREATE_FAILED", `Failed to create directory: ${current}`);
    }
    if (stats.isSymbolicLink()) {
      throw new CanonfigError("SYMLINK_ESCAPE", `Path component is a symbolic link: ${current}`);
    }
    if (!stats.isDirectory()) {
      throw new CanonfigError("PATH_COMPONENT_NOT_DIRECTORY", `Path component is not a directory: ${current}`);
    }
  }
}

export async function readOptionalFile(filePath: string): Promise<Uint8Array | undefined> {
  try { return await fs.readFile(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function walkFiles(root: string, boundary = root): Promise<string[]> {
  if (await lstatOptional(root) === undefined) return [];
  const result: string[] = [];
  async function visit(directory: string, ancestors: ReadonlySet<string>): Promise<void> {
    await assertRealPathInside(boundary, directory);
    const real = await fs.realpath(directory);
    if (ancestors.has(real)) throw new CanonfigError("SKILL_SYMLINK_CYCLE", `Skill source contains a directory symlink cycle: ${directory}`);
    const chain = new Set([...ancestors, real]);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      await assertRealPathInside(boundary, absolute);
      const kind = entry.isSymbolicLink() ? await fs.stat(absolute) : entry;
      if (kind.isDirectory()) await visit(absolute, chain);
      else if (kind.isFile()) result.push(path.relative(root, absolute));
      else throw new CanonfigError("SKILL_SOURCE_INVALID", `Skill source is not a regular file or directory: ${absolute}`);
    }
  }
  await visit(root, new Set());
  return result;
}

export async function atomicWrite(
  filePath: string,
  content: string | Uint8Array,
  mode?: number,
  root?: string,
): Promise<void> {
  if (root === undefined) await fs.mkdir(path.dirname(filePath), { recursive: true });
  else await ensureDirectoryNoFollow(root, path.dirname(filePath));
  let temporary: string | undefined;
  try {
    if (root !== undefined) await assertNoSymlinkPathComponents(root, path.dirname(filePath));
    // A merge does not declare a new mode. Preserve the existing regular
    // file's permissions rather than replacing them with process defaults.
    // lstat intentionally does not take permissions from a symlink target.
    const existing = mode === undefined ? await lstatOptional(filePath) : undefined;
    const writeMode = mode ?? (existing?.isFile() ? Number(existing.mode) & 0o777 : undefined);
    const opened = await openExclusiveTemporary(filePath, writeMode);
    temporary = opened.temporary;
    try {
      await opened.handle.writeFile(content);
      if (writeMode !== undefined) await opened.handle.chmod(writeMode);
    } finally {
      await opened.handle.close();
    }
    if (root !== undefined) await assertNoSymlinkPathComponents(root, path.dirname(filePath));
    await fs.rename(temporary, filePath);
    temporary = undefined;
  } catch (error) {
    if (temporary !== undefined) {
      try {
        if (root !== undefined) await assertNoSymlinkPathComponents(root, path.dirname(filePath));
        await fs.rm(temporary, { force: true });
      } catch { /* Preserve the original write error. */ }
    }
    throw error;
  }
}

export async function removeFileAndEmptyParents(filePath: string, stopAt: string): Promise<void> {
  await assertNoSymlinkPathComponents(stopAt, path.dirname(filePath));
  try { await fs.unlink(filePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let current = path.dirname(filePath);
  const stop = path.resolve(stopAt);
  while (current !== stop) {
    const relative = path.relative(stop, current);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) break;
    try {
      await assertNoSymlinkPathComponents(stop, current);
      await fs.rmdir(current);
    } catch { break; }
    current = path.dirname(current);
  }
}
