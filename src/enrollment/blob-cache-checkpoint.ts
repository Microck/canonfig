import { createHash, type Hash } from "node:crypto";
import { lstat, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Option, Schema } from "effect";
import { sameIdentity } from "../machine/anchored-directory.ts";
import { ContentDigest } from "../domain/brand.ts";

const CheckpointRecord = Schema.Struct({
  transfer: ContentDigest,
  bytes: Schema.Int.check(Schema.isGreaterThan(0)),
  digest: ContentDigest,
});
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(CheckpointRecord));
const MissingFile = Schema.Struct({ code: Schema.Literal("ENOENT") });

const syncDirectory = async (path: string) => {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

interface BlobCheckpoint {
  readonly bytes: number;
  readonly hash: Hash;
}

/** The cache lock gives one writer exclusive use of this slot. */
export const blobCacheCheckpoint = (directory: string) => {
  const dataPath = join(directory, "transfer.part");
  const recordPath = join(directory, "transfer.json");
  const temporaryRecord = join(directory, "transfer.next");
  const clear = async () => {
    await rm(recordPath, { force: true });
    await rm(dataPath, { force: true });
    await rm(temporaryRecord, { force: true });
  };

  const validate = async (
    transfer: typeof ContentDigest.Type,
    totalBytes: number,
  ): Promise<BlobCheckpoint | undefined> => {
    try {
      const recordFile = await open(recordPath, "r");
      const record = await recordFile.read({ buffer: Buffer.alloc(256) })
        .finally(() => recordFile.close());
      if (record.bytesRead === record.buffer.byteLength) return undefined;
      const saved = Option.getOrUndefined(decodeRecord(record.buffer.subarray(0, record.bytesRead).toString()));
      if (saved === undefined || saved.transfer !== transfer || saved.bytes > totalBytes) return undefined;
      const file = await open(dataPath, "r+");
      try {
        const { size } = await file.stat();
        if (size < saved.bytes || size > totalBytes) return undefined;
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of file.createReadStream({ start: 0, end: saved.bytes - 1, autoClose: false })) {
          hash.update(chunk);
          bytes += chunk.byteLength;
        }
        if (bytes !== saved.bytes || hash.copy().digest("hex") !== saved.digest) return undefined;
        // A crash can leave bytes past the last durable checkpoint.
        if (size > bytes) await file.truncate(bytes);
        return { bytes, hash };
      } finally {
        await file.close();
      }
    } catch (cause) {
      if (Schema.is(MissingFile)(cause)) return undefined;
      throw cause;
    }
  };

  return {
    clear,
    async resume(transfer: typeof ContentDigest.Type, totalBytes: number): Promise<BlobCheckpoint> {
      const previous = await validate(transfer, totalBytes);
      if (previous !== undefined) return previous;
      await clear();
      return { bytes: 0, hash: createHash("sha256") };
    },
    async append(transfer: typeof ContentDigest.Type, offset: number, bytes: Uint8Array, hash: Hash): Promise<void> {
      const file = await open(dataPath, offset === 0 ? "wx" : "a", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      hash.update(bytes);
      const recordFile = await open(temporaryRecord, "w", 0o600);
      try {
        await recordFile.writeFile(JSON.stringify({
          transfer,
          bytes: offset + bytes.byteLength,
          digest: hash.copy().digest("hex"),
        }));
        await recordFile.sync();
      } finally {
        await recordFile.close();
      }
      await rename(temporaryRecord, recordPath);
      await syncDirectory(directory);
    },
    async publish(path: string, digest: string, totalBytes: number): Promise<boolean> {
      const file = await open(dataPath, totalBytes === 0 ? "wx" : "r", 0o600);
      try {
        const before = await file.stat({ bigint: true });
        if (!before.isFile() || before.size !== BigInt(totalBytes)) return false;
        const hash = createHash("sha256");
        let bytes = 0;
        if (totalBytes === 0) {
          await file.sync();
        } else {
          for await (const chunk of file.createReadStream({ start: 0, end: totalBytes - 1, autoClose: false })) {
            hash.update(chunk);
            bytes += chunk.byteLength;
          }
        }
        const current = await lstat(dataPath, { bigint: true });
        if (bytes !== totalBytes || hash.digest("hex") !== digest || !sameIdentity(before, current)
          || before.mtimeNs !== current.mtimeNs || before.size !== current.size) return false;
      } finally {
        await file.close();
      }
      await rename(dataPath, path);
      await syncDirectory(dirname(path));
      await rm(recordPath, { force: true });
      await syncDirectory(directory);
      return true;
    },
  };
};
