import { spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer, type Server } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Effect, Schema } from "effect";
import { generate } from "selfsigned";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CliCommandFailure } from "../../src/cli/source-commands.ts";
import {
  CertificateFingerprint,
  GroupName,
  InvitationCode,
  Timestamp,
} from "../../src/domain/brand.ts";
import {
  consumeInvitationEnvelope,
  deliverInvitationEnvelope,
  readInvitationEnvelope,
} from "../../src/enrollment/invitation-envelope.ts";
import { invitationEnvelopeEof } from "../../src/enrollment/invitation-envelope-format.ts";
import { withManagedTunnel } from "../../src/enrollment/tunnel-supervision.ts";
import { TunnelLive } from "../../src/enrollment/tunnel.layer.ts";
import { Tunnel } from "../../src/enrollment/tunnel.service.ts";
import type { EnrollmentInvitationGrant } from
  "../../src/enrollment/enrollment.types.ts";
import {
  TunnelJournalSchema,
  sshHostKeyFingerprint,
  type TunnelProcess,
  type TunnelStartInput,
} from "../../src/enrollment/tunnel.types.ts";

const decode = Schema.decodeUnknownSync;
const decodeTunnelJournal = decode(Schema.fromJsonString(TunnelJournalSchema));
const roots: Array<string> = [];
const cleanups: Array<() => Promise<void> | void> = [];
const fingerprint = decode(CertificateFingerprint)("a".repeat(64));
const sourceFingerprint = decode(CertificateFingerprint)("b".repeat(64));
const hostKey = `ssh-ed25519 ${Buffer.alloc(32, 1).toString("base64")}`;

const grant: EnrollmentInvitationGrant = {
  code: decode(InvitationCode)("invitation-code"),
  nonce: "invitation-nonce",
  endpoint: "https://127.0.0.1:17342",
  sourceFingerprint,
  tlsFingerprint: fingerprint,
  groups: [decode(GroupName)("developers")],
  expiresAt: decode(Timestamp)("2026-09-12T15:00:00.000Z"),
};

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "canonfig-tunnel-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

const freePort = (): Promise<number> =>
  new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address !== null && !Schema.is(Schema.String)(address) ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });

/**
 * A stand-in for OpenSSH that does what the tunnel relies on: it parses the
 * approved `-L bind:port:host:port`, listens on the local end, and forwards
 * each connection to the remote end, exactly like an authenticated `ssh -N`.
 */
const fakeSsh = async (root: string): Promise<string> => {
  const path = join(root, "fake-ssh");
  await writeFile(
    path,
    `#!${process.execPath}
const net = require("node:net");
require("node:fs").writeFileSync(${JSON.stringify(join(root, "ssh.pid"))}, String(process.pid));
const args = process.argv.slice(2);
const [bind, localPort, remoteHost, remotePort] = args[args.indexOf("-L") + 1].split(":");
const server = net.createServer((client) => {
  const upstream = net.connect(Number(remotePort), remoteHost);
  client.pipe(upstream).pipe(client);
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});
server.listen(Number(localPort), bind);
process.on("SIGTERM", () => process.exit(0));
`,
  );
  await chmod(path, 0o700);
  return path;
};

/** A loopback Source that answers the unauthenticated descriptor probe. */
const fakeSource = async (gate: Promise<void> = Promise.resolve()): Promise<{
  readonly port: number;
  readonly tlsFingerprint: typeof CertificateFingerprint.Type;
}> => {
  const certificate = await generate([{ name: "commonName", value: "loopback-test" }], {
    keyType: "ec",
    curve: "P-256",
    extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }],
  });
  const tlsFingerprint = decode(CertificateFingerprint)(
    createHash("sha256").update(new X509Certificate(certificate.cert).raw).digest("hex"),
  );
  const server: Server = createHttpsServer(
    { key: certificate.private, cert: certificate.cert },
    (request, response) => {
      request.resume();
      void gate.then(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          source: { keyId: "source-key", publicKeyFingerprint: sourceFingerprint },
          tlsFingerprint,
        }));
      });
    },
  );
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  cleanups.push(() => new Promise<void>((resolveClose) => {
    server.closeAllConnections();
    server.close(() => resolveClose());
  }));
  const address = server.address();
  return {
    port: address !== null && !Schema.is(Schema.String)(address) ? address.port : 0,
    tlsFingerprint,
  };
};

