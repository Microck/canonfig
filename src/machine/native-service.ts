import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Schema } from "effect";

import { TaggedError } from "../domain/tagged-error.ts";
import { stableRuntimeExecutable } from "../schedule/schedule-command.ts";
import type { MachineStateError } from "./machine-state.errors.ts";
import { MachineState } from "./machine-state.service.ts";
import type { MachinePlatform, ProcessEnvironmentEntry, ProcessResult } from "./machine-state.types.ts";
import {
  decodeWindowsTaskXml,
  windowsAccountPrincipal,
  windowsTaskProbeReportsAbsence,
  windowsTaskProbeScript,
  windowsTaskQueryReportsAbsence,
} from "./windows.layer.ts";

/*
 * A Canonfig process supervised by the user's native service manager: a
 * systemd user unit, a launchd agent, or a Task Scheduler logon task. The
 * Source server (`source serve`) and the folder watcher (`watch`) each run as
 * one; this module renders, installs, inspects and removes either, and the
 * caller decides what "healthy" means for its own process.
 */

/** The requested service cannot be expressed on this machine (bad input or environment). */
export class NativeServiceConfigurationError
  extends TaggedError<NativeServiceConfigurationError>()(
    "NativeServiceConfigurationError",
    {
      operation: Schema.String,
      message: Schema.String,
    },
  ) {}

/**
 * The native service manager could not be reached or refused the request.
 * `message` names the manager and says what the operator has to do, such as
 * logging in or enabling linger when there is no user session bus.
 */
