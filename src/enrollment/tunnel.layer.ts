import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Effect, Layer, Schema } from "effect";

import { CertificateFingerprint } from "../domain/brand.ts";
import { probeSourceDescriptor } from "./follower-client.ts";
import {
  TunnelConfigurationError,
  TunnelHostKeyBypassError,
  TunnelHostKeyError,
  TunnelProcessError,
  TunnelReadinessError,
  type TunnelError,
} from "./tunnel.errors.ts";
import { Tunnel, type StopTunnelInput, type StopTunnelResult } from "./tunnel.service.ts";
import {
  sshHostKeyFingerprint,
  sshHostKeyType,
  TunnelStartInputSchema,
  TunnelStateFileSchema,
  type TunnelStartInput,
  type TunnelStateFile,
  type TunnelStatusReport,
} from "./tunnel.types.ts";

const isEnoent = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const decode = Schema.decodeUnknownSync;
const stateFileName = "tunnel.json";
const knownHostsFileName = "tunnel-known_hosts";
const logFileName = "tunnel.log";
const pollIntervalMilliseconds = 200;
const killGraceMilliseconds = 3_000;
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

const ownsTunnelProcess = async (state: TunnelStateFile): Promise<boolean> => {
  if (!isAlive(state.pid) || process.platform !== "linux") return false;
  try {
    const commandLine = await readFile(`/proc/${state.pid}/cmdline`);
    const argv = commandLine.toString("utf8").split("\0").filter(Boolean).slice(1);
    return processArgumentFingerprint(argv) === state.processArgumentFingerprint;
  } catch {
    return false;
  }
};

const stateFilePath = (directory: string): string => join(directory, stateFileName);

const readStateFile = (
  directory: string,
): Effect.Effect<TunnelStateFile | undefined, TunnelError> =>
  Effect.tryPromise({
    try: async () => {
      let text: string;
      try {
        text = await readFile(stateFilePath(directory), "utf8");
      } catch (error) {
        if (isEnoent(error)) return undefined;
        throw error;
      }
      return decode(TunnelStateFileSchema)(JSON.parse(text));
    },
    catch: () =>
      new TunnelConfigurationError({
        operation: "read tunnel state",
        message: "the recorded tunnel state could not be read",
      }),
  });

const writeStateFile = (
  directory: string,
  state: TunnelStateFile,
): Effect.Effect<void, TunnelError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `.tunnel-${randomUUID()}.json.part`);
      try {
        await writeFile(temporary, `${JSON.stringify(state, undefined, 2)}\n`, {
          mode: 0o600,
        });
        await rename(temporary, stateFilePath(directory));
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    },
    catch: () =>
      new TunnelConfigurationError({
        operation: "record tunnel state",
        message: "the tunnel state could not be recorded",
      }),
  }).pipe(Effect.uninterruptible);

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

const spawnTunnelProcess = (
  executable: string,
  argv: ReadonlyArray<string>,
  logPath: string,
): Effect.Effect<number, TunnelProcessError> =>
  Effect.tryPromise({
    try: async () => {
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

const waitTunnelReady = (
  input: TunnelStartInput,
  timeoutMilliseconds: number,
): Effect.Effect<
  { readonly observedTlsFingerprint: string; readonly sourceFingerprint: string | undefined },
  TunnelError
> =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<{
        readonly observedTlsFingerprint: string;
        readonly sourceFingerprint: string | undefined;
      }>((resolve, reject) => {
        const endpoint = tunnelEndpoint(input);
        const deadline = Date.now() + timeoutMilliseconds;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let finished = false;
        const finish = (outcome: () => void): void => {
          if (finished) return;
          finished = true;
          if (timer !== undefined) clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          outcome();
        };
        const onAbort = (): void => {
          finish(() =>
            reject(new TunnelReadinessError({
              endpoint,
              message: "tunnel establishment was cancelled",
            }))
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
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
              finish(() =>
                reject(new TunnelReadinessError({
                  endpoint,
                  message: !probe.tlsMatch
                    ? "the tunnel endpoint TLS certificate does not match the pinned Source identity"
                    : "the Source signing identity does not match the pinned invitation identity",
                }))
              );
              return;
            }
            finish(() =>
              resolve({
                observedTlsFingerprint: probe.observedTlsFingerprint,
                sourceFingerprint: probe.sourceFingerprint,
              })
            );
          }).catch(() => {
            if (finished) return;
            if (Date.now() >= deadline) {
              finish(() =>
                reject(new TunnelReadinessError({
                  endpoint,
                  message:
                    `the tunnel endpoint was not ready within ${timeoutMilliseconds} ms`,
                }))
              );
              return;
            }
            timer = setTimeout(attempt, pollIntervalMilliseconds);
            timer.unref?.();
          });
        };
        attempt();
      }),
    catch: (cause) =>
      cause instanceof TunnelReadinessError
        ? cause
        : new TunnelReadinessError({
          endpoint: tunnelEndpoint(input),
          message: "the tunnel endpoint could not be probed",
        }),
  });

