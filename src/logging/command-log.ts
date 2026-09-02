import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const COMMAND_ACTIONS = new Map<string, ReadonlySet<string>>([
  ["agent", new Set(["harness", "policy"])],
  ["follower", new Set(["enroll"])],
  [
    "harness",
    new Set([
      "apply",
      "clean",
      "diff",
      "doctor",
      "help",
      "init",
      "plan",
      "status",
      "sync",
      "targets",
      "validate",
    ]),
  ],
  ["overlay", new Set(["list", "remove", "set"])],
  ["profile", new Set(["list", "select", "show"])],
  ["schedule", new Set(["remove", "set", "status"])],
  ["secrets", new Set(["help", "list", "remove", "set", "sync"])],
  ["source", new Set(["init", "invite", "publish", "revoke", "scan", "serve"])],
]);
const SINGLE_COMMANDS = new Set([
  "doctor",
  "recover",
  "status",
  "sync",
]);
const WINDOWS_ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$path = [Environment]::GetEnvironmentVariable('CANONFIG_LOG_ACL_PATH')",
  "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$acl = New-Object System.Security.AccessControl.FileSecurity",
  "$acl.SetOwner($identity)",
  "$acl.SetAccessRuleProtection($true, $false)",
  "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')",
  "$acl.AddAccessRule($rule)",
  "Set-Acl -LiteralPath $path -AclObject $acl",
  "$verified = Get-Acl -LiteralPath $path",
  "if (-not $verified.AreAccessRulesProtected) { throw 'log DACL inheritance is not protected' }",
  "$rules = @($verified.Access)",
  "if ($rules.Count -ne 1 -or $rules[0].IsInherited) { throw 'log DACL must contain one explicit rule' }",
  "$verifiedIdentity = $rules[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier])",
  "if ($verifiedIdentity.Value -ne $identity.Value) { throw 'log DACL identity does not match the current user' }",
  "if ($rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { throw 'log DACL rule is not an allow rule' }",
  "$required = [System.Security.AccessControl.FileSystemRights]::FullControl",
  "if (($rules[0].FileSystemRights -band $required) -ne $required) { throw 'log DACL rule does not grant full control' }",
].join("; ");

export interface CommandLogFileOperations {
  readonly platform: NodeJS.Platform;
  readonly ensureDirectory: (path: string) => void;
  readonly ensureFile: (path: string) => void;
  readonly restrictWindowsAccess: (
    path: string,
    environment: NodeJS.ProcessEnv,
  ) => boolean;
  readonly restrictPosixAccess: (path: string) => void;
  readonly append: (path: string, content: string) => void;
}

export interface CommandLogOptions {
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => number) | undefined;
  readonly fileOperations?: CommandLogFileOperations | undefined;
}

export interface CommandLog {
  readonly complete: (exitCode: number) => void;
}

interface CommandLogEntry {
  readonly schema: "canonfig.log/v1";
  readonly timestamp: string;
  readonly event: "command.started" | "command.completed";
  readonly level: "info" | "error";
  readonly command: string;
  readonly pid: number;
  readonly exitCode?: number | undefined;
  readonly durationMilliseconds?: number | undefined;
}

const nodeFileOperations: CommandLogFileOperations = {
  platform: process.platform,
  ensureDirectory: (path) => {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  },
  ensureFile: (path) => {
    closeSync(openSync(path, "a", 0o600));
  },
  restrictWindowsAccess: (path, environment) => {
    const result = spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_SCRIPT],
      {
        env: {
          ...process.env,
          ...environment,
          CANONFIG_LOG_ACL_PATH: path,
        },
        stdio: "ignore",
        timeout: 5_000,
        windowsHide: true,
      },
    );
    return result.error === undefined && result.status === 0;
  },
  restrictPosixAccess: (path) => {
    chmodSync(path, 0o600);
  },
  append: (path, content) => {
    appendFileSync(path, content, "utf8");
  },
};

const commandName = (arguments_: ReadonlyArray<string>): string => {
  if (arguments_.length === 0) return "help";
  if (arguments_.includes("--help") || arguments_.includes("-h")) return "help";
  if (arguments_.includes("--version") || arguments_.includes("-V")) return "version";

  const normalizedArguments = arguments_.filter((argument) => argument !== "--json");
  const first = normalizedArguments[0];
  const second = normalizedArguments[1];
  const actions = first === undefined ? undefined : COMMAND_ACTIONS.get(first);
  if (
    actions?.has("help") === true
    && (second === undefined || second === "help")
  ) {
    return `${first}.help`;
  }

  if (first === undefined) return "unknown";
  if (SINGLE_COMMANDS.has(first)) return first;
  if (second !== undefined && actions?.has(second) === true) {
    return `${first}.${second}`;
  }
  return "unknown";
};

const logPath = (environment: NodeJS.ProcessEnv): string => {
  const configured = environment.CANONFIG_LOG_FILE?.trim();
  return configured === undefined || configured.length === 0
    ? join(homedir(), ".canonfig", "canonfig.log")
    : resolve(configured);
};

const writeEntry = (
  path: string,
  entry: CommandLogEntry,
  environment: NodeJS.ProcessEnv,
  fileOperations: CommandLogFileOperations,
): void => {
  try {
    fileOperations.ensureDirectory(dirname(path));
    fileOperations.ensureFile(path);
    if (fileOperations.platform === "win32") {
      if (!fileOperations.restrictWindowsAccess(path, environment)) return;
    } else {
      fileOperations.restrictPosixAccess(path);
    }
    fileOperations.append(path, `${JSON.stringify(entry)}\n`);
  } catch {
    // Observability must never change command behavior.
  }
};

export const createCommandLog = (
  arguments_: ReadonlyArray<string>,
  options: CommandLogOptions = {},
): CommandLog => {
  const environment = options.environment ?? process.env;
  if (environment.CANONFIG_LOG?.trim().toLowerCase() === "off") {
    return { complete: () => undefined };
  }

  const now = options.now ?? Date.now;
  const fileOperations = options.fileOperations ?? nodeFileOperations;
  const startedAt = now();
  const path = logPath(environment);
  const command = commandName(arguments_);
  let completed = false;

  writeEntry(path, {
    schema: "canonfig.log/v1",
    timestamp: new Date(startedAt).toISOString(),
    event: "command.started",
    level: "info",
    command,
    pid: process.pid,
  }, environment, fileOperations);

  return {
    complete: (exitCode) => {
      if (completed) return;
      completed = true;
      const completedAt = now();
      writeEntry(path, {
        schema: "canonfig.log/v1",
        timestamp: new Date(completedAt).toISOString(),
        event: "command.completed",
        level: exitCode === 0 ? "info" : "error",
        command,
        pid: process.pid,
        exitCode,
        durationMilliseconds: Math.max(0, completedAt - startedAt),
      }, environment, fileOperations);
    },
  };
};

/** Register catchable termination signals. SIGKILL cannot be observed or logged. */
export const registerCommandLogSignalHandlers = (log: CommandLog): void => {
  const register = (
    signal: "SIGINT" | "SIGTERM",
    exitCode: number,
  ): void => {
    const handler = (): void => {
      log.complete(exitCode);
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    process.once(signal, handler);
  };

  register("SIGINT", 130);
  register("SIGTERM", 143);
};

/** Install one command log whose normal completion is the process's final exit. */
export const installCommandLog = (
  arguments_: ReadonlyArray<string>,
  options: CommandLogOptions = {},
): CommandLog => {
  const log = createCommandLog(arguments_, options);
  process.once("exit", (exitCode) => log.complete(exitCode));
  registerCommandLogSignalHandlers(log);
  return log;
};
