import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { expect, it } from "vitest";
import { fakeSsh, freePort } from "../fixtures/tunnel-forwarder.ts";
import { runCli } from "../../src/cli/cli.ts";
import { SourceCommands } from "../../src/cli/source-commands.ts";
import { FollowerCommands } from "../../src/cli/follower-commands.ts";
import { startSourceServer } from "../../src/enrollment/source-server.ts";
import { requestFleetUpdate } from "../../src/enrollment/follower-client.ts";
import { fleetPath, writeFleetRecord } from "../../src/enrollment/fleet-update.ts";
import { finishFleetSync, followerFleetPath, prepareFleetSync } from "../../src/runtime/follower-fleet-update.ts";
import { SignedFleetDirective, type FleetReport } from "../../src/domain/fleet-update.ts";
import { EnrollmentLive } from "../../src/enrollment/enrollment.layer.ts";
import { Tunnel } from "../../src/enrollment/tunnel.service.ts";
import { TunnelLive } from "../../src/enrollment/tunnel.layer.ts";
import { Enrollment } from "../../src/enrollment/enrollment.service.ts";
import { fleetSource, verifyFleetDirective } from "../../src/enrollment/fleet-update.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { StateRepository } from "../../src/state/state-repository.service.ts";
import { runtimeLayer } from "../../src/runtime/layers.ts";
import { buildIdentity } from "../../src/runtime/build-identity.ts";
import { managedCommandLease } from "../../src/runtime/self-update/coordination.ts";

