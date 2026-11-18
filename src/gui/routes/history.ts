import { Effect } from "effect";

import { FollowerCommands } from "../../cli/follower-commands.ts";
import { sanitizeCliData } from "../../cli/render.ts";
import { asJson } from "../../profile/profile-codec.ts";
import { HistoryRequest } from "../contract/history.ts";
import { GuiOperations } from "../operations.ts";
import { mutationRoute, queryRoute, type GuiRoute } from "../routing.ts";

export const historyRoutes = Effect.gen(function*() {
  const commands = yield* FollowerCommands;
  const operations = yield* GuiOperations;
  const result = (request: HistoryRequest) => commands.history(request).pipe(Effect.map(sanitizeCliData), Effect.map(asJson));
  return [
    queryRoute("/api/history/status", () => result({ action: "list" })),
    mutationRoute("POST", "/api/history", HistoryRequest, request =>
      operations.start(result(request), () => Effect.succeed(null)), 202),
  ] satisfies ReadonlyArray<GuiRoute>;
});
