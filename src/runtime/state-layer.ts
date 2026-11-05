import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Cause, Effect, Layer } from "effect";
import { StateRepository } from "../state/state-repository.service.ts";
import {
  EarlierStateFormatError,
  EarlierStateUpgradeError,
  type RepositorySqlError,
} from "../state/state-repository.errors.ts";
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
      if (error instanceof EarlierStateFormatError) {
        return Layer.effect(StateRepository, Effect.fail(new StateInitializationError({
          path: filename,
          message: error.origin === "before-state-format-4"
            ? `Canonfig state at ${filename} was created by a release before 4.0.0, which this version cannot upgrade directly. Run any command once with Canonfig 5.0.1 (for example \`npx @microck/canonfig@5.0.1 status\`) so it brings the state up to date, then run this version again.`
            : `Canonfig state at ${filename} has a schema history this version does not know (${error.migrations.join(", ")}), most likely from a newer release. Run the release that wrote it, or move ${filename} aside and set this machine up again.`,
        })));
      }
      if (error instanceof EarlierStateUpgradeError) {
        return Layer.effect(StateRepository, Effect.fail(new StateInitializationError({
          path: filename,
          message: `Canonfig cannot carry the state at ${filename} forward from 5.0.1: ${error.item}: ${error.reason}. ${error.recovery}`,
        })));
      }
      const message = error instanceof Error ? error.message : "";
      const busy = /database (?:is |table is )?locked|SQLITE_(?:BUSY|LOCKED)/iu.test(message);
      const failure: Effect.Effect<never, StateInitializationError | RepositorySqlError | EarlierStateFormatError | EarlierStateUpgradeError> =
        busy || /file is not a database|unable to open database|database disk image is malformed|database or disk is full|readonly database|SQLITE_(?:CANTOPEN|NOTADB|CORRUPT|READONLY|FULL)/iu.test(message)
          ? Effect.fail(unavailable(filename, busy))
          : Effect.failCause(cause);
      return Layer.effect(StateRepository, failure);
    }),
  ))),
);
