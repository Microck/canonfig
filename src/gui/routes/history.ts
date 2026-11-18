import { Effect } from "effect";

import { FollowerCommands } from "../../cli/follower-commands.ts";
import { asJson } from "../../profile/profile-codec.ts";
import { HistoryRequest } from "../contract/history.ts";
import { GuiOperations } from "../operations.ts";
import { mutationRoute, queryRoute, type GuiRoute } from "../routing.ts";

export const historyRoutes = Effect.gen(function*() {
  const commands = yield* FollowerCommands;
  const operations = yield* GuiOperations;
  return [
    queryRoute("/api/history/status", () => commands.history({ action: "list" }).pipe(Effect.map(asJson))),
    mutationRoute("POST", "/api/history", HistoryRequest, request =>
      operations.start(commands.history(request).pipe(Effect.map(asJson)), () => Effect.succeed(null)), 202),
  ] satisfies ReadonlyArray<GuiRoute>;
});
