import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** External tools may print credentials from their configuration. Never expose their output on failure. */
export class BackupIoError extends Error {
  constructor(readonly code: "BACKUP_INVALID" | "BACKUP_TOOL_REQUIRED" | "BACKUP_VERIFY_FAILED" | "BACKUP_CONFLICT" | "BACKUP_CREDENTIAL_REQUIRED", message: string) {
    super(message);
    this.name = "BackupIoError";
  }
}

/**
 * How a read-only probe of an external tool ended. `detail` is the tool's stderr: it is only ever matched by
 * `probeFailure`, never shown or logged, because it can contain credentials from the tool's configuration.
 */
export type ProbeResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly missing: boolean; readonly timedOut: boolean; readonly detail: string; readonly stdout: string; readonly code: number | null };

const processEnvironment = (environment: Record<string, string | undefined> | undefined) =>
  environment === undefined ? process.env : { NODE_ENV: process.env.NODE_ENV, ...environment };

/** Run a destination probe with a deadline. A missing executable and a timeout are reported, never thrown. */
export const probeBackupTool = (executable: string, args: ReadonlyArray<string>, options: {
  readonly cwd: string; readonly signal: AbortSignal; readonly timeoutMilliseconds: number; readonly environment?: Record<string, string | undefined>;
}): Promise<ProbeResult> => new Promise(resolve => {
  const deadline = AbortSignal.timeout(options.timeoutMilliseconds);
  const child = spawn(executable, [...args], {
    cwd: options.cwd, signal: AbortSignal.any([options.signal, deadline]), windowsHide: true, shell: false,
    env: processEnvironment(options.environment), stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 1024 * 1024) stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8"); });
  child.once("error", (error) => resolve({ ok: false, missing: "code" in error && error.code === "ENOENT", timedOut: deadline.aborted, detail: stderr, stdout, code: null }));
  child.once("close", (code) => resolve(code === 0 ? { ok: true, stdout } : { ok: false, missing: false, timedOut: deadline.aborted, detail: stderr, stdout, code }));
});

const NETWORK = /could not resolve|name or service not known|no such host|temporary failure in name resolution|network is unreachable|connection (?:timed out|refused|reset)|operation timed out|i\/o timeout|dial tcp|failed to connect|could not connect|no route to host/iu;
const AUTH = /permission denied|authentication failed|could not read username|terminal prompts disabled|access denied|unauthori[sz]ed|forbidden|\b40[13]\b|invalid_grant|token (?:has )?expired|couldn't fetch token|failed to refresh token|host key verification failed/iu;
const NOT_FOUND = /repository not found|does not appear to be a git repository|not a git repository|no such file or directory|directory not found|doesn't exist|does not exist|not found/iu;

/** Why a probe failed, from its stderr. Network problems are the only ones a later run can fix on its own. */
export const probeFailure = (result: Extract<ProbeResult, { readonly ok: false }>): "missing" | "network" | "auth" | "not-found" | "other" =>
  result.missing ? "missing" : result.timedOut || NETWORK.test(result.detail) ? "network" : AUTH.test(result.detail) ? "auth" : NOT_FOUND.test(result.detail) ? "not-found" : "other";

interface BackupToolOptions {
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly input?: AsyncIterable<Uint8Array>;
  readonly output?: string;
  readonly maximumOutputBytes?: number;
  readonly text?: string;
  readonly environment?: Record<string, string | undefined>;
}

export function runBackupTool(executable: string, args: ReadonlyArray<string>, options: BackupToolOptions): Promise<string>;
export function runBackupTool<A>(executable: string, args: ReadonlyArray<string>, options: Omit<BackupToolOptions, "output"> & { readonly consume: (bytes: AsyncIterable<Uint8Array>) => Promise<A> }): Promise<A>;
export async function runBackupTool<A>(executable: string, args: ReadonlyArray<string>, options: BackupToolOptions & { readonly consume?: (bytes: AsyncIterable<Uint8Array>) => Promise<A> }): Promise<string | A> {
  const child = spawn(executable, [...args], {
    cwd: options.cwd, signal: options.signal, windowsHide: true, shell: false,
    env: processEnvironment(options.environment), stdio: ["pipe", "pipe", "ignore"],
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
