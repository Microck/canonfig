import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as filesystemConstants } from "node:fs";
import { access, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { isAbsolute, join, resolve } from "node:path";

import { Effect, Layer, Schema } from "effect";

import { withRunLock } from "../synchronization/run-lock.ts";
import { probeSourceDescriptor } from "./follower-client.ts";
import {
  TunnelConfigurationError,
  TunnelHostKeyBypassError,
  TunnelHostKeyError,
  TunnelProcessError,
  TunnelReadinessError,
  type TunnelError,
} from "./tunnel.errors.ts";
import {
  Tunnel,
  type RestartTunnelInput,
  type StopTunnelInput,
  type StopTunnelRequest,
  type StopTunnelResult,
} from "./tunnel.service.ts";
import {
  sshHostKeyFingerprint,
  sshHostKeyType,
  TunnelConfigurationSchema,
  TunnelJournalSchema,
  TunnelProcessSchema,
  TunnelStartInputSchema,
  type TunnelConfiguration,
  type TunnelJournal,
  type TunnelLaunch,
  type TunnelProcess,
  type TunnelStartInput,
  type TunnelState,
  type TunnelStatusReport,
} from "./tunnel.types.ts";

const isEnoent = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const decode = Schema.decodeUnknownSync;
const stateFileName = "tunnel.json";
const configurationFileName = "tunnel-config.json";
const knownHostsFileName = "tunnel-known_hosts";
const logFileName = "tunnel.log";
const pollIntervalMilliseconds = 200;
const killGraceMilliseconds = 3_000;
/**
 * How long SSH may be forwarding while the Source behind it refuses before
 * readiness gives up. A Source that is starting answers well within this; one
 * that is not running never will, and waiting the full timeout only hides why.
 */
const sourceSilenceMilliseconds = 5_000;
const restartCommand = "canonfig tunnel start";
const invitationStartCommand =
  "canonfig tunnel start --invitation <path> --ssh-host <host> --ssh-user <user> --ssh-host-key-file <path>";
const hostKeyFailurePattern =
  /host key verification failed|remote host identification has changed|offending (?:ecdsa|ed25519|rsa) key/iu;

const bypassArguments: ReadonlyArray<{ readonly pattern: RegExp; readonly flag: string }> = [
  {
    pattern: /StrictHostKeyChecking\s*=\s*(?:no|off|false|accept-new)/iu,
    flag: "StrictHostKeyChecking",
  },
  {
    pattern: /UserKnownHostsFile\s*=\s*(?:\/dev\/null|none)/iu,
    flag: "UserKnownHostsFile",
  },
  {
    pattern: /NoHostAuthenticationForLocalhost\s*=\s*yes/iu,
    flag: "NoHostAuthenticationForLocalhost",
  },
  {
    pattern: /(?:^|\s)-(?:[A-Za-z]*[fF])\b/u,
    flag: "fork to background (-f)",
  },
  {
    pattern: /(?:^|\s)-(?:[A-Za-z]*[LRD])\b/u,
    flag: "extra forwarding (-L/-R/-D)",
  },
  {
    pattern: /(?:LocalForward|RemoteForward|DynamicForward)\s/iu,
    flag: "extra forwarding (Forward directive)",
  },
];

const rejectBypassArguments = (
  extra: ReadonlyArray<string>,
): Effect.Effect<void, TunnelHostKeyBypassError> =>
  Effect.gen(function*() {
    const combined = extra.join(" ");
    for (const { pattern, flag } of bypassArguments) {
      if (pattern.test(combined)) {
        return yield* new TunnelHostKeyBypassError({
          flag,
          message: `SSH argument ${flag} bypasses host-key verification or the approved forwarding and is rejected`,
        });
      }
    }
  });

const knownHostsEntry = (host: string, port: number, key: string): string => {
  const trimmed = key.trim().replace(/\s+$/u, "");
  return port === 22 ? `${host} ${trimmed}\n` : `[${host}]:${port} ${trimmed}\n`;
};

const localBind = (host: "127.0.0.1" | "::1"): string =>
  host === "::1" ? "[::1]" : host;

const tunnelEndpoint = (input: TunnelStartInput): string =>
  `https://${localBind(input.localHost) === "[::1]" ? "[::1]" : input.localHost}:${input.localPort}`;

const buildSshArguments = (
  input: TunnelStartInput,
  knownHostsPath: string,
  extra: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  "-N",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  `UserKnownHostsFile=${knownHostsPath}`,
  "-o",
  "ExitOnForwardFailure=yes",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=4",
  "-o",
  "ConnectTimeout=10",
  "-L",
  `${localBind(input.localHost)}:${input.localPort}:${localBind(input.remoteHost)}:${input.remotePort}`,
  "-p",
  String(input.sshPort),
  ...extra,
  `${input.sshUser}@${input.sshHost}`,
];

const processArgumentFingerprint = (argv: ReadonlyArray<string>): string =>
  createHash("sha256").update(argv.join("\0")).digest("hex");

const readProcessCommandLine = (
  executable: string,
  argv: ReadonlyArray<string>,
): Promise<string | undefined> =>
  new Promise((resolve) => {
    const child = spawn(executable, [...argv], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Array<Buffer> = [];
    let bytes = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 16 * 1024) {
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", () => resolve(undefined));
    child.once("close", (code) => {
      resolve(code === 0 ? Buffer.concat(chunks).toString("utf8") : undefined);
    });
  });

const ownsTunnelProcess = async (state: TunnelProcess): Promise<boolean> => {
  if (!isAlive(state.pid)) return false;
  if (process.platform === "linux") {
    try {
      const commandLine = await readFile(`/proc/${state.pid}/cmdline`);
      const argv = commandLine.toString("utf8").split("\0").filter(Boolean).slice(1);
      return processArgumentFingerprint(argv) === state.processArgumentFingerprint;
    } catch {
      return false;
    }
  }
  const commandLine = process.platform === "darwin"
    ? await readProcessCommandLine("/bin/ps", [
      "-p",
      String(state.pid),
      "-o",
      "command=",
    ])
    : process.platform === "win32"
    ? await readProcessCommandLine(
      `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${state.pid}').CommandLine`,
      ],
    )
    : undefined;
  if (commandLine === undefined) return false;
  const forward =
    `${localBind(state.local.host)}:${state.local.port}:${state.remote.host}:${state.remote.port}`;
  return commandLine.includes(state.knownHostsPath)
    && commandLine.includes(`${state.ssh.user}@${state.ssh.host}`)
    && commandLine.includes(forward);
};

const stateFilePath = (directory: string): string => join(directory, stateFileName);
const configurationFilePath = (directory: string): string =>
  join(directory, configurationFileName);

const readRecord = <Value>(
  path: string,
  schema: Schema.Decoder<Value>,
  what: string,
): Effect.Effect<Value | undefined, TunnelConfigurationError> =>
  Effect.tryPromise({
    try: async () => {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if (isEnoent(error)) return undefined;
        throw error;
      }
      return decode(schema)(JSON.parse(text));
    },
    catch: () =>
      new TunnelConfigurationError({
        operation: `read ${what}`,
        message: `the recorded ${what} at ${path} could not be read`,
      }),
  });

