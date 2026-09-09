import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
    expect(command.arguments.slice(1)).toEqual(["sync", "--apply", "--no-input"]);
    expect(command.arguments[0]).toMatch(/[\\/]runtime[\\/]main\.js$/u);
    expect(command.arguments).not.toContain("--eval");
    expect(command.arguments).not.toContain("--import");
  });

  it("retains an explicitly selected standalone executable", () => {
    const executable = process.platform === "win32"
      ? "C:\\Program Files\\Canonfig\\standalone.exe"
      : "/opt/Canonfig Tools/standalone";
    expect(scheduleCommand(executable)).toEqual({
      executable,
      arguments: ["sync", "--apply", "--no-input"],
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

  it("starts the built CLI with an empty PATH and unrelated working directory", () => {
    // The existing acceptance workflow builds dist before running this suite.
    const module = resolve("dist/schedule/schedule-command.js");
    expect(existsSync(module), "build the CLI before native acceptance").toBe(true);
    const script = `
      const { scheduleCommand } = await import(${JSON.stringify(pathToFileURL(module).href)});
      const { spawnSync } = await import("node:child_process");
      const command = scheduleCommand();
      if (command.executable !== process.execPath ||
          JSON.stringify(command.arguments.slice(1)) !==
          JSON.stringify(["sync", "--apply", "--no-input"])) process.exit(90);
      const result = spawnSync(command.executable, [command.arguments[0], "--version"], {
        shell: false, encoding: "utf8", timeout: 10000,
        cwd: ${JSON.stringify(resolve("tests"))}, env: { ...process.env, PATH: "" }
      });
      if (result.error || result.status !== 0) process.exit(91);
      process.stdout.write(result.stdout);
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      shell: false,
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, PATH: "" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);
  });
});
