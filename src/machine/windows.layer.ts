import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { win32 } from "node:path";

import { Effect, Layer, Redacted, Schema } from "effect";

import {
  CredentialReference,
  type CredentialReference as CredentialReferenceType,
} from "../domain/brand.ts";
import {
  CredentialStorageError,
  ExecutableNotFoundError,
  HumanActionRequiredError,
  InvalidMachinePathError,
  InvalidSchedulerJobError,
  type MachineStateError,
} from "./machine-state.errors.ts";
import { MachineState } from "./machine-state.service.ts";
import { linuxMachineStateLayer } from "./linux.layer.ts";
import type {
  CredentialPolicy,
  CredentialStorageCapability,
  MachinePath,
  NormalizePathInput,
  ProcessEnvironmentEntry,
  RenderedSchedulerJob,
  SchedulerBackend,
  SchedulerCalendar,
  SchedulerJob,
} from "./machine-state.types.ts";

export interface WindowsMachineStateOptions {
  readonly credentialPolicy?: CredentialPolicy | undefined;
  readonly credentialStoreAccess?: "auto" | "unavailable" | undefined;
  readonly environment?: ReadonlyArray<ProcessEnvironmentEntry> | undefined;
  readonly schedulerBackend?: SchedulerBackend | undefined;
}

const decode = Schema.decodeUnknownSync;

const environmentEntries = (): ReadonlyArray<ProcessEnvironmentEntry> =>
  Object.entries(process.env).flatMap(([name, value]) =>
    value === undefined ? [] : [{ name, value }]
  );

const environmentValue = (
  environment: ReadonlyArray<ProcessEnvironmentEntry>,
  name: string,
): string | undefined =>
  environment.find((entry) => entry.name.toUpperCase() === name.toUpperCase())?.value;

const windowsPath = (absolute: string): MachinePath => ({
  platform: "windows",
  absolute: win32.normalize(absolute),
});

const linuxPath = (path: MachinePath): MachinePath => ({
  platform: "linux",
  absolute: path.absolute,
});

const requireWindowsPath = (
  path: MachinePath,
): Effect.Effect<MachinePath, InvalidMachinePathError> =>
  path.platform === "windows"
    ? Effect.succeed(linuxPath(path))
    : Effect.fail(new InvalidMachinePathError({
      path: path.absolute,
      message: `expected a Windows path, received ${path.platform}`,
    }));

const normalizedPath = (
  input: NormalizePathInput,
  home: string,
): Effect.Effect<MachinePath, InvalidMachinePathError> => {
  if (input.path.length === 0 || input.path.includes("\0")) {
    return Effect.fail(new InvalidMachinePathError({
      path: input.path,
      message: "path must not be empty or contain NUL bytes",
    }));
  }
  if (input.base !== undefined && input.base.platform !== "windows") {
    return Effect.fail(new InvalidMachinePathError({
      path: input.path,
      message: `relative Windows paths cannot use a ${input.base.platform} base`,
    }));
  }
  const expanded = input.path === "~"
    ? home
    : /^~[\\/]/u.test(input.path)
    ? win32.join(home, input.path.slice(2))
    : input.path;
  return Effect.succeed(
    windowsPath(win32.resolve(input.base?.absolute ?? process.cwd(), expanded)),
  );
};

const validateSingleLine = (
  value: string,
  field: string,
): Effect.Effect<string, InvalidSchedulerJobError> =>
  value.trim().length > 0 && !/[\n\r\0]/u.test(value)
    ? Effect.succeed(value)
    : Effect.fail(new InvalidSchedulerJobError({
      field,
      message: `${field} must be non-empty, single-line, and contain no NUL bytes`,
    }));

const powershellLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

const windowsCommandLineArgument = (value: string): string => {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let output = "\"";
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === "\"") {
      output += "\\".repeat(backslashes * 2 + 1) + "\"";
      backslashes = 0;
      continue;
    }
    output += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return output + "\\".repeat(backslashes * 2) + "\"";
};