const writeRecord = (
  directory: string,
  fileName: string,
  value: TunnelJournal,
  what: string,
): Effect.Effect<void, TunnelConfigurationError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `.tunnel-${randomUUID()}.json.part`);
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(value, undefined, 2)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, join(directory, fileName));
        if (process.platform !== "win32") {
          const parent = await open(directory, "r");
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
        }
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    },
    catch: () =>
      new TunnelConfigurationError({
        operation: `record ${what}`,
        message: `the ${what} could not be recorded in ${directory}`,
      }),
  }).pipe(Effect.uninterruptible);

// Released 6.1 files are decoded only at this boundary. Once v2 is published,
// tunnel-config.json is obsolete and never consulted again.
const LegacyConfiguration = Schema.Struct({
  version: Schema.Literal(1),
  desired: Schema.Literals(["running", "stopped"]),
  recordedAt: Schema.NonEmptyString,
  ...TunnelConfigurationSchema.fields,
});
const LegacyProcess = Schema.Struct({
  version: Schema.Literal(1),
  ...TunnelProcessSchema.fields,
});

const processMatches = (state: TunnelProcess, config: TunnelConfiguration): boolean =>
  state.ssh.host === config.sshHost
  && state.ssh.port === config.sshPort
  && state.ssh.user === config.sshUser
  && state.ssh.hostKeyFingerprint === sshHostKeyFingerprint(config.sshHostKey)
  && state.local.host === config.localHost
  && state.local.port === config.localPort
  && state.remote.host === config.remoteHost
  && state.remote.port === config.remotePort
  && state.tlsFingerprint === config.tlsFingerprint
  && state.sourceFingerprint === config.sourceFingerprint;

const readLifecycle = (directory: string) => Effect.gen(function*() {
  const record = yield* readRecord(stateFilePath(directory), Schema.Unknown, "tunnel journal");
  if (Schema.is(TunnelJournalSchema)(record)) {
    return { state: record.state, convert: false };
  }
  const legacy = yield* readRecord(
    configurationFilePath(directory), LegacyConfiguration, "released tunnel configuration",
  );
  if (record === undefined && legacy === undefined) {
    return { state: { _tag: "Unconfigured" } satisfies TunnelState, convert: false };
  }
  const previous = Schema.is(LegacyProcess)(record) ? record : undefined;
  if (legacy === undefined || (record !== undefined && previous === undefined)
    || (previous !== undefined && !processMatches(previous, legacy))) {
    return yield* new TunnelConfigurationError({
      operation: "convert released tunnel state",
      message: `the tunnel records in ${directory} cannot be combined safely. Keep both files and the pinned known_hosts file; inspect the recorded PID and command line, stop only that verified SSH process, then move tunnel.json and tunnel-config.json aside and configure the tunnel again with an invitation. No process was stopped or forgotten.`,
    });
  }
  const config = decode(TunnelConfigurationSchema)(legacy);
  const state: TunnelState = previous === undefined
    ? legacy.desired === "stopped" ? { _tag: "Stopped", config } : { _tag: "Down", config }
    : legacy.desired === "stopped"
    ? { _tag: "Stopping", config, process: decode(TunnelProcessSchema)(previous) }
    : { _tag: "Running", config, process: decode(TunnelProcessSchema)(previous) };
  return { state, convert: true };
});

const processOf = (state: TunnelState): TunnelProcess | undefined => {
  switch (state._tag) {
    case "Starting": return state.ownedProcess;
    case "Running":
    case "Stopping":
    case "RecoveryRequired": return state.process;
    case "Down": return state.previous;
    case "Stopped":
    case "Unconfigured": return undefined;
  }
};

interface TunnelOwnership {
  process?: TunnelProcess;
  launch?: TunnelLaunch;
}

