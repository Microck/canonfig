import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { MachineState } from "../src/machine/machine-state.service.ts";
import { establishSetupScope, probeTools, runSetupPreflight } from "../src/setup/setup.controller.ts";

import {
  nextEligibleSetupStage,
  setupItemVerdicts,
  setupPlanDigest,
} from "../src/setup/setup.plan.ts";
import type {
  SetupInventory,
  SetupJournal,
  SetupPlanItem,
} from "../src/setup/setup.types.ts";

const inventory: SetupInventory = {
  schema: "canonfig.setup-inventory/v1",
  platform: "linux",
  home: "/home/operator",
  account: "operator",
  osRelease: "Linux 6.8 arm64",
  nodeRuntime: "v24.0.0 (/usr/bin/node)",
  credentialStorage: {
    kind: "local-file",
    provider: "test",
    verification: "test fixture",
  },
  transport: {
    policy: "loopback",
    initialized: false,
  },
  tools: [],
  discoveryFiles: 0,
  discoveryEvidence: 0,
  discoveryDigest: "discovery-digest",
};

const items: ReadonlyArray<SetupPlanItem> = [
  {
    id: "optional-installer",
    kind: "recipe-install",
    scope: "optional-tool",
    optional: true,
    dependsOn: [],
    detail: {},
  },
  {
    id: "required-directory",
    kind: "ensure-directory",
    scope: "machine",
    optional: false,
    dependsOn: [],
    detail: { path: "/home/operator/.canonfig" },
  },
];

const digest = setupPlanDigest({
  role: "follower",
  scope: "full",
  intent: "prepare follower",
  exclusions: [],
  inventory,
  items,
});
const journal = (overrides: Partial<SetupJournal> = {}): SetupJournal => ({
  schema: "canonfig.setup/v1",
  role: "follower",
  scope: "full",
  planDigest: digest,
  intent: "prepare follower",
  inventory,
  items: [...items],
  decisions: [],
  exclusions: [],
  evidence: [],
  approvals: [{
    digest,
    approver: "operator",
    approvedAt: "2026-08-17T00:00:00.000Z",
  }],
  catalog: [],
  stages: ["role", "preflight", "inventory", "plan"].map((stage) => ({
    stage,
    digest,
    completedAt: "2026-08-17T00:00:00.000Z",
  })),
  records: [],
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
  ...overrides,
});

