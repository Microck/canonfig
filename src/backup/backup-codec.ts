import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants, createZstdCompress, createZstdDecompress } from "node:zlib";
import { Decrypter, Encrypter } from "age-encryption";
import { Redacted } from "effect";
import type { BackupCodec, BackupCompression } from "./backup.types.ts";
import { BackupIoError, runBackupTool } from "./backup-io.ts";

interface CodecInput {
  readonly preset: BackupCompression;
  readonly output: string;
  readonly scratch: string;
  readonly signal: AbortSignal;
  readonly password: Redacted.Redacted<string> | undefined;
  readonly maximumBytes: number;
}

const bounded = (maximum: number): Transform => {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maximum ? new BackupIoError("BACKUP_VERIFY_FAILED", "Backup exceeds the configured size limit") : null, chunk);
    },
  });
};

/** Compress first, then use the standard age password envelope. Passwords never enter child arguments. */
export const encodeBackup = async (input: CodecInput & { readonly bytes: AsyncIterable<Uint8Array> }): Promise<BackupCodec> => {
  const compressed = input.password === undefined ? input.output : join(input.scratch, "compressed");
  let codec: BackupCodec = input.preset === "small" || input.preset === "max" ? "xz" : "zstd";
  if (input.preset === "fast" || input.preset === "balanced") {
    await pipeline(Readable.from(input.bytes), createZstdCompress({
      params: { [constants.ZSTD_c_compressionLevel]: input.preset === "fast" ? 1 : 6 },
    }), createWriteStream(compressed, { flags: "wx", mode: 0o600 }), { signal: input.signal });
  } else if (input.preset === "small") {
    await runBackupTool("xz", ["-9e", "-T1", "-c"], {
      cwd: input.scratch, signal: input.signal, input: input.bytes, output: compressed,
      maximumOutputBytes: input.maximumBytes,
    });
  } else {
    // No compressor wins on every corpus. Stage one tar stream and compare the measured frontier.
    const tar = join(input.scratch, "max-input.tar");
    const xz = join(input.scratch, "max.xz");
    const zpaq = join(input.scratch, "max.zpaq");
    await pipeline(Readable.from(input.bytes), bounded(input.maximumBytes), createWriteStream(tar, { flags: "wx", mode: 0o600 }), { signal: input.signal });
    await runBackupTool("xz", ["-9e", "-T1", "-c"], { cwd: input.scratch, signal: input.signal, input: createReadStream(tar), output: xz, maximumOutputBytes: input.maximumBytes });
    await runBackupTool("zpaq-stream", ["5"], { cwd: input.scratch, signal: input.signal, input: createReadStream(tar), output: zpaq, maximumOutputBytes: input.maximumBytes });
    codec = (await stat(xz)).size <= (await stat(zpaq)).size ? "xz" : "zpaq";
    await rename(codec === "xz" ? xz : zpaq, compressed);
    await rm(codec === "xz" ? zpaq : xz);
    await rm(tar);
  }
  if (input.password !== undefined) {
    const encrypter = new Encrypter();
    encrypter.setPassphrase(Redacted.value(input.password));
    const source = createReadStream(compressed);
    try {
      const encrypted = await encrypter.encrypt(Readable.toWeb(source));
      await pipeline(Readable.fromWeb(encrypted), createWriteStream(input.output, { flags: "wx", mode: 0o600 }), { signal: input.signal });
    } finally { source.destroy(); }
    await rm(compressed);
  }
  return codec;
};

/** Keep decrypted recovery material off disk. Publication waits for age's final authentication and archive verification. */
export const decodeBackup = async <A>(input: Omit<CodecInput, "preset" | "output"> & {
  readonly codec: BackupCodec; readonly archive: string; readonly encrypted: boolean;
  readonly consume: (bytes: AsyncIterable<Uint8Array>) => Promise<A>;
}): Promise<A> => {
  const source = createReadStream(input.archive);
  let compressed: Readable = source;
  try {
    if (input.encrypted) {
      if (input.password === undefined) throw new BackupIoError("BACKUP_INVALID", "Encrypted backup needs its local password credential reference");
      const decrypter = new Decrypter();
      decrypter.addPassphrase(Redacted.value(input.password));
      try { compressed = Readable.fromWeb(await decrypter.decrypt(Readable.toWeb(source))); }
      catch { throw new BackupIoError("BACKUP_VERIFY_FAILED", "Backup decryption failed. The password is wrong or the encrypted archive is damaged; no restore was published."); }
    }
    if (input.codec === "zstd") {
      return await pipeline(compressed, createZstdDecompress({
        params: { [constants.ZSTD_d_windowLogMax]: 27 },
      }), bounded(input.maximumBytes), input.consume, { signal: input.signal });
    }
    return await runBackupTool(input.codec === "xz" ? "xz" : "zpaq-stream", input.codec === "xz" ? ["-d", "-c", "--memlimit-decompress=1GiB"] : ["d"], {
      cwd: input.scratch, signal: input.signal, input: compressed, consume: input.consume, maximumOutputBytes: input.maximumBytes,
    });
  } finally { compressed.destroy(); source.destroy(); }
};