const ownershipOf = (state: TunnelState) => {
  const ownership: TunnelOwnership = {};
  const process = processOf(state);
  if (process !== undefined) ownership.process = process;
  if (state._tag === "Starting" || state._tag === "Stopping" || state._tag === "RecoveryRequired") {
    if (state.launch !== undefined) ownership.launch = state.launch;
  }
  return ownership;
};

type TunnelEvent =
  | { readonly _tag: "Start"; readonly config: TunnelConfiguration; readonly opId: string; readonly launch: TunnelLaunch }
  | { readonly _tag: "Own"; readonly process: TunnelProcess }
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Stop" }
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "Forget" }
  | { readonly _tag: "Down" }
  | { readonly _tag: "Failed"; readonly failedStep: string; readonly intent: "running" | "stopped" };

const nextTunnelState = (
  state: TunnelState, event: TunnelEvent,
): Effect.Effect<TunnelState, TunnelConfigurationError> => {
  switch (event._tag) {
    case "Start":
      if (state._tag === "Unconfigured" || state._tag === "Stopped" || state._tag === "Down") {
        return Effect.succeed({
          _tag: "Starting", config: event.config, opId: event.opId, launch: event.launch,
        });
      }
      break;
    case "Own":
      if (state._tag === "Starting" && state.ownedProcess === undefined) {
        return Effect.succeed({ ...state, ownedProcess: event.process });
      }
      break;
    case "Ready":
      if (state._tag === "Starting" && state.ownedProcess !== undefined) {
        return Effect.succeed({ _tag: "Running", config: state.config, process: state.ownedProcess });
      }
      break;
    case "Stop":
      if (state._tag !== "Unconfigured") {
        return Effect.succeed({
          _tag: "Stopping", config: state.config, ...ownershipOf(state),
        });
      }
      break;
    case "Stopped":
      if (state._tag === "Stopping") return Effect.succeed({ _tag: "Stopped", config: state.config });
      break;
    case "Forget":
      if (state._tag === "Stopped" || state._tag === "Unconfigured") {
        return Effect.succeed({ _tag: "Unconfigured" });
      }
      break;
    case "Down":
      if (state._tag === "Starting" || state._tag === "Stopping") {
        return Effect.succeed({ _tag: "Down", config: state.config });
      }
      break;
    case "Failed":
      if (state._tag === "Starting" || state._tag === "Stopping") {
        return Effect.succeed({
          _tag: "RecoveryRequired", config: state.config,
          intent: event.intent, failedStep: event.failedStep,
          ...ownershipOf(state),
        });
      }
      break;
  }
  return Effect.fail(new TunnelConfigurationError({
    operation: "transition tunnel",
    message: `cannot apply tunnel ${event._tag} while ${state._tag}; run \`canonfig tunnel status\` and finish recovery with \`canonfig tunnel stop\` before starting again`,
  }));
};

interface TunnelOwner {
  readonly current: () => TunnelState;
  readonly transition: (event: TunnelEvent) => Effect.Effect<void, TunnelError>;
}

/** The only lifecycle writer, held across all OS effects and compensation. */
const withTunnelState = <A>(
  directory: string, operation: string,
  run: (owner: TunnelOwner) => Effect.Effect<A, TunnelError>,
): Effect.Effect<A, TunnelError> => Effect.gen(function*() {
  yield* Effect.tryPromise({
    try: () => mkdir(directory, { recursive: true }),
    catch: () => new TunnelConfigurationError({ operation, message: `cannot create tunnel state directory ${directory}` }),
  });
  return yield* withRunLock(stateFilePath(directory), operation, Effect.gen(function*() {
    const loaded = yield* readLifecycle(directory);
    let state: TunnelState = loaded.state;
    const persist = () => writeRecord(directory, stateFileName, { version: 2, state }, "tunnel journal");
    const owner: TunnelOwner = {
      current: () => state,
      transition: (event) => Effect.gen(function*() {
        // Keep attempted ownership in memory if publication fails so compensation
        // still knows its PID. The preceding Starting journal retains launch pins.
        state = yield* nextTunnelState(state, event);
        yield* persist();
      }).pipe(Effect.uninterruptible),
    };
    if (loaded.convert) {
      yield* persist();
      yield* Effect.tryPromise({
        try: () => unlink(configurationFilePath(directory)).catch((cause: unknown) => {
          if (!isEnoent(cause)) throw cause;
        }),
        catch: () => new TunnelConfigurationError({
          operation: "retire released tunnel configuration",
          message: `tunnel.json is now authoritative; the obsolete ${configurationFilePath(directory)} could not be removed`,
        }),
      });
    }
    return yield* run(owner);
  })).pipe(Effect.mapError((error) =>
    error._tag === "RunLockHeldError" || error._tag === "MachineFilesystemError"
      ? new TunnelConfigurationError({
        operation,
        message: error._tag === "RunLockHeldError"
          ? `another tunnel operation holds ${error.path}; wait for it to finish before retrying`
          : error.message,
      })
      : error
  ));
});

const configurationOf = (input: TunnelStartInput): TunnelConfiguration => {
  const { stateDirectory: _stateDirectory, ...fields } = input;
  return fields;
};

const startInputOf = (
  configuration: TunnelConfiguration,
  stateDirectory: string,
  timeoutMilliseconds: number | undefined,
): TunnelStartInput => ({
  ...configuration, stateDirectory,
  timeoutMilliseconds: timeoutMilliseconds ?? configuration.timeoutMilliseconds,
});

