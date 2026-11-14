import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Schema } from "effect";

/** External tools may print credentials from their configuration. Never expose their output on failure. */
export class BackupIoError extends Error {
  constructor(readonly code: "BACKUP_INVALID" | "BACKUP_TOOL_REQUIRED" | "BACKUP_VERIFY_FAILED" | "BACKUP_CONFLICT", message: string) {
    super(message);
    this.name = "BackupIoError";
  }
}

interface BackupToolOptions {
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly input?: AsyncIterable<Uint8Array>;
  readonly output?: string;
  readonly maximumOutputBytes?: number;
  readonly text?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export function runBackupTool(executable: string, args: ReadonlyArray<string>, options: BackupToolOptions): Promise<string>;
export function runBackupTool<A>(executable: string, args: ReadonlyArray<string>, options: Omit<BackupToolOptions, "output"> & { readonly consume: (bytes: AsyncIterable<Uint8Array>) => Promise<A> }): Promise<A>;
export async function runBackupTool<A>(executable: string, args: ReadonlyArray<string>, options: BackupToolOptions & { readonly consume?: (bytes: AsyncIterable<Uint8Array>) => Promise<A> }): Promise<string | A> {
  const child = spawn(executable, [...args], {
    cwd: options.cwd, signal: options.signal, windowsHide: true,
    env: options.environment ?? process.env, stdio: ["pipe", "pipe", "ignore"],
  });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new BackupIoError("BACKUP_TOOL_REQUIRED", `${executable} could not run. Install it and check the scheduled command's PATH.`)));
    child.once("exit", code => code === 0 ? resolve() : reject(new BackupIoError("BACKUP_INVALID", `${executable} failed. Check its local configuration and destination access; no tool output is included because it may contain credentials.`)));
  });
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(size > (options.maximumOutputBytes ?? (options.output === undefined ? 16 * 1024 * 1024 : Infinity))
        ? new BackupIoError("BACKUP_VERIFY_FAILED", `${executable} exceeded the configured output size limit`) : null, chunk);
    },
  });
  const receive = options.consume !== undefined
    ? pipeline(child.stdout, limit, options.consume, { signal: options.signal })
    : options.output !== undefined
      ? pipeline(child.stdout, limit, createWriteStream(options.output, { flags: "wx", mode: 0o600 }), { signal: options.signal }).then(() => "")
      : pipeline(child.stdout, limit, async (chunks: AsyncIterable<Uint8Array>) => {
        const output: Array<Uint8Array> = [];
        for await (const chunk of chunks) output.push(chunk);
        return Buffer.concat(output).toString("utf8");
      }, { signal: options.signal });
  const send = options.input === undefined
    ? new Promise<void>((resolve, reject) => {
      child.stdin.once("error", reject);
      child.stdin.end(options.text ?? "", resolve);
    })
    : pipeline(Readable.from(options.input), child.stdin, { signal: options.signal });
  try {
    const [, , output] = await Promise.all([completed, send, receive]);
    return output;
  } catch (error) {
    child.kill();
    await Promise.allSettled([completed, send, receive]);
    if (error instanceof BackupIoError) throw error;
    throw new BackupIoError("BACKUP_INVALID", `${executable} did not complete its backup operation`);
  }
}

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
