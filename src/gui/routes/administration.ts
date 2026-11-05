import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { isNestedCommandLauncher } from "../../agent/agent-resolution.service.ts";
import { FollowerCommands } from "../../cli/follower-commands.ts";
import { CliCommandFailure, SourceCommands, type CliPayload } from "../../cli/source-commands.ts";
import { HumanActionRequiredError, type MachineStateError } from "../../machine/machine-state.errors.ts";
import { MachineState } from "../../machine/machine-state.service.ts";
import { asJson as toJson } from "../../profile/profile-codec.ts";
import { installerMethods } from "../../domain/installer-binding.ts";
import { update } from "../../runtime/self-update/core.ts";
import { updateDirectory } from "../../runtime/self-update/coordination.ts";
import { readSettings } from "../../runtime/self-update/settings.ts";
import {
  checkInstallerBinding, listInstallerBindings, loadInstallerState,
  unboundInstallerRecovery, windowsNodeBinding,
} from "../../synchronization/installer-bindings.ts";
import {
  GuiAgentHarness, GuiAgentPolicy,
  GuiSourceServiceInput,
} from "../contract/administration.ts";
import { GuiQueries } from "../queries.ts";
import { EmptyBody, failureBody, mutationRoute, queryRoute, type GuiRoute } from "../routing.ts";

const report = (operation: Effect.Effect<CliPayload, CliCommandFailure>) => operation.pipe(
  Effect.map((value) => ({ report: toJson(value), error: null })),
  Effect.catch((error) => error.details === undefined
    ? Effect.fail(error)
    : Effect.succeed({ report: toJson(error.details), error: failureBody(error.category, error.message) })),
);

/** Installer CLI deliberately classifies every non-human failure as configuration. */
const installerFailure = (error: MachineStateError) => new CliCommandFailure({
  category: error instanceof HumanActionRequiredError ? "human-action-required" : "usage-or-configuration",
  message: error instanceof HumanActionRequiredError
    ? error.recovery : "Installer binding operation failed; inspect local executable and Canonfig directory access.",
});

export const administrationRoutes = Effect.gen(function*() {
  const source = yield* SourceCommands;
  const follower = yield* FollowerCommands;
  const queries = yield* GuiQueries;
  const machine = yield* MachineState;
  const sourceOnly = <A>(operation: Effect.Effect<A, CliCommandFailure>) => Effect.gen(function*() {
    if ((yield* queries.session()).role !== "source") return yield* new CliCommandFailure({
      category: "usage-or-configuration", message: "Source service settings require a Source Machine.",
    });
    return yield* operation;
  });
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const routes: GuiRoute[] = [
    queryRoute("/api/source-service", () => sourceOnly(report(source.serviceStatus()))),
    mutationRoute("POST", "/api/source-service", GuiSourceServiceInput,
      (input) => sourceOnly(source.installService(input)).pipe(Effect.map(toJson))),
    mutationRoute("DELETE", "/api/source-service", EmptyBody,
      () => sourceOnly(source.removeService()).pipe(Effect.map(toJson))),
    queryRoute("/api/agent/policy", () => follower.getAgentPolicy().pipe(Effect.map(toJson))),
    mutationRoute("PUT", "/api/agent/policy", GuiAgentPolicy, (input) => follower.setAgentPolicy(input).pipe(Effect.map(toJson))),
    queryRoute("/api/agent/harness", () => follower.getAgentHarness().pipe(Effect.map(toJson))),
    mutationRoute("PUT", "/api/agent/harness", GuiAgentHarness, (input) => Effect.gen(function*() {
      let message: string | undefined;
      if (input.kind === "custom" && input.model !== undefined) {
        message = "--model applies to codex and claude; pass a custom harness's model with --argument";
      } else if (input.kind !== "custom" && input.arguments !== undefined) {
        message = "--argument applies only to the custom harness; codex and claude get Canonfig's read-only flags";
      } else if (input.model !== undefined && !/^[^\s-][^\s]*$/u.test(input.model)) {
        message = "Invalid agent harness configuration";
      }
      for (const origin of input.allowedOrigins) {
        const url = URL.canParse(origin) ? new URL(origin) : undefined;
        if (url === undefined || url.protocol !== "https:" || url.origin !== origin) {
          message = `Agent harness origin must be an exact HTTPS origin: ${origin}`;
          break;
        }
      }
      const unclassifiable = input.executableAuthorizations?.find((authorization) => isNestedCommandLauncher(authorization.executable));
      if (unclassifiable !== undefined) {
        message = `${unclassifiable.executable} launches nested commands that cannot be bounded by an execution model; remove it from the agent harness allowlist`;
      }
      if (message !== undefined) return yield* new CliCommandFailure({ category: "usage-or-configuration", message });
      return toJson(yield* follower.setAgentHarness(input));
    })),
    mutationRoute("POST", "/api/doctor", EmptyBody,
      () => report(follower.doctor({ noInput: true, timeoutMilliseconds: 10_000 }))),
    queryRoute("/api/installers", () => Effect.gen(function*() {
      const bindings = yield* listInstallerBindings();
      const suggestions = (yield* Effect.forEach(
        ["npm", "pnpm"].filter((method) => !bindings.some((binding) => binding.method === method)),
        (method) => windowsNodeBinding(method).pipe(Effect.map((binding) =>
          binding === undefined ? undefined : { method, shim: binding.shim, command: binding.command })),
      )).filter((suggestion) => suggestion !== undefined);
      return toJson({ bindings, suggestions });
    }).pipe(Effect.provideService(MachineState, machine), Effect.mapError(installerFailure))),
    queryRoute("/api/self-update", () => Effect.try({
      try: () => {
        const directory = updateDirectory(root);
        const enabled = existsSync(join(directory, "settings.json"));
        return toJson({
          platform: process.platform,
          enabled, pending: existsSync(join(directory, "pending.json")),
          settings: enabled ? readSettings(directory) : null,
        });
      },
      catch: (error) => new CliCommandFailure({
        category: "human-action-required", message: error instanceof Error ? error.message : String(error),
      }),
    })),
    mutationRoute("POST", "/api/self-update/check", EmptyBody,
      () => Effect.tryPromise({
        try: (signal) => update(root, false, undefined, signal),
        catch: (error) => new CliCommandFailure({
          category: "human-action-required", message: error instanceof Error ? error.message : String(error),
        }),
      }).pipe(Effect.map(toJson))),
  ];
  for (const method of installerMethods) {
    routes.push(mutationRoute("POST", `/api/installers/${method}/check`, EmptyBody,
      () => Effect.gen(function*() {
        const state = yield* loadInstallerState(method);
        if (state.status !== "bound") return yield* new HumanActionRequiredError({
          action: "configure an installer binding",
          recovery: state.status === "removed"
            ? "The installer binding was explicitly removed; run installer set with the existing executable and optional JavaScript entrypoint, then retry."
            : yield* unboundInstallerRecovery(method),
        });
        return toJson(yield* checkInstallerBinding(state.binding));
      }).pipe(Effect.provideService(MachineState, machine), Effect.mapError(installerFailure))));
  }
  return routes;
});
