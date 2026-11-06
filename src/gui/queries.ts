import { hostname } from "node:os";
import { Context, Effect, Layer } from "effect";

import { describeRuntimeError } from "../cli/failure-taxonomy.ts";
import { programVersion } from "../cli/help.ts";
import { CliCommandFailure } from "../cli/source-commands.ts";
import type { AgentPolicy } from "../domain/identity.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import type { GuiSession } from "./contract.ts";

export class GuiQueries extends Context.Service<GuiQueries, {
  readonly session: () => Effect.Effect<GuiSession, CliCommandFailure>;
  readonly agentPolicy: () => Effect.Effect<AgentPolicy | undefined, CliCommandFailure>;
}>()("canonfig/gui/GuiQueries") {}

/** Session metadata is local. Opening the GUI must not probe the followed Source twice. */
export const guiQueriesLayer = (
  folderPath: string,
  readPolicy: () => Effect.Effect<AgentPolicy | undefined, CliCommandFailure>,
) => Layer.effect(GuiQueries, Effect.gen(function*() {
  const repository = yield* StateRepository;
  return GuiQueries.of({
    agentPolicy: Effect.fn("Gui.agentPolicy")(function*() {
      const configuration = yield* repository.getFollowerSynchronizationConfiguration().pipe(
        Effect.mapError((error) => {
          const failure = describeRuntimeError(error);
          return new CliCommandFailure({ category: failure.category, message: failure.message });
        }),
      );
      return configuration === undefined ? yield* readPolicy() : configuration.agentPolicy;
    }),
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
