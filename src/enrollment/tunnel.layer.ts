import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as filesystemConstants } from "node:fs";
import { access, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { isAbsolute, join, resolve } from "node:path";

import { Effect, Layer, Schema } from "effect";

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
  TunnelConfigurationFileSchema,
  TunnelStartInputSchema,
  TunnelStateFileSchema,
  type TunnelConfigurationFile,
  type TunnelStartInput,
  type TunnelStateFile,
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
  `${localBind(input.localHost)}:${input.localPort}:${input.remoteHost}:${input.remotePort}`,
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

const ownsTunnelProcess = async (state: TunnelStateFile): Promise<boolean> => {
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
  value: TunnelStateFile | TunnelConfigurationFile,
  what: string,
): Effect.Effect<void, TunnelConfigurationError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `.tunnel-${randomUUID()}.json.part`);
      try {
        await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, {
          mode: 0o600,
        });
        await rename(temporary, join(directory, fileName));
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

const readStateFile = (
  directory: string,
): Effect.Effect<TunnelStateFile | undefined, TunnelError> =>
  readRecord(stateFilePath(directory), TunnelStateFileSchema, "tunnel state");

const writeStateFile = (
  directory: string,
  state: TunnelStateFile,
): Effect.Effect<void, TunnelError> =>
  writeRecord(directory, stateFileName, state, "tunnel state");

const readConfigurationFile = (
  directory: string,
): Effect.Effect<TunnelConfigurationFile | undefined, TunnelError> =>
  readRecord(
    configurationFilePath(directory),
    TunnelConfigurationFileSchema,
    "tunnel configuration",
  );

const writeConfigurationFile = (
  directory: string,
  configuration: TunnelConfigurationFile,
): Effect.Effect<void, TunnelError> =>
  writeRecord(directory, configurationFileName, configuration, "tunnel configuration");

const removeConfigurationFile = (
  directory: string,
): Effect.Effect<void, TunnelConfigurationError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        await unlink(configurationFilePath(directory));
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
    },
    catch: () =>
      new TunnelConfigurationError({
        operation: "forget tunnel configuration",
        message: `the tunnel configuration at ${configurationFilePath(directory)} could not be removed`,
      }),
  }).pipe(Effect.uninterruptible);

const configurationOf = (
  input: TunnelStartInput,
  desired: TunnelConfigurationFile["desired"],
): TunnelConfigurationFile => {
  const { stateDirectory: _stateDirectory, ...fields } = input;
  return { version: 1, desired, recordedAt: new Date().toISOString(), ...fields };
};

const startInputOf = (
  configuration: TunnelConfigurationFile,
  stateDirectory: string,
  timeoutMilliseconds: number | undefined,
): TunnelStartInput => {
  const { version: _version, desired: _desired, recordedAt: _recordedAt, ...fields } =
    configuration;
  return {
    ...fields,
    stateDirectory,
    timeoutMilliseconds: timeoutMilliseconds ?? fields.timeoutMilliseconds,
  };
};

