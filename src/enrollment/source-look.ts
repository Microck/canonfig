import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, Schema } from "effect";

import { MachineState } from "../machine/machine-state.service.ts";

/** A preset key from the browser map (`desktop`, `orange`, `custom`); the browser falls back on one it does not know. */
const PresetKey = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/u));

/**
 * How the Source's card looks on the machine map, as customized on the Source.
 * Followers fetch it so their maps show the Source the same way. An uploaded
 * icon stays on the Source; a Follower draws the preset it falls back to.
 */
export const SourceLook = Schema.Struct({
  name: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  purpose: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
  icon: Schema.optional(PresetKey),
  accent: Schema.optional(PresetKey),
  customAccent: Schema.optional(Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/u))),
});
export type SourceLook = typeof SourceLook.Type;

/** `~/.canonfig/source-look.json`: Source state beside `source-service.json`, never part of a published revision. */
const sourceLookPath = Effect.gen(function*() {
  const machine = yield* MachineState;
  const directories = yield* machine.userDirectories();
  const directory = yield* machine.normalizePath({ path: ".canonfig", base: directories.home });
  return (yield* machine.normalizePath({ path: "source-look.json", base: directory })).absolute;
});

/** The saved look, or undefined when none was saved or the file no longer decodes. It is decoration, so it never fails a request. */
export const readSourceLook = (): Effect.Effect<SourceLook | undefined, never, MachineState> =>
  sourceLookPath.pipe(
    Effect.flatMap((path) => Effect.tryPromise(() => readFile(path, "utf8"))),
    Effect.flatMap((text) => Schema.decodeUnknownEffect(Schema.fromJsonString(SourceLook))(text, { onExcessProperty: "error" })),
    Effect.orElseSucceed(() => undefined),
  );

/** Saves the look, or removes it when `look` is undefined, so a reset Source card returns to the defaults everywhere. */
export const writeSourceLook = (look: SourceLook | undefined): Effect.Effect<void, Error, MachineState> =>
  sourceLookPath.pipe(
    Effect.mapError((cause) => new Error(`the source look path is unavailable: ${cause.message}`)),
    Effect.flatMap((path) => Effect.tryPromise({
      try: async () => {
        if (look === undefined) {
          await rm(path, { force: true });
          return;
        }
        // Write then rename, so a Follower reading at the same moment sees the old look or the new one, never half of one.
        // Each save gets its own temporary file, so two browsers saving at once cannot interleave or rename it from under each other.
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, `${JSON.stringify(look)}\n`, { mode: 0o600 });
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
      },
      catch: (cause) => new Error(`the source look could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`),
    })),
  );
