import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { macosMachineStateLayer } from "../../src/machine/macos.layer.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import type { SchedulerJob } from "../../src/machine/machine-state.types.ts";
import { windowsMachineStateLayer } from "../../src/machine/windows.layer.ts";
import { makeScheduleManagerLayer } from "../../src/schedule/schedule-manager.layer.ts";
import { ScheduleManager } from "../../src/schedule/schedule-manager.service.ts";

const nativeMachine = () => {
  const environment = [{ name: "PATH", value: "" }];
  switch (process.platform) {
    case "win32": return windowsMachineStateLayer({ environment });
    case "darwin": return macosMachineStateLayer({ environment });
    default: return linuxMachineStateLayer({ environment });
  }
};

describe("scheduled runtime identity", () => {
  it("executes the rendered command with an empty PATH and spaced entrypoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "canonfig scheduled runtime "));
    const entrypoint = join(root, "compiled CLI.mjs");
    const jobs: Array<SchedulerJob> = [];
    await writeFile(entrypoint, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    const observedMachine = Layer.effect(MachineState, Effect.gen(function*() {
      const machine = yield* MachineState;
      return MachineState.of({
        ...machine,
        renderSchedulerJob: (job) => {
          jobs.push(job);
          return machine.renderSchedulerJob(job);
        },
        // The test observes a rendered job without creating a native schedule.
        inspectSchedulerJob: () => Effect.succeed({ installed: false, enabled: false, matches: false }),
      });
    })).pipe(Layer.provide(nativeMachine()));
    const manager = makeScheduleManagerLayer({
      defaultCommand: { executable: process.execPath, arguments: [entrypoint] },
    }).pipe(Layer.provide(observedMachine));
    try {
      const status = await Effect.runPromise(Effect.gen(function*() {
        const schedules = yield* ScheduleManager;
        return yield* schedules.status({ schedule: { kind: "daily", localTime: "04:00" } });
      }).pipe(Effect.provide(manager)));
      expect(status.state).toBe("not-installed");
      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      if (job === undefined) throw new Error("The manager did not render a job");
      expect(job.executable.absolute).toBe(process.execPath);
      expect(job.arguments).toEqual([entrypoint, "sync", "--apply", "--no-input"]);
      const result = await Effect.runPromise(Effect.gen(function*() {
        const machine = yield* MachineState;
        return yield* machine.runProcess({
          executable: job.executable,
          arguments: job.arguments,
          timeoutMilliseconds: 5_000,
          maximumOutputBytes: 4_096,
        });
      }).pipe(Effect.provide(nativeMachine())));
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(Buffer.from(result.standardOutput).toString("utf8")))
        .toEqual(["sync", "--apply", "--no-input"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not prepend a Node entrypoint to an explicit operator executable", async () => {
    const jobs: Array<SchedulerJob> = [];
    const observedMachine = Layer.effect(MachineState, Effect.gen(function*() {
      const machine = yield* MachineState;
      return MachineState.of({
        ...machine,
        renderSchedulerJob: (job) => { jobs.push(job); return machine.renderSchedulerJob(job); },
        inspectSchedulerJob: () => Effect.succeed({ installed: false, enabled: false, matches: false }),
      });
    })).pipe(Layer.provide(nativeMachine()));
    await Effect.runPromise(Effect.gen(function*() {
      const schedules = yield* ScheduleManager;
      return yield* schedules.status({ executable: process.execPath });
    }).pipe(Effect.provide(makeScheduleManagerLayer({
      defaultCommand: { executable: process.execPath, arguments: ["unused.js"] },
    }).pipe(Layer.provide(observedMachine)))));
    expect(jobs[0]?.arguments).toEqual(["sync", "--apply", "--no-input"]);
  });
});