const removeStateFiles = (
  directory: string,
  state: TunnelStateFile,
): Effect.Effect<void, TunnelConfigurationError> =>
  Effect.tryPromise({
    try: async () => {
      for (const path of [stateFilePath(directory), state.knownHostsPath]) {
        try {
          await unlink(path);
        } catch (error) {
          if (!isEnoent(error)) throw error;
        }
      }
    },
    catch: () =>
      new TunnelConfigurationError({
        operation: "remove tunnel state",
        message: "the tunnel state could not be removed completely",
      }),
  }).pipe(Effect.uninterruptible);

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const terminateProcess = (pid: number): Promise<void> =>
  new Promise<void>((resolveTermination) => {
    if (!isAlive(pid)) {
      resolveTermination();
      return;
    }
    if (process.platform === "win32") {
      const killer = spawn(
        `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`,
        ["/pid", String(pid), "/t", "/f"],
        { shell: false, stdio: "ignore", windowsHide: true },
      );
      killer.once("error", () => resolveTermination());
      killer.once("close", () => resolveTermination());
      setTimeout(resolveTermination, killGraceMilliseconds).unref?.();
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      resolveTermination();
      return;
    }
    const deadline = Date.now() + killGraceMilliseconds;
    const poll = (): void => {
      if (!isAlive(pid) || Date.now() >= deadline) {
        if (isAlive(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
        resolveTermination();
        return;
      }
      setTimeout(poll, 100).unref?.();
    };
    poll();
  });

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
  state: TunnelStateFile,
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
  try {
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
    // Type=exec waits for execve, so MainPID is available when the launcher exits.
    const pid = Number(await runSystemdCommand(systemctl(), [
      "--user", "show", unit, "--property=MainPID", "--value",
    ]));
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error("the managed SSH service exited before its process could be recorded");
    }
    return pid;
  } catch (cause) {
    await runSystemdCommand(systemctl(), ["--user", "stop", unit]).catch(() => undefined);
    throw cause;
  }
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
  configuration: TunnelConfigurationFile,
): TunnelStatusReport => {
  const endpoint = tunnelEndpoint(startInputOf(configuration, ".", undefined));
  const identity = {
    sshHostKeyFingerprint: sshHostKeyFingerprint(configuration.sshHostKey),
    tlsPinnedFingerprint: configuration.tlsFingerprint,
    sourcePinnedFingerprint: configuration.sourceFingerprint,
  };
  const target = sshTarget(configuration.sshUser, configuration.sshHost);
  return {
    lifecycle: configuration.desired === "stopped" ? "stopped" : "down",
    endpoint,
    identity,
    detail: configuration.desired === "stopped"
      ? `the tunnel to ${target} was stopped with \`canonfig tunnel stop\`; run \`${restartCommand}\` to start it from the recorded configuration`
      : `the tunnel to ${target} is not running; run \`${restartCommand}\` to start it from the recorded configuration`,
    restartable: true,
    recovery: restartCommand,
  };
};

