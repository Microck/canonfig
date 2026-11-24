import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";

/** A local SQLite write transaction releases its lock even if its owner dies. */
export const withSqliteWriteLock = <A, E, R, LockFailure>(
  path: string,
  use: Effect.Effect<A, E, R>,
  onFailure: (cause: unknown) => LockFailure,
): Effect.Effect<A, E | LockFailure, R> => Effect.acquireUseRelease(
  Effect.try({
    try: () => {
      const lock = new DatabaseSync(path);
      try {
        lock.exec("BEGIN IMMEDIATE");
        return lock;
      } catch (error) {
        lock.close();
        throw error;
      }
    },
    catch: onFailure,
  }),
  () => use,
  (lock) => Effect.sync(() => lock.close()),
);
