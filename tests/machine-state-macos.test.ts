import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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

describe.skipIf(process.platform !== "darwin")("macOS keychain session probe", () => {
  it("verifies the real login keychain from this process context", async () => {
    const root = await mkdtemp(join(tmpdir(), "canonfig-keychain-probe-"));
    const layer = macosMachineStateLayer({
      credentialPolicy: { kind: "secure-store" },
      environment: environment(root),
    });
    const capability = await runWith(
      layer,
      Effect.flatMap(MachineState, (machine) => machine.credentialCapability()),
    );
    expect(capability).toEqual({
      kind: "secure-noninteractive",
      provider: "keychain",
      verification: "session-probe",
    });
  });
});

// Manual qualification for the supported execution context: a per-user
// LaunchAgent in the logged-in graphical domain. Run with
// CANONFIG_KEYCHAIN_QUALIFICATION=1 on a logged-in macOS host.
const qualification = process.platform === "darwin"
  && process.env.CANONFIG_KEYCHAIN_QUALIFICATION === "1";
describe.skipIf(!qualification)("gui LaunchAgent keychain qualification", () => {
  it("runs the keychain write probe from a bootstrapped gui/<uid> agent", async () => {
    const identifier = randomUUID();
    const label = `dev.canonfig.qualification.${identifier}`;
    const root = await mkdtemp(join(tmpdir(), "canonfig-qualification-"));
    const plist = join(root, `${label}.plist`);
    const outcomePath = join(root, "outcome.json");
    const childScript = `
      const { spawnSync } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const sentinel = "canonfig-session-probe write check";
      const service = "dev.canonfig.session-probe.${identifier}";
      const script = [
        "ObjC.import('Foundation');",
        "ObjC.import('Security');",
        "function run() {",
        "  const bytes = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;",
        "  const payload = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding)));",
        "  const query = $.NSMutableDictionary.dictionary;",
        "  query.setObjectForKey(ObjC.castRefToObject($.kSecClassGenericPassword), ObjC.castRefToObject($.kSecClass));",
        "  query.setObjectForKey($(payload.service), ObjC.castRefToObject($.kSecAttrService));",
        "  query.setObjectForKey($('canonfig-session-probe'), ObjC.castRefToObject($.kSecAttrAccount));",
        "  if (payload.operation === 'add') {",
        "    const attributes = $.NSMutableDictionary.dictionary;",
        "    attributes.setObjectForKey($(payload.hexadecimal).dataUsingEncoding($.NSUTF8StringEncoding), ObjC.castRefToObject($.kSecValueData));",
        "    const status = $.SecItemAdd(query, null);",
        "    if (status !== 0) throw Error('add failed: ' + status);",
        "    return '';",
        "  }",
        "  if (payload.operation === 'load') {",
        "    query.setObjectForKey($.NSNumber.numberWithBool(true), ObjC.castRefToObject($.kSecReturnData));",
        "    const output = Ref();",
        "    const status = $.SecItemCopyMatching(query, output);",
        "    if (status !== 0) throw Error('load failed: ' + status);",
        "    return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(ObjC.castRefToObject(output[0]), $.NSUTF8StringEncoding));",
        "  }",
        "  const status = $.SecItemDelete(query);",
        "  if (status !== 0) throw Error('delete failed: ' + status);",
        "  return '';",
        "}",
      ].join("\\n");
      const input = (operation) => JSON.stringify({
        operation,
        service,
        hexadecimal: Buffer.from(sentinel, "utf8").toString("hex"),
      });
      const outcome = { ok: false, stage: "add" };
      try {
        const add = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { input: input("add") });
        if (add.status !== 0) throw new Error(String(add.stderr));
        const load = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { input: input("load") });
        if (load.status !== 0 || load.stdout.toString().trim() !== sentinel) {
          outcome.stage = "load";
          throw new Error(String(load.stderr) + load.stdout.toString());
        }
        const remove = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { input: input("delete") });
        if (remove.status !== 0) throw new Error(String(remove.stderr));
        outcome.ok = true;
      } catch (error) {
        outcome.error = String(error);
      } finally {
        writeFileSync(${JSON.stringify(outcomePath)}, JSON.stringify(outcome));
      }
    `;
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string><string>-e</string><string>${childScript.replaceAll("<", "\\u003c")}</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>`;
    await writeFile(plist, plistContent);
    const uid = process.getuid?.() ?? 0;
    const launchctl = spawnSync("/bin/launchctl", ["bootstrap", `gui/${uid}`, plist]);
    try {
      // launchd exposes no completion signal for a RunAtLoad agent, so the
      // only way to await the run is polling its outcome file. A fixed sleep
      // would just guess at agent startup time.
      const deadline = Date.now() + 30_000;
      while (!existsSync(outcomePath) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const outcome = JSON.parse(await readFile(outcomePath, "utf8")) as {
        ok: boolean;
        stage?: string;
        error?: string;
      };
      expect(outcome.error ?? outcome.stage).toBeUndefined();
      expect(outcome.ok).toBe(true);
    } finally {
      spawnSync("/bin/launchctl", ["bootout", `gui/${uid}/${label}`]);
      await rm(root, { recursive: true, force: true });
    }
  });
});
