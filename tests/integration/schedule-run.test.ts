import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clock, Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { it } from "@effect/vitest";
import { afterEach, describe, expect } from "vitest";

import { runCli, type CliIo } from "../../src/cli/cli.ts";
import { FollowerCommands } from "../../src/cli/follower-commands.ts";
import { CliCommandFailure } from "../../src/cli/source-commands.ts";
import { RunId } from "../../src/domain/brand.ts";
import { SourceIdentity } from "../../src/domain/identity.ts";
import type { SynchronizationOutcome } from "../../src/domain/synchronization.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import type { RenderedSchedulerJob, SchedulerBackend, SchedulerInspection } from "../../src/machine/machine-state.types.ts";
import { runtimeLayer } from "../../src/runtime/layers.ts";
import { scheduleManagerLayer } from "../../src/schedule/schedule-manager.layer.ts";
import { ScheduleManager } from "../../src/schedule/schedule-manager.service.ts";
import { stateRepositoryLayer } from "../../src/state/state-repository.layer.ts";
import { StateRepository } from "../../src/state/state-repository.service.ts";
import type { ScheduledInvocation } from "../../src/state/state-repository.types.ts";
import type { ManagedCommandLease } from "../../src/runtime/self-update/coordination.ts";
import { defaultScheduledInvocation, FollowerSynchronizationConfiguration } from "../../src/synchronization/follower-sync-config.ts";

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class SessionScheduler implements SchedulerBackend {
  inspection: SchedulerInspection = { installed: true, enabled: true, active: true, matches: true };
  starts: Array<RenderedSchedulerJob> = [];
  onStart: Effect.Effect<void> = Effect.void;
  readonly inspect = () => Effect.sync(() => this.inspection);
  readonly snapshot = () => Effect.die("unused");
  readonly install = () => Effect.die("run must not install or enable the job");
  readonly remove = () => Effect.die("unused");
  readonly restore = () => Effect.die("unused");
  readonly start = (definition: RenderedSchedulerJob) => Effect.suspend(() => {
    this.starts.push(definition);
    return this.onStart;
  });
}

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-schedule-run-"));
  roots.push(root);
  const statePath = join(root, "state.sqlite");
  const scheduler = new SessionScheduler();
  const machine = linuxMachineStateLayer({
    environment: [{ name: "HOME", value: root }, { name: "PATH", value: "/usr/bin:/bin" }],
    credentialPolicy: { kind: "local-file", path: join(root, "credentials") },
    schedulerBackend: scheduler,
  });
  return {
    root, statePath, scheduler, machine,
    layer: Layer.merge(stateRepositoryLayer(statePath), scheduleManagerLayer.pipe(Layer.provide(machine))),
  };
};

const run = Schema.decodeUnknownSync(RunId)("scheduled-sync-run");
const converged: SynchronizationOutcome = { outcome: "Converged", run, verified: [] };

const record = (repository: StateRepository["Service"], id: string, startedAt: string, outcome = converged) =>
  repository.transitionScheduledInvocation({ _tag: "Running", id, startedAt }).pipe(
    Effect.andThen(repository.transitionScheduledInvocation({ _tag: "Completed", id, startedAt, at: startedAt, outcome })),
  );

