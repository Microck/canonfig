import { Effect, Schema } from "effect";
import { FollowerCommands } from "../../cli/follower-commands.ts";
import { sanitizeCliData } from "../../cli/render.ts";
import { CliCommandFailure } from "../../cli/source-commands.ts";
import { GuiStatus, guiEndpoints } from "../contract/session.ts";
import { GuiQueries } from "../queries.ts";
import { queryRoute } from "../routing.ts";

export const sessionRoutes = Effect.gen(function*() {
  const commands = yield* FollowerCommands;
  const queries = yield* GuiQueries;
  return [
    queryRoute(guiEndpoints.session, queries.session),
    queryRoute(guiEndpoints.status, () => commands.status(undefined).pipe(
      Effect.map(sanitizeCliData),
      Effect.flatMap(Schema.decodeUnknownEffect(GuiStatus)),
      Effect.mapError((error) => error instanceof CliCommandFailure ? error : new CliCommandFailure({
        category: "internal", message: "The status service returned an invalid browser response.",
      })),
    )),
  ];
});
