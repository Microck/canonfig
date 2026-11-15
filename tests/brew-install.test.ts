import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ActionId, ResourceId, RunId } from "../src/domain/brand.ts";
import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { MachineState } from "../src/machine/machine-state.service.ts";
import { defaultSynchronizationExecutionLimits } from "../src/synchronization/executor.ts";
import { prepareResourceAction, type ResourceExecutionContext } from "../src/synchronization/resource-executors.ts";

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const formulaInfo = (stable: string, revision = 0) => JSON.stringify({
  formulae: [{ versions: { stable }, revision }],
});

const fixture = (options: {
  readonly formula?: string;
  readonly version?: string;
  readonly available?: string;
  readonly metadata?: string;
  readonly infoExitCode?: number;
  readonly installedVersion?: string | null;
  readonly method?: "brew" | "homebrew";
} = {}) => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-brew-"));
  directories.push(root);
  const formula = options.formula ?? "jq";
  const version = options.version ?? "1.8.1";
  const available = options.available ?? version;
  const installed = new Map<string, string>();
  let queries = 0;
  let mutations = 0;
  const encode = new TextEncoder();
  const response = (exitCode: number, stdout: string, stderr = "") => Effect.succeed({
    exitCode, signal: null,
    standardOutput: encode.encode(stdout), standardError: encode.encode(stderr),
  });
  const machine = Layer.effect(MachineState, Effect.map(MachineState, (service): MachineState["Service"] => ({
    ...service,
    findExecutable: ({ name }) => Effect.succeed({
      name, path: { platform: "linux" as const, absolute: join(root, "bin", name) },
    }),
    runProcess: (input) => {
      const args = input.arguments;
      // This fake models formula lookup and mutation, including the update
      // hazard: without the environment guard it refuses to use this catalog.
      if (args[0] === "info" || args[0] === "install") {
        if (!input.environment?.some((entry) => entry.name === "HOMEBREW_NO_AUTO_UPDATE" && entry.value === "1")) {
          return response(1, "", "catalog would auto-update");
        }
      }
      if (args[0] === "info") {
        queries += 1;
        if (mutations > 0) {
          const current = installed.get(formula);
          return response(0, JSON.stringify({ formulae: [{
            installed: current === undefined ? [] : [{ version: current }],
            linked_keg: current ?? null,
          }] }));
        }
        if (args.join("\0") !== ["info", "--json=v2", "--formula", "--", formula].join("\0")) {
          return response(1, "", "unknown formula query");
        }
        return response(options.infoExitCode ?? 0, options.metadata ?? formulaInfo(available), "formula query failed");
      }
      if (args[0] === "install") {
        mutations += 1;
        if (args.join("\0") !== ["install", "--formula", "--", formula].join("\0")) {
          return response(1, "", "formula does not exist");
        }
        if (options.installedVersion !== null) installed.set(formula, options.installedVersion ?? available);
        return response(0, "");
      }
      if (args[0] === "list") {
        const current = installed.get(formula);
        return response(current === undefined ? 1 : 0, current === undefined ? "" : `${formula} ${current}\n`);
      }
      return response(1, "", "unexpected command");
    },
  }))).pipe(Layer.provide(linuxMachineStateLayer({
    environment: [{ name: "HOME", value: join(root, "home") }, { name: "PATH", value: join(root, "bin") }],
    credentialPolicy: { kind: "local-file", path: join(root, "credentials") },
  })));
  const id = Schema.decodeUnknownSync(ResourceId)("brew-tool");
  const context: ResourceExecutionContext = {
    run: Schema.decodeUnknownSync(RunId)("brew-run"),
    action: {
      id: Schema.decodeUnknownSync(ActionId)("brew-install"), resource: id, kind: "install-tool", before: [],
      detail: { kind: "install-tool", toolId: "brew-tool", method: options.method ?? "brew", package: formula, version },
    },
    resource: { id, kind: "tool", policy: "ensure", target: "brew-tool", dependsOn: [], blobs: [] },
    desired: { kind: "tool", toolId: "brew-tool", recipes: [], loginRequired: false },
    verification: { method: "executable-present", executable: "brew-tool" },
    artifacts: new Map(), limits: defaultSynchronizationExecutionLimits,
  };
  return {
    installed,
    queries: () => queries,
    mutations: () => mutations,
    execute: () => Effect.runPromise(Effect.gen(function*() {
      const prepared = yield* prepareResourceAction(context);
      yield* prepared.execute;
    }).pipe(Effect.provide(machine))),
  };
};