describe("starting the installed schedule", () => {
  for (const [state, inspection] of [
    ["not-installed", { installed: false }],
    ["disabled", { enabled: false }],
    ["drifted", { matches: false }],
    ["inactive", { active: false }],
    ["overridden", { overrides: ["override.conf"] }],
  ] as const) {
    it.effect(`refuses a ${state} job without starting or installing anything`, () => {
      const host = fixture();
      host.scheduler.inspection = { ...host.scheduler.inspection, ...inspection };
      return Effect.gen(function*() {
        const manager = yield* ScheduleManager;
        const error = yield* Effect.flip(manager.run());
        expect(error).toMatchObject({ _tag: "ScheduleHumanActionRequiredError", recovery: expect.stringContaining("canonfig schedule set") });
        expect(host.scheduler.starts).toEqual([]);
      }).pipe(Effect.provide(host.layer));
    });
  }

  it.effect("returns the new invocation and its persisted run outcome, not an older completion", () => {
    const host = fixture();
    return Effect.gen(function*() {
      const repository = yield* StateRepository;
      const manager = yield* ScheduleManager;
      const now = yield* Clock.currentTimeMillis;
      yield* record(repository, "old", new Date(now - 1).toISOString());
      host.scheduler.onStart = record(repository, "new", new Date(now).toISOString()).pipe(Effect.orDie);
      const result = yield* manager.run();
      expect(result).toMatchObject({ id: "new", _tag: "Completed", outcome: converged });
      expect(host.scheduler.starts.map((job) => job.serviceName)).toEqual(["canonfig-sync.service"]);
    }).pipe(Effect.provide(host.layer));
  });

  it.effect("waits for the first matching invocation, ignoring older and other-generation runs", () => {
    const host = fixture();
    host.scheduler.inspection = { ...host.scheduler.inspection, generation: "current" };
    return Effect.gen(function*() {
      const repository = yield* StateRepository;
      const manager = yield* ScheduleManager;
      const now = yield* Clock.currentTimeMillis;
      const identity = { id: "first", generation: "current", startedAt: new Date(now).toISOString() };
      yield* record(repository, "old", new Date(now - 1).toISOString());
      const started = yield* Deferred.make<void>();
      host.scheduler.onStart = Effect.gen(function*() {
        yield* repository.transitionScheduledInvocation({ ...identity, _tag: "Running" });
        yield* record(repository, "wrong-generation", identity.startedAt);
        const later = { ...identity, id: "later", startedAt: new Date(now + 1).toISOString() };
        yield* repository.transitionScheduledInvocation({ ...later, _tag: "Running" });
        yield* repository.transitionScheduledInvocation({ ...later, _tag: "Completed", at: later.startedAt, outcome: converged });
        yield* Deferred.succeed(started, undefined);
      }).pipe(Effect.orDie);
      const fiber = yield* manager.run({ timeoutMilliseconds: 10_000 }).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* TestClock.adjust(1_000);
      yield* repository.transitionScheduledInvocation({ ...identity, _tag: "Completed", at: identity.startedAt, outcome: converged });
      yield* TestClock.adjust(1_000);
      expect(yield* Fiber.join(fiber)).toMatchObject({ id: "first", outcome: converged });
    }).pipe(Effect.provide(host.layer));
  });

  it.effect("times out instead of reporting an invocation that started before the request", () => {
    const host = fixture();
    return Effect.gen(function*() {
      const repository = yield* StateRepository;
      const manager = yield* ScheduleManager;
      const now = yield* Clock.currentTimeMillis;
      const started = yield* Deferred.make<void>();
      host.scheduler.onStart = record(repository, "old", new Date(now - 1).toISOString()).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)), Effect.asVoid, Effect.orDie,
      );
      const fiber = yield* Effect.flip(manager.run({ timeoutMilliseconds: 2_000 })).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* TestClock.adjust(2_000);
      expect(yield* Fiber.join(fiber)).toMatchObject({
        _tag: "ScheduleRunTimeoutError", message: expect.stringContaining("may still be running"),
      });
      expect(host.scheduler.starts).toHaveLength(1);
    }).pipe(Effect.provide(host.layer));
  });

  it.effect("ignores a record that existed before the request, even from the same millisecond", () => {
    const host = fixture();
    return Effect.gen(function*() {
      const repository = yield* StateRepository;
      const manager = yield* ScheduleManager;
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      yield* record(repository, "old", now);
      host.scheduler.onStart = record(repository, "new", now).pipe(Effect.orDie);
      expect(yield* manager.run()).toMatchObject({ id: "new", outcome: converged });
    }).pipe(Effect.provide(host.layer));
  });

  it.effect("follows a Fleet Update handoff to the replacement process's outcome", () => {
    const host = fixture();
    return Effect.gen(function*() {
      const repository = yield* StateRepository;
      const manager = yield* ScheduleManager;
      const now = yield* Clock.currentTimeMillis;
      const parent = { id: "parent", startedAt: new Date(now).toISOString() };
      host.scheduler.onStart = Effect.gen(function*() {
        yield* repository.transitionScheduledInvocation({ ...parent, _tag: "Running" });
        yield* repository.transitionScheduledInvocation({ ...parent, _tag: "Completed", at: parent.startedAt, restarted: true });
        yield* record(repository, "replacement", new Date(now + 1).toISOString());
      }).pipe(Effect.orDie);
      expect(yield* manager.run()).toMatchObject({ id: "replacement", _tag: "Completed", outcome: converged });
    }).pipe(Effect.provide(host.layer));
  });
});