describe("setup controller decisions", () => {
  it.runIf(process.platform === "linux")(
    "reports Source key-storage prerequisites before initialization",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "canonfig-setup-preflight-"));
      const home = join(root, "home");
      mkdirSync(home);
      try {
        const error = await Effect.runPromise(Effect.flip(
          runSetupPreflight("source").pipe(
            Effect.provide(linuxMachineStateLayer({
              environment: [
                { name: "HOME", value: home },
                { name: "PATH", value: "" },
              ],
              credentialPolicy: { kind: "secure-store" },
            })),
          ),
        ));
        expect(error).toMatchObject({
          _tag: "SetupError",
          category: "prerequisite",
        });
        expect(error.message).toContain("Source signing key");
        expect(error.message).toContain("TLS key");
        expect(error.message).toContain("before initialization");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "skips the Source key-storage gate for narrow scopes",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "canonfig-setup-narrow-"));
      const home = join(root, "home");
      mkdirSync(home);
      try {
        const layer = linuxMachineStateLayer({
          environment: [
            { name: "HOME", value: home },
            { name: "PATH", value: "" },
          ],
          credentialPolicy: { kind: "secure-store" },
        });
        for (const scope of ["cli-only", "project-only"] as const) {
          const preflight = await Effect.runPromise(
            runSetupPreflight("source", scope).pipe(Effect.provide(layer)),
          );
          expect(preflight.credentialStorage.kind).toBe("unavailable");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux" && process.env["RUSTUP_HOME"] === undefined)(
    "probes installers without letting corepack or rustup shims write state",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "canonfig-setup-probe-"));
      const home = join(root, "home");
      const bin = join(root, "bin");
      mkdirSync(home);
      mkdirSync(bin);
      try {
        // A rustup proxy writes its settings file on any invocation.
        writeFileSync(join(bin, "rustup"), [
          "#!/bin/sh",
          "mkdir -p \"$RUSTUP_HOME\" && touch \"$RUSTUP_HOME/settings.toml\"",
          "echo 'cargo 1.99.0'",
          "",
        ].join("\n"));
        chmodSync(join(bin, "rustup"), 0o755);
        symlinkSync("rustup", join(bin, "cargo"));
        // A corepack shim downloads the package manager unless network is off.
        writeFileSync(join(bin, "pnpm"), [
          "#!/bin/sh",
          "[ \"$COREPACK_ENABLE_NETWORK\" = 0 ] || mkdir -p \"$HOME/.cache/node/corepack\"",
          "exit 1",
          "",
        ].join("\n"));
        chmodSync(join(bin, "pnpm"), 0o755);
        const probe = Effect.gen(function*() {
          return yield* probeTools(yield* MachineState, "linux");
        }).pipe(Effect.provide(linuxMachineStateLayer({
          environment: [
            { name: "HOME", value: home },
            { name: "PATH", value: bin },
          ],
        })));

        const fresh = await Effect.runPromise(probe);
        expect(fresh.find((tool) => tool.method === "cargo")).toMatchObject({ verified: false });
        expect(fresh.find((tool) => tool.method === "pnpm")).toMatchObject({ verified: false });
        expect(existsSync(join(home, ".rustup"))).toBe(false);
        expect(existsSync(join(home, ".cache"))).toBe(false);

        // Once rustup is configured, running its proxy changes nothing new.
        mkdirSync(join(home, ".rustup"));
        writeFileSync(join(home, ".rustup", "settings.toml"), "version = \"12\"\n");
        const configured = await Effect.runPromise(probe);
        expect(configured.find((tool) => tool.method === "cargo")).toMatchObject({
          verified: true,
          version: "cargo 1.99.0",
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects unknown request scopes with the supported list", async () => {
    const error = await Effect.runPromise(Effect.flip(establishSetupScope("minimal")));
    expect(error).toMatchObject({ _tag: "SetupError", category: "usage" });
    expect(error.recovery).toContain("--scope full");
  });

  it("binds approval to declared intent, exclusions, inventory, and exact items", () => {
    expect(setupPlanDigest({
      role: "follower",
      scope: "full",
      intent: "prepare follower",
      exclusions: [],
      inventory,
      items,
    })).toBe(digest);
    expect(setupPlanDigest({
      role: "follower",
      scope: "cli-only",
      intent: "prepare follower",
      exclusions: [],
      inventory,
      items,
    })).not.toBe(digest);
    expect(setupPlanDigest({
      role: "follower",
      scope: "full",
      intent: "prepare source instead",
      exclusions: [],
      inventory,
      items,
    })).not.toBe(digest);
    expect(setupPlanDigest({
      role: "follower",
      scope: "full",
      intent: "prepare follower",
      exclusions: ["skip unavailable integration"],
      inventory,
      items,
    })).not.toBe(digest);
  });

  it("reproduces pre-scope digests for upgrade comparison", () => {
    const base = {
      role: "follower",
      intent: "prepare follower",
      exclusions: [],
      inventory,
      items,
    } as const;
    const legacy = setupPlanDigest({ ...base });
    // The scoped encoding binds the scope: identical inputs under an
    // explicit scope never collide with a legacy approval.
    expect(setupPlanDigest({ ...base, scope: "full" })).not.toBe(legacy);
    expect(setupPlanDigest({ ...base, scope: "cli-only" })).not.toBe(legacy);
    expect(setupPlanDigest({ ...base })).toBe(legacy);
  });

  it("resumes required work without blocking on an independent optional failure", () => {
    const records = [
      {
        id: "optional-installer",
        status: "failed" as const,
        evidence: "installer unavailable",
        updatedAt: "2026-08-17T00:01:00.000Z",
      },
      {
        id: "required-directory",
        status: "completed" as const,
        evidence: "/home/operator/.canonfig",
        updatedAt: "2026-08-17T00:01:00.000Z",
      },
    ];

    expect(setupItemVerdicts(items, records).get("required-directory"))
      .toBe("completed");
    expect(nextEligibleSetupStage(journal({ records }))).toBe("apply");
    expect(nextEligibleSetupStage(journal({
      records,
      stages: [
        ...journal().stages,
        {
          stage: "apply",
          digest,
          completedAt: "2026-08-17T00:02:00.000Z",
        },
      ],
    }))).toBe("complete");
  });
});

describe("setup decision record", () => {
  const projectRoot = resolve(import.meta.dirname, "..");
  const runtimeEntrypoint = resolve(projectRoot, "src/runtime/main.ts");

  it("records mode and discovery paths, and setup status shows them with the approver and stages", () => {
    const home = mkdtempSync(join(tmpdir(), "canonfig-setup-record-"));
    const discoveryFile = join(home, "package.json");
    writeFileSync(discoveryFile, "{\"name\":\"record\"}\n");
    const setup = (arguments_: ReadonlyArray<string>) => {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", runtimeEntrypoint, "setup", ...arguments_, "--json"],
        {
          cwd: projectRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            CANONFIG_LOCAL_CREDENTIAL_ROOT: join(home, ".canonfig-credentials"),
            CANONFIG_LOG: "off",
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout).data;
    };
    const plan = (mode: ReadonlyArray<string>) => setup([
      "plan", "--role", "follower", "--scope", "cli-only", ...mode,
      "--file", discoveryFile, "--file", join(home, "missing.md"),
    ]);
    try {
      const planned = plan(["--mode", "advanced"]);
      expect(planned.mode).toBe("advanced");
      // Only files discovery actually read are recorded; the missing one is an
      // exclusion.
      expect(planned.discoveryPaths).toHaveLength(1);
      expect(planned.discoveryPaths[0]).toMatch(/package\.json$/u);
      setup(["approve", "--approver", "operator"]);

      // Switching modes is not a new plan: the approval survives.
      const switched = plan(["--mode", "simple"]);
      expect(switched.planDigest).toBe(planned.planDigest);
      // A re-plan without --mode keeps the recorded choice.
      plan([]);

      const status = setup(["status"]);
      expect(status).toMatchObject({
        role: "follower",
        scope: "cli-only",
        mode: "simple",
        discoveryPaths: planned.discoveryPaths,
        planDigest: planned.planDigest,
        approvals: [{ approver: "operator", digest: planned.planDigest }],
      });
      expect(status.stages.map((stage: { readonly stage: string }) => stage.stage))
        .toEqual(["role", "preflight", "inventory", "plan", "approve"]);
      expect(status.stages.every((stage: { readonly completedAt: string }) =>
        !Number.isNaN(Date.parse(stage.completedAt)))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
