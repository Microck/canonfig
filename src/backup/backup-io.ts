import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Schema } from "effect";
import { BackupIoError } from "../git/tool-process.ts";

/** Stream hashes without loading an archive or a harness database into memory. */
export const hashBackupFile = async (path: string): Promise<{ readonly sha256: string; readonly bytes: number }> => {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest("hex"), bytes };
};

/** Metadata is bounded before allocation, including when a malicious remote supplies it. */
export const readBackupMetadata = async <A>(path: string, schema: Schema.Decoder<A>, maximumBytes = 16 * 1024 * 1024): Promise<A> => {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximumBytes) throw new BackupIoError("BACKUP_INVALID", "Backup metadata is not a bounded regular file");
    const bytes = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await file.read(bytes, count, bytes.length - count);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    if (count !== info.size) throw new BackupIoError("BACKUP_INVALID", "Backup metadata changed during read");
    return Schema.decodeUnknownSync(schema)(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count))));
  } finally { await file.close(); }
};
