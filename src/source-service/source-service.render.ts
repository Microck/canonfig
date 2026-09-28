import { createHash } from "node:crypto";
import { dirname, join, win32 } from "node:path";

import { Effect } from "effect";

import { SourceServiceConfigurationError } from "./source-service.errors.ts";
import type {
  RenderedSourceService,
  SourceServiceSpecification,
} from "./source-service.types.ts";

export const sourceServiceStem = "canonfig-source";
export const launchdSourceLabel = "dev.canonfig.source";
export const windowsSourceTaskName = `Canonfig\\${sourceServiceStem}`;
const description = "Canonfig Source server";

const singleLine = (
  value: string,
  field: string,
): Effect.Effect<string, SourceServiceConfigurationError> =>
  value.length > 0 && !/[\n\r\0]/u.test(value)
    ? Effect.succeed(value)
    : Effect.fail(new SourceServiceConfigurationError({
      operation: "render Source service",
      message: `${field} must be non-empty, single-line, and contain no NUL bytes`,
    }));

const fingerprintOf = (specification: SourceServiceSpecification): string =>
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
  specification: SourceServiceSpecification,
): Effect.Effect<RenderedSourceService, SourceServiceConfigurationError> =>
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
    const serviceName = `${sourceServiceStem}.service`;
    return {
      platform: "linux",
      mechanism: "systemd-user-service",
      serviceName,
      definitionPath: join(specification.home, ".config", "systemd", "user", serviceName),
      definition: [
        "[Unit]",
        `Description=${description}`,
        // A Source that cannot start (locked keyring, port in use) stops
        // retrying after five failures in five minutes and reads `failed`.
        "StartLimitIntervalSec=300",
        "StartLimitBurst=5",
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
        "RestartSec=10",
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
  specification: SourceServiceSpecification,
): Effect.Effect<RenderedSourceService, SourceServiceConfigurationError> =>
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
      serviceName: launchdSourceLabel,
      definitionPath: join(
        specification.home,
        "Library",
        "LaunchAgents",
        `${launchdSourceLabel}.plist`,
      ),
      definition: [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" "
        + "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
        "<plist version=\"1.0\"><dict>",
        `<key>Label</key><string>${launchdSourceLabel}</string>`,
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

export const sourceTaskDescription = (fingerprint: string): string =>
  `${description} [canonfig:${fingerprint}]`;

const renderTaskScheduler = (
  specification: SourceServiceSpecification,
): Effect.Effect<RenderedSourceService, SourceServiceConfigurationError> =>
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
      return yield* new SourceServiceConfigurationError({
        operation: "render Source service",
        message: `Task Scheduler cannot carry environment variables (${
          specification.environment.map((entry) => entry.name).join(", ")
        }); set them in the user environment instead`,
      });
    }
    const fingerprint = fingerprintOf(specification);
    return {
      platform: "windows",
      mechanism: "task-scheduler-logon",
      serviceName: windowsSourceTaskName,
      definition: [
        "<?xml version=\"1.0\" encoding=\"UTF-16\"?>",
        "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">",
        `<RegistrationInfo><Description>${xml(sourceTaskDescription(fingerprint))}</Description></RegistrationInfo>`,
        `<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(principal)}</UserId></LogonTrigger></Triggers>`,
        `<Principals><Principal id="Author"><UserId>${xml(principal)}</UserId>`,
        "<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>",
        "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
        "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
        "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate>",
        "<StartWhenAvailable>true</StartWhenAvailable>",
        "<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>",
        "<Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>",
        `<Actions Context="Author"><Exec><Command>${xml(executable)}</Command>`,
        `<Arguments>${xml(arguments_.map(windowsArgument).join(" "))}</Arguments>`,
        `<WorkingDirectory>${xml(win32.normalize(specification.home))}</WorkingDirectory></Exec></Actions></Task>`,
      ].join(""),
      fingerprint,
    };
  });

/** The native definition that supervises `canonfig source serve` on this platform. */
export const renderSourceService = (
  specification: SourceServiceSpecification,
): Effect.Effect<RenderedSourceService, SourceServiceConfigurationError> => {
  switch (specification.platform) {
    case "linux": return renderSystemd(specification);
    case "macos": return renderLaunchd(specification);
    case "windows": return renderTaskScheduler(specification);
  }
};

/** The bounded PATH a supervised process gets: the runtime's own directory first. */
export const sourceServicePath = (executable: string): string =>
  [...new Set([dirname(executable), "/usr/local/bin", "/usr/bin", "/bin"])].join(":");
