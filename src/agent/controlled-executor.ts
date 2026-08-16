import { spawn } from "node:child_process";

import { Effect } from "effect";

import {
  AgentExecutionCancelledError,
  AgentExecutionTimeoutError,
  AgentInputLimitError,
  AgentOutputLimitError,
  AgentProcessError,
  type AgentResolutionError,
} from "./agent-resolution.errors.ts";
import type {
  CapturedProcess,
  ControlledProcessInput,
} from "./agent-resolution.types.ts";

const decoder = new TextDecoder();

export const redactText = (
  value: string,
  secrets: ReadonlyArray<string>,
): string => {
  let redacted = value;
  const ordered = [...new Set(secrets)]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const secret of ordered) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return redacted;
};

const environmentObject = (
  entries: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const entry of entries) environment[entry.name] = entry.value;
  return environment;
};

const cancelled = (input: ControlledProcessInput): AgentExecutionCancelledError =>
  new AgentExecutionCancelledError({ executable: input.executable });

export const executeControlledProcess = (
  input: ControlledProcessInput,
): Effect.Effect<CapturedProcess, AgentResolutionError> => {
  const inputBytes = input.standardInput?.byteLength ?? 0;
  if (inputBytes > input.maximumInputBytes) {
    return Effect.fail(new AgentInputLimitError({
      actualBytes: inputBytes,
      maximumBytes: input.maximumInputBytes,
    }));
  }
  if (input.signal?.aborted === true) return Effect.fail(cancelled(input));

  return Effect.tryPromise({
    try: (effectSignal) => new Promise<CapturedProcess>((resolve, reject) => {
      const output: Array<Buffer> = [];
      const errors: Array<Buffer> = [];
      let capturedBytes = 0;
      let settled = false;
      let limitExceeded = false;
      let timedOut = false;
      let wasCancelled = false;
      const child = spawn(input.executable, [...input.arguments], {
        cwd: input.workingDirectory,
        env: environmentObject(input.environment ?? []),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const finishWith = (cause: AgentResolutionError): void => {
        if (settled) return;
        settled = true;
        reject(cause);
      };
      const terminate = (): void => {
        if (!child.killed) child.kill("SIGKILL");
      };
      const capture = (target: Array<Buffer>) => (chunk: Buffer): void => {
        capturedBytes += chunk.byteLength;
        if (capturedBytes > input.maximumOutputBytes) {
          limitExceeded = true;
          terminate();
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", capture(output));
      child.stderr.on("data", capture(errors));
      child.once("error", (cause) => {
        finishWith(new AgentProcessError({
          executable: input.executable,
          message: redactText(String(cause), input.secrets),
        }));
      });
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, input.timeoutMilliseconds);
      const abort = (): void => {
        wasCancelled = true;
        terminate();
      };
      effectSignal.addEventListener("abort", abort, { once: true });
      input.signal?.addEventListener("abort", abort, { once: true });
      child.once("close", (exitCode, signal) => {
        clearTimeout(timer);
        effectSignal.removeEventListener("abort", abort);
        input.signal?.removeEventListener("abort", abort);
        if (settled) return;
        if (wasCancelled) {
          finishWith(cancelled(input));
          return;
        }
        if (timedOut) {
          finishWith(new AgentExecutionTimeoutError({
            executable: input.executable,
            timeoutMilliseconds: input.timeoutMilliseconds,
          }));
          return;
        }
        if (limitExceeded) {
          finishWith(new AgentOutputLimitError({
            executable: input.executable,
            maximumBytes: input.maximumOutputBytes,
          }));
          return;
        }
        settled = true;
        resolve({
          executable: input.executable,
          arguments: input.arguments,
          exitCode,
          signal,
          stdout: redactText(decoder.decode(Buffer.concat(output)), input.secrets),
          stderr: redactText(decoder.decode(Buffer.concat(errors)), input.secrets),
        });
      });
      if (input.standardInput === undefined) child.stdin.end();
      else child.stdin.end(input.standardInput);
    }),
    catch: (cause) => cause instanceof AgentInputLimitError
      || cause instanceof AgentExecutionCancelledError
      || cause instanceof AgentExecutionTimeoutError
      || cause instanceof AgentOutputLimitError
      || cause instanceof AgentProcessError
      ? cause
      : new AgentProcessError({
        executable: input.executable,
        message: redactText(String(cause), input.secrets),
      }),
  });
};