const removePins = (launch: TunnelLaunch): Effect.Effect<void, TunnelConfigurationError> =>
  Effect.tryPromise({
    try: () => unlink(launch.knownHostsPath).catch((cause: unknown) => {
      if (!isEnoent(cause)) throw cause;
    }),
    catch: () => new TunnelConfigurationError({
      operation: "remove tunnel pins",
      message: `the pinned SSH host key at ${launch.knownHostsPath} could not be removed; tunnel ownership was retained`,
    }),
  });

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const terminateProcess = async (pid: number): Promise<void> => {
  if (!isAlive(pid)) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolveTermination, rejectTermination) => {
      const killer = spawn(
        `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`,
        ["/pid", String(pid), "/t", "/f"],
        { shell: false, stdio: "ignore", windowsHide: true },
      );
      const timer = setTimeout(() => rejectTermination(new Error("taskkill did not finish")), killGraceMilliseconds);
      killer.once("error", (cause) => { clearTimeout(timer); rejectTermination(cause); });
      killer.once("close", () => { clearTimeout(timer); resolveTermination(); });
    });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch (cause) {
      if (isAlive(pid)) throw cause;
      return;
    }
  }
  const deadline = Date.now() + killGraceMilliseconds;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise<void>((resolvePoll) => setTimeout(resolvePoll, 50));
  }
  if (!isAlive(pid)) return;
  if (process.platform !== "win32") {
    process.kill(pid, "SIGKILL");
    const forcedDeadline = Date.now() + killGraceMilliseconds;
    while (isAlive(pid) && Date.now() < forcedDeadline) {
      await new Promise<void>((resolvePoll) => setTimeout(resolvePoll, 50));
    }
  }
  if (isAlive(pid)) throw new Error(`tunnel process ${pid} still exists after termination`);
};

const readLogTail = async (logPath: string): Promise<string | undefined> => {
  try {
    const text = await readFile(logPath, "utf8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    return lines.slice(-3).join(" ").slice(0, 500) || undefined;
  } catch {
    return undefined;
  }
};

const tunnelUnitPrefix = (directory: string): string =>
  `canonfig-tunnel-${createHash("sha256").update(resolve(directory)).digest("hex")}-`;

const runSystemdCommand = (
  executable: string,
  argv: ReadonlyArray<string>,
): Promise<string> =>
  new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, [...argv], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectCommand(new Error("the systemd user manager did not answer within 10 seconds"));
    }, 10_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-16_384);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-16_384);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectCommand(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveCommand(stdout.trim());
      else rejectCommand(new Error(stderr.trim() || `systemd command exited with status ${code}`));
    });
  });

const systemctl = (): string => process.env.CANONFIG_SYSTEMCTL ?? "/usr/bin/systemctl";

const resolveSshExecutable = async (executable: string): Promise<string> => {
  if (isAbsolute(executable) || executable.includes("/")) return resolve(executable);
  for (const directory of (process.env.PATH ?? "/usr/bin:/bin").split(":")) {
    const candidate = resolve(directory, executable);
    try {
      await access(candidate, filesystemConstants.X_OK);
      return candidate;
    } catch {
      // Search the next PATH entry, as a direct spawn would.
    }
  }
  throw new Error(`SSH executable ${executable} was not found in PATH`);
};

const terminateTunnelProcess = async (
  state: TunnelProcess,
  directory: string,
): Promise<void> => {
  if (state.systemdUnit === undefined) return terminateProcess(state.pid);
  if (!state.systemdUnit.startsWith(tunnelUnitPrefix(directory))) {
    throw new Error("the recorded tunnel service does not belong to this state directory");
  }
  const properties = await runSystemdCommand(systemctl(), [
    "--user", "show", state.systemdUnit, "--property=MainPID,LoadState",
  ]);
  if (/^LoadState=not-found$/mu.test(properties)) return;
  const value = /^MainPID=(\d+)$/mu.exec(properties)?.[1];
  if (value === undefined) throw new Error("the tunnel service did not report its process identity");
  const pid = Number(value);
  if (pid !== 0 && pid !== state.pid) {
    throw new Error("the tunnel service no longer owns the recorded SSH process");
  }
  // Stop the whole dedicated cgroup, including any SSH subprocesses.
  await runSystemdCommand(systemctl(), ["--user", "stop", state.systemdUnit]);
};

const spawnSystemdTunnel = async (
  executable: string,
  argv: ReadonlyArray<string>,
  logPath: string,
  unit: string,
): Promise<number> => {
  const ssh = await resolveSshExecutable(executable);
  const environment = ["PATH", "SSH_AUTH_SOCK"].flatMap((name) =>
    process.env[name] === undefined ? [] : [`--setenv=${name}=${process.env[name]}`]
  );
  await runSystemdCommand(process.env.CANONFIG_SYSTEMD_RUN ?? "/usr/bin/systemd-run", [
    "--user", "--collect", "--service-type=exec", `--unit=${unit}`,
    "--property=KillMode=control-group",
    `--property=TimeoutStopSec=${killGraceMilliseconds}ms`,
    `--property=StandardOutput=append:${resolve(logPath)}`,
    `--property=StandardError=append:${resolve(logPath)}`,
    ...environment,
    // Transient service commands still expand $ variables at execution.
    "--", ssh, ...argv.map((argument) => argument.replaceAll("$", () => "$$")),
  ]);
  // The lifecycle owner retains this unit even if querying MainPID fails.
  const pid = Number(await runSystemdCommand(systemctl(), [
    "--user", "show", unit, "--property=MainPID", "--value",
  ]));
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("the managed SSH service exited before its process could be recorded");
  }
  return pid;
};