const statusOf = (
  state: TunnelStateFile,
  reconnected: boolean,
): Effect.Effect<TunnelStatusReport, TunnelError> =>
  Effect.gen(function*() {
    const pidAlive = isAlive(state.pid);
    const owned = yield* Effect.promise(() => ownsTunnelProcess(state));
    const endpoint =
      `https://${state.local.host === "::1" ? "[::1]" : state.local.host}:${state.local.port}`;
    const baseIdentity = {
      sshHostKeyFingerprint: state.ssh.hostKeyFingerprint,
      tlsPinnedFingerprint: state.tlsFingerprint,
      sourcePinnedFingerprint: state.sourceFingerprint,
    };
    if (!owned) {
      return {
        lifecycle: "down",
        pid: state.pid,
        startedAt: state.startedAt,
        endpoint,
        reconnected,
        identity: baseIdentity,
        detail: pidAlive
          ? `process ${state.pid} does not match the recorded tunnel and was left untouched`
          : `tunnel process ${state.pid} is not running`,
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
          ? `tunnel process ${state.pid} is running but the endpoint is not reachable`
          : !probe.tlsMatch
          ? "tunnel endpoint TLS identity does not match the pinned Source"
          : "Source signing identity does not match the pinned invitation identity",
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
    } satisfies TunnelStatusReport;
  });

const makeTunnel = Effect.gen(function*() {
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
    const existing = yield* readStateFile(input.stateDirectory);
    if (existing !== undefined) {
      const current = yield* statusOf(existing, false);
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
      if (current.lifecycle === "running" && sameConfiguration) return current;
      if (yield* Effect.promise(() => ownsTunnelProcess(existing))) {
        yield* Effect.tryPromise({
          try: () => terminateProcess(existing.pid),
          catch: () =>
            new TunnelProcessError({
              operation: "reclaim tunnel",
              message: `the previous tunnel process ${existing.pid} could not be stopped`,
            }),
        });
      }
      yield* removeStateFiles(input.stateDirectory, existing);
    }
    const knownHostsPath = join(input.stateDirectory, knownHostsFileName);
    const logPath = join(input.stateDirectory, logFileName);
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
    let pid: number | undefined;
    let recorded = false;
    const cleanupUnrecorded = Effect.gen(function*() {
      if (recorded) return;
      const processId = pid;
      if (processId !== undefined) {
        yield* Effect.tryPromise({
          try: () => terminateProcess(processId),
          catch: () =>
            new TunnelProcessError({
              operation: "cancel tunnel start",
              message: "the starting tunnel process could not be stopped",
            }),
        }).pipe(Effect.ignore);
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
      pid = yield* spawnTunnelProcess(executable, argv, logPath);
      yield* waitTunnelReady(input, timeoutMilliseconds).pipe(
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
        pid,
        processArgumentFingerprint: processArgumentFingerprint(argv),
        startedAt: new Date().toISOString(),
        logPath,
        knownHostsPath,
      };
      yield* writeStateFile(input.stateDirectory, state);
      recorded = true;
      return state;
    }).pipe(Effect.ensuring(cleanupUnrecorded));
    const report = yield* statusOf(started, existing !== undefined);
    if (report.lifecycle !== "running") {
      const tail = yield* Effect.promise(() => readLogTail(logPath));
      return yield* new TunnelReadinessError({
        endpoint: tunnelEndpoint(input),
        message: tail === undefined
          ? "the tunnel started but the endpoint is not ready"
          : `the tunnel started but the endpoint is not ready: ${tail}`,
      });
    }
    return report;
  });

  const tunnelStatus = Effect.fn("Tunnel.tunnelStatus")(function*(
    input: StopTunnelInput,
  ) {
    const existing = yield* readStateFile(input.stateDirectory);
    if (existing === undefined) {
      return {
        lifecycle: "not-configured",
        identity: undefined,
        detail: "no tunnel has been configured",
      } satisfies TunnelStatusReport;
    }
    return yield* statusOf(existing, false);
  });

  const stopTunnel = Effect.fn("Tunnel.stopTunnel")(function*(
    input: StopTunnelInput,
  ): Effect.fn.Return<StopTunnelResult, TunnelError> {
    const existing = yield* readStateFile(input.stateDirectory);
    if (existing === undefined) return { stopped: false };
    const owned = yield* Effect.promise(() => ownsTunnelProcess(existing));
    if (owned) {
      yield* Effect.tryPromise({
        try: () => terminateProcess(existing.pid),
        catch: () =>
          new TunnelProcessError({
            operation: "stop tunnel",
            message: `tunnel process ${existing.pid} could not be stopped`,
          }),
      });
    }
    yield* removeStateFiles(input.stateDirectory, existing);
    return { stopped: owned || !isAlive(existing.pid), pid: existing.pid };
  });

  return Tunnel.of({ startTunnel, tunnelStatus, stopTunnel });
});

export const TunnelLive = Layer.effect(Tunnel, makeTunnel);
