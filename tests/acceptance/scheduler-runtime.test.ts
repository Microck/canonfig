import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { macosMachineStateLayer } from "../../src/machine/macos.layer.ts";
import { windowsMachineStateLayer } from "../../src/machine/windows.layer.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import { scheduleCommand } from "../../src/schedule/schedule-command.ts";
import { scheduleManagerLayer } from "../../src/schedule/schedule-manager.layer.ts";
import { ScheduleManager } from "../../src/schedule/schedule-manager.service.ts";

describe("scheduler runtime binding", () => {
  it("uses the current absolute Node runtime without inheriting Node flags", () => {
    const command = scheduleCommand();
    expect(command.executable).toBe(process.execPath);
    expect(command.arguments.slice(1)).toEqual(["sync", "--apply", "--no-input", "--scheduled"]);
    expect(command.arguments[0]).toMatch(/[\\/]runtime[\\/]main\.js$/u);
  });
  it("retains an explicitly selected standalone executable", () => {
    const executable = process.platform === "win32"
      ? "C:\\Program Files\\Canonfig\\standalone.exe"
      : "/opt/Canonfig Tools/standalone";
    expect(scheduleCommand(executable)).toEqual({
      executable,
      arguments: ["sync", "--apply", "--no-input", "--scheduled"],
    });
  });

  it("renders the default native job even when PATH contains no canonfig shim", async () => {
    const machineLayer = process.platform === "win32"
      ? windowsMachineStateLayer({ environment: [{ name: "PATH", value: "" }] })
      : process.platform === "darwin"
      ? macosMachineStateLayer({ environment: [{ name: "PATH", value: "" }] })
      : linuxMachineStateLayer({ environment: [{ name: "PATH", value: "" }] });
    const observingMachine = Layer.effect(MachineState, Effect.gen(function*() {
      const machine = yield* MachineState;
      return MachineState.of({
        ...machine,
        inspectSchedulerJob: () => Effect.succeed({
          installed: false, enabled: false, matches: false,
        }),
      });
    })).pipe(Layer.provide(machineLayer));
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const manager = yield* ScheduleManager;
        return yield* manager.status({ schedule: { kind: "daily", localTime: "04:00" } });
      }).pipe(Effect.provide(scheduleManagerLayer.pipe(Layer.provide(observingMachine)))),
    );
    expect(result.state).toBe("not-installed");
    expect(result.definition.service).toContain("main.js");
    expect(result.definition.service).toContain("--no-input");
  });
});
