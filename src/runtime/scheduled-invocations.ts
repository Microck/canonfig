import { createHash } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Effect, Schema } from "effect";

import { ContentDigest, Timestamp } from "../domain/brand.ts";
import type { StateRepository } from "../state/state-repository.service.ts";
import type { ScheduledInvocation } from "../state/state-repository.types.ts";
import { CliCommandFailure } from "../cli/source-commands.ts";
import { describeRuntimeError } from "../cli/failure-taxonomy.ts";

const LegacyFireFields = {
  startedAt: Timestamp,
  at: Timestamp,
  generation: Schema.optional(Schema.NonEmptyString),
};
const LegacyReceipts = Schema.Struct({
  schema: Schema.Literal("canonfig.schedule-fire/v1"),
  fires: Schema.Array(Schema.Union([
    Schema.Struct({ ...LegacyFireFields, outcome: Schema.Literal("started") }),
    Schema.Struct({ ...LegacyFireFields, outcome: Schema.Literal("completed") }),
    Schema.Struct({ ...LegacyFireFields, outcome: Schema.Literal("failed"), reason: Schema.NonEmptyString }),
  ])),
});

/** SQL owns import acknowledgement, so a crash before rename cannot duplicate history. */
export const loadScheduledInvocations = Effect.fn("Runtime.loadScheduledInvocations")(function*(
  repository: StateRepository["Service"],
  statePath: string,
) {
  const path = join(dirname(statePath), "schedule-fires.json");
  const recovery = (detail: string) => new CliCommandFailure({
    category: "human-action-required",
    message: `The old unattended receipt ${path} could not be imported: ${detail}. Move that receipt aside and let the native scheduler run again; the enrollment and synchronization history remain unchanged.`,
  });
  const bytes = yield* Effect.tryPromise({
    try: () => readFile(path, "utf8").catch((cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
      throw cause;
    }),
    catch: () => recovery("the file could not be read"),
  });
  if (bytes !== undefined) {
    const receipts = yield* Effect.try({
      try: () => JSON.parse(bytes),
      catch: () => recovery("the file is not valid JSON"),
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(LegacyReceipts)),
      Effect.mapError(() => recovery("the file is malformed or lacks invocation start times")));
    const digest = ContentDigest.make(createHash("sha256").update(bytes).digest("hex"));
    const grouped = new Map<string, ScheduledInvocation>();
    for (const fire of receipts.fires) {
      if (!Number.isFinite(Date.parse(fire.startedAt)) || !Number.isFinite(Date.parse(fire.at))
        || Date.parse(fire.at) < Date.parse(fire.startedAt)) {
        return yield* recovery("an invocation has invalid timestamps");
      }
      const key = JSON.stringify([fire.startedAt, fire.generation]);
      const previous = grouped.get(key);
      if (previous !== undefined && (previous._tag !== "Running" || fire.outcome === "started")) {
        return yield* recovery("overlapping events cannot be assigned to a unique invocation");
      }
      // The ten-event file can begin with a terminal event whose start was
      // trimmed. Its recorded startedAt still identifies that invocation.
      const identity = {
        id: previous?.id ?? `legacy:${digest}:${grouped.size}`,
        startedAt: fire.startedAt,
        generation: fire.generation,
      };
      const invocation: ScheduledInvocation = fire.outcome === "started"
        ? { ...identity, _tag: "Running" }
        : fire.outcome === "completed"
        ? { ...identity, _tag: "Completed", at: fire.at }
        : { ...identity, _tag: "Failed", at: fire.at, reason: fire.reason };
      grouped.set(key, invocation);
    }
    yield* repository.importScheduledInvocations({
      path, digest, invocations: [...grouped.values()],
    }).pipe(Effect.mapError((error) => recovery(error.message)));
    yield* Effect.tryPromise({
      try: () => rename(path, `${path}.imported`).catch((cause: unknown) => {
        // Another reader may have acknowledged and renamed the same file.
        if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
      }),
      catch: () => recovery("SQL import completed, but archiving the file failed; repair directory permissions and retry"),
    });
  }
  return yield* repository.listScheduledInvocations().pipe(Effect.mapError((error) =>
    new CliCommandFailure(describeRuntimeError(error))));
});