const recordedProcess = async (root: string): Promise<TunnelProcess> => {
  const { state } = decodeTunnelJournal(await readFile(join(root, "tunnel.json"), "utf8"));
  const process = state._tag === "Starting" ? state.ownedProcess
    : state._tag === "Running" || state._tag === "Stopping" || state._tag === "RecoveryRequired"
    ? state.process : state._tag === "Down" ? state.previous : undefined;
  if (process === undefined) throw new Error("the test tunnel has no recorded process");
  return process;
};

/** Kill the recorded SSH process, as a network drop or a reboot would. */
const killRecordedTunnel = async (root: string): Promise<number> => {
  const state = await recordedProcess(root);
  process.kill(state.pid, "SIGKILL");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(state.pid, 0);
    } catch {
      return state.pid;
    }
    await delay(10);
  }
  throw new Error(`disposable tunnel ${state.pid} did not exit`);
};

const runTunnel = <Success, Failure>(
  program: Effect.Effect<Success, Failure, Tunnel>,
): Promise<Success> => Effect.runPromise(program.pipe(Effect.provide(TunnelLive)));

/** Start a real managed tunnel (fake ssh) in front of `remotePort`. */
const startManagedTunnel = async (
  root: string,
  remotePort: number,
  tlsFingerprint: typeof CertificateFingerprint.Type,
): Promise<TunnelStartInput> => {
  const input: TunnelStartInput = {
    sshHost: "source.example",
    sshPort: 22,
    sshUser: "operator",
    sshHostKey: hostKey,
    localHost: "127.0.0.1",
    localPort: await freePort(),
    remoteHost: "127.0.0.1",
    remotePort,
    tlsFingerprint,
    sourceFingerprint,
    stateDirectory: root,
    sshExecutable: await fakeSsh(root),
    timeoutMilliseconds: 20_000,
  };
  cleanups.push(async () => {
    try {
      const pid = Number(await readFile(join(root, "ssh.pid"), "utf8"));
      process.kill(pid, "SIGKILL");
    } catch {
      // No live recorded tunnel.
    }
  });
  return input;
};

