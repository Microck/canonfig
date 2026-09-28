import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Layer, Schema } from "effect";

import { probeSourceDescriptor } from "../enrollment/follower-client.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import type {
  MachinePlatform,
  ProcessEnvironmentEntry,
  ProcessResult,
} from "../machine/machine-state.types.ts";
import {
  decodeWindowsTaskXml,
  windowsAccountPrincipal,
  windowsTaskQueryReportsAbsence,
  windowsTaskProbeReportsAbsence,
  windowsTaskProbeScript,
} from "../machine/windows.layer.ts";
import { stableRuntimeExecutable } from "../schedule/schedule-command.ts";
import {
  SourceServiceConfigurationError,
  type SourceServiceError,
  SourceServiceManagerError,
  SourceServiceVerificationError,
} from "./source-service.errors.ts";
import {
  renderSourceService,
  sourceServicePath,
  sourceTaskDescription,
} from "./source-service.render.ts";
import { SourceService } from "./source-service.service.ts";
import type {
  RenderedSourceService,
  SourceServiceIdentity,
  SourceServiceInput,
  SourceServiceManagerState,
  SourceServiceStatus,
} from "./source-service.types.ts";

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

const ServiceRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  hostname: Schema.Literals(["127.0.0.1", "::1"]),
  port: Schema.Int,
});

const platformOf = (): MachinePlatform =>
  process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";

const outputOf = (result: ProcessResult): string =>
  `${Buffer.from(result.standardOutput).toString("utf8")}\n${
    Buffer.from(result.standardError).toString("utf8")
  }`.trim();

const tailOf = (text: string): string => text.split("\n").slice(-3).join(" ").slice(0, 400);

