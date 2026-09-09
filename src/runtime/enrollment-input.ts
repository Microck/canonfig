import type { Readable } from "node:stream";

/** Enrollment is the only CLI argument replaced from this private input path. */
export const isPrivateEnrollmentCommand = (arguments_: ReadonlyArray<string>): boolean =>
  arguments_[0] === "follower"
  && arguments_[1] === "enroll"
  && arguments_.slice(2).includes("--stdin");

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
  const maximumBytes = limits.maximumBytes ?? 64 * 1024;
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
        invitation = new TextDecoder("utf-8", { fatal: true }).decode(value).trim();
      } catch {
        value.fill(0);
        fail("Private enrollment input is not valid UTF-8");
        return;
      }
      value.fill(0);
      if (!/^[A-Za-z0-9_-]+$/u.test(invitation)) {
        fail("Private enrollment input must contain one nonempty base64url invitation");
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
  let stdinCount = 0;
  const seen = new Set<string>();
  for (let index = 2; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--stdin") {
      stdinCount += 1;
      continue;
    }
    if (!["--name", "--profile", "--replace", "--json"].includes(argument) || seen.has(argument)) {
      throw new EnrollmentInputError("Private enrollment accepts --stdin, --name, --profile, --replace, and --json once each");
    }
    seen.add(argument);
    if (argument === "--name" || argument === "--profile") {
      const value = arguments_[++index];
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
