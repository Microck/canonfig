import { createHash } from "node:crypto";
import { constants as filesystemConstants, type BigIntStats, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";

import { join } from "node:path";

import type { MachineDirectoryEntry, MachineObject } from "./machine-state.types.ts";
import { sameIdentity } from "./anchored-directory.ts";
import { FileSizeLimitError } from "./machine-state.errors.ts";

export const objectKind = (metadata: Stats | BigIntStats): MachineObject["kind"] => {
  if (metadata.isSymbolicLink()) return "symlink";
  if (metadata.isFile()) return "regular";
  if (metadata.isDirectory()) return "directory";
  return "special";
};

export const directoryEntries = async (path: string): Promise<ReadonlyArray<MachineDirectoryEntry>> => {
  const names = await readdir(path).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  });
  names.sort((left, right) => left.localeCompare(right));
  const entries: Array<MachineDirectoryEntry> = [];
  for (const name of names) {
    entries.push({ path: name, kind: objectKind(await lstat(join(path, name))) });
  }
  return entries;
};

export const pathEntryMetadata = async (path: string) => {
  const stats = await lstat(path, { bigint: true });
  return { objectKind: objectKind(stats), mode: Number(stats.mode & 0o7777n), identity: { dev: stats.dev, ino: stats.ino } };
};

const assertStableRegularHandle = async (
  path: string,
  opened: Stats,
): Promise<void> => {
  if (!opened.isFile()) {
    throw new Error(`path is not a regular file: ${path}`);
  }
  const visible = await lstat(path);
  if (!visible.isFile() || !sameIdentity(opened, visible)) {
    throw new Error(`regular file target changed during read: ${path}`);
  }
};

export const regularFileBytes = async (
  path: string,
  maximumBytes: number,
  prefixBytes?: number,
): Promise<Buffer> => {
  const handle = await open(
    path,
    filesystemConstants.O_RDONLY
      | filesystemConstants.O_NOFOLLOW
      | filesystemConstants.O_NONBLOCK,
  );
  try {
    const metadata = await handle.stat();
    await assertStableRegularHandle(path, metadata);
    if (metadata.size > maximumBytes) {
      throw new FileSizeLimitError({ path, maximumBytes });
    }
    if (prefixBytes !== undefined) {
      const bytes = Buffer.allocUnsafe(Math.min(metadata.size, prefixBytes));
      let total = 0;
      while (total < bytes.byteLength) {
        const result = await handle.read(bytes, total, bytes.byteLength - total, null);
        if (result.bytesRead === 0) break;
        total += result.bytesRead;
      }
      await assertStableRegularHandle(path, metadata);
      return bytes.subarray(0, total);
    }
    const chunks: Array<Buffer> = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, maximumBytes)));
    while (true) {
      const result = await handle.read(chunk, 0, chunk.byteLength, null);
      if (result.bytesRead === 0) break;
      const bytes = Buffer.from(chunk.subarray(0, result.bytesRead));
      total += bytes.byteLength;
      if (total > maximumBytes) {
        throw new FileSizeLimitError({ path, maximumBytes });
      }
      chunks.push(bytes);
    }
    await assertStableRegularHandle(path, metadata);
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
};

export const regularFileDigest = async (
  path: string,
  maximumBytes: number,
): Promise<string> => {
  const handle = await open(
    path,
    filesystemConstants.O_RDONLY
      | filesystemConstants.O_NOFOLLOW
      | filesystemConstants.O_NONBLOCK,
  );
  try {
    const metadata = await handle.stat();
    await assertStableRegularHandle(path, metadata);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const result = await handle.read(chunk, 0, chunk.byteLength, null);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      if (total > maximumBytes) {
        throw new FileSizeLimitError({ path, maximumBytes });
      }
      hash.update(chunk.subarray(0, result.bytesRead));
    }
    await assertStableRegularHandle(path, metadata);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
};
