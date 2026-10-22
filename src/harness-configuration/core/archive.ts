import { gzipSync } from "node:zlib";
import { CanonfigError } from "./errors.ts";

export interface ArchiveFile {
  path: string;
  content: Uint8Array;
  mode: number;
}

/** Archives contain regular, relative files only, never extraction-time links. */
export function validateArchivePath(value: string): void {
  if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/")
    || /^[a-z]:/iu.test(value) || value.split("/").some((part) => !part || part === "." || part === "..")
    || value.split("/").some((part) => /[:<>"|?*\x00-\x1f]/u.test(part) || /[. ]$/u.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw new CanonfigError("ARCHIVE_PATH_INVALID", `Non-portable archive path: ${value}`);
  }
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files: readonly ArchiveFile[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path);
    if (name.length > 65535) throw new CanonfigError("ARCHIVE_PATH_INVALID", "ZIP filename is too long");
    const content = Buffer.from(file.content);
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); // UTF-8, stored (no platform-specific compressor).
    local.writeUInt16LE(0x21, 12); // 1980-01-01, deterministic.
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // Unix attributes.
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((0o100000 | file.mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    parts.push(local, name, content);
    directory.push(central, name);
    offset += local.length + name.length + content.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

function octal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
}
function tarHeader(name: string, size: number, mode: number, type: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  octal(header, 100, 8, mode);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, size);
  octal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return header;
}
function padded(content: Uint8Array): Buffer[] {
  return [Buffer.from(content), Buffer.alloc((512 - content.length % 512) % 512)];
}
function tar(files: readonly ArchiveFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const [index, file] of files.entries()) {
    // PAX handles UTF-8 and long names without silently truncating them.
    const payload = `path=${file.path}\n`;
    let length = Buffer.byteLength(payload) + 3;
    while (length !== Buffer.byteLength(payload) + String(length).length + 1) {
      length = Buffer.byteLength(payload) + String(length).length + 1;
    }
    const record = Buffer.from(`${length} ${payload}`);
    parts.push(tarHeader(`PaxHeaders/${index}`, record.length, 0o644, "x"), ...padded(record));
    parts.push(tarHeader(`file-${index}`, file.content.length, file.mode, "0"), ...padded(file.content));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]), { level: 9 });
}

export function encodeArchive(files: readonly ArchiveFile[], format: "zip" | "tar.gz"): Buffer {
  if (files.length > 20_000) throw new CanonfigError("ARCHIVE_LIMIT_INVALID", "Archive exceeds 20,000 files");
  let bytes = 0;
  const names = new Set<string>();
  for (const file of files) {
    validateArchivePath(file.path);
    const name = file.path.normalize("NFC").toLowerCase();
    if (names.has(name)) throw new CanonfigError("ARCHIVE_COLLISION", `Duplicate or case-colliding archive path: ${file.path}`);
    names.add(name);
    bytes += file.content.length;
    if (bytes > 128 * 1024 * 1024) throw new CanonfigError("ARCHIVE_LIMIT_INVALID", "Archive exceeds 128 MiB");
  }
  const ordered = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return format === "zip" ? zip(ordered) : tar(ordered);
}
