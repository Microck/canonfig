import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { expect, it } from "vitest";
import { SourceCommands } from "../../src/cli/source-commands.ts";
import { FollowerCommands } from "../../src/cli/follower-commands.ts";
import { startSourceServer } from "../../src/enrollment/source-server.ts";
import { requestFleetUpdate } from "../../src/enrollment/follower-client.ts";
import { writeFleetRecord } from "../../src/enrollment/fleet-update.ts";
import { finishFleetSync, followerFleetPath } from "../../src/runtime/follower-fleet-update.ts";
import { SignedFleetDirective, type FleetReport } from "../../src/domain/fleet-update.ts";
import { EnrollmentLive } from "../../src/enrollment/enrollment.layer.ts";
import { Enrollment } from "../../src/enrollment/enrollment.service.ts";
import { fleetSource, verifyFleetDirective } from "../../src/enrollment/fleet-update.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { StateRepository } from "../../src/state/state-repository.service.ts";
import { runtimeLayer } from "../../src/runtime/layers.ts";
import { buildIdentity } from "../../src/runtime/build-identity.ts";

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
  let close: (() => Promise<void>) | undefined;
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
      const invitation = yield* enrollment.createInvitation({ endpoint: server.endpoint, expiresInMilliseconds: 60_000 });
      return { controller, server, invitation, revision: (yield* repository.listRevisions())[0]! };
    }));
    close = control.server.close;
    await follower.runtime.runPromise(Effect.flatMap(FollowerCommands, (commands) => commands.enroll({ invitation: control.invitation, followerName: "health", replace: false })));
    const configuration = await follower.runtime.runPromise(Effect.flatMap(StateRepository, (repository) => repository.getFollowerSynchronizationConfiguration()));
    if (configuration === undefined) throw new Error("Follower enrollment missing");
    await source.runtime.runPromise(control.controller.startFleetUpdate({ canary: configuration.follower.id, apply: true }));
    const { directive } = await follower.runtime.runPromise(requestFleetUpdate({
      endpoint: configuration.source.endpoint, tlsFingerprint: configuration.source.tlsFingerprint,
      sourceFingerprint: configuration.source.signingFingerprint, credentialReference: configuration.credentialReference,
    }));
    writeFleetRecord(followerFleetPath(follower.state), { signed: directive, startedAt: new Date().toISOString(), report: null, reported: false });
    await follower.runtime.runPromise(Effect.flatMap(FollowerCommands, (commands) => commands.synchronize({ mode: "apply", noInput: true })));
    const receipt = await follower.runtime.runPromise(Effect.flatMap(StateRepository, (repository) => repository.latestDeploymentReceipt(configuration.follower.id)));
    expect(receipt?.revision).not.toBe(control.revision.id);
    await follower.runtime.runPromise(finishFleetSync(true));
    const rollout = await source.runtime.runPromise(control.controller.fleetStatus());
    expect(rollout).toMatchObject({ status: "complete", followers: [{ status: "healthy", health: { revision: control.revision.id, run: receipt?.run } }] });
  } finally {
    await close?.();
    await follower.runtime.dispose();
    await source.runtime.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});
