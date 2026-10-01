import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, stat, unlink } from "node:fs/promises";

import { Effect, Option, Schema } from "effect";

import { MachineFilesystemError } from "../machine/machine-state.errors.ts";
import { RunLockHeldError } from "./synchronization.errors.ts";

/**
 * One process at a time may apply, recover or abandon a follower's run.
 *
 * The open-run row in the state database says a run exists, not whether its
 * owner is still alive. `recover` used to execute a run whose process was only
 * paused, record it Converged, and let the resumed owner rename its temporary
 * file over the result. The lock is an exclusively created file next to the
 * state database that records its owner's PID. A lock whose PID no longer
 * exists was left by a killed process and is taken over.
 */
export const runLockPath = (stateLocation: string): string => `${stateLocation}.run-lock`;

const LockRecord = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  operation: Schema.String,
  since: Schema.String,
  token: Schema.String,
});
type LockRecord = typeof LockRecord.Type;

/**
 * An empty or partial lock this young may still be being written by its
 * owner; an older one was left by a process killed while creating it.
 */
const unreadableLockGraceMilliseconds = 5_000;

const ErrorWithCode = Schema.Struct({ code: Schema.String });

const errorCode = (cause: unknown): string | undefined =>
  Schema.is(ErrorWithCode)(cause) ? cause.code : undefined;

const decodeLockRecord = Schema.decodeUnknownOption(Schema.fromJsonString(LockRecord));

/** An empty, partial or foreign lock file is unreadable: handled by the caller. */
const parseRecord = (text: string): LockRecord | undefined =>
  Option.getOrUndefined(decodeLockRecord(text));

/** Signal 0 checks existence only. EPERM means it exists under another user. */
const processExists = (pid: number): boolean => {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return errorCode(cause) === "EPERM";
  }
};

type Holder =
  | { readonly state: "missing" }
  | { readonly state: "live"; readonly record?: LockRecord | undefined }
  | { readonly state: "stale"; readonly text: string };

const inspectHolder = async (path: string): Promise<Holder> => {
  let text: string;
  let modified: number;
  try {
    [text, modified] = await Promise.all([
      readFile(path, "utf8"),
      stat(path).then((metadata) => metadata.mtimeMs),
    ]);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return { state: "missing" };
    throw cause;
  }
  const record = parseRecord(text);
  if (record === undefined) {
    return Date.now() - modified < unreadableLockGraceMilliseconds
      ? { state: "live" }
      : { state: "stale", text };
  }
  return processExists(record.pid) ? { state: "live", record } : { state: "stale", text };
};

/**
 * Move a stale lock out of the way, but only if it is still the one that was
 * judged stale. If a competing process replaced it in between, its live lock
 * is linked back into place (never over a newer one) before retrying.
 */
const removeStaleLock = async (path: string, staleText: string): Promise<void> => {
  const retired = `${path}.${randomUUID()}.stale`;
  try {
    await rename(path, retired);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return;
    throw cause;
  }
  try {
    if (await readFile(retired, "utf8") === staleText) return;
    await link(retired, path).catch((cause: unknown) => {
      if (errorCode(cause) !== "EEXIST") throw cause;
    });
  } finally {
    await unlink(retired).catch(() => undefined);
  }
};

const acquire = async (path: string, operation: string): Promise<LockRecord | RunLockHeldError> => {
  for (;;) {
    const record: LockRecord = {
      pid: process.pid,
      operation,
      since: new Date().toISOString(),
      token: randomUUID(),
    };
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return record;
    } catch (cause) {
      if (errorCode(cause) !== "EEXIST") throw cause;
    }
    const holder = await inspectHolder(path);
    if (holder.state === "live") {
      return new RunLockHeldError({
        path,
        operation: holder.record?.operation,
        pid: holder.record?.pid,
        since: holder.record?.since,
      });
    }
    if (holder.state === "stale") await removeStaleLock(path, holder.text);
  }
};

const release = async (path: string, token: string): Promise<void> => {
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current !== undefined && parseRecord(current)?.token === token) {
    await unlink(path).catch(() => undefined);
  }
};

/** The live process holding the run lock, if any. Read-only; never reclaims. */
export const runLockHolder = (
  stateLocation: string,
): Effect.Effect<{ readonly pid: number; readonly operation: string; readonly since: string } | undefined> =>
  Effect.promise(() =>
    inspectHolder(runLockPath(stateLocation)).then(
      (holder) =>
        holder.state === "live" && holder.record !== undefined
          ? { pid: holder.record.pid, operation: holder.record.operation, since: holder.record.since }
          : undefined,
      () => undefined,
    )
  );

/**
 * Run `effect` while holding the follower's run lock. Fails with
 * `RunLockHeldError`, before `effect` starts, when a live process holds it.
 */
export const withRunLock = <A, E, R>(
  stateLocation: string,
  operation: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | RunLockHeldError | MachineFilesystemError, R> => {
  const path = runLockPath(stateLocation);
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => acquire(path, operation),
      catch: (cause) =>
        new MachineFilesystemError({
          operation: "acquire run lock",
          path,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(
      Effect.flatMap((result) =>
        result instanceof RunLockHeldError ? Effect.fail(result) : Effect.succeed(result)
      ),
    ),
    () => effect,
    (record) => Effect.promise(() => release(path, record.token)),
  );
};
