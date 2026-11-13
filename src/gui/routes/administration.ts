import { FleetStart } from "../../domain/fleet-update.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { isNestedCommandLauncher } from "../../agent/agent-resolution.service.ts";
import { FollowerCommands } from "../../cli/follower-commands.ts";
import { CliCommandFailure, SourceCommands, type CliPayload } from "../../cli/source-commands.ts";
import { sanitizeCliData } from "../../cli/render.ts";
import { HumanActionRequiredError, type MachineStateError } from "../../machine/machine-state.errors.ts";
import { MachineState } from "../../machine/machine-state.service.ts";
import { asJson as toJson } from "../../profile/profile-codec.ts";
import { installerMethods } from "../../domain/installer-binding.ts";
import { disable, enable, update, type UpdateProgress } from "../../runtime/self-update/core.ts";
import { updateDirectory, type ManagedCommandLease } from "../../runtime/self-update/coordination.ts";
import { readSettings } from "../../runtime/self-update/settings.ts";
import { StateRepository } from "../../state/state-repository.service.ts";
import type { FollowerSynchronizationConfiguration } from "../../synchronization/follower-sync-config.ts";
import {
  checkInstallerBinding, detectInstaller, listInstallerBindings, loadInstallerState,
  removeInstallerBinding, saveInstallerBinding, unboundInstallerRecovery,
} from "../../synchronization/installer-bindings.ts";
import {
  GuiAgentHarness, GuiAgentPolicy, type GuiAgentHarnessRead,
  GuiInstallerSetInput, GuiSelfUpdateEnable, GuiSourceServiceInput,
} from "../contract/administration.ts";
import { GuiQueries } from "../queries.ts";
import { EmptyBody, commandFailure, failureBody, mutationRoute, queryRoute, type GuiRoute } from "../routing.ts";
import { GuiOperations } from "../operations.ts";

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

/** Keep credential-bearing collections write-only, rather than editable redaction markers. */
const harnessResponse = (value: CliPayload) => {
  const safe = Schema.decodeUnknownSync(GuiAgentHarness)(sanitizeCliData(value, [], true));
  return {
    ...safe,
    arguments: safe.arguments?.some((argument) => argument.includes("[REDACTED]")) ? undefined : safe.arguments,
    environment: safe.environment?.some(({ name, value }) => `${name}${value}`.includes("[REDACTED]")) ? undefined : safe.environment,
  };
};

