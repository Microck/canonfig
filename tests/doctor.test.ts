import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:https";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Effect, Layer, Redacted, Schema } from "effect";
import { generate } from "selfsigned";
import { afterEach, describe, expect, it } from "vitest";

import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { MachineState } from "../src/machine/machine-state.service.ts";
import { doctorProbeNames, runDoctorProbes } from "../src/runtime/doctor.ts";
import { credentialReadiness, scheduledDefinitionReadiness } from "../src/runtime/readiness.ts";
import { scheduleManagerLayer } from "../src/schedule/schedule-manager.layer.ts";
import type { ScheduleStatus } from "../src/schedule/schedule-manager.types.ts";
import { stateRepositoryLayer } from "../src/state/state-repository.layer.ts";

const projectRoot = resolve(import.meta.dirname, "..");
const runtimeEntrypoint = resolve(projectRoot, "src/runtime/main.ts");

const executeDoctor = (
  home: string,
  arguments_: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = {},
) =>
  spawnSync(
    process.execPath,
    ["--import", "tsx", runtimeEntrypoint, "doctor", ...arguments_],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, ...environment, HOME: home },
      timeout: 60_000,
    },
  );

describe("doctor probes", () => {
  it("reports every typed probe deterministically without prompting", () => {
    const home = mkdtempSync(resolve(tmpdir(), "canonfig-doctor-"));
    const result = executeDoctor(
      home,
      ["--json", "--no-input", "--timeout-ms", "2000"],
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({
      schema: "canonfig.cli/v1",
      command: "doctor",
      status: "success",
      exitCode: 0,
      data: {
        schema: "canonfig.doctor/v1",
        noInput: true,
        timeoutMilliseconds: 2000,
      },
    });
    expect(envelope.data.probes.map((probe: { name: string }) => probe.name))
      .toEqual(doctorProbeNames);
    expect(envelope.data.probes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "state",
        status: "pass",
        details: expect.objectContaining({
          header: "valid",
          migrations: "current",
          readWrite: true,
        }),
      }),
      expect.objectContaining({ name: "credentials" }),
      expect.objectContaining({ name: "source" }),
      expect.objectContaining({ name: "scheduler" }),
      expect.objectContaining({ name: "package-managers" }),
      expect.objectContaining({ name: "agent-adapter" }),
    ]));
  });

  it("isolates a bounded source failure and reports remaining probes", () => {
    const home = mkdtempSync(resolve(tmpdir(), "canonfig-doctor-failure-"));
    const secret = "must-not-leak-doctor-secret";
    const result = executeDoctor(
      home,
      ["--json", "--no-input", "--timeout-ms", "2000"],
      {
        CANONFIG_SOURCE_ENDPOINT: "https://127.0.0.1:9",
        CANONFIG_SOURCE_TLS_FINGERPRINT: "configured-fingerprint",
        CANONFIG_SOURCE_CREDENTIAL_REFERENCE: secret,
      },
    );
    expect(result.status).toBe(5);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(secret);
    const envelope = JSON.parse(result.stderr);
    expect(envelope).toMatchObject({
      schema: "canonfig.cli/v1",
      command: "doctor",
      status: "error",
      exitCode: 5,
      data: {
        schema: "canonfig.doctor/v1",
        status: "unhealthy",
      },
    });
    expect(envelope.data.probes).toHaveLength(doctorProbeNames.length);
    expect(envelope.data.probes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "source",
        status: "fail",
        category: "authentication-or-revocation",
      }),
      expect.objectContaining({ name: "agent-adapter" }),
    ]));
  });

  it("rejects invalid timeouts before constructing runtime layers", () => {
    const home = mkdtempSync(resolve(tmpdir(), "canonfig-doctor-invalid-"));
    const result = executeDoctor(home, ["--timeout-ms", "0"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid doctor timeout: 0");
  });
});

