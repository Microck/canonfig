import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Cause, Effect, Layer } from "effect";
import { StateRepository } from "../state/state-repository.service.ts";
import type { RepositorySqlError } from "../state/state-repository.errors.ts";
import { stateRepositoryLayer } from "../state/state-repository.layer.ts";
import { StateInitializationError } from "./state-initialization.errors.ts";

const unavailable = (path: string, busy = false) => new StateInitializationError({
  path,
  message: busy ? `Canonfig state at ${path} is busy. Wait for the other process to finish, then retry; do not delete the database.` : `Cannot open Canonfig state at ${path}. Check that its parent is a writable directory and the database is valid. Preserve the existing state; restore a known-good backup if it is corrupt, then retry.`,
});

/** Classify recoverable storage initialization failures without logging raw defects. */
export const runtimeStateLayer = (filename: string) => Layer.unwrap(
  Effect.tryPromise({
    try: () => mkdir(dirname(filename), { recursive: true, mode: 0o700 }),
    catch: () => unavailable(filename),
  }).pipe(Effect.as(stateRepositoryLayer(filename).pipe(
    Layer.catchCause((cause) => {
      const error = Cause.squash(cause);
      const message = error instanceof Error ? error.message : "";
      const busy = /database (?:is |table is )?locked|SQLITE_(?:BUSY|LOCKED)/iu.test(message);
      const failure: Effect.Effect<never, StateInitializationError | RepositorySqlError> =
        busy || /file is not a database|unable to open database|database disk image is malformed|database or disk is full|readonly database|SQLITE_(?:CANTOPEN|NOTADB|CORRUPT|READONLY|FULL)/iu.test(message)
          ? Effect.fail(unavailable(filename, busy))
          : Effect.failCause(cause);
      return Layer.effect(StateRepository, failure);
    }),
  ))),
);