describe("managed enrollment tunnel", () => {
  it("delivers one bounded private envelope with explicit EOF and consumes it", async () => {
    const root = await temporaryRoot();
    const path = join(root, "invite.txt");

    await Effect.runPromise(deliverInvitationEnvelope({ grant, path, timeoutMilliseconds: 1_000 }));
    expect(await readFile(path, "utf8")).toMatch(
      new RegExp(`^[A-Za-z0-9_-]+\\n${invitationEnvelopeEof}\\n$`, "u"),
    );
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(await Effect.runPromise(readInvitationEnvelope({ path }))).toEqual(grant);
    expect(await Effect.runPromise(consumeInvitationEnvelope({ path }))).toEqual(grant);
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects host-key bypass flags before starting a process", async () => {
    const root = await temporaryRoot();
    const error = await Effect.runPromise(Effect.flip(
      Effect.flatMap(Tunnel, (tunnel) => tunnel.startTunnel({
        sshHost: "source.example",
        sshPort: 22,
        sshUser: "operator",
        sshHostKey: `ssh-ed25519 ${Buffer.alloc(32, 1).toString("base64")}`,
        localHost: "127.0.0.1",
        localPort: 17342,
        remoteHost: "127.0.0.1",
        remotePort: 17342,
        tlsFingerprint: fingerprint,
        sourceFingerprint,
        stateDirectory: root,
        sshArguments: ["-o", "StrictHostKeyChecking=no"],
      })).pipe(Effect.provide(TunnelLive)),
    ));

    expect(error._tag).toBe("TunnelHostKeyBypassError");
  });

  it.skipIf(process.platform === "win32").each(["source.example", "2001:db8::1234"])(
    "classifies an unknown or changed SSH host key for %s as an identity failure",
    async (sshHost) => {
      const root = await temporaryRoot();
      const executable = join(root, "fake-ssh");
      await writeFile(executable, "#!/bin/sh\necho 'Host key verification failed' >&2\nexit 255\n");
      await chmod(executable, 0o700);

      const error = await Effect.runPromise(Effect.flip(
        Effect.flatMap(Tunnel, (tunnel) => tunnel.startTunnel({
          sshHost,
          sshPort: 22,
          sshUser: "operator",
          sshHostKey: `ssh-ed25519 ${Buffer.alloc(32, 1).toString("base64")}`,
          localHost: "127.0.0.1",
          localPort: 17342,
          remoteHost: "127.0.0.1",
          remotePort: 17342,
          tlsFingerprint: fingerprint,
          sourceFingerprint,
          stateDirectory: root,
          sshExecutable: executable,
          timeoutMilliseconds: 1_000,
        })).pipe(Effect.provide(TunnelLive)),
      ));

      expect(error._tag).toBe("TunnelHostKeyError");
    },
  );

  it("never signals a reused PID that does not match the recorded tunnel", async () => {
    const root = await temporaryRoot();
    const knownHostsPath = join(root, "tunnel-known_hosts");
    await writeFile(knownHostsPath, "pinned\n", { mode: 0o600 });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    cleanups.push(() => { child.kill("SIGKILL"); });
    const pid = child.pid;
    if (pid === undefined) throw new Error("disposable child has no PID");
    const state: TunnelProcess = {
      ssh: {
        host: "source.example",
        port: 22,
        user: "operator",
        hostKeyType: "ssh-ed25519",
        hostKeyFingerprint: sshHostKeyFingerprint(hostKey),
      },
      local: { host: "127.0.0.1", port: 17342 },
      remote: { host: "127.0.0.1", port: 17342 },
      tlsFingerprint: fingerprint,
      sourceFingerprint,
      pid,
      processArgumentFingerprint: "not-the-current-process",
      startedAt: new Date().toISOString(),
      logPath: join(root, "tunnel.log"),
      knownHostsPath,
    };
    await writeFile(join(root, "tunnel.json"), JSON.stringify({
      version: 2,
      state: {
        _tag: "Running",
        config: {
          sshHost: "source.example", sshPort: 22, sshUser: "operator", sshHostKey: hostKey,
          localHost: "127.0.0.1", localPort: 17342, remoteHost: "127.0.0.1", remotePort: 17342,
          tlsFingerprint: fingerprint, sourceFingerprint,
        },
        process: state,
      },
    }), { mode: 0o600 });

    const failure = await runTunnel(Effect.flip(
      Effect.flatMap(Tunnel, (tunnel) => tunnel.stopTunnel({ stateDirectory: root })),
    ));
    expect(failure._tag).toBe("TunnelProcessError");
    expect((decodeTunnelJournal(await readFile(join(root, "tunnel.json"), "utf8"))).state)
      .toMatchObject({ _tag: "RecoveryRequired", intent: "stopped", process: { pid } });
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(await readFile(knownHostsPath, "utf8")).toBe("pinned\n");
  });

  describe.skipIf(process.platform === "win32")("lifecycle without the invitation", () => {
    it("refuses a concurrent stop while start owns the lifecycle journal", async () => {
      const root = await temporaryRoot();
      const { promise: gate, resolve: release } = Promise.withResolvers<void>();
      const source = await fakeSource(gate);
      const input = await startManagedTunnel(root, source.port, source.tlsFingerprint);
      const starting = runTunnel(Effect.flatMap(Tunnel, (tunnel) => tunnel.startTunnel(input)));
      try {
        const deadline = Date.now() + 5_000;
        for (;;) {
          try { await access(join(root, "ssh.pid")); break; }
          catch { if (Date.now() >= deadline) throw new Error("disposable start did not record ownership"); }
          await delay(10);
        }
        const failure = await runTunnel(Effect.flip(
          Effect.flatMap(Tunnel, (tunnel) => tunnel.stopTunnel({ stateDirectory: root })),
        ));
        expect(failure).toMatchObject({
          _tag: "TunnelConfigurationError", message: expect.stringContaining("another tunnel operation"),
        });
      } finally { release(); await starting; }
    });

    it("rechecks stopped intent before a stale unattended restart", async () => {
      const root = await temporaryRoot();
      const source = await fakeSource();
      const input = await startManagedTunnel(root, source.port, source.tlsFingerprint);
      await runTunnel(Effect.flatMap(Tunnel, (tunnel) => tunnel.startTunnel(input)));
      await killRecordedTunnel(root);
      await runTunnel(Effect.flatMap(Tunnel, (tunnel) => tunnel.stopTunnel({ stateDirectory: root })));
      const failure = await runTunnel(Effect.flip(
        Effect.flatMap(Tunnel, (tunnel) => tunnel.restartTunnel({ stateDirectory: root, onlyIfDown: true })),
      ));
      expect(failure.message).toContain("operator's latest intent");
      expect(await runTunnel(Effect.flatMap(Tunnel, (tunnel) => tunnel.tunnelStatus({ stateDirectory: root }))))
        .toMatchObject({ lifecycle: "stopped" });
    });

    it("restarts a dead tunnel from its recorded configuration, with no invitation (CF-55)", async () => {
      const root = await temporaryRoot();
      const source = await fakeSource();
      const input = await startManagedTunnel(root, source.port, source.tlsFingerprint);

      const first = await runTunnel(Effect.flatMap(Tunnel, (tunnel) => tunnel.startTunnel(input)));
      expect(first.lifecycle).toBe("running");
      const deadPid = await killRecordedTunnel(root);

      const down = await runTunnel(
        Effect.flatMap(Tunnel, (tunnel) => tunnel.tunnelStatus({ stateDirectory: root })),
      );
      expect(down).toMatchObject({
        lifecycle: "down",
        restartable: true,
        recovery: "canonfig tunnel start",
      });

      // Only the state directory: no envelope, host key file, or SSH options.
      const restarted = await runTunnel(
        Effect.flatMap(Tunnel, (tunnel) => tunnel.restartTunnel({ stateDirectory: root })),
      );
      expect(restarted).toMatchObject({ lifecycle: "running", reconnected: true });
      expect(restarted.pid).not.toBe(deadPid);
      expect(restarted.identity).toMatchObject({ tlsMatch: true, sourceMatch: true });
    });

    it("keeps stopped intent when teardown cannot remove pinned material", async () => {
      const root = await temporaryRoot();
      const source = await fakeSource();
      const input = await startManagedTunnel(root, source.port, source.tlsFingerprint);
      await runTunnel(Effect.flatMap(Tunnel, (tunnel) => tunnel.startTunnel(input)));
      await killRecordedTunnel(root);
      const pins = (await recordedProcess(root)).knownHostsPath;
      await rm(pins);
      await mkdir(pins);

      const failure = await runTunnel(Effect.flip(
        Effect.flatMap(Tunnel, (tunnel) => tunnel.stopTunnel({ stateDirectory: root })),
      ));
      expect(failure._tag).toBe("TunnelConfigurationError");
      expect(await runTunnel(
        Effect.flatMap(Tunnel, (tunnel) => tunnel.tunnelStatus({ stateDirectory: root })),
      )).toMatchObject({ lifecycle: "stopped", restartable: false });
      expect((decodeTunnelJournal(await readFile(join(root, "tunnel.json"), "utf8"))).state)
        .toMatchObject({ _tag: "RecoveryRequired", intent: "stopped", process: { knownHostsPath: pins } });
      await rm(pins, { recursive: true });
      await runTunnel(Effect.flatMap(Tunnel, (tunnel) => tunnel.stopTunnel({ stateDirectory: root })));
      expect(await runTunnel(
        Effect.flatMap(Tunnel, (tunnel) => tunnel.tunnelStatus({ stateDirectory: root })),
      )).toMatchObject({ lifecycle: "stopped", restartable: true });
    });

    it("does not spawn when the canonical journal cannot be read or published", async () => {
      const root = await temporaryRoot();
      const source = await fakeSource();
      const input = await startManagedTunnel(root, source.port, source.tlsFingerprint);
      await mkdir(join(root, "tunnel.json"));

      const error = await runTunnel(Effect.flip(
        Effect.flatMap(Tunnel, (tunnel) => tunnel.startTunnel(input)),
      ));
      expect(error._tag).toBe("TunnelConfigurationError");
      await expect(access(join(root, "ssh.pid"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.skipIf(process.platform !== "linux")("never detaches a route when native service ownership fails", async () => {
      const root = await temporaryRoot();
      const source = await fakeSource();
      const input = await startManagedTunnel(root, source.port, source.tlsFingerprint);
      vi.stubEnv("INVOCATION_ID", "a".repeat(32));
      vi.stubEnv("CANONFIG_SYSTEMD_RUN", join(root, "missing-systemd-run"));
      vi.stubEnv("CANONFIG_SYSTEMCTL", "/bin/true");

      const error = await runTunnel(Effect.flip(
        Effect.flatMap(Tunnel, (tunnel) => tunnel.startTunnel(input)),
      ));
      expect(error._tag).toBe("TunnelProcessError");
      await expect(access(join(root, "ssh.pid"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((decodeTunnelJournal(await readFile(join(root, "tunnel.json"), "utf8"))).state)
        .toMatchObject({ _tag: "Down" });
    });

    it("keeps a stopped tunnel restartable but reports it as stopped", async () => {
      const root = await temporaryRoot();
      const source = await fakeSource();
      const input = await startManagedTunnel(root, source.port, source.tlsFingerprint);
      await runTunnel(Effect.flatMap(Tunnel, (tunnel) => tunnel.startTunnel(input)));

      // The fake ssh runs under node, so its argv never matches the recorded
      // ssh argv and stop would (correctly) refuse to signal it: end it here.
      await killRecordedTunnel(root);
      const stopped = await runTunnel(
        Effect.flatMap(Tunnel, (tunnel) => tunnel.stopTunnel({ stateDirectory: root })),
      );
      expect(stopped.restartable).toBe(true);
      expect(await runTunnel(
        Effect.flatMap(Tunnel, (tunnel) => tunnel.tunnelStatus({ stateDirectory: root })),
      )).toMatchObject({ lifecycle: "stopped", recovery: "canonfig tunnel start" });

      expect(await runTunnel(
        Effect.flatMap(Tunnel, (tunnel) => tunnel.restartTunnel({ stateDirectory: root })),
      )).toMatchObject({ lifecycle: "running" });

      await killRecordedTunnel(root);
      await runTunnel(Effect.flatMap(Tunnel, (tunnel) =>
        tunnel.stopTunnel({ stateDirectory: root, forget: true })
      ));
      const forgotten = await Effect.runPromise(Effect.flip(
        Effect.flatMap(Tunnel, (tunnel) => tunnel.restartTunnel({ stateDirectory: root })).pipe(
          Effect.provide(TunnelLive),
        ),
      ));
      expect(forgotten._tag).toBe("TunnelConfigurationError");
      expect(forgotten.message).toContain("--invitation");
    });

    it("says SSH is up but the Source is not answering, without waiting out the timeout (CF-57)", async () => {
      const root = await temporaryRoot();
      const input = await startManagedTunnel(root, await freePort(), fingerprint);
      const started = Date.now();

      const error = await Effect.runPromise(Effect.flip(
        Effect.flatMap(Tunnel, (tunnel) => tunnel.startTunnel(input)).pipe(
          Effect.provide(TunnelLive),
        ),
      ));

      expect(error._tag).toBe("TunnelReadinessError");
      expect(error.message).toMatch(
        /SSH to operator@source\.example is connected, but the Source at 127\.0\.0\.1:\d+ on that host is not answering/u,
      );
      expect(error.message).toContain("canonfig source service install");
      expect(Date.now() - started).toBeLessThan(15_000);
    });

    it("reports Source transport failures behind a down tunnel as the tunnel outage (CF-54)", async () => {
      const root = await temporaryRoot();
      const source = await fakeSource();
      const input = await startManagedTunnel(root, source.port, source.tlsFingerprint);
      const running = await runTunnel(Effect.flatMap(Tunnel, (tunnel) => tunnel.startTunnel(input)));
      await killRecordedTunnel(root);
      const transportFailure = new CliCommandFailure({
        category: "transport",
        message: "the source TLS certificate could not be inspected",
      });
      const guard = (restart: boolean, operation: Effect.Effect<string, CliCommandFailure>) =>
        withManagedTunnel(
          { stateDirectory: root, sourceEndpoint: running.endpoint, restart },
          (failure: CliCommandFailure) => failure.category === "transport",
          operation,
        );

      const reported = await runTunnel(Effect.flip(guard(false, Effect.fail(transportFailure))));
      expect(reported._tag).toBe("TunnelDownError");
      expect(reported.message).toContain("managed tunnel");
      expect(reported.message).toContain("canonfig tunnel start");

      // An unattended run restarts the tunnel once, then reaches the Source.
      expect(await runTunnel(guard(true, Effect.succeed("synchronized")))).toBe("synchronized");
      expect(await runTunnel(
        Effect.flatMap(Tunnel, (tunnel) => tunnel.tunnelStatus({ stateDirectory: root })),
      )).toMatchObject({ lifecycle: "running" });

      // A deliberate stop is never undone by an unattended run.
      await killRecordedTunnel(root);
      await runTunnel(Effect.flatMap(Tunnel, (tunnel) => tunnel.stopTunnel({ stateDirectory: root })));
      const stopped = await runTunnel(Effect.flip(guard(true, Effect.fail(transportFailure))));
      expect(stopped.message).toContain("is stopped");
      expect(await runTunnel(
        Effect.flatMap(Tunnel, (tunnel) => tunnel.tunnelStatus({ stateDirectory: root })),
      )).toMatchObject({ lifecycle: "stopped" });
    });
  });
});
