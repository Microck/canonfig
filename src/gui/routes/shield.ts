import { Effect, Schema } from "effect";
import { FollowerCommands } from "../../cli/follower-commands.ts";
import { CliCommandFailure } from "../../cli/source-commands.ts";
import { asJson } from "../../profile/profile-codec.ts";
import { loadCanonicalFolder } from "../../projection/folder.ts";
import { readShieldLog } from "../../projection/shield-log.ts";
import { GuiShieldRequest, GuiShieldStatus, type GuiShield } from "../contract/shield.ts";
import { GuiQueries } from "../queries.ts";
import { mutationRoute, queryRoute, type GuiRoute } from "../routing.ts";

const invalid = (message: string) => new CliCommandFailure({ category: "usage-or-configuration", message });

/** Shield is per machine, so both roles read and change their own policy, log and plugin reviews. */
export const shieldRoutes = Effect.gen(function*() {
  const commands = yield* FollowerCommands;
  const queries = yield* GuiQueries;
  const configured = queries.session().pipe(Effect.flatMap((session) => session.role === "unconfigured"
    ? Effect.fail(invalid("Shield needs a Source or Follower machine."))
    : Effect.succeed(session)));
  return [
    queryRoute("/api/shield", () => Effect.gen(function*() {
      const session = yield* configured;
      const status = yield* commands.shield({ action: "status" }).pipe(
        Effect.flatMap((payload) => Schema.decodeUnknownEffect(GuiShieldStatus)(payload)),
        Effect.mapError((error) => error instanceof CliCommandFailure ? error : invalid(`Shield status was not readable: ${error.message}`)),
      );
      const [log, loaded] = yield* Effect.tryPromise({
        try: () => Promise.all([readShieldLog(session.folderPath), loadCanonicalFolder(session.folderPath)]),
        catch: (cause) => invalid(String(cause)),
      });
      const shield: GuiShield = {
        status, log,
        plugins: loaded.model.plugins.map((plugin) => ({
          id: plugin.id,
          harnesses: [...new Set(plugin.manifest.variants.map((variant) => variant.harness))],
          entries: [...new Set(plugin.manifest.variants.flatMap((variant) => variant.entry === undefined ? [] : [`${variant.directory}/${variant.entry}`]))],
          requires: [...new Set(plugin.manifest.variants.flatMap((variant) => variant.requires ?? []))],
          files: plugin.files.length,
          digest: plugin.digest,
          reviewed: plugin.reviewed,
          excluded: status.excludedPlugins.includes(plugin.id),
        })),
      };
      return asJson(shield);
    })),
    mutationRoute("POST", "/api/shield", GuiShieldRequest, (input) => configured.pipe(
      // A GUI review is signed with this machine's name: the person at this machine looked at the digest they approve.
      Effect.flatMap((session) => commands.shield(input.action === "review" ? { ...input, reviewer: session.machineName } : input)),
      Effect.map(asJson),
    )),
  ] satisfies ReadonlyArray<GuiRoute>;
});