describe("Homebrew exact-version installation", () => {
  it.each(["brew", "homebrew"] as const)("installs an ordinary stable formula through %s without inventing a name", async (method) => {
    const brew = fixture({ method });
    await brew.execute();
    expect(brew.installed.get("jq")).toBe("1.8.1");
  });

  it("preserves an explicitly authored tapped versioned formula and its revision", async () => {
    const brew = fixture({
      formula: "owner/tap/tool@2", version: "2.4.1_3", metadata: formulaInfo("2.4.1", 3),
    });
    await brew.execute();
    expect(brew.installed.get("owner/tap/tool@2")).toBe("2.4.1_3");
  });

  it("rejects an installer that succeeds without installing the pinned version", async () => {
    const brew = fixture({ installedVersion: "1.7.0" });
    await expect(brew.execute()).rejects.toMatchObject({
      _tag: "ActionExecutionError", message: expect.stringContaining("not the pinned 1.8.1"),
    });
    expect(brew.installed.get("jq")).toBe("1.7.0");
  });

  it("does not accept success without installed-version evidence", async () => {
    const brew = fixture({ installedVersion: null });
    await expect(brew.execute()).rejects.toMatchObject({
      _tag: "ActionExecutionError", message: expect.stringContaining("was not verified"),
    });
    expect(brew.installed.has("jq")).toBe(false);
  });

  it.each([
    ["older pin", "1.7.0", formulaInfo("1.8.1")],
    ["newer pin", "1.9.0", formulaInfo("1.8.1")],
    ["different revision", "1.8.1", formulaInfo("1.8.1", 1)],
  ])("refuses an unavailable %s before mutation", async (_label, version, metadata) => {
    const brew = fixture({ version, metadata });
    await expect(brew.execute()).rejects.toMatchObject({
      _tag: "ActionExecutionError", message: expect.stringContaining("not the pinned"),
    });
    expect(brew.mutations()).toBe(0);
    expect([...brew.installed]).toEqual([]);
  });

  it.each([
    "not JSON", "{}", '{"formulae":[]}',
    '{"formulae":[{"versions":{"stable":null},"revision":0}]}',
    '{"formulae":[{"versions":{"stable":"1.8.1"}}]}',
    formulaInfo(""), formulaInfo("1.8.1", -1), formulaInfo("1.8.1", 0.5),
    JSON.stringify({ formulae: [{ versions: { stable: "1.8.1" }, revision: 0 }, { versions: { stable: "1.8.1" }, revision: 0 }] }),
  ])("rejects unusable formula metadata before mutation: %s", async (metadata) => {
    const brew = fixture({ metadata });
    await expect(brew.execute()).rejects.toMatchObject({ _tag: "ActionExecutionError" });
    expect(brew.mutations()).toBe(0);
  });

  it("does not trust metadata from a failed query", async () => {
    const brew = fixture({ infoExitCode: 1 });
    await expect(brew.execute()).rejects.toMatchObject({ _tag: "ActionExecutionError" });
    expect(brew.mutations()).toBe(0);
  });

  it.each(["--HEAD", "jq --HEAD", "https://example.com/formula.rb"])("rejects unsafe formula %s before querying", async (formula) => {
    const brew = fixture({ formula });
    await expect(brew.execute()).rejects.toMatchObject({ _tag: "InvalidExecutionPlanError" });
    expect(brew.queries()).toBe(0);
    expect(brew.mutations()).toBe(0);
  });
});