const taskCalendar = (
  calendar: SchedulerCalendar,
): Effect.Effect<string, InvalidSchedulerJobError> => {
  if (calendar.kind === "systemd-on-calendar") {
    return Effect.fail(new InvalidSchedulerJobError({
      field: "calendar.kind",
      message: "systemd calendar expressions are not supported by Task Scheduler",
    }));
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(calendar.localTime)) {
    return Effect.fail(new InvalidSchedulerJobError({
      field: "calendar.localTime",
      message: "local time must use 24-hour HH:mm format",
    }));
  }
  return Effect.succeed(calendar.kind === "daily"
    ? `New-ScheduledTaskTrigger -Daily -At ${powershellLiteral(calendar.localTime)}`
    : `New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${calendar.weekday} `
      + `-At ${powershellLiteral(calendar.localTime)}`);
};

const renderTaskSchedulerJob = (
  job: SchedulerJob,
): Effect.Effect<RenderedSchedulerJob, MachineStateError> =>
  Effect.gen(function*() {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(job.name)) {
      return yield* new InvalidSchedulerJobError({
        field: "name",
        message: "job name must be a portable Task Scheduler name",
      });
    }
    const description = yield* validateSingleLine(job.description, "description");
    const executable = yield* requireWindowsPath(job.executable);
    const arguments_ = yield* Effect.forEach(
      job.arguments,
      (argument, index) => validateSingleLine(argument, `arguments[${index}]`),
    );
    const trigger = yield* taskCalendar(job.calendar);
    const commandLine = arguments_.map(windowsCommandLineArgument).join(" ");
    const taskName = `Canonfig\\${job.name}`;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({
        executable: executable.absolute,
        arguments: arguments_,
        trigger,
      }))
      .digest("hex");
    const ownedDescription = `${description} [canonfig:${fingerprint}]`;
    return {
      platform: "windows",
      mechanism: "task-scheduler",
      serviceName: taskName,
      service: [
        `$Action = New-ScheduledTaskAction -Execute ${powershellLiteral(executable.absolute)} `
          + `-Argument ${powershellLiteral(commandLine)}`,
        `$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive`,
        `$Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1)`,
      ].join("\r\n"),
      schedule: [
        `$Trigger = ${trigger}`,
        `Register-ScheduledTask -TaskName ${powershellLiteral(taskName)} `
          + `-Description ${powershellLiteral(ownedDescription)} -Action $Action `
          + "-Trigger $Trigger -Principal $Principal -Settings $Settings",
      ].join("\r\n"),
    };
  });

const credentialKey = (
  reference: CredentialReferenceType,
): Effect.Effect<string, CredentialStorageError> => {
  const prefix = "credential-manager:";
  const value = String(reference);
  if (!value.startsWith(prefix) || value.length === prefix.length) {
    return Effect.fail(new CredentialStorageError({
      operation: "resolve credential reference",
      reference: value,
      message: "credential reference is not owned by Windows Credential Manager",
    }));
  }
  return Effect.succeed(value.slice(prefix.length));
};

const credentialScript = {
  store: [
    "$vault = New-Object Windows.Security.Credentials.PasswordVault",
    "$credential = New-Object Windows.Security.Credentials.PasswordCredential("
      + "$env:CANONFIG_TARGET,'canonfig',$env:CANONFIG_SECRET)",
    "$vault.Add($credential)",
  ].join(";"),
  load: [
    "$vault = New-Object Windows.Security.Credentials.PasswordVault",
    "$credential = $vault.Retrieve($env:CANONFIG_TARGET,'canonfig')",
    "$credential.RetrievePassword()",
    "[Console]::Out.Write($credential.Password)",
  ].join(";"),
  remove: [
    "$vault = New-Object Windows.Security.Credentials.PasswordVault",
    "$credential = $vault.Retrieve($env:CANONFIG_TARGET,'canonfig')",
    "$vault.Remove($credential)",
  ].join(";"),
} as const;