const enroll = (repository: StateRepository["Service"], statePath: string) =>
  repository.saveFollowerSynchronizationConfiguration({
    sourceIdentity: Schema.decodeUnknownSync(SourceIdentity)({ keyId: "source", publicKeyFingerprint: "source" }),
    configuration: Schema.decodeUnknownSync(FollowerSynchronizationConfiguration)({
      schemaVersion: 1, lifecycle: { _tag: "Active" },
      follower: { id: "follower", name: "Follower", groups: [], revoked: false,
        credentialReference: "secure-store://canonfig/follower", enrolledAt: "2026-11-01T00:00:00Z" },
      profile: "profile", source: { endpoint: "https://127.0.0.1:17342", tlsFingerprint: "source", signingFingerprint: "source" },
      credentialReference: "secure-store://canonfig/follower", cacheDirectory: join(statePath, "cache"), stateLocation: statePath,
      agentPolicy: "deterministic-only", scheduledInvocation: defaultScheduledInvocation,
      scheduleOverride: { kind: "schedule", schedule: { kind: "daily", localTime: "04:00" } },
      updatedAt: "2026-11-01T00:00:00Z",
    }),
  });

describe("schedule run CLI through the real runtime and SQLite", () => {
  for (const [outcome, exitCode, json] of [
    [converged, 0, true],
    [{ outcome: "HumanActionRequired", run, actions: [{ reason: "approval", instructions: "approve" }] }, 3, true],
    [{ outcome: "FollowerDrift", run, conflicts: [] }, 4, true],
    [{ outcome: "Failed", run, reason: "verification failed" }, 7, true],
    [{ outcome: "Interrupted", run, completedActions: [] }, 7, true],
    [converged, 0, false],
  ] satisfies ReadonlyArray<readonly [SynchronizationOutcome, number, boolean]>) {
    it.effect(`reports ${outcome.outcome} with exit ${exitCode} and the run id (${json ? "JSON" : "human"})`, () => {
      const host = fixture();
      return Effect.gen(function*() {
        const repository = yield* StateRepository;
        yield* enroll(repository, host.statePath);
        host.scheduler.onStart = Effect.gen(function*() {
          const now = new Date(yield* Clock.currentTimeMillis).toISOString();
          yield* record(repository, "invocation", now, outcome);
        }).pipe(Effect.orDie);
        const stdout: Array<string> = [];
        const stderr: Array<string> = [];
        const io: CliIo = { writeStdout: (text) => stdout.push(text), writeStderr: (text) => stderr.push(text),
          setExitCode: (code) => expect(code).toBe(exitCode) };
        yield* runCli(["schedule", "run", ...(json ? ["--json"] : [])], io);
        const output = [...stdout, ...stderr].join("");
        if (json) {
          expect(JSON.parse(output)).toMatchObject({
            schema: "canonfig.cli/v1", command: "schedule.run", exitCode,
            data: { run, outcome: { outcome: outcome.outcome, run } },
          });
        } else {
          expect(output).toContain("Converged");
          expect(output).toContain(run);
        }
      }).pipe(Effect.provide(runtimeLayer({ statePath: host.statePath }, host.machine)));
    });
  }

  it.effect("preserves pre-sync failure categories even when no run id exists", () => {
    const host = fixture();
    return Effect.gen(function*() {
      const repository = yield* StateRepository;
      yield* enroll(repository, host.statePath);
      host.scheduler.onStart = Effect.gen(function*() {
        const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
        yield* repository.transitionScheduledInvocation({ _tag: "Running", id: "preflight", startedAt });
        yield* repository.transitionScheduledInvocation({
          _tag: "Failed", id: "preflight", startedAt, at: startedAt,
          reason: "human-action-required: unlock the credential store", failureCategory: "human-action-required",
        });
      }).pipe(Effect.orDie);
      const commands = yield* FollowerCommands;
      expect(yield* Effect.flip(commands.runSchedule({ timeoutMilliseconds: 10_000 }))).toMatchObject({
        category: "human-action-required", message: expect.stringContaining("unlock the credential store"),
      });
    }).pipe(Effect.provide(runtimeLayer({ statePath: host.statePath }, host.machine)));
  });

  it.effect("holds no command lease while the job runs, so a Fleet Update can activate", () => {
    const host = fixture();
    // Same state transitions as the real lease, without reader files.
    let suspended = false;
    const lease: ManagedCommandLease = {
      get suspended() { return suspended; },
      close: () => undefined,
      selfUpdate: async (operation, keepsRunning) => {
        suspended = true;
        try { const result = await operation(); suspended = !keepsRunning(result); return result; }
        catch (error) { suspended = false; throw error; }
      },
    };
    const suspendedDuringRun: Array<boolean> = [];
    return Effect.gen(function*() {
      const repository = yield* StateRepository;
      yield* enroll(repository, host.statePath);
      host.scheduler.onStart = Effect.gen(function*() {
        suspendedDuringRun.push(lease.suspended);
        yield* record(repository, "invocation", new Date(yield* Clock.currentTimeMillis).toISOString());
      }).pipe(Effect.orDie);
      const io: CliIo = { writeStdout: () => undefined, writeStderr: () => undefined, setExitCode: (code) => expect(code).toBe(0) };
      yield* runCli(["schedule", "run"], io, lease);
      expect(suspendedDuringRun).toEqual([true]);
      expect(lease.suspended).toBe(false);
    }).pipe(Effect.provide(runtimeLayer({ statePath: host.statePath }, host.machine)));
  });

  it.effect("records scheduled command outcomes and run ids on both terminal paths", () => {
    const host = fixture();
    return Effect.gen(function*() {
      const commands = yield* FollowerCommands;
      const repository = yield* StateRepository;
      yield* commands.synchronize({ mode: "apply", noInput: true, scheduled: true }, () => Effect.succeed({ payload: { outcome: converged } }));
      yield* Effect.flip(commands.synchronize({ mode: "apply", noInput: true, scheduled: true }, () => Effect.fail(new CliCommandFailure({
        category: "human-action-required", message: "approval required".repeat(200),
        details: { outcome: { outcome: "HumanActionRequired", run, actions: [] } },
        deferredFleetCheck: "The Source could not complete the Fleet Update request",
      }))));
      const invocations: ReadonlyArray<ScheduledInvocation> = yield* repository.listScheduledInvocations();
      expect(invocations).toMatchObject([
        { _tag: "Completed", outcome: converged },
        { _tag: "Failed", outcome: { outcome: "HumanActionRequired", run },
          reason: expect.stringMatching(/^human-action-required: approval required/u),
          failureCategory: "human-action-required", deferredFleetCheck: "The Source could not complete the Fleet Update request" },
      ]);
    }).pipe(Effect.provide(runtimeLayer({ statePath: host.statePath }, host.machine)));
  });

  it.effect("records a Fleet Update handoff as a restarted completion, not a result", () => {
    const host = fixture();
    return Effect.gen(function*() {
      const commands = yield* FollowerCommands;
      const repository = yield* StateRepository;
      yield* commands.synchronize({ mode: "apply", noInput: true, scheduled: true }, () => Effect.succeed({ payload: null }));
      const invocations: ReadonlyArray<ScheduledInvocation> = yield* repository.listScheduledInvocations();
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toMatchObject({ _tag: "Completed", restarted: true });
      expect(invocations[0]).not.toHaveProperty("outcome");
    }).pipe(Effect.provide(runtimeLayer({ statePath: host.statePath }, host.machine)));
  });
});