it("binds admissions to the enrolled identity, advances only on fresh target-version health, and halts at the first failure", async () => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-fleet-control-"));
  const folder = join(home, ".canonfig");
  mkdirSync(folder);
  const machine = linuxMachineStateLayer({
    environment: [{ name: "HOME", value: home }, { name: "PATH", value: join(home, "bin") }],
    credentialPolicy: { kind: "local-file", path: join(home, "credentials") },
  });
  const base = runtimeLayer({ statePath: join(folder, "state.sqlite") }, machine);
  const runtime = ManagedRuntime.make(Layer.merge(base, EnrollmentLive.pipe(Layer.provide(base))));
  try {
    await runtime.runPromise(Effect.flatMap(SourceCommands, (commands) => commands.initialize()));
    writeFileSync(join(folder, "canonfig.jsonc"), JSON.stringify({ version: 1, profile: { id: "fleet", name: "Fleet" }, harnesses: [] }));
    await runtime.runPromise(Effect.flatMap(SourceCommands, (commands) => commands.publish({ reviewer: "fleet-test" })));
    const { enrollment, controller, revision } = await runtime.runPromise(Effect.gen(function*() {
      const enrollment = yield* Enrollment;
      const repository = yield* StateRepository;
      return { enrollment, revision: (yield* repository.listRevisions())[0]!, controller: fleetSource({
        repository, credentials: enrollment.sourceCredentials, authenticate: enrollment.authenticate,
        release: async (version) => ({ version, integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`, tarball: "fixture-only" }),
      }) };
    }));
    const enroll = async (name: string) => {
      const invitation = await runtime.runPromise(enrollment.createInvitation({ endpoint: "https://127.0.0.1:17342", expiresInMilliseconds: 60_000, groups: [] }));
      const follower = await runtime.runPromise(enrollment.enrollFollower({ ...invitation, followerName: name }));
      await runtime.runPromise(enrollment.finalizeFollower(follower.credential));
      return follower;
    };
    const canary = await enroll("canary");
    const second = await enroll("second");
    await runtime.runPromise(controller.startFleetUpdate({ canary: canary.follower.id, apply: false }));
    expect(await runtime.runPromise(controller.fleetStatus())).toBeNull();
    const started = await runtime.runPromise(controller.startFleetUpdate({ canary: canary.follower.id, apply: true }));
    expect((await runtime.runPromise(controller.pollFleetUpdate(second.credential))).directive).toBeNull();
    const signed = (await runtime.runPromise(controller.pollFleetUpdate(canary.credential))).directive!;
    const fingerprint = canary.source.publicKeyFingerprint;
    expect(verifyFleetDirective(signed, canary.follower.id, fingerprint).version).toBe(buildIdentity.packageVersion);
    expect(() => verifyFleetDirective({ ...signed, directive: { ...signed.directive, version: "99.0.0" } }, canary.follower.id, fingerprint)).toThrow("signature");
    expect(() => verifyFleetDirective(signed, second.follower.id, fingerprint)).toThrow("identity");
    expect(() => verifyFleetDirective(signed, canary.follower.id, fingerprint, Date.parse(signed.directive.expiresAt))).toThrow("expired");
    // A follower whose clock runs behind the Source still accepts the directive the Source just admitted.
    const admittedAtSource = Date.parse(signed.directive.expiresAt) - 60 * 60 * 1000;
    expect(verifyFleetDirective(signed, canary.follower.id, fingerprint, admittedAtSource - 100_000).attempt).toBe(signed.directive.attempt);
    expect(() => verifyFleetDirective(signed, canary.follower.id, fingerprint, admittedAtSource - 6 * 60 * 1000)).toThrow("invalid lifetime");
    expect(() => Schema.decodeUnknownSync(SignedFleetDirective)({ directive: signed.directive, publicKey: signed.publicKey })).toThrow();
    const healthy: FleetReport = { rollout: started.id, attempt: signed.directive.attempt, version: started.version, status: "healthy", detail: "Converged", health: {
      run: "run-canary", revision: revision.id, version: started.version, outcome: "Converged", recordedAt: new Date().toISOString(),
    } };
    const stale = { ...healthy, health: { ...healthy.health!, recordedAt: "2000-01-01T00:00:00.000Z" } };
    expect((await runtime.runPromise(Effect.result(controller.reportFleetUpdate(canary.credential, stale))))._tag).toBe("Failure");
    expect((await runtime.runPromise(controller.pollFleetUpdate(second.credential))).directive).toBeNull();
    await runtime.runPromise(controller.reportFleetUpdate(canary.credential, healthy));
    const next = (await runtime.runPromise(controller.pollFleetUpdate(second.credential))).directive!;
    expect(next.directive.follower).toBe(second.follower.id);
    await runtime.runPromise(controller.reportFleetUpdate(second.credential, {
      rollout: started.id, attempt: next.directive.attempt, version: started.version, status: "failed", detail: "Verification failed", health: null,
    }));
    expect((await runtime.runPromise(controller.fleetStatus()))?.status).toBe("halted");
    expect((await runtime.runPromise(controller.pollFleetUpdate(canary.credential))).directive).toBeNull();
    const retry = await runtime.runPromise(controller.startFleetUpdate({ canary: canary.follower.id, apply: true }));
    expect(retry.sequence).toBe(started.sequence + 1);
    expect((await runtime.runPromise(Effect.result(controller.reportFleetUpdate(canary.credential, healthy))))._tag).toBe("Failure");
    await runtime.runPromise(controller.stopFleetUpdate(true));
    expect((await runtime.runPromise(controller.pollFleetUpdate(canary.credential))).directive).toBeNull();

    // A canary that goes offline after admission halts the rollout at its deadline without polling again.
    const offline = await runtime.runPromise(controller.startFleetUpdate({ canary: canary.follower.id, apply: true }));
    const admitted = (await runtime.runPromise(controller.pollFleetUpdate(canary.credential))).directive!;
    const rolloutPath = fleetPath(join(folder, "state.sqlite"));
    const admitAgo = (minutes: number) => {
      const recorded = JSON.parse(readFileSync(rolloutPath, "utf8"));
      writeFleetRecord(rolloutPath, { ...recorded, followers: recorded.followers.map((follower: { id: string }) => follower.id === canary.follower.id
        ? { ...follower, admittedAt: new Date(Date.now() - minutes * 60 * 1000).toISOString() } : follower) });
    };
    const recordedStatus = () => JSON.parse(readFileSync(rolloutPath, "utf8")).status;
    admitAgo(59);
    expect((await runtime.runPromise(controller.fleetStatus()))?.status).toBe("running");
    expect((await runtime.runPromise(controller.pollFleetUpdate(second.credential))).directive).toBeNull();
    await runtime.runPromise(controller.reportFleetUpdate(canary.credential, {
      ...healthy, rollout: offline.id, attempt: admitted.directive.attempt, status: "deferred", detail: "Busy", health: null,
    }));
    const beforeRetry = JSON.parse(readFileSync(rolloutPath, "utf8")).followers[0].admittedAt;
    const retryDirective = (await runtime.runPromise(controller.pollFleetUpdate(canary.credential))).directive!;
    expect(Date.parse(retryDirective.directive.expiresAt)).toBe(Date.parse(beforeRetry) + 60 * 60 * 1000);
    await runtime.runPromise(controller.reportFleetUpdate(canary.credential, {
      ...healthy, rollout: offline.id, attempt: admitted.directive.attempt, status: "deferred", detail: "Busy", health: null,
    }));
    admitAgo(61);
    expect(await runtime.runPromise(controller.fleetStatus())).toMatchObject({ id: offline.id, status: "halted", followers: [
      { id: canary.follower.id, status: "failed", detail: expect.stringContaining("within one hour") }, { id: second.follower.id, status: "queued" },
    ] });
    const overdue = readFileSync(rolloutPath, "utf8");
    expect((await runtime.runPromise(controller.startFleetUpdate({ canary: canary.follower.id, apply: false }))).sequence).toBe(offline.sequence + 1);
    expect((await runtime.runPromise(controller.stopFleetUpdate(false)))?.status).toBe("halted");
    expect(readFileSync(rolloutPath, "utf8")).toBe(overdue);

    // Expiry can expand the diagnostic on a record at the read limit.
    const atLimit = JSON.parse(overdue);
    atLimit.followers[1].name += "x".repeat(1_048_576 - Buffer.byteLength(overdue));
    writeFleetRecord(rolloutPath, atLimit);
    expect(recordedStatus()).toBe("running");
    expect((await runtime.runPromise(controller.pollFleetUpdate(second.credential))).directive).toBeNull();
    expect(recordedStatus()).toBe("halted");
    expect((await runtime.runPromise(controller.fleetStatus()))?.status).toBe("halted");
    expect((await runtime.runPromise(Effect.result(controller.reportFleetUpdate(canary.credential, {
      ...healthy, rollout: offline.id, attempt: admitted.directive.attempt,
      health: { ...healthy.health!, recordedAt: new Date().toISOString() },
    }))))._tag).toBe("Failure");
    expect((await runtime.runPromise(controller.startFleetUpdate({ canary: canary.follower.id, apply: true }))).sequence).toBe(offline.sequence + 1);
  } finally {
    await runtime.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

it("reports the published Source revision after a real follower projection converges", async () => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-fleet-health-"));
  const machineRuntime = (name: string) => {
    const directory = join(home, name);
    const state = join(directory, ".canonfig", "state.sqlite");
    const machine = linuxMachineStateLayer({
      environment: [{ name: "HOME", value: directory }, { name: "PATH", value: join(directory, "bin") }],
      credentialPolicy: { kind: "local-file", path: join(directory, "credentials") },
    });
    const base = runtimeLayer({ statePath: state }, machine);
    return { directory, state, runtime: ManagedRuntime.make(Layer.merge(base, EnrollmentLive.pipe(Layer.provide(base)))) };
  };
  const source = machineRuntime("source");
  const follower = machineRuntime("follower");
  mkdirSync(follower.directory);
  let close: (() => Promise<void>) | undefined;
  const tunnelDirectory = join(follower.directory, ".canonfig", "tunnel");
  const lease = managedCommandLease(follower.directory, home);
  const syncFromCli = async (scheduled = false) => {
    let output = "";
    const exitCode = await follower.runtime.runPromise(runCli(["sync", "--apply", "--no-input", "--json", ...(scheduled ? ["--scheduled"] : [])], {
      writeStdout: (text) => { output += text; },
      writeStderr: (text) => { output += text; },
      setExitCode: () => undefined,
    }, lease));
    return { exitCode, output };
  };
  try {
    await source.runtime.runPromise(Effect.flatMap(SourceCommands, (commands) => commands.initialize()));
    writeFileSync(join(source.directory, ".canonfig", "canonfig.jsonc"), JSON.stringify({ version: 1, profile: { id: "fleet-health", name: "Fleet health" }, harnesses: [] }));
    writeFileSync(join(source.directory, ".canonfig", "AGENTS.md"), "Published instructions.\n");
    await source.runtime.runPromise(Effect.flatMap(SourceCommands, (commands) => commands.publish({ reviewer: "fleet-test" })));
    const control = await source.runtime.runPromise(Effect.gen(function*() {
      const enrollment = yield* Enrollment;
      const repository = yield* StateRepository;
      const controller = fleetSource({ repository, credentials: enrollment.sourceCredentials, authenticate: enrollment.authenticate,
        release: async (version) => ({ version, integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`, tarball: "fixture-only" }) });
      const server = yield* startSourceServer({ hostname: "127.0.0.1" }).pipe(Effect.provideService(Enrollment, { ...enrollment, ...controller }));
      close = server.close;
      const credentials = yield* enrollment.sourceCredentials();
      const endpoint = process.platform === "win32" ? server.endpoint : yield* Effect.gen(function*() {
        const tunnel = yield* Tunnel;
        const localPort = yield* Effect.promise(freePort);
        const sshExecutable = yield* Effect.promise(() => fakeSsh(follower.directory));
        const running = yield* tunnel.startTunnel({
          sshHost: "source.example", sshPort: 22, sshUser: "operator",
          sshHostKey: `ssh-ed25519 ${Buffer.alloc(32, 1).toString("base64")}`,
          localHost: "127.0.0.1", localPort, remoteHost: "127.0.0.1", remotePort: Number(new URL(server.endpoint).port),
          tlsFingerprint: credentials.material.tlsFingerprint,
          sourceFingerprint: credentials.material.source.publicKeyFingerprint,
          stateDirectory: tunnelDirectory, sshExecutable,
        });
        return running.endpoint!;
      }).pipe(Effect.provide(TunnelLive));
      const invitation = yield* enrollment.createInvitation({ endpoint, expiresInMilliseconds: 60_000 });
      return { controller, server, invitation, revision: (yield* repository.listRevisions())[0]! };
    }));
    await follower.runtime.runPromise(Effect.flatMap(FollowerCommands, (commands) => commands.enroll({ invitation: control.invitation, followerName: "health", replace: false })));
    const configuration = await follower.runtime.runPromise(Effect.flatMap(StateRepository, (repository) => repository.getFollowerSynchronizationConfiguration()));
    if (configuration === undefined) throw new Error("Follower enrollment missing");
    // A broken Fleet Update record makes just the fleet endpoint fail.
    const rolloutPath = fleetPath(source.state);
    const sourceErrorText = "source-supplied-error-text";
    writeFileSync(rolloutPath, JSON.stringify(sourceErrorText));
    const deferred = await syncFromCli(true);
    expect(deferred.exitCode).toBe(0);
    expect(deferred.output).not.toContain(sourceErrorText);
    expect(JSON.parse(deferred.output)).toMatchObject({
      status: "success", message: expect.stringContaining("Fleet Update check deferred"),
      data: { outcome: { outcome: "Converged" } },
    });
    const invocations = await follower.runtime.runPromise(Effect.flatMap(StateRepository, (repository) => repository.listScheduledInvocations()));
    expect(JSON.stringify(invocations)).not.toContain(sourceErrorText);
    expect(invocations).toMatchObject([{
      _tag: "Completed", outcome: { outcome: "Converged" }, deferredFleetCheck: "The Source could not complete the Fleet Update request",
    }]);
    unlinkSync(rolloutPath);
    const noDirective = await syncFromCli();
    expect(noDirective.exitCode).toBe(0);
    expect(noDirective.output).not.toContain("Fleet Update check deferred");

    await source.runtime.runPromise(control.controller.startFleetUpdate({ canary: configuration.follower.id, apply: true }));
    const { directive } = await follower.runtime.runPromise(requestFleetUpdate({
      endpoint: configuration.source.endpoint, tlsFingerprint: configuration.source.tlsFingerprint,
      sourceFingerprint: configuration.source.signingFingerprint, credentialReference: configuration.credentialReference,
    }));
    // Two syncs overlap: the first wrote its record and converged, then the second replaced the record with a later
    // start before the first reported. The first must leave that record alone (its receipt predates the second's
    // start, so judging it would halt a healthy rollout); the second's own sync and receipt report health.
    const first = new Date().toISOString();
    writeFleetRecord(followerFleetPath(follower.state), { signed: directive, startedAt: first, report: null, reported: false });
    const sync = () => follower.runtime.runPromise(Effect.flatMap(FollowerCommands, (commands) => commands.synchronize({ mode: "apply", noInput: true })));
    await sync();
    const second = new Date().toISOString();
    writeFleetRecord(followerFleetPath(follower.state), { signed: directive, startedAt: second, report: null, reported: false });
    await follower.runtime.runPromise(finishFleetSync(true, first));
    expect(JSON.parse(readFileSync(followerFleetPath(follower.state), "utf8"))).toMatchObject({ startedAt: second, report: null });
    await sync();
    const receipt = await follower.runtime.runPromise(Effect.flatMap(StateRepository, (repository) => repository.latestDeploymentReceipt(configuration.follower.id)));
    expect(receipt?.revision).not.toBe(control.revision.id);
    await follower.runtime.runPromise(finishFleetSync(true, second));
    const rollout = await source.runtime.runPromise(control.controller.fleetStatus());
    expect(rollout).toMatchObject({ status: "complete", followers: [{ status: "healthy", health: { revision: control.revision.id, run: receipt?.run } }] });
    if (process.platform !== "win32") {
      const oldPid = Number(readFileSync(join(follower.directory, "ssh.pid"), "utf8"));
      process.kill(oldPid, "SIGKILL");
      await source.runtime.runPromise(control.controller.startFleetUpdate({ canary: configuration.follower.id, apply: true }));
      const restarted = await syncFromCli(true);
      expect(restarted.exitCode).toBe(0);
      expect(restarted.output).not.toContain("Fleet Update check deferred");
      expect(Number(readFileSync(join(follower.directory, "ssh.pid"), "utf8"))).not.toBe(oldPid);
      expect(await source.runtime.runPromise(control.controller.fleetStatus())).toMatchObject({
        status: "complete", followers: [{ status: "healthy" }],
      });
    }
    // An unreachable Source defers the fleet check and retains the transport diagnostic.
    await control.server.close();
    close = undefined;
    expect(await follower.runtime.runPromise(prepareFleetSync(follower.directory, lease))).toEqual({
      restart: false, startedAt: null, deferredCheck: "The Source could not complete the Fleet Update request",
    });
  } finally {
    lease.close();
    if (process.platform !== "win32") await Effect.runPromise(Effect.flatMap(Tunnel, (tunnel) =>
      tunnel.stopTunnel({ stateDirectory: tunnelDirectory })).pipe(Effect.provide(TunnelLive), Effect.ignore));
    await close?.();
    await follower.runtime.dispose();
    await source.runtime.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});