const spawnTunnelProcess = (
  executable: string,
  argv: ReadonlyArray<string>,
  logPath: string,
  systemdUnit: string | undefined,
): Effect.Effect<number, TunnelProcessError> =>
  Effect.tryPromise({
    try: async () => {
      if (systemdUnit !== undefined) {
        return spawnSystemdTunnel(executable, argv, logPath, systemdUnit);
      }
      const log = await open(logPath, "a");
      try {
        const child = await new Promise<ReturnType<typeof spawn>>((resolve, reject) => {
          const spawned = spawn(executable, [...argv], {
            detached: true,
            shell: false,
            stdio: ["ignore", log.fd, log.fd],
            windowsHide: true,
          });
          spawned.once("error", reject);
          spawned.once("spawn", () => {
            spawned.removeListener("error", reject);
            spawned.on("error", () => undefined);
            resolve(spawned);
          });
        });
        const pid = child.pid;
        child.unref();
        if (pid === undefined) throw new Error("SSH tunnel process has no pid");
        return pid;
      } finally {
        await log.close();
      }
    },
    catch: (cause) =>
      new TunnelProcessError({
        operation: "start tunnel process",
        message: cause instanceof Error
          ? `the SSH tunnel process could not be started: ${cause.message}`
          : "the SSH tunnel process could not be started",
      }),
  });

/**
 * Whether anything accepts TCP connections on the local end of the forward.
 * OpenSSH binds `-L` only after it has authenticated, so a listening forward
 * while the Source probe fails means SSH is up and the Source is not.
 */
const forwardListening = (host: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = netConnect({ host, port });
    const settle = (listening: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(2_000);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });

const sshTarget = (user: string, host: string): string => `${user}@${host}`;

const sourceNotAnsweringMessage = (
  target: string,
  remoteHost: string,
  remotePort: number,
): string =>
  `SSH to ${target} is connected, but the Source at ${remoteHost}:${remotePort} on that host is not answering through the tunnel. `
  + "Start the Source there first (`canonfig source serve`, or `canonfig source service install` to keep it running), "
  + `then run \`${restartCommand}\`.`;

interface TunnelReadiness {
  readonly observedTlsFingerprint: string;
  readonly sourceFingerprint: string | undefined;
}