export class NativeServiceManagerError extends TaggedError<NativeServiceManagerError>()(
  "NativeServiceManagerError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

/** The manager accepted the service, but it is not doing its work. */
export class NativeServiceVerificationError
  extends TaggedError<NativeServiceVerificationError>()(
    "NativeServiceVerificationError",
    {
      operation: Schema.String,
      state: Schema.String,
      message: Schema.String,
    },
  ) {}

export type NativeServiceError =
  | NativeServiceConfigurationError
  | NativeServiceManagerError
  | NativeServiceVerificationError
  | MachineStateError;

export type NativeServiceMechanism =
  | "systemd-user-service"
  | "launchd-user-agent"
  | "task-scheduler-logon";

/** How one supervised process is named to each manager. */
export interface NativeServiceName {
  /** systemd unit stem and Task Scheduler task name under `\\Canonfig\\`. */
  readonly stem: string;
  readonly launchdLabel: string;
  /** systemd Description= and the Task Scheduler task description. */
  readonly description: string;
  /**
   * The process finishes its current work after SIGTERM before it exits (the
   * watcher completing a pass). systemd then signals only the main process
   * (KillMode=mixed), so children it started are not stopped mid-way.
   * Absent for the Source server, whose installed units must stay unchanged.
   */
  readonly drainsOnStop?: true | undefined;
}

/** Everything a native definition is rendered from; pure data, no machine access. */
export interface NativeServiceSpecification {
  readonly name: NativeServiceName;
  readonly platform: MachinePlatform;
  readonly home: string;
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
  /** Carried into the service where the manager supports it (not Task Scheduler). */
  readonly environment: ReadonlyArray<ProcessEnvironmentEntry>;
  /** launchd output file; systemd uses the journal and Task Scheduler its history. */
  readonly logPath: string;
  /** Windows account the logon trigger and principal name. */
  readonly principal?: string | undefined;
}

export interface RenderedNativeService {
  readonly platform: MachinePlatform;
  readonly mechanism: NativeServiceMechanism;
  /** Unit name, launchd label, or Task Scheduler path. */
  readonly serviceName: string;
  /** Where the definition file lives; Task Scheduler keeps its own store. */
  readonly definitionPath?: string | undefined;
  readonly definition: string;
  /** Fingerprint embedded where the manager rewrites the definition (Task Scheduler). */
  readonly fingerprint: string;
}

/**
 * What the native manager reports. `active` means the manager says the
 * process is running now; `enabled` means it will start at login or boot.
 */
export interface NativeServiceManagerState {
  readonly installed: boolean;
  readonly matches: boolean;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly state: string;
  readonly pid?: number | undefined;
}

const singleLine = (
  value: string,
  field: string,
): Effect.Effect<string, NativeServiceConfigurationError> =>
  value.length > 0 && !/[\n\r\0]/u.test(value)
    ? Effect.succeed(value)
    : Effect.fail(new NativeServiceConfigurationError({
      operation: "render the service definition",
      message: `${field} must be non-empty, single-line, and contain no NUL bytes`,
    }));

const fingerprintOf = (specification: NativeServiceSpecification): string =>
  createHash("sha256")
    .update(JSON.stringify({
      executable: specification.executable,
      arguments: specification.arguments,
      environment: specification.environment,
    }))
    .digest("hex");

/**
 * systemd.service(5) command-line and assignment quoting: `%` specifiers
 * expand everywhere, `\` and `"` are unescaped inside quotes, and `$VAR`
 * expands in ExecStart arguments (never in the program path or Environment=).
 */
const systemdQuoted = (value: string, expandsVariables: boolean): string => {
  const quoted = value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("%", "%%");
  return `"${expandsVariables ? quoted.replaceAll("$", () => "$$") : quoted}"`;
};

const renderSystemd = (
  specification: NativeServiceSpecification,
): Effect.Effect<RenderedNativeService, NativeServiceConfigurationError> =>
  Effect.gen(function*() {
    const executable = yield* singleLine(specification.executable, "executable");
    const arguments_ = yield* Effect.forEach(
      specification.arguments,
      (argument, index) => singleLine(argument, `arguments[${index}]`),
    );
    const environment = yield* Effect.forEach(
      specification.environment,
      (entry) =>
        singleLine(`${entry.name}=${entry.value}`, `environment ${entry.name}`).pipe(
          Effect.map((assignment) => `Environment=${systemdQuoted(assignment, false)}`),
        ),
    );
    const serviceName = `${specification.name.stem}.service`;
    return {
      platform: "linux",
      mechanism: "systemd-user-service",
      serviceName,
      definitionPath: join(specification.home, ".config", "systemd", "user", serviceName),
      definition: [
        "[Unit]",
        `Description=${specification.name.description}`,
        // Credential access may recover only after a later login or unlock.
        // Keep supervision alive instead of exhausting a boot-time start quota.
        "StartLimitIntervalSec=0",
        "",
        "[Service]",
        "Type=simple",
        ...environment,
        `ExecStart=${
          [
            systemdQuoted(executable, false),
            ...arguments_.map((argument) => systemdQuoted(argument, true)),
          ].join(" ")
        }`,
        "Restart=on-failure",
        // systemd still kills what is left once the main process exits.
        ...specification.name.drainsOnStop ? ["KillMode=mixed"] : [],
        "RestartSec=30",
        "",
        "[Install]",
        // default.target starts with the user manager: at login, or at boot
        // when linger is enabled for the user.
        "WantedBy=default.target",
        "",
      ].join("\n"),
      fingerprint: fingerprintOf(specification),
    };
  });

const xml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");

const renderLaunchd = (
  specification: NativeServiceSpecification,
): Effect.Effect<RenderedNativeService, NativeServiceConfigurationError> =>
  Effect.gen(function*() {
    const program = yield* Effect.forEach(
      [specification.executable, ...specification.arguments],
      (argument, index) => singleLine(argument, `arguments[${index}]`),
    );
    const environment = yield* Effect.forEach(
      specification.environment,
      (entry) =>
        singleLine(entry.value, `environment ${entry.name}`).pipe(
          Effect.map((value) => `<key>${xml(entry.name)}</key><string>${xml(value)}</string>`),
        ),
    );
    const logPath = yield* singleLine(specification.logPath, "log path");
    return {
      platform: "macos",
      mechanism: "launchd-user-agent",
      serviceName: specification.name.launchdLabel,
      definitionPath: join(
        specification.home,
        "Library",
        "LaunchAgents",
        `${specification.name.launchdLabel}.plist`,
      ),
      definition: [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" "
        + "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
        "<plist version=\"1.0\"><dict>",
        `<key>Label</key><string>${specification.name.launchdLabel}</string>`,
        `<key>ProgramArguments</key><array>${
          program.map((argument) => `<string>${xml(argument)}</string>`).join("")
        }</array>`,
        `<key>EnvironmentVariables</key><dict>${environment.join("")}</dict>`,
        // Start when the agent loads (login) and restart after a crash, but
        // not after a clean exit such as `launchctl kill TERM`.
        "<key>RunAtLoad</key><true/>",
        "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
        "<key>ThrottleInterval</key><integer>10</integer>",
        "<key>ProcessType</key><string>Background</string>",
        `<key>StandardOutPath</key><string>${xml(logPath)}</string>`,
        `<key>StandardErrorPath</key><string>${xml(logPath)}</string>`,
        "</dict></plist>",
        "",
      ].join("\n"),
      fingerprint: fingerprintOf(specification),
    };
  });

/** CommandLineToArgvW quoting, the convention Task Scheduler arguments are split by. */
const windowsArgument = (value: string): string => {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let output = "\"";
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    output += character === "\""
      ? "\\".repeat(backslashes * 2 + 1) + "\""
      : "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return output + "\\".repeat(backslashes * 2) + "\"";
};

/**
 * Task Scheduler rewrites the XML it stores, so a task's description carries
 * the definition fingerprint and inspection matches on it instead of the text.
 */
const taskMarker = (fingerprint: string): string => `[canonfig:${fingerprint}]`;

const renderTaskScheduler = (
  specification: NativeServiceSpecification,
): Effect.Effect<RenderedNativeService, NativeServiceConfigurationError> =>
  Effect.gen(function*() {
    const executable = yield* singleLine(specification.executable, "executable");
    const arguments_ = yield* Effect.forEach(
      specification.arguments,
      (argument, index) => singleLine(argument, `arguments[${index}]`),
    );
    const principal = yield* singleLine(specification.principal ?? "", "principal");
    if (specification.environment.length > 0) {
      // Task Scheduler starts actions with the user's persistent environment
      // and has no per-task variables; the caller must not rely on any here.
      return yield* new NativeServiceConfigurationError({
        operation: "render the service definition",
        message: `Task Scheduler cannot carry environment variables (${
          specification.environment.map((entry) => entry.name).join(", ")
        }); set them in the user environment instead`,
      });
    }
    const fingerprint = fingerprintOf(specification);
    return {
      platform: "windows",
      mechanism: "task-scheduler-logon",
      serviceName: `Canonfig\\${specification.name.stem}`,
      definition: [
        "<?xml version=\"1.0\" encoding=\"UTF-16\"?>",
        "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">",
        `<RegistrationInfo><Description>${xml(`${specification.name.description} ${taskMarker(fingerprint)}`)}</Description></RegistrationInfo>`,
        `<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(principal)}</UserId></LogonTrigger></Triggers>`,
        `<Principals><Principal id="Author"><UserId>${xml(principal)}</UserId>`,
        "<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>",
        "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
        "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
        "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate>",
        "<StartWhenAvailable>true</StartWhenAvailable>",
        "<RestartOnFailure><Interval>PT1M</Interval><Count>255</Count></RestartOnFailure>",
        "<Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>",
        `<Actions Context="Author"><Exec><Command>${xml(executable)}</Command>`,
        `<Arguments>${xml(arguments_.map(windowsArgument).join(" "))}</Arguments>`,
        `<WorkingDirectory>${xml(win32.normalize(specification.home))}</WorkingDirectory></Exec></Actions></Task>`,
      ].join(""),
      fingerprint,
    };
  });

/** The native definition that supervises one Canonfig process on this platform. */
export const renderNativeService = (
  specification: NativeServiceSpecification,
): Effect.Effect<RenderedNativeService, NativeServiceConfigurationError> => {
  switch (specification.platform) {
    case "linux": return renderSystemd(specification);
    case "macos": return renderLaunchd(specification);
    case "windows": return renderTaskScheduler(specification);
  }
};

/** The bounded PATH a supervised process gets: the runtime's own directory first. */
export const nativeServicePath = (executable: string): string =>
  [...new Set([dirname(executable), "/usr/local/bin", "/usr/bin", "/bin"])].join(":");

/** The platform this process runs on, in Canonfig's terms. */
export const platformOf = (): MachinePlatform =>
  process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";

const outputOf = (result: ProcessResult): string =>
  `${Buffer.from(result.standardOutput).toString("utf8")}\n${
    Buffer.from(result.standardError).toString("utf8")
  }`.trim();

const tailOf = (text: string): string => text.split("\n").slice(-3).join(" ").slice(0, 400);

const isEnoent = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const fileFailure = (operation: string, path: string) => (cause: unknown) =>
  new NativeServiceConfigurationError({
    operation,
    message: `${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

export const readOptional = (path: string): Effect.Effect<string | undefined, NativeServiceError> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8").catch((cause: unknown) => {
      if (isEnoent(cause)) return undefined;
      throw cause;
    }),
    catch: fileFailure("read the service definition", path),
  });

export const writeAtomically = (
  path: string,
  content: string,
): Effect.Effect<void, NativeServiceError> =>
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
    catch: fileFailure("write the service definition", path),
  }).pipe(Effect.uninterruptible);

export const removeOptional = (path: string): Effect.Effect<void, NativeServiceError> =>
  Effect.tryPromise({
    try: () => unlink(path).catch((cause: unknown) => {
      if (!isEnoent(cause)) throw cause;
    }),
    catch: fileFailure("remove the service definition", path),
  });

/** Native operations for one platform's user service manager. */
export interface NativeServiceManager {
  readonly inspect: (
    rendered: RenderedNativeService,
  ) => Effect.Effect<NativeServiceManagerState, NativeServiceError>;
  /** Write the definition and (re)start the service from it. */
  readonly install: (rendered: RenderedNativeService) => Effect.Effect<void, NativeServiceError>;
  readonly remove: (rendered: RenderedNativeService) => Effect.Effect<boolean, NativeServiceError>;
  readonly supportedModes: Effect.Effect<{ readonly text: string; readonly linger?: boolean }>;
  readonly logs: (rendered: RenderedNativeService) => string;
}

export interface NativeServiceHostOptions {
  readonly platform?: MachinePlatform | undefined;
  readonly home?: string | undefined;
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined;
  /** Names the service in operator messages, such as "Source service". */
  readonly label: string;
  /** Where launchd writes the process's output. */
  readonly logPath: string;
  /** What the systemd user manager's lifecycle means for this service, with and without linger. */
  readonly systemdModes?: ((user: string, linger: boolean) => string) | undefined;
}

/** This machine's service manager, and a renderer for definitions it runs. */
export interface NativeServiceHost {
  readonly platform: MachinePlatform;
  readonly manager: NativeServiceManager;
  /**
   * The definition that runs `canonfig <arguments>` with this installation's
   * runtime. `installing` adds the Windows checks that only matter before
   * registering a task.
   */
  readonly render: (
    name: NativeServiceName,
    arguments_: ReadonlyArray<string>,
    installing?: boolean,
  ) => Effect.Effect<RenderedNativeService, NativeServiceError>;
}

const defaultSystemdModes = (user: string, linger: boolean): string =>
  linger
    ? `is started at boot and managed across logouts by the user manager (linger is enabled for ${user})`
    : `is managed only while ${user} has a login session; \`loginctl enable-linger ${user}\` keeps it running without one`;

export const nativeServiceHost = (
  options: NativeServiceHostOptions,
): Effect.Effect<NativeServiceHost, never, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const platform = options.platform ?? platformOf();
    const home = options.home ?? homedir();
    const environment = options.environment ?? process.env;
    const user = userInfo().username;
    const { label, logPath } = options;
    const systemdModes = options.systemdModes ?? defaultSystemdModes;

    const run = (
      executable: string,
      arguments_: ReadonlyArray<string>,
      timeoutMilliseconds = 30_000,
    ): Effect.Effect<ProcessResult, NativeServiceError> =>
      machine.runProcess({
        executable: { platform, absolute: executable },
        arguments: arguments_,
        timeoutMilliseconds,
        maximumOutputBytes: 1024 * 1024,
      });

    const systemd = (): NativeServiceManager => {
      const systemctl = environment.CANONFIG_SYSTEMCTL ?? "/usr/bin/systemctl";
      const busMessage =
        `the systemd user manager is not reachable: this session has no user session bus (DBUS_SESSION_BUS_ADDRESS or $XDG_RUNTIME_DIR/bus). `
        + `Run this from a login session of ${user}, or enable linger with \`loginctl enable-linger ${user}\` so the user manager runs without a login, then retry.`;
      const systemctlFailure = (operation: string, result: ProcessResult) => {
        const output = outputOf(result);
        return new NativeServiceManagerError({
          operation,
          message: /failed to connect to bus|no medium found|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR/iu
              .test(output)
            ? busMessage
            : `\`systemctl --user\` failed (exit ${result.exitCode ?? "signal"}): ${tailOf(output)}`,
        });
      };
      const systemctlUser = (operation: string, arguments_: ReadonlyArray<string>, timeoutMilliseconds?: number) =>
        run(systemctl, ["--user", ...arguments_], timeoutMilliseconds).pipe(
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
            const shown = yield* systemctlUser(`inspect the ${label}`, [
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
            yield* systemctlUser(`enable the ${label}`, ["enable", rendered.serviceName]);
            // A restart, not `start`: an already running Source must pick
            // up a changed definition, and a failed one its reset limit.
            yield* systemctlUser(`reset the ${label}`, ["reset-failed", rendered.serviceName])
              .pipe(Effect.ignore);
            yield* systemctlUser(`start the ${label}`, ["restart", rendered.serviceName]);
          }),
        remove: (rendered) =>
          Effect.gen(function*() {
            const stored = yield* readOptional(rendered.definitionPath!);
            if (stored === undefined) return false;
            // Stopping waits for the process to exit, and a watcher first finishes
            // its running pass; allow systemd's whole default stop window (90 s).
            yield* systemctlUser(`stop the ${label}`, ["disable", "--now", rendered.serviceName], 120_000);
            yield* removeOptional(rendered.definitionPath!);
            yield* systemctlUser("reload the systemd user manager", ["daemon-reload"]);
            return true;
          }),
        supportedModes: Effect.promise(() =>
          access(lingerPath).then(() => true, () => false)
        ).pipe(Effect.map((linger) => ({
          linger,
          text: systemdModes(user, linger),
        }))),
        logs: (rendered) => `journalctl --user -u ${rendered.serviceName}`,
      };
    };

    const launchd = (): NativeServiceManager => {
      const launchctl = "/bin/launchctl";
      const domain = `gui/${process.getuid?.() ?? 0}`;
      const unavailable = (operation: string, result: ProcessResult) =>
        new NativeServiceManagerError({
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
              return yield* unavailable(`inspect the ${label}`, printed);
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
            if (loaded.exitCode !== 0) return yield* unavailable(`load the ${label}`, loaded);
          }),
        remove: (rendered) =>
          Effect.gen(function*() {
            const stored = yield* readOptional(rendered.definitionPath!);
            if (stored === undefined) return false;
            // bootout fails both for a job that is not loaded (fine) and for one
            // it could not unload; only the job's absence lets the plist go,
            // which keeps the definition for a retry while the job still runs.
            yield* run(launchctl, ["bootout", domain, rendered.definitionPath!], 120_000).pipe(Effect.ignore);
            const printed = yield* run(launchctl, ["print", `${domain}/${rendered.serviceName}`]);
            if (!/could not find service/iu.test(outputOf(printed))) {
              return yield* printed.exitCode === 0
                ? new NativeServiceManagerError({
                  operation: `stop the ${label}`,
                  message: `launchd still has ${rendered.serviceName} loaded after bootout; its definition ${rendered.definitionPath} is kept. Retry once the job has exited`,
                })
                : unavailable(`stop the ${label}`, printed);
            }
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

    const taskScheduler = (): NativeServiceManager => {
      const system32 = win32.join(environment.SystemRoot ?? "C:\\Windows", "System32");
      const schtasks = environment.CANONFIG_SCHTASKS ?? win32.join(system32, "schtasks.exe");
      const powershell = environment.CANONFIG_POWERSHELL
        ?? win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
      const unavailable = (operation: string, result: ProcessResult) =>
        new NativeServiceManagerError({
          operation,
          message:
            `Task Scheduler refused to ${operation} (${tailOf(outputOf(result))}). Sign in interactively as ${user} and ensure the Task Scheduler service is running, then retry.`,
        });
      const taskAbsent = (
        rendered: RenderedNativeService,
        failed: ProcessResult,
        operation: string,
      ): Effect.Effect<boolean, NativeServiceError> =>
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
      /** Task Scheduler's state for the task (Running, Ready, Disabled), or "unknown". */
      const taskState = (rendered: RenderedNativeService) =>
        run(powershell, [
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
        inspect: (rendered) =>
          Effect.gen(function*() {
            const query = yield* run(schtasks, ["/Query", "/TN", rendered.serviceName, "/XML"]);
            if (query.exitCode !== 0) {
              if (yield* taskAbsent(rendered, query, `query the ${label} task`)) {
                return { installed: false, matches: false, enabled: false, active: false, state: "absent" };
              }
              return yield* unavailable(`query the ${label} task`, query);
            }
            const xml = decodeWindowsTaskXml(query.standardOutput);
            const settings = /<Settings>([\s\S]*?)<\/Settings>/u.exec(xml)?.[1] ?? "";
            const state = yield* taskState(rendered);
            return {
              installed: true,
              matches: xml.includes(taskMarker(rendered.fingerprint)),
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
              catch: fileFailure(`write the ${label} task definition`, path),
            });
            const created = yield* run(schtasks, [
              "/Create",
              "/TN",
              rendered.serviceName,
              "/XML",
              path,
              "/F",
            ]).pipe(Effect.ensuring(Effect.promise(() => rm(path, { force: true }))));
            if (created.exitCode !== 0) return yield* unavailable(`register the ${label} task`, created);
            yield* run(schtasks, ["/End", "/TN", rendered.serviceName]).pipe(Effect.ignore);
            const started = yield* run(schtasks, ["/Run", "/TN", rendered.serviceName]);
            if (started.exitCode !== 0) return yield* unavailable(`start the ${label} task`, started);
          }),
        remove: (rendered) =>
          Effect.gen(function*() {
            yield* run(schtasks, ["/End", "/TN", rendered.serviceName]).pipe(Effect.ignore);
            // Deleting a task does not stop its running instance, and afterwards
            // nothing would name it for a retry: delete only once it has stopped.
            if ((yield* taskState(rendered)) === "Running") {
              return yield* new NativeServiceManagerError({
                operation: `stop the ${label} task`,
                message: `${rendered.serviceName} is still running after Task Scheduler was asked to end it; the task is kept. Retry once it has stopped`,
              });
            }
            const deleted = yield* run(schtasks, ["/Delete", "/TN", rendered.serviceName, "/F"]);
            if (deleted.exitCode === 0) return true;
            if (yield* taskAbsent(rendered, deleted, `delete the ${label} task`)) return false;
            return yield* unavailable(`delete the ${label} task`, deleted);
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
    const serviceEnvironment = Effect.fn("NativeService.environment")(function*(
      executable: string,
      installing: boolean,
    ): Effect.fn.Return<ReadonlyArray<ProcessEnvironmentEntry>, NativeServiceError> {
      const credentialRoot = environment.CANONFIG_LOCAL_CREDENTIAL_ROOT;
      if (platform !== "windows") {
        return [
          { name: "HOME", value: home },
          { name: "PATH", value: nativeServicePath(executable) },
          ...credentialRoot === undefined
            ? []
            : [{ name: "CANONFIG_LOCAL_CREDENTIAL_ROOT", value: credentialRoot }],
          ...["CANONFIG_TAILSCALE_EXECUTABLE", "CANONFIG_TAILSCALE_SOCKET"].flatMap((name) =>
            environment[name] === undefined ? [] : [{ name, value: environment[name] }]),
        ];
      }
      if (!installing) return [];
      // Task Scheduler starts the task with the user's own profile and
      // persistent environment. Refuse what that would silently change.
      if (win32.resolve(home).toLowerCase() !== win32.resolve(userInfo().homedir).toLowerCase()) {
        return yield* new NativeServiceConfigurationError({
          operation: `install the ${label}`,
          message:
            `this shell uses ${home} as its home, but Task Scheduler starts the ${label} with ${user}'s profile ${userInfo().homedir}; run the install from a normal session of ${user}`,
        });
      }
      const registry = win32.join(environment.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
      for (const name of ["CANONFIG_LOCAL_CREDENTIAL_ROOT", "CANONFIG_TAILSCALE_EXECUTABLE", "CANONFIG_TAILSCALE_SOCKET"]) {
        const value = environment[name];
        if (value === undefined) continue;
        // A user value overrides a system value in the task's environment, so the system scope counts only when
        // the user scope does not define the name.
        const user = yield* run(registry, ["query", "HKCU\\Environment", "/v", name]);
        const query = user.exitCode === 0 ? user
          : yield* run(registry, ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "/v", name]);
        if (query.exitCode !== 0 || !outputOf(query).includes(value)) {
          return yield* new NativeServiceConfigurationError({
            operation: `install the ${label}`,
            message: `${name} is set in this shell only. Set it in your Windows user or system environment, open a new terminal, and retry so Task Scheduler uses the same configuration.`,
          });
        }
      }
      return [];
    });

    const render = Effect.fn("NativeService.render")(function*(
      name: NativeServiceName,
      arguments_: ReadonlyArray<string>,
      installing = false,
    ): Effect.fn.Return<RenderedNativeService, NativeServiceError> {
      const executable = stableRuntimeExecutable();
      const principal = platform === "windows"
        ? windowsAccountPrincipal(
          Object.entries(environment).flatMap(([variable, value]) =>
            value === undefined ? [] : [{ name: variable, value }]
          ),
          home,
        )
        : undefined;
      return yield* renderNativeService({
        name,
        platform,
        home,
        executable,
        arguments: [fileURLToPath(new URL("../runtime/main.js", import.meta.url)), ...arguments_],
        environment: yield* serviceEnvironment(executable, installing),
        logPath,
        principal,
      });
    });

    return { platform, manager, render };
  });