const statusOf = (
  state: TunnelStateFile,
  reconnected: boolean,
  configuration: TunnelConfigurationFile | undefined,
): Effect.Effect<TunnelStatusReport, TunnelError> =>
  Effect.gen(function*() {
    const alive = isAlive(state.pid);
    const endpoint =
      `https://${state.local.host === "::1" ? "[::1]" : state.local.host}:${state.local.port}`;
    const target = sshTarget(state.ssh.user, state.ssh.host);
    const restartable = configuration !== undefined;
    const recovery = restartable ? restartCommand : invitationStartCommand;
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

const makeTunnel = Effect.sync(() => {
  const startTunnel = Effect.fn("Tunnel.startTunnel")(function*(
    rawInput: TunnelStartInput,
  ): Effect.fn.Return<TunnelStatusReport, TunnelError> {
    const input = yield* Schema.decodeUnknownEffect(TunnelStartInputSchema)(rawInput).pipe(
      Effect.mapError(() =>
        new TunnelConfigurationError({
          operation: "start tunnel",
          message: "the tunnel configuration is invalid",
        })
      ),
    );
    const extra = input.sshArguments ?? [];
    yield* rejectBypassArguments(extra);
    const timeoutMilliseconds = input.timeoutMilliseconds ?? 30_000;
    const executable = input.sshExecutable ?? "ssh";
    const configuration = configurationOf(input, "running");
    const existing = yield* readStateFile(input.stateDirectory);
    if (existing !== undefined) {
      const current = yield* statusOf(existing, false, configuration);
      const sameConfiguration = existing.ssh.host === input.sshHost
        && existing.ssh.port === input.sshPort
        && existing.ssh.user === input.sshUser
        && existing.ssh.hostKeyFingerprint === sshHostKeyFingerprint(input.sshHostKey)
        && existing.local.host === input.localHost
        && existing.local.port === input.localPort
        && existing.remote.host === input.remoteHost
        && existing.remote.port === input.remotePort
        && existing.tlsFingerprint === input.tlsFingerprint
        && existing.sourceFingerprint === input.sourceFingerprint;
      if (current.lifecycle === "running" && sameConfiguration) {
        // A tunnel started before restart configurations were recorded
        // becomes restartable the first time it is confirmed here.
        yield* writeConfigurationFile(input.stateDirectory, configuration);
        return current;
      }
      if (
        (yield* Effect.promise(() => ownsTunnelProcess(existing)))
        || (existing.systemdUnit !== undefined && !isAlive(existing.pid))
      ) {
        yield* Effect.tryPromise({
          try: () => terminateTunnelProcess(existing, input.stateDirectory),
          catch: () =>
            new TunnelProcessError({
              operation: "reclaim tunnel",
              message: `the previous tunnel process ${existing.pid} could not be stopped`,
            }),
        });
      }
      yield* removeStateFiles(input.stateDirectory, existing);
    }
    const knownHostsPath = join(resolve(input.stateDirectory), knownHostsFileName);
    const logPath = join(resolve(input.stateDirectory), logFileName);
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(input.stateDirectory, { recursive: true });
        await writeFile(
          knownHostsPath,
          knownHostsEntry(input.sshHost, input.sshPort, input.sshHostKey),
          { mode: 0o600 },
        );
      },
      catch: () =>
        new TunnelConfigurationError({
          operation: "pin SSH host key",
          message: "the pinned SSH host key could not be recorded",
        }),
    });
    // setsid/detached does not leave a systemd cgroup. Native recovery must
    // give SSH its own user service, not a child of the sync oneshot.
    const systemdUnit = process.platform === "linux"
        && /^[a-f0-9]{32}$/u.test(process.env.INVOCATION_ID ?? "")
      ? `${tunnelUnitPrefix(input.stateDirectory)}${randomUUID().replaceAll("-", "")}.service`
      : undefined;
    let pid: number | undefined;
    let recorded = false;
    let startedState: TunnelStateFile | undefined;
    const cleanupUnrecorded = Effect.gen(function*() {
      if (recorded) return;
      const processId = pid;
      if (processId !== undefined) {
        yield* Effect.tryPromise({
          try: async () => {
            if (systemdUnit !== undefined) {
              await runSystemdCommand(systemctl(), ["--user", "stop", systemdUnit]);
            } else {
              await terminateProcess(processId);
            }
          },
          catch: () =>
            new TunnelProcessError({
              operation: "cancel tunnel start",
              message: "the starting tunnel process could not be stopped",
            }),
        }).pipe(Effect.ignore);
      }
      if (startedState !== undefined) {
        yield* removeStateFiles(input.stateDirectory, startedState).pipe(Effect.ignore);
      }
      yield* Effect.tryPromise({
        try: () => unlink(knownHostsPath).catch(() => undefined),
        catch: () =>
          new TunnelProcessError({
            operation: "cancel tunnel start",
            message: "temporary tunnel material could not be removed",
          }),
      }).pipe(Effect.ignore);
    });
    const started = yield* Effect.gen(function*() {
      const argv = buildSshArguments(input, knownHostsPath, extra);
      const processId = yield* spawnTunnelProcess(executable, argv, logPath, systemdUnit);
      pid = processId;
      yield* waitTunnelReady(input, processId, logPath, timeoutMilliseconds).pipe(
        Effect.catchTag("TunnelReadinessError", (error) =>
          Effect.promise(() => readLogTail(logPath)).pipe(
            Effect.flatMap((
              tail,
            ): Effect.Effect<never, TunnelReadinessError | TunnelHostKeyError> =>
              tail !== undefined && hostKeyFailurePattern.test(tail)
                ? Effect.fail(new TunnelHostKeyError({
                  host: input.sshHost,
                  message:
                    "the SSH host key is unknown or has changed; the connection was blocked",
                }))
                : Effect.fail(error)
            ),
          ))
      );
      const state: TunnelStateFile = {
        version: 1,
        ssh: {
          host: input.sshHost,
          port: input.sshPort,
          user: input.sshUser,
          hostKeyType: sshHostKeyType(input.sshHostKey),
          hostKeyFingerprint: sshHostKeyFingerprint(input.sshHostKey),
        },
        local: { host: input.localHost, port: input.localPort },
        remote: { host: input.remoteHost, port: input.remotePort },
        tlsFingerprint: input.tlsFingerprint,
        sourceFingerprint: input.sourceFingerprint,
        pid: processId,
        processArgumentFingerprint: processArgumentFingerprint(argv),
        systemdUnit,
        startedAt: new Date().toISOString(),
        logPath,
        knownHostsPath,
      };
      startedState = state;
      yield* writeStateFile(input.stateDirectory, state);
      // The durable restart record: `tunnel start` and a scheduled sync can
      // bring this tunnel back after its process dies or the machine reboots,
      // without the one-use invitation envelope.
      yield* writeConfigurationFile(input.stateDirectory, configuration);
      recorded = true;
      return state;
    }).pipe(Effect.ensuring(cleanupUnrecorded));
    const report = yield* statusOf(started, existing !== undefined, configuration);
    if (report.lifecycle !== "running") {
      const tail = yield* Effect.promise(() => readLogTail(logPath));
      return yield* new TunnelReadinessError({
        endpoint: tunnelEndpoint(input),
        message: tail === undefined
          ? `the tunnel started but the endpoint is not ready: ${report.detail}`
          : `the tunnel started but the endpoint is not ready: ${report.detail} (${tail})`,
      });
    }
    return report;
  });

  const restartTunnel = Effect.fn("Tunnel.restartTunnel")(function*(
    input: RestartTunnelInput,
  ): Effect.fn.Return<TunnelStatusReport, TunnelError> {
    const configuration = yield* readConfigurationFile(input.stateDirectory);
    if (configuration === undefined) {
      return yield* new TunnelConfigurationError({
        operation: "restart tunnel",
        message:
          `no tunnel configuration is recorded in ${input.stateDirectory}; run \`${invitationStartCommand}\` once to record one`,
      });
    }
    return yield* startTunnel(
      startInputOf(configuration, input.stateDirectory, input.timeoutMilliseconds),
    );
  });

  const tunnelStatus = Effect.fn("Tunnel.tunnelStatus")(function*(
    input: StopTunnelInput,
  ): Effect.fn.Return<TunnelStatusReport, TunnelError> {
    const [existing, configuration] = yield* Effect.all([
      readStateFile(input.stateDirectory),
      readConfigurationFile(input.stateDirectory),
    ]);
    if (existing === undefined) {
      return configuration === undefined
        ? {
          lifecycle: "not-configured",
          identity: undefined,
          detail: "no tunnel has been configured",
          restartable: false,
        }
        : configuredStatus(configuration);
    }
    return yield* statusOf(existing, false, configuration);
  });

  const stopTunnel = Effect.fn("Tunnel.stopTunnel")(function*(
    input: StopTunnelRequest,
  ): Effect.fn.Return<StopTunnelResult, TunnelError> {
    const [existing, configuration] = yield* Effect.all([
      readStateFile(input.stateDirectory),
      readConfigurationFile(input.stateDirectory),
    ]);
    let owned = false;
    if (existing !== undefined) {
      owned = yield* Effect.promise(() => ownsTunnelProcess(existing));
      if (owned || (existing.systemdUnit !== undefined && !isAlive(existing.pid))) {
        yield* Effect.tryPromise({
          try: () => terminateTunnelProcess(existing, input.stateDirectory),
          catch: () =>
            new TunnelProcessError({
              operation: "stop tunnel",
              message: `tunnel process ${existing.pid} could not be stopped`,
            }),
        });
      }
      yield* removeStateFiles(input.stateDirectory, existing);
    }
    if (input.forget === true) {
      yield* removeConfigurationFile(input.stateDirectory);
    } else if (configuration !== undefined && configuration.desired !== "stopped") {
      // Recorded so neither a scheduled sync nor doctor treats a deliberate
      // stop as an outage to repair.
      yield* writeConfigurationFile(input.stateDirectory, {
        ...configuration,
        desired: "stopped",
      });
    }
    const restartable = input.forget !== true && configuration !== undefined;
    return existing === undefined
      ? { stopped: false, restartable }
      : { stopped: owned || !isAlive(existing.pid), pid: existing.pid, restartable };
  });

  return Tunnel.of({ startTunnel, restartTunnel, tunnelStatus, stopTunnel });
});

export const TunnelLive = Layer.effect(Tunnel, makeTunnel);