const waitTunnelReady = (
  input: TunnelStartInput,
  pid: number,
  logPath: string,
  timeoutMilliseconds: number,
): Effect.Effect<TunnelReadiness, TunnelError> =>
  Effect.tryPromise({
    try: (signal) => {
      // The tsconfig lib predates Promise.withResolvers.
      let resolve!: (readiness: TunnelReadiness) => void;
      let reject!: (error: TunnelReadinessError) => void;
      const promise = new Promise<TunnelReadiness>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      const endpoint = tunnelEndpoint(input);
      const target = sshTarget(input.sshUser, input.sshHost);
      const deadline = Date.now() + timeoutMilliseconds;
      let forwardSeenAt: number | undefined;
      let timer: NodeJS.Timeout | undefined;
      let finished = false;
      const finish = (outcome: () => void): void => {
        if (finished) return;
        finished = true;
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        outcome();
      };
      const fail = (message: string): void =>
        finish(() => reject(new TunnelReadinessError({ endpoint, message })));
      const onAbort = (): void => fail("tunnel establishment was cancelled");
      // Tell the three ways a start can stall apart instead of waiting out the
      // whole timeout: SSH exited, SSH never opened the forward, or SSH
      // forwards but the Source behind it does not answer.
      const diagnose = async (): Promise<void> => {
        if (!isAlive(pid)) {
          const tail = await readLogTail(logPath);
          fail(
            `the SSH process for ${target} exited before the tunnel was ready`
              + (tail === undefined ? "" : `: ${tail}`),
          );
          return;
        }
        const listening = await forwardListening(input.localHost, input.localPort);
        if (finished) return;
        const now = Date.now();
        if (listening) forwardSeenAt ??= now;
        if (
          forwardSeenAt !== undefined
          && (now - forwardSeenAt >= Math.min(sourceSilenceMilliseconds, timeoutMilliseconds)
            || now >= deadline)
        ) {
          fail(sourceNotAnsweringMessage(target, input.remoteHost, input.remotePort));
          return;
        }
        if (now >= deadline) {
          const tail = await readLogTail(logPath);
          fail(
            `SSH to ${target} did not open the forward at ${endpoint} within ${timeoutMilliseconds} ms`
              + (tail === undefined ? "" : `: ${tail}`),
          );
          return;
        }
        timer = setTimeout(attempt, pollIntervalMilliseconds);
        timer.unref();
      };
      const attempt = (): void => {
        if (finished) return;
        Effect.runPromise(
          probeSourceDescriptor({
            endpoint,
            tlsFingerprint: input.tlsFingerprint,
            timeoutMilliseconds: Math.min(5_000, timeoutMilliseconds),
          }),
        ).then((probe) => {
          if (finished) return;
          if (!probe.tlsMatch || probe.sourceFingerprint !== input.sourceFingerprint) {
            fail(
              !probe.tlsMatch
                ? "the tunnel endpoint TLS certificate does not match the pinned Source identity"
                : "the Source signing identity does not match the pinned invitation identity",
            );
            return;
          }
          finish(() =>
            resolve({
              observedTlsFingerprint: probe.observedTlsFingerprint,
              sourceFingerprint: probe.sourceFingerprint,
            })
          );
        }, () => {
          if (finished) return;
          diagnose().catch(() => fail("the tunnel endpoint could not be probed"));
        });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      else attempt();
      return promise;
    },
    catch: (cause) =>
      cause instanceof TunnelReadinessError
        ? cause
        : new TunnelReadinessError({
          endpoint: tunnelEndpoint(input),
          message: "the tunnel endpoint could not be probed",
        }),
  });

/** A recorded configuration with no live process record: stopped on purpose, or down. */
const configuredStatus = (
  configuration: TunnelConfiguration,
  stopped = false,
): TunnelStatusReport => {
  const endpoint = tunnelEndpoint(startInputOf(configuration, ".", undefined));
  const identity = {
    sshHostKeyFingerprint: sshHostKeyFingerprint(configuration.sshHostKey),
    tlsPinnedFingerprint: configuration.tlsFingerprint,
    sourcePinnedFingerprint: configuration.sourceFingerprint,
  };
  const target = sshTarget(configuration.sshUser, configuration.sshHost);
  return {
    lifecycle: stopped ? "stopped" : "down",
    endpoint,
    identity,
    detail: stopped
      ? `the tunnel to ${target} was stopped with \`canonfig tunnel stop\`; run \`${restartCommand}\` to start it from the recorded configuration`
      : `the tunnel to ${target} is not running; run \`${restartCommand}\` to start it from the recorded configuration`,
    restartable: true,
    recovery: restartCommand,
  };
};

const statusOf = (
  state: TunnelProcess,
  reconnected: boolean,
): Effect.Effect<TunnelStatusReport, TunnelError> =>
  Effect.gen(function*() {
    const alive = isAlive(state.pid);
    const endpoint =
      `https://${state.local.host === "::1" ? "[::1]" : state.local.host}:${state.local.port}`;
    const target = sshTarget(state.ssh.user, state.ssh.host);
    const restartable = true;
    const recovery = restartCommand;
    const baseIdentity = {
      sshHostKeyFingerprint: state.ssh.hostKeyFingerprint,
      tlsPinnedFingerprint: state.tlsFingerprint,
      sourcePinnedFingerprint: state.sourceFingerprint,
    };
    if (!alive) {
      return {
        lifecycle: "down",
        pid: state.pid,
        startedAt: state.startedAt,
        endpoint,
        reconnected,
        identity: baseIdentity,
        detail: `the SSH tunnel process ${state.pid} for ${target} is not running; run \`${recovery}\``,
        restartable,
        recovery,
      } satisfies TunnelStatusReport;
    }
    const probe = yield* probeSourceDescriptor({
      endpoint,
      tlsFingerprint: state.tlsFingerprint,
      timeoutMilliseconds: 5_000,
    }).pipe(
      Effect.match({
        onFailure: () => undefined,
        onSuccess: (result) => result,
      }),
    );
    const sourceMatch = probe?.sourceFingerprint === state.sourceFingerprint;
    if (probe === undefined || !probe.tlsMatch || !sourceMatch) {
      const listening = probe === undefined
        && (yield* Effect.promise(() => forwardListening(state.local.host, state.local.port)));
      return {
        lifecycle: "down",
        pid: state.pid,
        startedAt: state.startedAt,
        endpoint,
        reconnected,
        identity: {
          ...baseIdentity,
          tlsObservedFingerprint: probe?.observedTlsFingerprint,
          tlsMatch: probe?.tlsMatch ?? false,
          sourceObservedFingerprint: probe?.sourceFingerprint,
          sourceMatch,
        },
        detail: probe === undefined
          ? listening
            ? sourceNotAnsweringMessage(target, state.remote.host, state.remote.port)
            : `the SSH tunnel process ${state.pid} for ${target} is running but its forward at ${endpoint} is not listening; run \`${recovery}\``
          : !probe.tlsMatch
          ? "tunnel endpoint TLS identity does not match the pinned Source"
          : "Source signing identity does not match the pinned invitation identity",
        restartable,
        recovery,
      } satisfies TunnelStatusReport;
    }
    return {
      lifecycle: "running",
      pid: state.pid,
      startedAt: state.startedAt,
      endpoint,
      reconnected,
      identity: {
        ...baseIdentity,
        tlsObservedFingerprint: probe.observedTlsFingerprint,
        tlsMatch: true,
        sourceObservedFingerprint: probe.sourceFingerprint,
        sourceMatch: true,
      },
      detail: `tunnel is forwarding ${endpoint} with independent SSH, TLS, and Source signing pins`,
      restartable,
    } satisfies TunnelStatusReport;
  });

const lifecycleStatus = (state: TunnelState): Effect.Effect<TunnelStatusReport, TunnelError> => {
  switch (state._tag) {
    case "Unconfigured":
      return Effect.succeed({
        lifecycle: "not-configured", identity: undefined,
        detail: "no tunnel has been configured", restartable: false,
      });
    case "Running": return statusOf(state.process, false);
    case "Stopped": return Effect.succeed(configuredStatus(state.config, true));
    case "Down": return Effect.succeed(configuredStatus(state.config));
    case "Starting":
    case "Stopping":
    case "RecoveryRequired": {
      const process = processOf(state);
      const stopped = state._tag === "Stopping"
        || (state._tag === "RecoveryRequired" && state.intent === "stopped");
      return Effect.succeed({
        ...configuredStatus(state.config, stopped),
        pid: process?.pid, startedAt: process?.startedAt,
        restartable: false,
        recovery: "canonfig tunnel stop",
        detail: state._tag === "RecoveryRequired"
          ? `tunnel recovery is required after ${state.failedStep}; process and pinned material were retained. Run \`canonfig tunnel stop\` to finish cleanup before starting again.`
          : `the tunnel is ${state._tag === "Starting" ? "starting" : "stopping"}; if its operation was interrupted, run \`canonfig tunnel stop\` to recover it before starting again`,
      });
    }
  }
};

/** Never discard process identity or pins until teardown has been confirmed. */
const teardown = (
  state: TunnelState, directory: string, newlySpawned = false,
): Effect.Effect<void, TunnelError> => Effect.gen(function*() {
  const process = processOf(state);
  const launch = state._tag === "Starting" || state._tag === "Stopping" || state._tag === "RecoveryRequired"
    ? state.launch ?? process : process;
  yield* Effect.tryPromise({
    try: async () => {
      if (process !== undefined) {
        if (isAlive(process.pid) && !newlySpawned && !(await ownsTunnelProcess(process))) {
          throw new Error(`PID ${process.pid} does not match the recorded SSH process; inspect it manually, do not signal it blindly`);
        }
        await terminateTunnelProcess(process, directory);
      } else if (launch?.systemdUnit !== undefined) {
        if (!launch.systemdUnit.startsWith(tunnelUnitPrefix(directory))) {
          throw new Error("the recorded service does not belong to this state directory");
        }
        await runSystemdCommand(systemctl(), ["--user", "stop", launch.systemdUnit]);
      } else if (state._tag === "Starting" || state._tag === "RecoveryRequired"
        || (state._tag === "Stopping" && launch !== undefined)) {
        // A crash between spawn and PID publication cannot prove that nothing
        // launched. The operation-specific known_hosts path identifies it.
        throw new Error(`an interrupted launch has no confirmed PID; inspect processes using ${launch?.knownHostsPath ?? directory}, stop the verified SSH process, then move tunnel.json aside before configuring again`);
      }
    },
    catch: (cause) => new TunnelProcessError({
      operation: "tear down tunnel",
      message: cause instanceof Error ? cause.message : "the tunnel could not be stopped",
    }),
  });
  if (launch !== undefined) yield* removePins(launch);
});

const failCleanup = (
  owner: TunnelOwner, intent: "running" | "stopped", cleanup: Effect.Effect<void, TunnelError>,
): Effect.Effect<void, TunnelError> => cleanup.pipe(
  Effect.catch((failure) => owner.transition({
    _tag: "Failed", intent, failedStep: failure.message,
  }).pipe(Effect.andThen(Effect.fail(failure)))),
);

const startOwned = (
  owner: TunnelOwner, input: TunnelStartInput,
): Effect.Effect<TunnelStatusReport, TunnelError> => Effect.uninterruptibleMask((restore) =>
  Effect.gen(function*() {
    const extra = input.sshArguments ?? [];
    yield* rejectBypassArguments(extra);
    const config = configurationOf(input);
    const existing = owner.current();
    if (existing._tag === "Starting" || existing._tag === "Stopping" || existing._tag === "RecoveryRequired") {
      return yield* new TunnelConfigurationError({
        operation: "start tunnel",
        message: `the recorded tunnel is ${existing._tag}; run \`canonfig tunnel stop\` to finish recovery before starting it`,
      });
    }
    if (existing._tag === "Running") {
      const report = yield* statusOf(existing.process, false);
      if (report.lifecycle === "running" && processMatches(existing.process, config)) return report;
      yield* owner.transition({ _tag: "Stop" });
      yield* failCleanup(owner, "stopped", teardown(owner.current(), input.stateDirectory));
      yield* owner.transition({ _tag: "Stopped" });
    } else if (existing._tag === "Down" && existing.previous !== undefined) {
      yield* owner.transition({ _tag: "Stop" });
      yield* failCleanup(owner, "stopped", teardown(owner.current(), input.stateDirectory));
      yield* owner.transition({ _tag: "Stopped" });
    }
    const opId = randomUUID();
    // A unique path leaves durable launch identity even if PID publication fails.
    const knownHostsPath = join(resolve(input.stateDirectory), `${knownHostsFileName}-${opId}`);
    const logPath = join(resolve(input.stateDirectory), logFileName);
    // setsid/detached cannot leave a systemd cgroup. Native jobs give SSH a
    // dedicated service whose identity is journaled before calling systemd-run.
    const systemdUnit = process.platform === "linux"
        && /^[a-f0-9]{32}$/u.test(process.env.INVOCATION_ID ?? "")
      ? `${tunnelUnitPrefix(input.stateDirectory)}${opId.replaceAll("-", "")}.service`
      : undefined;
    const argv = buildSshArguments(input, knownHostsPath, extra);
    const launchFields = {
      processArgumentFingerprint: processArgumentFingerprint(argv), knownHostsPath, logPath,
    };
    const launch: TunnelLaunch = systemdUnit === undefined ? launchFields : { ...launchFields, systemdUnit };
    yield* owner.transition({ _tag: "Start", config, opId, launch });
    yield* Effect.tryPromise({
      try: () => writeFile(knownHostsPath, knownHostsEntry(input.sshHost, input.sshPort, input.sshHostKey), { mode: 0o600 }),
      catch: () => new TunnelConfigurationError({
        operation: "pin SSH host key", message: "the pinned SSH host key could not be recorded; run `canonfig tunnel stop` before starting again",
      }),
    });
    const establish = Effect.gen(function*() {
      const pid = yield* spawnTunnelProcess(input.sshExecutable ?? "ssh", argv, logPath, systemdUnit);
      const process: TunnelProcess = {
        ...launch,
        ssh: {
          host: input.sshHost, port: input.sshPort, user: input.sshUser,
          hostKeyType: sshHostKeyType(input.sshHostKey),
          hostKeyFingerprint: sshHostKeyFingerprint(input.sshHostKey),
        },
        local: { host: input.localHost, port: input.localPort },
        remote: { host: input.remoteHost, port: input.remotePort },
        tlsFingerprint: input.tlsFingerprint, sourceFingerprint: input.sourceFingerprint,
        pid, startedAt: new Date().toISOString(),
      };
      // Spawn and ownership publication cannot be interrupted between them.
      yield* owner.transition({ _tag: "Own", process });
      yield* restore(waitTunnelReady(input, pid, logPath, input.timeoutMilliseconds ?? 30_000));
      const report = yield* restore(statusOf(process, existing._tag !== "Unconfigured"));
      if (report.lifecycle !== "running") {
        return yield* new TunnelReadinessError({
          endpoint: tunnelEndpoint(input),
          message: `the tunnel endpoint is not ready: ${report.detail}`,
        });
      }
      yield* owner.transition({ _tag: "Ready" });
      return report;
    }).pipe(
      Effect.catchTags({
        TunnelProcessError: (error) => classifyStartupFailure(error, input, logPath),
        TunnelReadinessError: (error) => classifyStartupFailure(error, input, logPath),
      }),
    );
    return yield* establish.pipe(Effect.catchCause((cause) => {
      // The same owner compensates both readiness failures and interruption.
      // A failed Ready publication may already be visible on disk.
      const state = owner.current();
      return Effect.gen(function*() {
        if (state._tag === "Running") yield* owner.transition({ _tag: "Stop" });
        yield* failCleanup(owner, "running", teardown(owner.current(), input.stateDirectory, true));
        yield* owner.transition({ _tag: "Down" });
        return yield* Effect.failCause(cause);
      });
    }));
  })
);

const classifyStartupFailure = (
  error: TunnelProcessError | TunnelReadinessError, input: TunnelStartInput, logPath: string,
) => Effect.promise(() => readLogTail(logPath)).pipe(
  Effect.flatMap((tail): Effect.Effect<never, TunnelProcessError | TunnelReadinessError | TunnelHostKeyError> =>
    tail !== undefined && hostKeyFailurePattern.test(tail)
      ? Effect.fail(new TunnelHostKeyError({
        host: input.sshHost,
        message: "the SSH host key is unknown or has changed; the connection was blocked",
      }))
      : Effect.fail(error)
  ),
);

const makeTunnel = Effect.sync(() => {
  const startTunnel = Effect.fn("Tunnel.startTunnel")(function*(
    rawInput: TunnelStartInput,
  ): Effect.fn.Return<TunnelStatusReport, TunnelError> {
    const input = yield* Schema.decodeUnknownEffect(TunnelStartInputSchema)(rawInput).pipe(
      Effect.mapError(() => new TunnelConfigurationError({
        operation: "start tunnel", message: "the tunnel configuration is invalid",
      })),
    );
    return yield* withTunnelState(input.stateDirectory, "start tunnel", (owner) => startOwned(owner, input));
  });

  const restartTunnel = Effect.fn("Tunnel.restartTunnel")(function*(
    input: RestartTunnelInput,
  ): Effect.fn.Return<TunnelStatusReport, TunnelError> {
    return yield* withTunnelState(input.stateDirectory, "restart tunnel", (owner) => Effect.gen(function*() {
      const state = owner.current();
      if (state._tag === "Unconfigured") {
        return yield* new TunnelConfigurationError({
          operation: "restart tunnel",
          message: `no tunnel configuration is recorded in ${input.stateDirectory}; run \`${invitationStartCommand}\` once to record one`,
        });
      }
      if (input.onlyIfDown && state._tag !== "Down" && state._tag !== "Running") {
        return yield* new TunnelConfigurationError({
          operation: "restart tunnel",
          message: `automatic recovery cannot restart a tunnel that is ${state._tag}; the operator's latest intent was retained`,
        });
      }
      return yield* startOwned(owner, startInputOf(state.config, input.stateDirectory, input.timeoutMilliseconds));
    }));
  });

  const tunnelStatus = Effect.fn("Tunnel.tunnelStatus")(function*(
    input: StopTunnelInput,
  ): Effect.fn.Return<TunnelStatusReport, TunnelError> {
    return yield* lifecycleStatus((yield* readLifecycle(input.stateDirectory)).state);
  });

  const stopTunnel = Effect.fn("Tunnel.stopTunnel")(function*(
    input: StopTunnelRequest,
  ): Effect.fn.Return<StopTunnelResult, TunnelError> {
    return yield* withTunnelState(input.stateDirectory, "stop tunnel", (owner) => Effect.uninterruptible(
      Effect.gen(function*() {
        const existing = owner.current();
        if (existing._tag === "Unconfigured") return { stopped: false, restartable: false };
        const process = processOf(existing);
        // Publish stopped intent before touching a process or deleting pins.
        // If publication fails, no OS mutation is attempted.
        yield* owner.transition({ _tag: "Stop" });
        yield* failCleanup(owner, "stopped", teardown(owner.current(), input.stateDirectory));
        yield* owner.transition({ _tag: "Stopped" });
        if (input.forget) yield* owner.transition({ _tag: "Forget" });
        return {
          stopped: process !== undefined,
          pid: process?.pid,
          restartable: !input.forget,
        };
      }),
    ));
  });

  return Tunnel.of({ startTunnel, restartTunnel, tunnelStatus, stopTunnel });
});

export const TunnelLive = Layer.effect(Tunnel, makeTunnel);
