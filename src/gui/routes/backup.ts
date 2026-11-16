import { Effect, Redacted } from "effect";
import type { BackupRequest } from "../../backup/backup.types.ts";
import { FollowerCommands } from "../../cli/follower-commands.ts";
import { asJson } from "../../profile/profile-codec.ts";
import { GuiBackupRequest } from "../contract/backup.ts";
import { GuiOperations } from "../operations.ts";
import { mutationRoute, queryRoute, type GuiRoute } from "../routing.ts";

export const backupRoutes = Effect.gen(function*() {
  // This command service operates on the local machine for either role.
  const commands = yield* FollowerCommands;
  const operations = yield* GuiOperations;
  return [
    queryRoute("/api/backup/status", () => commands.backup({ action: "status" }).pipe(Effect.map(asJson))),
    mutationRoute("POST", "/api/backup", GuiBackupRequest, input => {
      const request: BackupRequest = input.action === "password"
        ? { action: "password", name: input.name, value: Redacted.make(input.password) }
        : input;
      // A disconnected browser must not interrupt an upload, retention or restore midway.
      return operations.start(commands.backup(request).pipe(Effect.map(asJson)), () => Effect.succeed(null));
    }, 202),
  ] satisfies ReadonlyArray<GuiRoute>;
});