const isEnoent = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const fileFailure = (operation: string, path: string) => (cause: unknown) =>
  new SourceServiceConfigurationError({
    operation,
    message: `${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const readOptional = (path: string): Effect.Effect<string | undefined, SourceServiceError> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8").catch((cause: unknown) => {
      if (isEnoent(cause)) return undefined;
      throw cause;
    }),
    catch: fileFailure("read Source service definition", path),
  });

const writeAtomically = (
  path: string,
  content: string,
): Effect.Effect<void, SourceServiceError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = join(dirname(path), `.cf-${randomBytes(6).toString("hex")}.tmp`);
      try {
        await writeFile(temporary, content, { mode: 0o600 });
        await rename(temporary, path);
      } catch (cause) {
        await unlink(temporary).catch(() => undefined);
        throw cause;
      }
    },
    catch: fileFailure("write Source service definition", path),
  }).pipe(Effect.uninterruptible);

const removeOptional = (path: string): Effect.Effect<void, SourceServiceError> =>
  Effect.tryPromise({
    try: () => unlink(path).catch((cause: unknown) => {
      if (!isEnoent(cause)) throw cause;
    }),
    catch: fileFailure("remove Source service definition", path),
  });

const endpointOf = (input: SourceServiceInput): string =>
  `https://${input.hostname === "::1" ? "[::1]" : input.hostname}:${input.port}`;

/** Native operations for one platform's user service manager. */
interface ServiceManager {
  readonly inspect: (
    rendered: RenderedSourceService,
  ) => Effect.Effect<SourceServiceManagerState, SourceServiceError>;
  /** Write the definition and (re)start the service from it. */
  readonly install: (rendered: RenderedSourceService) => Effect.Effect<void, SourceServiceError>;
  readonly remove: (rendered: RenderedSourceService) => Effect.Effect<boolean, SourceServiceError>;
  readonly supportedModes: Effect.Effect<{ readonly text: string; readonly linger?: boolean }>;
  readonly logs: (rendered: RenderedSourceService) => string;
}

export const sourceServiceLayer = (
  options: SourceServiceLayerOptions,
): Layer.Layer<SourceService, never, MachineState> =>
  Layer.effect(
    SourceService,
    Effect.gen(function*() {
      const machine = yield* MachineState;
      const platform = options.platform ?? platformOf();
      const home = options.home ?? homedir();
      const environment = options.environment ?? process.env;
      const user = userInfo().username;
      const readinessTimeout = options.readinessTimeoutMilliseconds ?? 20_000;
      const recordPath = join(options.stateDirectory, recordFileName);
      const logPath = join(options.stateDirectory, "source-service.log");

      const run = (
        executable: string,
        arguments_: ReadonlyArray<string>,
      ): Effect.Effect<ProcessResult, SourceServiceError> =>
        machine.runProcess({
          executable: { platform, absolute: executable },
          arguments: arguments_,
          timeoutMilliseconds: 30_000,
          maximumOutputBytes: 1024 * 1024,
        });

      const systemd = (): ServiceManager => {
        const systemctl = environment.CANONFIG_SYSTEMCTL ?? "/usr/bin/systemctl";
        const busMessage =
          `the systemd user manager is not reachable: this session has no user session bus (DBUS_SESSION_BUS_ADDRESS or $XDG_RUNTIME_DIR/bus). `
          + `Run this from a login session of ${user}, or enable linger with \`loginctl enable-linger ${user}\` so the user manager runs without a login, then retry.`;
        const systemctlFailure = (operation: string, result: ProcessResult) => {
          const output = outputOf(result);
          return new SourceServiceManagerError({
            operation,
            message: /failed to connect to bus|no medium found|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR/iu
                .test(output)
              ? busMessage
              : `\`systemctl --user\` failed (exit ${result.exitCode ?? "signal"}): ${tailOf(output)}`,
          });
        };
        const systemctlUser = (operation: string, arguments_: ReadonlyArray<string>) =>
          run(systemctl, ["--user", ...arguments_]).pipe(
            Effect.flatMap((result) =>
              result.exitCode === 0
                ? Effect.succeed(result)
                : Effect.fail(systemctlFailure(operation, result))
            ),
          );
        const lingerPath = `/var/lib/systemd/linger/${user}`;
        return {
          inspect: (rendered) =>
            Effect.gen(function*() {
              const stored = yield* readOptional(rendered.definitionPath!);
              if (stored === undefined) {
                return { installed: false, matches: false, enabled: false, active: false, state: "absent" };
              }
              const shown = yield* systemctlUser("inspect the Source service", [
                "show",
                rendered.serviceName,
                "--property=LoadState,ActiveState,SubState,UnitFileState,MainPID",
                "--no-pager",
              ]);
              const properties = new Map(
                Buffer.from(shown.standardOutput).toString("utf8").split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line.includes("="))
                  .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
              );
              const activeState = properties.get("ActiveState") ?? "unknown";
              const subState = properties.get("SubState") ?? "unknown";
              const pid = Number(properties.get("MainPID") ?? "0");
              return {
                installed: true,
                matches: stored === rendered.definition,
                enabled: properties.get("UnitFileState") === "enabled",
                active: activeState === "active" && subState === "running",
                state: `${activeState}/${subState}`,
                pid: pid > 0 ? pid : undefined,
              };
            }),
          install: (rendered) =>
            Effect.gen(function*() {
              yield* writeAtomically(rendered.definitionPath!, rendered.definition);
              yield* systemctlUser("reload the systemd user manager", ["daemon-reload"]);
              yield* systemctlUser("enable the Source service", ["enable", rendered.serviceName]);
              // A restart, not `start`: an already running Source must pick
              // up a changed definition, and a failed one its reset limit.
              yield* systemctlUser("reset the Source service", ["reset-failed", rendered.serviceName])
                .pipe(Effect.ignore);
              yield* systemctlUser("start the Source service", ["restart", rendered.serviceName]);
            }),
          remove: (rendered) =>
            Effect.gen(function*() {
              const stored = yield* readOptional(rendered.definitionPath!);
              if (stored === undefined) return false;
              yield* systemctlUser("stop the Source service", ["disable", "--now", rendered.serviceName]);
              yield* removeOptional(rendered.definitionPath!);
              yield* systemctlUser("reload the systemd user manager", ["daemon-reload"]);
              return true;
            }),
          supportedModes: Effect.promise(() =>
            access(lingerPath).then(() => true, () => false)
          ).pipe(Effect.map((linger) => ({
            linger,
            text: linger
              ? `runs from boot without a login and across logouts (linger is enabled for ${user})`
              : `runs only while ${user} has a login session; enable linger with \`loginctl enable-linger ${user}\` to run it at boot and after logout`,
          }))),
          logs: (rendered) => `journalctl --user -u ${rendered.serviceName}`,
        };
      };

      const launchd = (): ServiceManager => {
        const launchctl = "/bin/launchctl";
        const domain = `gui/${process.getuid?.() ?? 0}`;
        const unavailable = (operation: string, result: ProcessResult) =>
          new SourceServiceManagerError({
            operation,
            message:
              `launchd domain ${domain} is not available (${tailOf(outputOf(result))}). LaunchAgents load only in ${user}'s logged-in graphical session, not over SSH: sign in to the Mac as ${user} and run this from Terminal there.`,
          });
        return {
          inspect: (rendered) =>
            Effect.gen(function*() {
              const stored = yield* readOptional(rendered.definitionPath!);
              if (stored === undefined) {
                return { installed: false, matches: false, enabled: false, active: false, state: "absent" };
              }
              const printed = yield* run(launchctl, ["print", `${domain}/${rendered.serviceName}`]);
              const output = outputOf(printed);
              if (printed.exitCode !== 0) {
                if (/could not find service/iu.test(output)) {
                  return {
                    installed: true,
                    matches: stored === rendered.definition,
                    enabled: false,
                    active: false,
                    state: "not-loaded",
                  };
                }
                return yield* unavailable("inspect the Source service", printed);
              }
              const state = /\bstate = (\S+)/u.exec(output)?.[1] ?? "unknown";
              const pid = Number(/\bpid = (\d+)/u.exec(output)?.[1] ?? "0");
              return {
                installed: true,
                matches: stored === rendered.definition,
                enabled: true,
                active: state === "running",
                state,
                pid: pid > 0 ? pid : undefined,
              };
            }),
          install: (rendered) =>
            Effect.gen(function*() {
              yield* writeAtomically(rendered.definitionPath!, rendered.definition);
              yield* run(launchctl, ["bootout", domain, rendered.definitionPath!]).pipe(Effect.ignore);
              const loaded = yield* run(launchctl, ["bootstrap", domain, rendered.definitionPath!]);
              if (loaded.exitCode !== 0) return yield* unavailable("load the Source service", loaded);
            }),
          remove: (rendered) =>
            Effect.gen(function*() {
              const stored = yield* readOptional(rendered.definitionPath!);
              if (stored === undefined) return false;
              yield* run(launchctl, ["bootout", domain, rendered.definitionPath!]).pipe(Effect.ignore);
              yield* removeOptional(rendered.definitionPath!);
              return true;
            }),
          supportedModes: Effect.succeed({
            text:
              `runs while ${user} is logged in to the macOS graphical session and restarts after a crash; logged-out operation is not supported`,
          }),
          logs: () => logPath,
        };
      };

      const taskScheduler = (): ServiceManager => {
        const system32 = win32.join(environment.SystemRoot ?? "C:\\Windows", "System32");
        const schtasks = environment.CANONFIG_SCHTASKS ?? win32.join(system32, "schtasks.exe");
        const powershell = environment.CANONFIG_POWERSHELL
          ?? win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
        const unavailable = (operation: string, result: ProcessResult) =>
          new SourceServiceManagerError({
            operation,
            message:
              `Task Scheduler refused to ${operation} (${tailOf(outputOf(result))}). Sign in interactively as ${user} and ensure the Task Scheduler service is running, then retry.`,
          });
        const taskAbsent = (
          rendered: RenderedSourceService,
          failed: ProcessResult,
          operation: string,
        ): Effect.Effect<boolean, SourceServiceError> =>
          windowsTaskQueryReportsAbsence(failed)
            ? Effect.succeed(true)
            : run(powershell, [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              windowsTaskProbeScript(rendered.serviceName),
            ]).pipe(
              Effect.flatMap((probe) =>
                windowsTaskProbeReportsAbsence(probe)
                  ? Effect.succeed(true)
                  : probe.exitCode === 0
                  ? Effect.succeed(false)
                  : Effect.fail(unavailable(operation, failed))
              ),
              Effect.catch(() => Effect.fail(unavailable(operation, failed))),
            );
        return {
          inspect: (rendered) =>
            Effect.gen(function*() {
              const query = yield* run(schtasks, ["/Query", "/TN", rendered.serviceName, "/XML"]);
              if (query.exitCode !== 0) {
                if (yield* taskAbsent(rendered, query, "query the Source task")) {
                  return { installed: false, matches: false, enabled: false, active: false, state: "absent" };
                }
                return yield* unavailable("query the Source task", query);
              }
              const xml = decodeWindowsTaskXml(query.standardOutput);
              const settings = /<Settings>([\s\S]*?)<\/Settings>/u.exec(xml)?.[1] ?? "";
              const state = yield* run(powershell, [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `(Get-ScheduledTask -TaskPath '\\Canonfig\\' -TaskName '${
                  rendered.serviceName.slice(rendered.serviceName.lastIndexOf("\\") + 1)
                }').State`,
              ]).pipe(
                Effect.map((result) =>
                  result.exitCode === 0
                    ? Buffer.from(result.standardOutput).toString("utf8").trim()
                    : "unknown"
                ),
              );
              return {
                installed: true,
                matches: xml.includes(sourceTaskDescription(rendered.fingerprint)),
                enabled: !/<Enabled>false<\/Enabled>/u.test(settings),
                active: state === "Running",
                state,
              };
            }),
          install: (rendered) =>
            Effect.gen(function*() {
              const path = win32.join(
                environment.TEMP ?? tmpdir(),
                `.cf-${randomBytes(6).toString("hex")}.tmp`,
              );
              yield* Effect.tryPromise({
                try: () => writeFile(path, Buffer.from(`\ufeff${rendered.definition}`, "utf16le")),
                catch: fileFailure("write the Source task definition", path),
              });
              const created = yield* run(schtasks, [
                "/Create",
                "/TN",
                rendered.serviceName,
                "/XML",
                path,
                "/F",
              ]).pipe(Effect.ensuring(Effect.promise(() => rm(path, { force: true }))));
              if (created.exitCode !== 0) return yield* unavailable("register the Source task", created);
              yield* run(schtasks, ["/End", "/TN", rendered.serviceName]).pipe(Effect.ignore);
              const started = yield* run(schtasks, ["/Run", "/TN", rendered.serviceName]);
              if (started.exitCode !== 0) return yield* unavailable("start the Source task", started);
            }),
          remove: (rendered) =>
            Effect.gen(function*() {
              yield* run(schtasks, ["/End", "/TN", rendered.serviceName]).pipe(Effect.ignore);
              const deleted = yield* run(schtasks, ["/Delete", "/TN", rendered.serviceName, "/F"]);
              if (deleted.exitCode === 0) return true;
              if (yield* taskAbsent(rendered, deleted, "delete the Source task")) return false;
              return yield* unavailable("delete the Source task", deleted);
            }),
          supportedModes: Effect.succeed({
            text:
              `starts when ${user} logs on and runs while that user is logged on, restarting after a failure; logged-out operation is not supported`,
          }),
          logs: (rendered) =>
            `Task Scheduler history for ${rendered.serviceName} (Event Viewer: Microsoft-Windows-TaskScheduler/Operational)`,
        };
      };

      const manager = platform === "linux"
        ? systemd()
        : platform === "macos"
        ? launchd()
        : taskScheduler();

      /**
       * Environment the supervised process must see. The manager does not
       * inherit this shell, so the state location (HOME) and the local-file
       * credential policy have to be written into the definition.
       */
      const serviceEnvironment = Effect.fn("SourceService.environment")(function*(
        executable: string,
        installing: boolean,
      ): Effect.fn.Return<ReadonlyArray<ProcessEnvironmentEntry>, SourceServiceError> {
        const credentialRoot = environment.CANONFIG_LOCAL_CREDENTIAL_ROOT;
        if (platform !== "windows") {
          return [
            { name: "HOME", value: home },
            { name: "PATH", value: sourceServicePath(executable) },
            ...credentialRoot === undefined
              ? []
              : [{ name: "CANONFIG_LOCAL_CREDENTIAL_ROOT", value: credentialRoot }],
          ];
        }
        if (!installing) return [];
        // Task Scheduler starts the task with the user's own profile and
        // persistent environment. Refuse what that would silently change.
        if (win32.resolve(home).toLowerCase() !== win32.resolve(userInfo().homedir).toLowerCase()) {
          return yield* new SourceServiceConfigurationError({
            operation: "install the Source service",
            message:
              `this shell uses ${home} as its home, but Task Scheduler starts the Source with ${user}'s profile ${userInfo().homedir}; run the install from a normal session of ${user}`,
          });
        }
        if (credentialRoot !== undefined) {
          const query = yield* run(win32.join(
            environment.SystemRoot ?? "C:\\Windows",
            "System32",
            "reg.exe",
          ), ["query", "HKCU\\Environment", "/v", "CANONFIG_LOCAL_CREDENTIAL_ROOT"]);
          if (query.exitCode !== 0 || !outputOf(query).includes(credentialRoot)) {
            return yield* new SourceServiceConfigurationError({
              operation: "install the Source service",
              message:
                `CANONFIG_LOCAL_CREDENTIAL_ROOT is set in this shell only; Task Scheduler would start the Source without it. Run \`setx CANONFIG_LOCAL_CREDENTIAL_ROOT "${credentialRoot}"\`, open a new terminal, and retry`,
            });
          }
        }
        return [];
      });

      const render = Effect.fn("SourceService.render")(function*(
        input: SourceServiceInput,
        installing = false,
      ): Effect.fn.Return<RenderedSourceService, SourceServiceError> {
        const executable = stableRuntimeExecutable();
        const principal = platform === "windows"
          ? windowsAccountPrincipal(
            Object.entries(environment).flatMap(([name, value]) =>
              value === undefined ? [] : [{ name, value }]
            ),
            home,
          )
          : undefined;
        return yield* renderSourceService({
          platform,
          home,
          executable,
          arguments: [
            fileURLToPath(new URL("../runtime/main.js", import.meta.url)),
            "source",
            "serve",
            "--host",
            input.hostname,
            "--port",
            String(input.port),
          ],
          environment: yield* serviceEnvironment(executable, installing),
          logPath,
          principal,
        });
      });

      const readRecord = readOptional(recordPath).pipe(
        Effect.map((text) => {
          if (text === undefined) return undefined;
          try {
            return Schema.decodeUnknownSync(ServiceRecordSchema)(JSON.parse(text));
          } catch {
            return undefined;
          }
        }),
      );

      const serving = (
        input: SourceServiceInput,
        identity: SourceServiceIdentity | undefined,
      ): Effect.Effect<boolean> =>
        identity === undefined
          ? Effect.succeed(false)
          : probeSourceDescriptor({
            endpoint: endpointOf(input),
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
        rendered: RenderedSourceService,
        identity: SourceServiceIdentity | undefined,
      ): Effect.fn.Return<SourceServiceStatus, SourceServiceError> {
        const [state, answering, modes] = yield* Effect.all([
          manager.inspect(rendered),
          serving(input, identity),
          manager.supportedModes,
        ]);
        const endpoint = endpointOf(input);
        const logs = manager.logs(rendered);
        const base = {
          platform,
          mechanism: rendered.mechanism,
          serviceName: rendered.serviceName,
          definitionPath: rendered.definitionPath,
          endpoint,
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
              `the ${rendered.mechanism} is running, but ${endpoint} does not answer with this Source's pinned identity (the Source credentials may be unavailable to the service). Logs: ${logs}`,
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
      ): Effect.fn.Return<SourceServiceStatus, SourceServiceError> {
        const input = (yield* readRecord) ?? defaultInput;
        return yield* statusFor(input, yield* render(input), identity);
      });

      const install = Effect.fn("SourceService.install")(function*(
        input: SourceServiceInput,
        identity: SourceServiceIdentity,
      ): Effect.fn.Return<
        { readonly change: "installed" | "updated" | "unchanged"; readonly status: SourceServiceStatus },
        SourceServiceError
      > {
        const rendered = yield* render(input, true);
        const before = yield* statusFor(input, rendered, identity);
        if (before.state === "running") return { change: "unchanged", status: before };
        if (before.serving && !before.manager.active) {
          return yield* new SourceServiceConfigurationError({
            operation: "install the Source service",
            message:
              `a Source is already answering at ${before.endpoint} outside the service manager; stop that \`canonfig source serve\` first so the service can bind the port, then retry`,
          });
        }
        yield* manager.install(rendered);
        yield* writeAtomically(
          recordPath,
          `${JSON.stringify({ version: 1, hostname: input.hostname, port: input.port })}\n`,
        );
        const deadline = Date.now() + readinessTimeout;
        let after = yield* statusFor(input, rendered, identity);
        while (after.state !== "running" && Date.now() < deadline) {
          yield* Effect.sleep(500);
          after = yield* statusFor(input, rendered, identity);
        }
        if (after.state !== "running") {
          return yield* new SourceServiceVerificationError({
            operation: "install the Source service",
            state: after.state,
            message:
              `the Source service was installed but is not serving after ${readinessTimeout} ms: ${after.detail}. Inspect it with \`canonfig source service status\`, or remove it with \`canonfig source service remove\``,
          });
        }
        return { change: before.manager.installed ? "updated" : "installed", status: after };
      });

      const remove = Effect.fn("SourceService.remove")(function*() {
        const input = (yield* readRecord) ?? defaultInput;
        const rendered = yield* render(input);
        const removed = yield* manager.remove(rendered);
        yield* removeOptional(recordPath);
        return {
          change: removed ? "removed" as const : "unchanged" as const,
          serviceName: rendered.serviceName,
        };
      });

      return SourceService.of({ install, status, remove });
    }),
  );
