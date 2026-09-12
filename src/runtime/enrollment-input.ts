import type { Readable } from "node:stream";

import { invitationEnvelopeEof, maximumEnvelopeBytes } from
  "../enrollment/invitation-envelope.ts";

/**
 * `--json` is a global option that `evaluateCli` accepts at any position, so it
 * never identifies a command. Drop it before matching, or a wrapper that writes
 * `canonfig --json follower enroll --stdin ...` would miss the private path and
 * then fail on an unknown `--stdin` option.
 */
const withoutGlobalJson = (arguments_: ReadonlyArray<string>): ReadonlyArray<string> =>
  arguments_.filter((argument) => argument !== "--json");

/** Enrollment is the only CLI argument replaced from this private input path. */
export const isPrivateEnrollmentCommand = (arguments_: ReadonlyArray<string>): boolean => {
  const command = withoutGlobalJson(arguments_);
  return command[0] === "follower"
    && command[1] === "enroll"
    && command.slice(2).includes("--stdin");
};

export const privateEnrollmentHelp = "  follower enroll --stdin --name <name> --profile <id> [--replace]";

export class EnrollmentInputError extends Error {
  readonly name = "EnrollmentInputError";
}

interface InputLimits {
  readonly maximumBytes?: number;
  readonly timeoutMilliseconds?: number;
  readonly signal?: AbortSignal;
}

/**
 * Read one opaque invitation from a pipe. Never echo bytes, include them in an
 * error, put them in process.argv, or persist them. EOF is required, and both
 * missing EOF and oversized input fail within fixed bounds.
 */
export const readEnrollmentInput = (
  input: Readable & { readonly isTTY?: boolean },
  limits: InputLimits = {},
): Promise<string> => {
  const maximumBytes = limits.maximumBytes ?? maximumEnvelopeBytes;
  const timeoutMilliseconds = limits.timeoutMilliseconds ?? 10_000;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 64 * 1024
    || !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1
    || timeoutMilliseconds > 60_000) {
    return Promise.reject(new EnrollmentInputError("Invalid private enrollment input limits"));
  }
  if (input.readableObjectMode) {
    return Promise.reject(new EnrollmentInputError("Private enrollment input must be a byte stream"));
  }
  if (input.isTTY) {
    return Promise.reject(new EnrollmentInputError("Enrollment --stdin requires a private pipe, not an interactive terminal"));
  }
  if (limits.signal?.aborted) {
    return Promise.reject(new EnrollmentInputError("Private enrollment input was interrupted"));
  }
  if (input.destroyed || input.readableEnded) {
    return Promise.reject(new EnrollmentInputError("Private enrollment input is unavailable or already consumed"));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      input.removeListener("close", onClose);
      limits.signal?.removeEventListener("abort", onAbort);
      input.pause();
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new EnrollmentInputError(message));
    };
    const onData = (chunk: Buffer | string): void => {
      // Copy: clearing the private buffer must not mutate caller-owned memory.
      const value = Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        value.fill(0);
        fail(`Private enrollment input exceeds the ${maximumBytes} byte limit`);
        return;
      }
      chunks.push(value);
    };
    const onEnd = (): void => {
      if (settled) return;
      const value = Buffer.concat(chunks, bytes);
      let invitation: string;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(value);
        const lines = text.split("\n");
        if (
          lines.length !== 3
          || lines[2] !== ""
          || lines[1] !== invitationEnvelopeEof
        ) {
          throw new Error("missing invitation EOF marker");
        }
        invitation = lines[0] ?? "";
      } catch {
        value.fill(0);
        fail("Private enrollment input is incomplete or not valid UTF-8");
        return;
      }
      value.fill(0);
      if (!/^[A-Za-z0-9_-]+$/u.test(invitation)) {
        fail("Private enrollment input must contain one invitation envelope");
        return;
      }
      settled = true;
      cleanup();
      resolve(invitation);
    };
    const onError = (): void => fail("Private enrollment input could not be read");
    const onClose = (): void => fail("Private enrollment input closed before EOF");
    const onAbort = (): void => fail("Private enrollment input was interrupted");
    timer = setTimeout(() => fail("Private enrollment input timed out waiting for EOF"), timeoutMilliseconds);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.once("close", onClose);
    limits.signal?.addEventListener("abort", onAbort, { once: true });
    // The signal may have changed while installing the listeners.
    if (limits.signal?.aborted) onAbort();
  });
};

/** Validate the non-secret command shape before reading a potentially open pipe. */
export const privateEnrollmentArguments = (arguments_: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (!isPrivateEnrollmentCommand(arguments_)) {
    throw new EnrollmentInputError("Not a private enrollment command");
  }
  const command = withoutGlobalJson(arguments_);
  let stdinCount = 0;
  const seen = new Set<string>();
  for (let index = 2; index < command.length; index += 1) {
    const argument = command[index]!;
    if (argument === "--stdin") {
      stdinCount += 1;
      continue;
    }
    if (!["--name", "--profile", "--replace"].includes(argument) || seen.has(argument)) {
      throw new EnrollmentInputError("Private enrollment accepts --stdin, --name, --profile, and --replace once each");
    }
    seen.add(argument);
    if (argument === "--name" || argument === "--profile") {
      const value = command[++index];
      if (value === undefined || value.trim().length === 0 || value.startsWith("-") || /[\0\r\n]/u.test(value)) {
        throw new EnrollmentInputError("Private enrollment requires nonempty --name and --profile values");
      }
    }
  }
  if (stdinCount !== 1 || !seen.has("--name") || !seen.has("--profile")) {
    throw new EnrollmentInputError("Usage: canonfig follower enroll --stdin --name <name> --profile <id> [--replace]");
  }
  return arguments_.filter((argument) => argument !== "--stdin");
};
