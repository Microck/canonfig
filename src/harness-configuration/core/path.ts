import path from "node:path";
import fs from "node:fs/promises";
import { CanonfigError } from "./errors.ts";
export function toPosix(value: string): string { return value.replaceAll("\\", "/").split(path.sep).join("/"); }
export function assertSafeRelativePath(value: string): string {
  const normalized = path.posix.normalize(toPosix(value));
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || path.posix.isAbsolute(normalized)) {
    throw new CanonfigError("UNSAFE_PATH", `Unsafe repository-relative path: ${value}`);
  }
  return normalized;
}
export function resolveInside(root: string, relativePath: string): string {
  const safe = assertSafeRelativePath(relativePath);
  const resolved = path.resolve(root, safe);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new CanonfigError("PATH_ESCAPE", `Path escapes repository root: ${relativePath}`);
  return resolved;
}


function assertAbsoluteInside(realRoot: string, realCandidate: string, original: string): void {
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new CanonfigError("SYMLINK_ESCAPE", `Path resolves outside repository root: ${original}`);
  }
}

/** Verify an existing path, or its nearest existing ancestor, remains inside root after symlink resolution. */
export async function assertRealPathInside(root: string, candidate: string): Promise<void> {
  const rootReal = await fs.realpath(root);
  let current = candidate;
  while (true) {
    try {
      const resolved = await fs.realpath(current);
      assertAbsoluteInside(rootReal, resolved, candidate);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}