export const windowsMachineStateLayer = (
  options: WindowsMachineStateOptions = {},
): Layer.Layer<MachineState> => {
  const environment = options.environment ?? environmentEntries();
  const home = environmentValue(environment, "USERPROFILE")
    ?? environmentValue(environment, "HOME")
    ?? homedir();
  const policy = options.credentialPolicy ?? { kind: "secure-store" };
  const powershell = environmentValue(environment, "CANONFIG_POWERSHELL")
    ?? win32.join(
      environmentValue(environment, "SystemRoot") ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  const base = linuxMachineStateLayer({
    credentialPolicy: policy,
    environment,
  });

  return Layer.effect(
    MachineState,
    Effect.gen(function*() {
      const machine = yield* MachineState;
      const secureStoreAvailable = Effect.promise(() =>
        options.credentialStoreAccess !== "unavailable"
          && process.platform === "win32"
          ? access(powershell).then(() => true).catch(() => false)
          : Promise.resolve(false)
      );
      const requirePowerShell = Effect.gen(function*() {
        if (yield* secureStoreAvailable) return powershell;
        return yield* new HumanActionRequiredError({
          action: "configure Windows credential storage",
          recovery:
            "Run on Windows with Credential Manager available, or explicitly select the local-file credential policy.",
        });
      });
      const runCredentialScript = (
        script: string,
        additions: ReadonlyArray<ProcessEnvironmentEntry>,
      ) =>
        machine.runProcess({
          executable: { platform: "linux", absolute: powershell },
          arguments: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
          ],
          environment: additions,
          timeoutMilliseconds: 5_000,
          maximumOutputBytes: 1024 * 1024,
        });
      const runSchedulerScript = (script: string) =>
        machine.runProcess({
          executable: { platform: "linux", absolute: powershell },
          arguments: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
          ],
          timeoutMilliseconds: 10_000,
          maximumOutputBytes: 1024 * 1024,
        });
      const nativeScheduler: SchedulerBackend = {
        inspect: (expected) => {
          const fingerprint = /\[canonfig:([a-f0-9]{64})\]/u.exec(expected.schedule)?.[1];
          const action = /-Execute '((?:''|[^'])*)' -Argument '((?:''|[^'])*)'/u
            .exec(expected.service);
          const daily = /-Daily -At '([0-2]\d:[0-5]\d)'/u.exec(expected.schedule);
          const weekly = /-Weekly -DaysOfWeek (Mon|Tue|Wed|Thu|Fri|Sat|Sun) -At '([0-2]\d:[0-5]\d)'/u
            .exec(expected.schedule);
          const taskName = powershellLiteral(expected.serviceName);
          const script = [
            `$Task = Get-ScheduledTask -TaskName ${taskName} -ErrorAction SilentlyContinue`,
            "if ($null -eq $Task) { [Console]::Out.Write('missing') } else {",
            "  $Trigger = $Task.Triggers[0]",
            "  [ordered]@{",
            "    Description = $Task.Description",
            "    Enabled = $Task.Settings.Enabled",
            "    Execute = $Task.Actions[0].Execute",
            "    Arguments = $Task.Actions[0].Arguments",
            "    TriggerType = $Trigger.CimClass.CimClassName",
            "    StartBoundary = $Trigger.StartBoundary",
            "    DaysOfWeek = $Trigger.DaysOfWeek",
            "  } | ConvertTo-Json -Compress",
            "}",
          ].join("\r\n");
          return runSchedulerScript(script).pipe(
            Effect.map((result) => {
              const output = Buffer.from(result.standardOutput).toString("utf8");
              if (result.exitCode !== 0 || output === "missing") {
                return { installed: false, enabled: false, matches: false };
              }
              let actual: {
                readonly Description?: string | undefined;
                readonly Enabled?: boolean | undefined;
                readonly Execute?: string | undefined;
                readonly Arguments?: string | undefined;
                readonly TriggerType?: string | undefined;
                readonly StartBoundary?: string | undefined;
                readonly DaysOfWeek?: number | undefined;
              };
              try {
                actual = JSON.parse(output);
              } catch {
                return { installed: true, enabled: false, matches: false };
              }
              const expectedExecutable = action?.[1]?.replaceAll("''", "'");
              const expectedArguments = action?.[2]?.replaceAll("''", "'");
              const expectedTime = daily?.[1] ?? weekly?.[2];
              const weekdayMask = weekly === null
                ? undefined
                : {
                  Sun: 1,
                  Mon: 2,
                  Tue: 4,
                  Wed: 8,
                  Thu: 16,
                  Fri: 32,
                  Sat: 64,
                }[weekly[1]];
              const triggerMatches = expectedTime !== undefined
                && actual.StartBoundary?.includes(`T${expectedTime}:00`) === true
                && (daily !== null
                  ? actual.TriggerType?.includes("Daily") === true
                  : actual.TriggerType?.includes("Weekly") === true
                    && actual.DaysOfWeek === weekdayMask);
              return {
                installed: true,
                enabled: actual.Enabled === true,
                matches: fingerprint !== undefined
                  && actual.Description?.includes(`[canonfig:${fingerprint}]`) === true
                  && actual.Execute === expectedExecutable
                  && actual.Arguments === expectedArguments
                  && triggerMatches,
              };
            }),
          );
        },
        install: (definition) =>
          runSchedulerScript(`${definition.service}\r\n${definition.schedule}`).pipe(
            Effect.flatMap((result) =>
              result.exitCode === 0
                ? Effect.void
                : Effect.fail(new HumanActionRequiredError({
                  action: "register the Canonfig scheduled task",
                  recovery:
                    "Sign in interactively and ensure per-user Task Scheduler access is available, then retry.",
                }))
            ),
          ),
        remove: (definition) =>
          runSchedulerScript(
            `Unregister-ScheduledTask -TaskName ${
              powershellLiteral(definition.serviceName)
            } -Confirm:$false -ErrorAction SilentlyContinue`,
          ).pipe(
            Effect.flatMap((result) =>
              result.exitCode === 0
                ? Effect.void
                : Effect.fail(new HumanActionRequiredError({
                  action: "remove the Canonfig scheduled task",
                  recovery:
                    "Sign in interactively and ensure per-user Task Scheduler access is available, then retry.",
                }))
            ),
          ),
      };
      const scheduler = options.schedulerBackend ?? nativeScheduler;

      return MachineState.of({
        normalizePath: (input) => normalizedPath(input, home),
        userDirectories: () => Effect.succeed({
          home: windowsPath(home),
          config: windowsPath(
            environmentValue(environment, "APPDATA")
              ?? win32.join(home, "AppData", "Roaming"),
          ),
          data: windowsPath(
            environmentValue(environment, "LOCALAPPDATA")
              ?? win32.join(home, "AppData", "Local"),
          ),
          cache: windowsPath(
            environmentValue(environment, "LOCALAPPDATA")
              ?? win32.join(home, "AppData", "Local"),
          ),
        }),
        ensureDirectory: (input) =>
          requireWindowsPath(input.path).pipe(
            Effect.flatMap((path) => machine.ensureDirectory({ ...input, path })),
          ),
        atomicWrite: (input) =>
          requireWindowsPath(input.path).pipe(
            Effect.flatMap((path) => machine.atomicWrite({ ...input, path })),
          ),
        readFile: (input) =>
          requireWindowsPath(input.path).pipe(
            Effect.flatMap((path) => machine.readFile({ ...input, path })),
          ),
        removeFile: (input) =>
          requireWindowsPath(input.path).pipe(
            Effect.flatMap((path) => machine.removeFile({ ...input, path })),
          ),
        replaceSymlink: (input) =>
          Effect.all({
            path: requireWindowsPath(input.path),
            target: requireWindowsPath(input.target),
          }).pipe(Effect.flatMap(machine.replaceSymlink)),
        readSymlink: (path) =>
          requireWindowsPath(path).pipe(
            Effect.flatMap(machine.readSymlink),
            Effect.map((target) => windowsPath(target.absolute)),
          ),
        setPermissions: (input) =>
          requireWindowsPath(input.path).pipe(
            Effect.flatMap((path) => machine.setPermissions({ ...input, path })),
          ),
        permissions: (path) =>
          requireWindowsPath(path).pipe(Effect.flatMap(machine.permissions)),
        findExecutable: (query) => {
          if (
            query.name.length === 0
            || /[\\/\0]/u.test(query.name)
          ) {
            return Effect.fail(new ExecutableNotFoundError({ name: query.name }));
          }
          const names = win32.extname(query.name).length > 0
            ? [query.name]
            : (environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
              .split(";")
              .map((extension) => `${query.name}${extension.toLowerCase()}`);
          const directories = query.searchPath
            ?? (environmentValue(environment, "PATH") ?? "")
              .split(";")
              .filter((entry) => entry.length > 0)
              .map(windowsPath);
          return Effect.gen(function*() {
            for (const directory of directories) {
              yield* requireWindowsPath(directory);
              for (const name of names) {
                const candidate = win32.join(directory.absolute, name);
                const available = yield* Effect.promise(() =>
                  access(candidate).then(() => true).catch(() => false)
                );
                if (available) {
                  return { name: query.name, path: windowsPath(candidate) };
                }
              }
            }
            return yield* new ExecutableNotFoundError({ name: query.name });
          });
        },
        runProcess: (invocation) =>
          Effect.all({
            executable: requireWindowsPath(invocation.executable),
            workingDirectory: invocation.workingDirectory === undefined
              ? Effect.succeed(undefined)
              : requireWindowsPath(invocation.workingDirectory),
          }).pipe(
            Effect.flatMap(({ executable, workingDirectory }) =>
              machine.runProcess({ ...invocation, executable, workingDirectory })
            ),
          ),
        digestFile: (input) =>
          requireWindowsPath(input.path).pipe(
            Effect.flatMap((path) => machine.digestFile({ ...input, path })),
          ),
        credentialCapability: (): Effect.Effect<
          CredentialStorageCapability,
          MachineStateError
        > => {
          if (policy.kind === "local-file") {
            return Effect.succeed({
              kind: "local-file",
              path: windowsPath(win32.resolve(policy.path)),
            });
          }
          return secureStoreAvailable.pipe(Effect.map((available) =>
            available
              ? {
                kind: "secure-noninteractive" as const,
                provider: "credential-manager" as const,
              }
              : {
                kind: "unavailable" as const,
                recovery:
                  "Run on Windows with Credential Manager available, or explicitly select the local-file credential policy.",
              }
          ));
        },
        storeCredential: (input) => {
          if (policy.kind === "local-file") return machine.storeCredential(input);
          if (input.name.trim().length === 0) {
            return Effect.fail(new CredentialStorageError({
              operation: "store credential",
              reference: "credential-manager",
              message: "credential name must not be empty",
            }));
          }
          const key = createHash("sha256").update(input.name).digest("hex");
          return requirePowerShell.pipe(
            Effect.flatMap(() =>
              runCredentialScript(credentialScript.store, [
                { name: "CANONFIG_TARGET", value: `dev.canonfig.${key}` },
                { name: "CANONFIG_SECRET", value: Redacted.value(input.value) },
              ])
            ),
            Effect.flatMap((result) =>
              result.exitCode === 0
                ? Effect.succeed(
                  decode(CredentialReference)(`credential-manager:${key}`),
                )
                : Effect.fail(new HumanActionRequiredError({
                  action: "unlock Windows Credential Manager",
                  recovery: "Sign in interactively and make Credential Manager available, then retry.",
                }))
            ),
          );
        },
        loadCredential: (input) => {
          if (policy.kind === "local-file") return machine.loadCredential(input);
          return Effect.gen(function*() {
            const key = yield* credentialKey(input.reference);
            yield* requirePowerShell;
            const result = yield* runCredentialScript(credentialScript.load, [
              { name: "CANONFIG_TARGET", value: `dev.canonfig.${key}` },
            ]);
            if (result.exitCode !== 0) {
              return yield* new HumanActionRequiredError({
                action: "provide Windows credential",
                recovery: "Store the required credential in Windows Credential Manager, then retry.",
              });
            }
            return Redacted.make(Buffer.from(result.standardOutput).toString("utf8"));
          });
        },
        removeCredential: (reference) => {
          if (policy.kind === "local-file") return machine.removeCredential(reference);
          return Effect.gen(function*() {
            const key = yield* credentialKey(reference);
            yield* requirePowerShell;
            const result = yield* runCredentialScript(credentialScript.remove, [
              { name: "CANONFIG_TARGET", value: `dev.canonfig.${key}` },
            ]);
            if (result.exitCode !== 0) {
              return yield* new CredentialStorageError({
                operation: "remove credential",
                reference: String(reference),
                message: "Windows Credential Manager did not remove the credential",
              });
            }
          });
        },
        renderSchedulerJob: renderTaskSchedulerJob,
        inspectSchedulerJob: scheduler.inspect,
        installSchedulerJob: scheduler.install,
        removeSchedulerJob: scheduler.remove,
      });
    }).pipe(Effect.provide(base)),
  );
};
