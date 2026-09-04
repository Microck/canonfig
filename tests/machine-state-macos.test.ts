import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Effect, type Layer } from "effect";
import { describe, expect, it } from "vitest";

import { HumanActionRequiredError } from "../src/machine/machine-state.errors.ts";
import { macosMachineStateLayer } from "../src/machine/macos.layer.ts";
import { MachineState } from "../src/machine/machine-state.service.ts";
import { machineStateContract } from "./contract/machine-state.contract.ts";

const executableDirectory = dirname(process.execPath);

const environment = (root: string) => [
  { name: "HOME", value: join(root, "home") },
  { name: "XDG_CONFIG_HOME", value: join(root, "config") },
  { name: "XDG_DATA_HOME", value: join(root, "data") },
  { name: "XDG_CACHE_HOME", value: join(root, "cache") },
  { name: "PATH", value: executableDirectory },
];

const runWith = <Value, Error>(
  layer: Layer.Layer<MachineState>,
  effect: Effect.Effect<Value, Error, MachineState>,
): Promise<Value> => Effect.runPromise(effect.pipe(Effect.provide(layer)));

machineStateContract("macOS", {
  platform: "macos",
  executable: process.execPath,
  nativeOperations: process.platform === "darwin",
  localFileLayer: (root) =>
    macosMachineStateLayer({
      credentialPolicy: {
        kind: "local-file",
        path: join(root, "credentials"),
      },
      environment: environment(root),
    }),
  secureStoreLayer: (root) =>
    macosMachineStateLayer({
      credentialPolicy: { kind: "secure-store" },
      credentialStoreAccess: "unavailable",
      environment: environment(root),
    }),
  schedulerAssertions: (rendered) => {
    expect(rendered.service).toContain("<key>ProgramArguments</key>");
    expect(rendered.service).toContain("<string>a value</string>");
    expect(rendered.schedule).toContain("<key>StartCalendarInterval</key>");
    expect(rendered.schedule).toContain("<key>Hour</key><integer>0</integer>");
  },
});

describe("macOS native scheduler inspection", () => {
  it("never boots out the launchd agent that started this process", async () => {
    // launchctl bootout stops the service's processes, so booting out the agent
    // that owns the running process kills it. A scheduled run changing its own
    // calendar would end Interrupted and block later fires.
    const root = await mkdtemp(join(tmpdir(), "canonfig-macos-bootout-"));
    const home = join(root, "home");
    const invocations: Array<ReadonlyArray<string>> = [];
    const layerFor = (serviceLabel: string | undefined) =>
      macosMachineStateLayer({
        credentialPolicy: { kind: "local-file", path: join(root, "credentials") },
        environment: serviceLabel === undefined
          ? environment(root)
          : [...environment(root), { name: "XPC_SERVICE_NAME", value: serviceLabel }],
        launchctlRunner: (arguments_) => {
          invocations.push(arguments_);
          return Effect.succeed({
            exitCode: 0,
            signal: null,
            standardOutput: new Uint8Array(),
            standardError: new Uint8Array(),
          });
        },
      });

    const rendered = await runWith(
      layerFor(undefined),
      Effect.gen(function*() {
        const machine = yield* MachineState;
        const executable = yield* machine.normalizePath({ path: process.execPath });
        return yield* machine.renderSchedulerJob({
          name: "canonfig-sync",
          description: "Canonfig follower synchronization",
          executable,
          arguments: ["sync", "--apply", "--no-input"],
          calendar: { kind: "daily", localTime: "00:00" },
        });
      }),
    );
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    const label = rendered.serviceName.slice(0, -".plist".length);

    // Running outside the agent: the usual bootout and bootstrap cycle.
    invocations.length = 0;
    await runWith(
      layerFor(undefined),
      Effect.flatMap(MachineState, (machine) => machine.installSchedulerJob(rendered)),
    );
    expect(invocations.map((argv) => argv[0])).toEqual(["bootout", "bootstrap"]);

    // Running as the agent's own process: the plist is written and launchd
    // picks it up on the next login, but nothing boots this process out.
    invocations.length = 0;
    await runWith(
      layerFor(label),
      Effect.flatMap(MachineState, (machine) => machine.installSchedulerJob(rendered)),
    );
    expect(invocations).toEqual([]);
    expect(await readFile(
      join(home, "Library", "LaunchAgents", rendered.serviceName),
      "utf8",
    )).toBe(rendered.schedule);

    // Removal is the same hazard: dropping the plist is enough.
    invocations.length = 0;
    await runWith(
      layerFor(label),
      Effect.flatMap(MachineState, (machine) => machine.removeSchedulerJob(rendered)),
    );
    expect(invocations).toEqual([]);
  });

  it("distinguishes an unloaded service from a launchctl inspection failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "canonfig-macos-scheduler-"));
    const home = join(root, "home");
    const unloadedLayer = macosMachineStateLayer({
      credentialPolicy: { kind: "local-file", path: join(root, "credentials") },
      environment: environment(root),
      launchctlRunner: () =>
        Effect.succeed({
          exitCode: 113,
          signal: null,
          standardOutput: new Uint8Array(),
          standardError: new TextEncoder().encode(
            "Could not find service \"dev.canonfig.sync\" in domain for user",
          ),
        }),
    });
    try {
      const rendered = await runWith(
        unloadedLayer,
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const executable = yield* machine.normalizePath({ path: process.execPath });
          return yield* machine.renderSchedulerJob({
            name: "canonfig-sync",
            description: "Canonfig follower synchronization",
            executable,
            arguments: ["sync", "--apply", "--no-input"],
            calendar: { kind: "daily", localTime: "00:00" },
          });
        }),
      );
      const launchAgents = join(home, "Library", "LaunchAgents");
      await mkdir(launchAgents, { recursive: true });
      await writeFile(join(launchAgents, rendered.serviceName), rendered.schedule);

      const unloaded = await runWith(
        unloadedLayer,
        Effect.gen(function*() {
          const machine = yield* MachineState;
          return {
            inspection: yield* machine.inspectSchedulerJob(rendered),
            snapshot: yield* machine.snapshotSchedulerJob(rendered),
          };
        }),
      );
      expect(unloaded.inspection).toMatchObject({
        installed: true,
        enabled: false,
      });
      expect(unloaded.snapshot).toMatchObject({
        state: "present",
        active: false,
        enabled: false,
      });

      const failedLayer = macosMachineStateLayer({
        credentialPolicy: { kind: "local-file", path: join(root, "credentials") },
        environment: environment(root),
        launchctlRunner: () =>
          Effect.succeed({
            exitCode: 1,
            signal: null,
            standardOutput: new Uint8Array(),
            standardError: new TextEncoder().encode("Operation not permitted"),
          }),
      });
      const failures = await runWith(
        failedLayer,
        Effect.gen(function*() {
          const machine = yield* MachineState;
          return {
            inspection: yield* Effect.flip(machine.inspectSchedulerJob(rendered)),
            snapshot: yield* Effect.flip(machine.snapshotSchedulerJob(rendered)),
          };
        }),
      );
      expect(failures.inspection).toBeInstanceOf(HumanActionRequiredError);
      expect(failures.snapshot).toBeInstanceOf(HumanActionRequiredError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
