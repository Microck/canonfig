import { addAbortSignal } from "node:stream";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { fromBufferPromise, type Entry } from "yauzl";

import { isBinaryArchiveMemberPath, type BinaryArchive } from "../domain/recipe-versions.ts";
import { tarBlockBytes, tarChecksumValid, tarOctal, tarString } from "./tar-headers.ts";

const expandGzip = promisify(gunzip);
const maximumEntries = 4_096;
const maximumExpandedBytes = 128 * 1024 * 1024;

const checkedMember = (raw: string, directory: boolean, paths: Set<string>): string => {
  const path = directory && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  if (!(directory && path === ".") && !isBinaryArchiveMemberPath(path)) throw new Error("binary archive contains an unsafe member path");
  if (paths.has(path)) throw new Error("binary archive contains duplicate member paths");
  if (paths.size >= maximumEntries) throw new Error("binary archive exceeds the 4,096 entry limit");
  paths.add(path);
  return path;
};

const extractTarMember = async (bytes: Buffer, entrypoint: string, signal: AbortSignal): Promise<Buffer | undefined> => {
  const expanded = await expandGzip(bytes, { maxOutputLength: maximumExpandedBytes }).catch((cause: unknown) => {
    throw new Error("binary tar archive is invalid or exceeds the 128 MiB expansion limit", { cause });
  });
  signal.throwIfAborted();
  const paths = new Set<string>();
  let executable: Buffer | undefined;
  for (let offset = 0; offset + tarBlockBytes <= expanded.length;) {
    const header = expanded.subarray(offset, offset + tarBlockBytes);
    if (header.every((byte) => byte === 0)) {
      const trailer = expanded.subarray(offset + tarBlockBytes);
      if (trailer.length >= tarBlockBytes && trailer.every((byte) => byte === 0)) return executable;
      break;
    }
    if (!tarChecksumValid(header)) throw new Error("binary archive contains an invalid tar header");
    const directory = header[156] === 53; // POSIX typeflag '5'.
    if (!directory && header[156] !== 0 && header[156] !== 48) {
      throw new Error("binary tar archive contains a link, special file, or extended tar entry");
    }
    const name = tarString(header, 0, 100);
    // Only POSIX ustar uses this field as a path prefix. GNU tar uses it for timestamps.
    const prefix = header.toString("latin1", 257, 263) === "ustar\0" ? tarString(header, 345, 155) : "";
    const raw = prefix === "" ? name : `${prefix}/${name}`;
    const size = tarOctal(header, 124, 12);
    const start = offset + tarBlockBytes;
    if (size === undefined || (directory && size !== 0) || size > expanded.length - start) {
      throw new Error("binary archive contains an invalid or oversized tar entry");
    }
    offset = start + Math.ceil(size / tarBlockBytes) * tarBlockBytes;
    if (offset > expanded.length) break;
    // GNU tar commonly emits a root directory and prefixes its members with "./".
    const path = checkedMember(raw === "./" ? raw : raw.replace(/^\.\//u, ""), directory, paths);
    if (!directory && path === entrypoint) executable = expanded.subarray(start, start + size);
  }
  throw new Error("binary archive has truncated or trailing tar data");
};

const zipEntryIsDirectory = (entry: Entry): boolean => {
  const attributes = entry.externalFileAttributes;
  const fileType = (attributes >>> 16) & 0o170000;
  const directory = entry.fileName.endsWith("/");
  if ((attributes & 0x400) !== 0 || (fileType !== 0 && fileType !== (directory ? 0o040000 : 0o100000))) {
    throw new Error("binary zip archive contains a link or special file");
  }
  if (!directory && (attributes & 0x10) !== 0) throw new Error("binary zip archive contains an invalid directory entry");
  if (directory && entry.uncompressedSize !== 0) throw new Error("binary zip archive contains a directory with content");
  return directory;
};

const extractZipMember = async (bytes: Buffer, entrypoint: string, signal: AbortSignal): Promise<Buffer | undefined> => {
  const zip = await fromBufferPromise(bytes, { strictFileNames: true, validateEntrySizes: true });
  try {
    if (zip.entryCount > maximumEntries) throw new Error("binary archive exceeds the 4,096 entry limit");
    const paths = new Set<string>();
    let expandedSize = 0;
    let selected: Entry | undefined;
    for await (const entry of zip.eachEntry()) {
      signal.throwIfAborted();
      const directory = zipEntryIsDirectory(entry);
      const path = checkedMember(entry.fileName, directory, paths);
      expandedSize += entry.uncompressedSize;
      if (expandedSize > maximumExpandedBytes) throw new Error("binary zip archive exceeds the 128 MiB expansion limit");
      if (!directory && path === entrypoint) selected = entry;
    }
    if (selected === undefined) return undefined;
    // yauzl validates the stream against the declared size. Only the chosen member is inflated.
    const stream = addAbortSignal(signal, await zip.openReadStreamPromise(selected));
    const chunks: Buffer[] = await stream.toArray();
    return Buffer.concat(chunks, selected.uncompressedSize);
  } finally {
    zip.close();
  }
};

export const extractBinaryArchiveMember = async (
  bytes: Buffer, format: BinaryArchive["format"], entrypoint: string, signal: AbortSignal,
): Promise<Buffer> => {
  const extract = format === "zip" ? extractZipMember : extractTarMember;
  const executable = await extract(bytes, entrypoint, signal);
  if (executable === undefined) throw new Error(`binary archive entrypoint is missing or is not a regular file: ${entrypoint}`);
  return executable;
};