export const administrationRoutes = (lease: ManagedCommandLease, onUpdated: () => void, onSettled: () => void) => Effect.gen(function*() {
  const source = yield* SourceCommands;
  const follower = yield* FollowerCommands;
  const queries = yield* GuiQueries;
  const machine = yield* MachineState;
  const repository = yield* StateRepository;
  const operations = yield* GuiOperations;
  const sourceOnly = <A>(operation: Effect.Effect<A, CliCommandFailure>) => Effect.gen(function*() {
    if ((yield* queries.session()).role !== "source") return yield* new CliCommandFailure({
      category: "usage-or-configuration", message: "Source service settings require a Source Machine.",
    });
    return yield* operation;
  });
  // Agent policy and harness exist only on an enrolled Follower Machine, where runs call the agent. The configuration
  // read here is the role check and the route's own read, so no agent route reads it twice.
  const withFollower = <A>(operation: (configuration: FollowerSynchronizationConfiguration) => Effect.Effect<A, CliCommandFailure>) =>
    repository.getFollowerSynchronizationConfiguration().pipe(
      Effect.mapError(commandFailure),
      Effect.flatMap((configuration) => configuration === undefined
        ? Effect.fail(new CliCommandFailure({
          category: "usage-or-configuration", message: "Agent settings require an enrolled Follower Machine.",
        }))
        : operation(configuration)),
    );
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const updateFailure = (cause: unknown) => new CliCommandFailure({
    category: "human-action-required", message: cause instanceof Error ? cause.message : String(cause),
  });
  const status = () => {
    const directory = updateDirectory(root);
    const enabled = existsSync(join(directory, "settings.json"));
    return toJson({
      platform: process.platform, enabled, pending: existsSync(join(directory, "pending.json")),
      settings: enabled ? readSettings(directory) : null,
    });
  };
  const routes: GuiRoute[] = [
    queryRoute("/api/fleet-update", () => sourceOnly(source.fleetStatus()).pipe(Effect.map(toJson))),
    mutationRoute("POST", "/api/fleet-update", FleetStart, (input) => sourceOnly(source.startFleetUpdate(input)).pipe(Effect.map(toJson))),
    mutationRoute("POST", "/api/fleet-update/stop", Schema.Struct({ apply: Schema.Boolean }), (input) => sourceOnly(source.stopFleetUpdate(input.apply)).pipe(Effect.map(toJson))),
    queryRoute("/api/source-service", () => sourceOnly(report(source.serviceStatus()))),
    mutationRoute("POST", "/api/source-service", GuiSourceServiceInput,
      (input) => sourceOnly(source.installService(input)).pipe(Effect.map(toJson))),
    mutationRoute("DELETE", "/api/source-service", EmptyBody,
      () => sourceOnly(source.removeService()).pipe(Effect.map(toJson))),
    queryRoute("/api/agent/policy", () => withFollower((configuration) => Effect.succeed(toJson(configuration.agentPolicy)))),
    mutationRoute("PUT", "/api/agent/policy", GuiAgentPolicy, (input) => withFollower(() => follower.setAgentPolicy(input)).pipe(Effect.map(toJson))),
    queryRoute("/api/agent/harness", () => withFollower((configuration) => Effect.succeed(toJson(
      (configuration.agentHarness === undefined
        ? { configured: false } : { configured: true, value: harnessResponse(configuration.agentHarness) }) satisfies GuiAgentHarnessRead,
    )))),
    mutationRoute("PUT", "/api/agent/harness", GuiAgentHarness, (input) => withFollower((stored) => Effect.gen(function*() {
      if (JSON.stringify(input).includes("[REDACTED]")) return yield* new CliCommandFailure({
        category: "usage-or-configuration", message: "Redaction markers are not harness values. Reload settings and supply replacements only for fields you want to change.",
      });
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
      const previous = stored.agentHarness;
      const configuration = {
        ...input,
        // An omitted write-only collection keeps its stored value. An explicit array replaces it.
        arguments: input.arguments ?? (input.kind === "custom" && previous?.kind === "custom" ? previous.arguments : undefined),
        environment: input.environment ?? previous?.environment,
      };
      return toJson(harnessResponse(yield* follower.setAgentHarness(configuration)));
    }))),
    // A failed probe is part of the report, not a failed request: the report's status and probes say what is wrong.
    mutationRoute("POST", "/api/doctor", EmptyBody, () => follower.doctor({ noInput: true, timeoutMilliseconds: 10_000 }).pipe(
      Effect.map(toJson),
      Effect.catch((error) => error.details === undefined ? Effect.fail(error) : Effect.succeed(toJson(error.details))),
    )),
    queryRoute("/api/installers", () => Effect.gen(function*() {
      const bindings = yield* listInstallerBindings();
      // Every unbound method PATH can satisfy, already shaped as a valid binding (Windows shims included).
      const detected = (yield* Effect.forEach(
        installerMethods.filter((method) => !bindings.some((binding) => binding.method === method)),
        detectInstaller,
      )).filter((candidate) => candidate !== undefined);
      return toJson({ bindings, detected });
    }).pipe(Effect.provideService(MachineState, machine), Effect.mapError(installerFailure))),
    // The same operation as `canonfig installer set`: it resolves links, runs the --version check, then writes.
    mutationRoute("POST", "/api/installers", GuiInstallerSetInput, (input) =>
      saveInstallerBinding(input.method, input.executable, input.arguments).pipe(
        Effect.map((binding) => toJson({ binding })),
        Effect.provideService(MachineState, machine), Effect.mapError(installerFailure))),
    queryRoute("/api/self-update", () => Effect.try({ try: status, catch: updateFailure })),
    mutationRoute("POST", "/api/self-update/check", EmptyBody,
      () => Effect.tryPromise({
        try: (signal) => update(root, false, "manual", undefined, signal),
        catch: updateFailure,
      }).pipe(Effect.map(toJson))),
    mutationRoute("POST", "/api/self-update/enable", GuiSelfUpdateEnable,
      (input) => Effect.tryPromise({
        try: (signal) => lease.selfUpdate(
          () => enable(root, input.npmCli, input.confirmIdle, undefined, undefined, signal),
          () => true,
        ).finally(onSettled),
        catch: updateFailure,
      }).pipe(Effect.flatMap(() => Effect.try({ try: status, catch: updateFailure })))),
    mutationRoute("POST", "/api/self-update/disable", EmptyBody,
      () => Effect.tryPromise({
        try: () => lease.selfUpdate(async () => disable(root), () => true).finally(onSettled),
        catch: updateFailure,
      }).pipe(Effect.flatMap(() => Effect.try({ try: status, catch: updateFailure })))),
    mutationRoute("POST", "/api/self-update/apply", EmptyBody, () => {
      let journal: UpdateProgress | null = null;
      let installed = false;
      return operations.start(Effect.tryPromise({
        try: (signal) => lease.selfUpdate(
          () => update(root, true, "manual", undefined, signal, undefined, (progress) => { journal = progress; }),
          (result) => {
            installed = result.status === "updated";
            return !installed;
          },
        ).finally(onSettled),
        catch: updateFailure,
      }).pipe(Effect.map(toJson)),
      () => Effect.succeed(toJson(journal)),
      () => { if (installed) onUpdated(); });
    }, 202),
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
    routes.push(mutationRoute("DELETE", `/api/installers/${method}`, EmptyBody,
      () => removeInstallerBinding(method).pipe(
        Effect.map((removed) => toJson({ removed })),
        Effect.provideService(MachineState, machine), Effect.mapError(installerFailure))));
  }
  return routes;
});