// The doctor source probe reaches the Source over the same pinned HTTPS shape
// as the transport client, so it needs the same guard against a Source that
// stops writing mid-response.
describe("doctor source probe response lifecycle", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  // Only loadCredential is consulted before the probe issues its request, and
  // this fixture value grants access to no real service.
  const machine = Layer.effect(MachineState, Effect.gen(function*() {
    const base = yield* MachineState;
    return MachineState.of({
      ...base,
      loadCredential: () => Effect.succeed(Redacted.make("disposable-test-credential")),
    });
  })).pipe(Layer.provide(linuxMachineStateLayer()));

  it("fails a truncated source response instead of stalling until the probe timeout", async () => {
    const certificate = await generate([{ name: "commonName", value: "loopback-test" }], {
      keyType: "ec",
      curve: "P-256",
      extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }],
    });
    const sockets = new Set<Socket>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const server = createServer(
      { key: certificate.private, cert: certificate.cert },
      (request, response) => {
        request.resume();
        // Announce more than is ever written, then drop the socket. The client
        // socket is gone, so its idle timeout can no longer fire.
        response.writeHead(200, { "content-length": 128 });
        response.write("{");
        const timer = setTimeout(() => {
          timers.delete(timer);
          response.socket?.destroy();
        }, 25);
        timers.add(timer);
      },
    );
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((ready, failed) => {
      server.once("error", failed);
      server.listen(0, "127.0.0.1", ready);
    });
    cleanup.push(async () => {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((closed, failed) =>
        server.close((error) => error === undefined ? closed() : failed(error)));
    });
    const address = server.address();
    if (address === null || Schema.is(Schema.String)(address)) {
      throw new Error("missing fixture address");
    }

    const home = mkdtempSync(resolve(tmpdir(), "canonfig-doctor-truncated-"));
    const statePath = join(home, "state.sqlite");
    const state = stateRepositoryLayer(statePath);
    const timeoutMilliseconds = 10_000;
    const started = Date.now();
    const report = await Effect.runPromise(runDoctorProbes({
      noInput: true,
      timeoutMilliseconds,
      statePath,
      policyPath: join(home, "policy.json"),
      source: {
        endpoint: `https://127.0.0.1:${address.port}`,
        tlsFingerprint: createHash("sha256")
          .update(new X509Certificate(certificate.cert).raw)
          .digest("hex"),
        credentialReference: "fixture:credential",
      },
    }).pipe(
      Effect.provide(Layer.mergeAll(
        machine,
        state,
        scheduleManagerLayer.pipe(Layer.provide(machine)),
      )),
    ));
    const elapsed = Date.now() - started;

    const source = report.probes.find((probe) => probe.name === "source");
    expect(source).toMatchObject({
      status: "fail",
      category: "transport",
      message: "configured source is unreachable",
    });
    // A probe that only unblocked on its own timeout would report
    // "source probe timed out" after the full 10 seconds.
    expect(elapsed).toBeLessThan(timeoutMilliseconds / 2);
  });
});

describe("readiness evidence", () => {
  it.each(["secret-service", "keychain", "credential-manager"] as const)(
    "does not equate %s presence with usable unattended storage",
    (provider) => {
      const result = credentialReadiness({
        kind: "secure-noninteractive", provider, verification: "provider-presence",
      });
      expect(result.status).toBe("warning");
      expect(result.details).toMatchObject({
        verification: "provider-presence",
        writeAccessVerified: false,
        unattendedAccessVerified: false,
      });
    },
  );

  it.each(["secret-service", "keychain", "credential-manager"] as const)(
    "reports %s as verified when a session probe proved the write",
    (provider) => {
      const result = credentialReadiness({
        kind: "secure-noninteractive", provider, verification: "session-probe",
      });
      expect(result.status).toBe("pass");
      expect(result.details).toMatchObject({
        verification: "session-probe",
        writeAccessVerified: true,
        unattendedAccessVerified: true,
      });
    },
  );

  it("does not expose credential storage paths or untrusted recovery text", () => {
    const result = credentialReadiness({ kind: "unavailable", recovery: "secret fixture" });
    expect(JSON.stringify(result)).not.toContain("secret fixture");
    const local = credentialReadiness({
      kind: "local-file", path: { platform: "linux", absolute: "/private/fixture" },
    });
    expect(JSON.stringify(local)).not.toContain("/private/fixture");
  });

  it.each(["current", "not-installed", "disabled", "drifted"] as const)(
    "reports the requested %s schedule without inventing an execution receipt",
    (state) => {
      const status: ScheduleStatus = {
        state, platform: "linux", schedule: { kind: "daily", localTime: "04:00" },
        definition: {
          platform: "linux", mechanism: "systemd-user-timer",
          serviceName: "canonfig", service: "fixture", schedule: "fixture",
        },
      };
      const result = scheduledDefinitionReadiness(status);
      // A green renderer alone is a warning until the native scheduler is
      // observed firing the job.
      expect(result.status).toBe(state === "current" ? "warning" : "fail");
      expect(result.details?.scheduledExecutionVerified).toBe(false);
      expect(result.details?.definitionVerified).toBe(state === "current");
      if (state !== "current") expect(result.category).toBe("verification-or-apply-failure");
    },
  );

  it.each(["current"] as const)(
    "marks %s schedules verified only with recorded fire evidence",
    (state) => {
      const status: ScheduleStatus = {
        state, platform: "linux", schedule: { kind: "daily", localTime: "04:00" },
        definition: {
          platform: "linux", mechanism: "systemd-user-timer",
          serviceName: "canonfig", service: "fixture", schedule: "fixture",
        },
      };
      const fired = scheduledDefinitionReadiness(status, {
        at: "2026-09-12T04:00:05Z", outcome: "completed",
      });
      expect(fired.status).toBe("pass");
      expect(fired.details).toMatchObject({
        scheduledExecutionVerified: true,
        lastFiredAt: "2026-09-12T04:00:05Z",
        lastFiredOutcome: "completed",
      });
      // A failed scheduled apply still proves the scheduler fired the job.
      const failedFire = scheduledDefinitionReadiness(status, {
        at: "2026-09-12T04:00:05Z", outcome: "failed",
      });
      expect(failedFire.status).toBe("pass");
      expect(failedFire.details?.scheduledExecutionVerified).toBe(true);
    },
  );
});
