import { randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";

import { Effect, Layer, Schema } from "effect";

import { probeSourceDescriptor } from "../enrollment/follower-client.ts";
import { detectTailnet, tailnetBinding } from "../enrollment/tailnet.ts";
import type { TailnetReport } from "../domain/tailnet.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import type { MachinePlatform } from "../machine/machine-state.types.ts";
import {
  NativeServiceConfigurationError,
  type NativeServiceError,
  type NativeServiceName,
  NativeServiceVerificationError,
  nativeServiceHost,
  readOptional,
  removeOptional,
  type RenderedNativeService,
  writeAtomically,
} from "../machine/native-service.ts";
import { SourceService } from "./source-service.service.ts";
import type {
  SourceServiceIdentity,
  SourceServiceInput,
  SourceServiceStatus,
} from "./source-service.types.ts";

/** The supervised `canonfig source serve`. */
const sourceServiceName: NativeServiceName = {
  stem: "canonfig-source",
  launchdLabel: "dev.canonfig.source",
  description: "Canonfig Source server",
};

export interface SourceServiceLayerOptions {
  /** Canonfig's state directory; the installed host and port are recorded here. */
  readonly stateDirectory: string;
  readonly platform?: MachinePlatform | undefined;
  readonly home?: string | undefined;
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined;
  /** How long install waits for the service to serve the Source identity. */
  readonly readinessTimeoutMilliseconds?: number | undefined;
}

const recordFileName = "source-service.json";
const defaultInput: SourceServiceInput = { hostname: "127.0.0.1", port: 17342 };

const RequestedService = Schema.Struct({
  hostname: Schema.Literals(["127.0.0.1", "::1", "tailnet"]),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
});
const ServiceRegistration = Schema.Union([
  Schema.TaggedStruct("Absent", {}),
  Schema.TaggedStruct("Installing", { operationId: Schema.String, requested: RequestedService }),
  Schema.TaggedStruct("Verifying", { operationId: Schema.String, requested: RequestedService }),
  Schema.TaggedStruct("Installed", { requested: RequestedService }),
  Schema.TaggedStruct("Removing", { operationId: Schema.String, requested: RequestedService }),
]);
type ServiceRegistration = typeof ServiceRegistration.Type;
const ServiceRecordSchema = Schema.Struct({ version: Schema.Literal(2), registration: ServiceRegistration });

type RegistrationEvent =
  | { readonly _tag: "Install"; readonly requested: SourceServiceInput }
  | { readonly _tag: "Verify" }
  | { readonly _tag: "Confirm" }
  | { readonly _tag: "Remove"; readonly requested: SourceServiceInput }
  | { readonly _tag: "Removed" };

const transitionRegistration = (
  registration: ServiceRegistration,
  event: RegistrationEvent,
): Effect.Effect<ServiceRegistration, NativeServiceConfigurationError> => {
  switch (event._tag) {
    case "Install":
      if (registration._tag !== "Removing") {
        return Effect.succeed({ _tag: "Installing", operationId: randomUUID(), requested: event.requested });
      }
      break;
    case "Verify":
      if (registration._tag === "Installing") return Effect.succeed({ ...registration, _tag: "Verifying" });
      break;
    case "Confirm":
      if (registration._tag === "Verifying") return Effect.succeed({ _tag: "Installed", requested: registration.requested });
      break;
    case "Remove":
      return Effect.succeed({ _tag: "Removing", operationId: randomUUID(), requested: event.requested });
    case "Removed":
      if (registration._tag === "Removing") return Effect.succeed({ _tag: "Absent" });
      break;
  }
  return Effect.fail(new NativeServiceConfigurationError({
    operation: "transition Source service registration",
    message: `cannot ${event._tag} from ${registration._tag}; finish \`canonfig source service remove\` before reinstalling`,
  }));
};

const endpointOf = (input: SourceServiceInput, tailnet: TailnetReport): string =>
  input.hostname === "tailnet"
    ? tailnet.dnsName === undefined ? "" : `https://${tailnet.dnsName}:${input.port}`
    : `https://${input.hostname === "::1" ? "[::1]" : input.hostname}:${input.port}`;

export const sourceServiceLayer = (
  options: SourceServiceLayerOptions,
): Layer.Layer<SourceService, never, MachineState> =>
  Layer.effect(
    SourceService,
    Effect.gen(function*() {
      const readinessTimeout = options.readinessTimeoutMilliseconds ?? 20_000;
      const recordPath = join(options.stateDirectory, recordFileName);
      const host = yield* nativeServiceHost({
        platform: options.platform,
        home: options.home,
        environment: options.environment,
        label: "Source service",
        logPath: join(options.stateDirectory, "source-service.log"),
        // Serving needs the Source's signing credentials, which live in the user's credential store.
        systemdModes: (user, linger) => linger
          ? `is started at boot and managed across logouts by the user manager (linger is enabled for ${user}); serving without a login also requires the service to load its Source credentials in that session. An encrypted login keyring may require login and a separate unlock before the service can start serving`
          : `is managed only while ${user} has a login session, and must be able to load its Source credentials when it starts; \`loginctl enable-linger ${user}\` extends the manager lifecycle, but does not unlock an encrypted login keyring`,
      });
      const { manager, platform } = host;
      const render = (input: SourceServiceInput, installing = false) =>
        host.render(sourceServiceName, [
          "source",
          "serve",
          ...input.hostname === "tailnet" ? ["--tailnet"] : ["--host", input.hostname],
          "--port",
          String(input.port),
        ], installing);

      const readRecord = readOptional(recordPath).pipe(
        Effect.flatMap((text): Effect.Effect<ServiceRegistration, NativeServiceError> => {
          if (text === undefined) return Effect.succeed({ _tag: "Absent" });
          return Effect.try({
            try: () => {
              const record: unknown = JSON.parse(text);
              return Schema.decodeUnknownSync(ServiceRecordSchema)(record).registration;
            },
            catch: () => new NativeServiceConfigurationError({
              operation: "read Source service registration",
              message: `${recordPath} is malformed or unsupported. Preserve it and inspect the native Source service definition before repairing the registration; no default endpoint was assumed`,
            }),
          });
        }),
      );
      const transition = Effect.fn("SourceService.transition")(function*(
        registration: ServiceRegistration,
        event: RegistrationEvent,
      ) {
        const next = yield* transitionRegistration(registration, event);
        if (next._tag === "Absent") yield* removeOptional(recordPath);
        else yield* writeAtomically(recordPath, `${JSON.stringify({ version: 2, registration: next })}\n`);
        return next;
      });
      const withRegistrationLock = <A>(action: Effect.Effect<A, NativeServiceError>) =>
        Effect.acquireUseRelease(
          Effect.tryPromise({
            try: async () => {
              await mkdir(options.stateDirectory, { recursive: true });
              return open(`${recordPath}.lock`, "wx", 0o600);
            },
            catch: () => new NativeServiceConfigurationError({
              operation: "lock Source service registration",
              message: `cannot acquire ${recordPath}.lock. Another install/remove may be running. After an interrupted command, inspect the registration and native service before removing the stale lock`,
            }),
          }),
          () => action,
          (handle) => Effect.promise(async () => {
            await handle.close();
            await unlink(`${recordPath}.lock`);
          }),
        );

      const serving = (
        endpoint: string,
        identity: SourceServiceIdentity | undefined,
      ): Effect.Effect<boolean> =>
        identity === undefined || endpoint === ""
          ? Effect.succeed(false)
          : probeSourceDescriptor({
            endpoint,
            tlsFingerprint: identity.tlsFingerprint,
            timeoutMilliseconds: 3_000,
          }).pipe(
            Effect.map((probe) =>
              probe.tlsMatch && probe.sourceFingerprint === identity.sourceFingerprint
            ),
            Effect.catch(() => Effect.succeed(false)),
          );

      const statusFor = Effect.fn("SourceService.statusFor")(function*(
        input: SourceServiceInput,
        rendered: RenderedNativeService,
        identity: SourceServiceIdentity | undefined,
      ): Effect.fn.Return<SourceServiceStatus, NativeServiceError> {
        const tailnet = yield* detectTailnet();
        const endpoint = endpointOf(input, tailnet);
        const [state, answering, modes] = yield* Effect.all([
          manager.inspect(rendered),
          serving(endpoint, identity),
          manager.supportedModes,
        ]);
        const logs = manager.logs(rendered);
        const base = {
          platform,
          mechanism: rendered.mechanism,
          serviceName: rendered.serviceName,
          definitionPath: rendered.definitionPath,
          endpoint,
          requested: input,
          tailnet,
          manager: state,
          serving: answering,
          supportedModes: modes.text,
          linger: modes.linger,
          logs,
        };
        if (!state.installed) {
          return {
            ...base,
            state: "not-installed",
            detail: answering
              ? `no Source service is installed; the Source answering at ${endpoint} runs outside the service manager. Stop it and run \`canonfig source service install\` to supervise it`
              : "no Source service is installed; run `canonfig source service install`",
          };
        }
        if (!state.matches) {
          return {
            ...base,
            state: "drifted",
            detail:
              `the installed ${rendered.mechanism} definition differs from what \`canonfig source service install\` renders now (a different runtime, port, or a manual edit); run \`canonfig source service install\` again`,
          };
        }
        if (!state.active) {
          return {
            ...base,
            state: "not-running",
            detail: answering
              ? `the ${rendered.mechanism} is ${state.state}, and another process is serving ${endpoint}: stop that \`canonfig source serve\` so the service can bind the port. Logs: ${logs}`
              : `the ${rendered.mechanism} is ${state.state}; the Source is not being served. Logs: ${logs}`,
          };
        }
        if (!answering) {
          return {
            ...base,
            state: "not-serving",
            detail:
              input.hostname === "tailnet" && !tailnet.ready ? tailnet.detail
                : `the ${rendered.mechanism} is running, but ${endpoint} does not answer with this Source's pinned identity (the Source credentials may be unavailable to the service). Logs: ${logs}`,
          };
        }
        return {
          ...base,
          state: "running",
          detail: `the Source is served at ${endpoint} by the ${rendered.mechanism}; it ${modes.text}`,
        };
      });

      const status = Effect.fn("SourceService.status")(function*(
        identity: SourceServiceIdentity | undefined,
      ): Effect.fn.Return<SourceServiceStatus, NativeServiceError> {
        const registration = yield* readRecord;
        const input = registration._tag === "Absent" ? defaultInput : registration.requested;
        const observed = yield* statusFor(input, yield* render(input), identity);
        return registration._tag === "Installing" || registration._tag === "Verifying" || registration._tag === "Removing"
          ? { ...observed, detail: `Source service registration is ${registration._tag.toLowerCase()} (${registration.operationId}); inspect the native service and retry that operation. ${observed.detail}` }
          : observed;
      });

      const installOperation = Effect.fn("SourceService.install")(function*(
        input: SourceServiceInput,
        identity: SourceServiceIdentity,
      ): Effect.fn.Return<
        { readonly change: "installed" | "updated" | "unchanged"; readonly status: SourceServiceStatus },
        NativeServiceError
      > {
        if (input.hostname === "tailnet") {
          const tailnet = yield* detectTailnet();
          yield* Effect.try({
            try: () => tailnetBinding(tailnet),
            catch: (cause) => new NativeServiceConfigurationError({
              operation: "install tailnet Source service",
              message: cause instanceof Error ? cause.message : "Tailscale is unavailable.",
            }),
          });
        }
        let registration = yield* readRecord;
        const rendered = yield* render(input, true);
        const before = yield* statusFor(input, rendered, identity);
        if (before.state === "running") {
          registration = yield* transition(registration, { _tag: "Install", requested: input });
          registration = yield* transition(registration, { _tag: "Verify" });
          yield* transition(registration, { _tag: "Confirm" });
          return { change: "unchanged", status: before };
        }
        if (before.serving && !before.manager.active) {
          return yield* new NativeServiceConfigurationError({
            operation: "install the Source service",
            message:
              `a Source is already answering at ${before.endpoint} outside the service manager; stop that \`canonfig source serve\` first so the service can bind the port, then retry`,
          });
        }
        registration = yield* transition(registration, { _tag: "Install", requested: input });
        yield* manager.install(rendered);
        registration = yield* transition(registration, { _tag: "Verify" });
        const deadline = Date.now() + readinessTimeout;
        let after = yield* statusFor(input, rendered, identity);
        while (after.state !== "running" && Date.now() < deadline) {
          yield* Effect.sleep(500);
          after = yield* statusFor(input, rendered, identity);
        }
        if (after.state !== "running") {
          return yield* new NativeServiceVerificationError({
            operation: "install the Source service",
            state: after.state,
            message:
              `the Source service was installed but is not serving after ${readinessTimeout} ms: ${after.detail}. Inspect it with \`canonfig source service status\`, or remove it with \`canonfig source service remove\``,
          });
        }
        yield* transition(registration, { _tag: "Confirm" });
        return { change: before.manager.installed ? "updated" : "installed", status: after };
      });

      const install = (input: SourceServiceInput, identity: SourceServiceIdentity) =>
        withRegistrationLock(installOperation(input, identity));
      const removeOperation = Effect.fn("SourceService.remove")(function*() {
        let registration = yield* readRecord;
        const input = registration._tag === "Absent" ? defaultInput : registration.requested;
        const rendered = yield* render(input);
        registration = yield* transition(registration, { _tag: "Remove", requested: input });
        const removed = yield* manager.remove(rendered);
        yield* transition(registration, { _tag: "Removed" });
        return {
          change: removed ? "removed" as const : "unchanged" as const,
          serviceName: rendered.serviceName,
        };
      });
      const remove = () => withRegistrationLock(removeOperation());

      return SourceService.of({ install, status, remove });
    }),
  );
