import { hostname } from "node:os";
import { Context, Effect, Layer } from "effect";

import { describeRuntimeError } from "../cli/failure-taxonomy.ts";
import { programVersion } from "../cli/help.ts";
import { CliCommandFailure } from "../cli/source-commands.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import type { GuiSession } from "./contract.ts";

export class GuiQueries extends Context.Service<GuiQueries, {
  readonly session: () => Effect.Effect<GuiSession, CliCommandFailure>;
}>()("canonfig/gui/GuiQueries") {}

/** Session metadata is local. Opening the GUI must not probe the followed Source twice. */
export const guiQueriesLayer = (folderPath: string) => Layer.effect(GuiQueries, Effect.gen(function*() {
  const repository = yield* StateRepository;
  return GuiQueries.of({
    session: Effect.fn("Gui.session")(function*() {
      const [source, follower] = yield* Effect.all([
        repository.getEnrollmentSource(),
        repository.getFollowerSynchronizationConfiguration(),
      ]).pipe(Effect.mapError((error) => {
        const failure = describeRuntimeError(error);
        return new CliCommandFailure({ category: failure.category, message: failure.message });
      }));
      return {
        role: follower !== undefined ? "follower" : source !== undefined ? "source" : "unconfigured",
        machineName: hostname(),
        version: programVersion,
        folderPath,
      };
    }),
  });
}));
