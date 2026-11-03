import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Effect, Schema } from "effect";
import { parse as parseJsonc } from "jsonc-parser";
import { describe, expect, it } from "vitest";

import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { MachineState } from "../src/machine/machine-state.service.ts";
import { establishSetupScope, probeTools, runSetupPreflight, setupStatus } from "../src/setup/setup.controller.ts";

import {
  nextEligibleSetupStage,
  setupItemVerdicts,
  setupPlanDigest,
} from "../src/setup/setup.plan.ts";
import {
  maxSetupDiscoveryFileBytes,
  type SetupInventory,
  type SetupJournal,
  type SetupPlanItem,
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
  discoveryInputs: [],
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
        const preflight = await Effect.runPromise(
          runSetupPreflight("source", "cli-only").pipe(Effect.provide(layer)),
        );
        expect(preflight.credentialStorage.kind).toBe("unavailable");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  // secret-tool as libsecret runs it: with no Secret Service provider on the
  // bus every operation fails; with one, items persist in FAKE_SECRET_STORE.
  const fakeSecretTool = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const [operation, ...rest] = process.argv.slice(2);
if (process.env.FAKE_SECRET_PROVIDER !== "running") {
  process.stderr.write("secret-tool: The name org.freedesktop.secrets was not provided by any .service files\\n");
  process.exit(1);
}
const attributes = operation === "store" ? rest.slice(1) : rest;
const item = path.join(process.env.FAKE_SECRET_STORE, Buffer.from(attributes.join("=")).toString("hex"));
if (operation === "store") { fs.writeFileSync(item, fs.readFileSync(0)); process.exit(0); }
if (!fs.existsSync(item)) process.exit(1);
if (operation === "lookup") { process.stdout.write(fs.readFileSync(item)); process.exit(0); }
if (operation === "clear") { fs.rmSync(item); process.exit(0); }
process.exit(2);
`;

  it.runIf(process.platform === "linux").each(["stopped", "running"] as const)(
    "proves Source key storage with a disposable probe, not provider presence (provider %s)",
    async (provider) => {
      const root = mkdtempSync(join(tmpdir(), "canonfig-setup-secret-service-"));
      const home = join(root, "home");
      const bin = join(root, "bin");
      const store = join(root, "store");
      mkdirSync(home);
      mkdirSync(bin);
      mkdirSync(store);
      writeFileSync(join(bin, "secret-tool"), fakeSecretTool, { mode: 0o755 });
      const layer = linuxMachineStateLayer({
        environment: [
          { name: "HOME", value: home },
          { name: "PATH", value: `${bin}:${dirname(process.execPath)}` },
          // A reachable bus address and secret-tool on PATH: provider presence.
          { name: "DBUS_SESSION_BUS_ADDRESS", value: "unix:path=/nonexistent/canonfig-test-bus" },
          { name: "FAKE_SECRET_STORE", value: store },
          { name: "FAKE_SECRET_PROVIDER", value: provider },
        ],
        credentialPolicy: { kind: "secure-store" },
      });
      try {
        if (provider === "stopped") {
          const error = await Effect.runPromise(Effect.flip(runSetupPreflight("source").pipe(Effect.provide(layer))));
          expect(error).toMatchObject({ _tag: "SetupError", category: "prerequisite" });
          expect(error.message).toContain("cannot be a Source");
          expect(error.message).toContain("did not accept a disposable write");
          expect(error.message).toContain("before initialization");
          expect(error.recovery).toContain("Secret Service provider");
          // Narrow scopes create no keys and do not need the probe.
          const narrow = await Effect.runPromise(runSetupPreflight("source", "cli-only").pipe(Effect.provide(layer)));
          expect(narrow.credentialStorage).toMatchObject({ verification: "provider-presence" });
        } else {
          const preflight = await Effect.runPromise(runSetupPreflight("source").pipe(Effect.provide(layer)));
          expect(preflight.credentialStorage).toEqual({
            kind: "secure-noninteractive",
            provider: "secret-service",
            verification: "session-probe",
          });
        }
        // The probe item never outlives the preflight.
        expect(readdirSync(store)).toEqual([]);
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
      discoveryInputs: [],
      items,
    })).toBe(digest);
    expect(setupPlanDigest({
      role: "follower",
      scope: "cli-only",
      intent: "prepare follower",
      exclusions: [],
      inventory,
      discoveryInputs: [],
      items,
    })).not.toBe(digest);
    expect(setupPlanDigest({
      role: "follower",
      scope: "full",
      intent: "prepare source instead",
      exclusions: [],
      inventory,
      discoveryInputs: [],
      items,
    })).not.toBe(digest);
    expect(setupPlanDigest({
      role: "follower",
      scope: "full",
      intent: "prepare follower",
      exclusions: ["skip unavailable integration"],
      inventory,
      discoveryInputs: [],
      items,
    })).not.toBe(digest);
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

describe("setup diagnostic evidence", () => {
  it("retains failure evidence in status without attaching stale evidence to a dependency skip", async () => {
    const home = mkdtempSync(join(tmpdir(), "canonfig-setup-evidence-"));
    const path = join(home, "setup.json");
    try {
      const fixtureItems = [items[0]!, { ...items[1]!, dependsOn: [items[0]!.id] }];
      writeFileSync(path, JSON.stringify(journal({ items: fixtureItems, records: [
        { id: items[0]!.id, status: "failed", evidence: "pnpm executable is unavailable; configure an installer binding", updatedAt: "2026-08-17T00:01:00.000Z" },
        { id: items[1]!.id, status: "completed", evidence: "stale success", updatedAt: "2026-08-17T00:01:00.000Z" },
      ] })));
      const status = await Effect.runPromise(setupStatus(path).pipe(Effect.provide(linuxMachineStateLayer())));
      expect(status.items[0]).toMatchObject({ status: "failed", evidence: "pnpm executable is unavailable; configure an installer binding" });
      expect(status.items[1]).toMatchObject({ status: "skipped" });
      expect(status.items[1]?.evidence).toBeUndefined();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("classifies a directory discovery input as operator usage, not an internal defect", () => {
    const home = mkdtempSync(join(tmpdir(), "canonfig-setup-directory-"));
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/runtime/main.ts", "setup", "plan", "--role", "follower", "--scope", "cli-only", "--file", home, "--json"], {
        cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 60_000,
        env: { ...process.env, HOME: home, USERPROFILE: home, CANONFIG_LOCAL_CREDENTIAL_ROOT: join(home, "credentials"), CANONFIG_LOG: "off" },
      });
      expect(result.status, result.stderr || result.stdout).toBe(2);
      expect(result.stdout + result.stderr).toContain("discovery file");
      expect(result.stdout + result.stderr).not.toContain("internal-defect");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("classifies an unreadable discovery file as operator usage, not an internal defect", () => {
    const home = mkdtempSync(join(tmpdir(), "canonfig-setup-unreadable-"));
    const input = join(home, "unreadable.json");
    writeFileSync(input, "{}");
    chmodSync(input, 0);
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/runtime/main.ts", "setup", "plan", "--role", "follower", "--scope", "cli-only", "--file", input, "--json"], {
        cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 60_000,
        env: { ...process.env, HOME: home, USERPROFILE: home, CANONFIG_LOCAL_CREDENTIAL_ROOT: join(home, "credentials"), CANONFIG_LOG: "off" },
      });
      expect(result.status, result.stderr || result.stdout).toBe(2);
      expect(result.stdout + result.stderr).toContain("discovery file");
      expect(result.stdout + result.stderr).not.toContain("internal-defect");
    } finally { chmodSync(input, 0o600); rmSync(home, { recursive: true, force: true }); }
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

describe.runIf(process.platform === "linux" && existsSync(join(dirname(process.execPath), "npm")))(
  "setup recipe approval boundaries",
  () => {
    const projectRoot = resolve(import.meta.dirname, "..");
    const runtimeEntrypoint = resolve(projectRoot, "src/runtime/main.ts");
    const fixture = () => {
      const home = mkdtempSync(join(tmpdir(), "canonfig-setup-recipe-"));
      const bin = join(home, "bin");
      mkdirSync(bin);
      symlinkSync(process.execPath, join(bin, "node"));
      symlinkSync(join(dirname(process.execPath), "npm"), join(bin, "npm"));
      const file = join(home, "package.json");
      const writeRecipe = (version = "1.6.0", disabled = false) => writeFileSync(file, JSON.stringify({
        canonfig: {
          tools: [
            { ecosystem: "npm", name: "cowsay", executable: "cowsay", version, disabled },
            { ecosystem: "npm", name: "disabled-tool", version: "1.0.0", disabled: true },
          ],
        },
      }));
      writeRecipe();
      const invoke = (arguments_: ReadonlyArray<string>) => spawnSync(
        process.execPath,
        ["--import", "tsx", runtimeEntrypoint, "setup", ...arguments_, "--json"],
        {
          cwd: projectRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            PATH: bin,
            NPM_CONFIG_PREFIX: join(home, "packages"),
            CANONFIG_LOCAL_CREDENTIAL_ROOT: join(home, ".canonfig-credentials"),
            CANONFIG_LOG: "off",
          },
        },
      );
      const setup = (arguments_: ReadonlyArray<string>) => {
        const result = invoke(arguments_);
        expect(result.status, result.stderr || result.stdout).toBe(0);
        return JSON.parse(result.stdout).data;
      };
      // A full follower plan installs accepted recipes without a Source identity.
      const plan = (scope = "full") => setup([
        "plan", "--role", "follower", "--scope", scope, "--file", file,
      ]);
      return { home, bin, file, writeRecipe, invoke, setup, plan };
    };

    it("plans installation and its verifier for an accepted missing recipe, but not disabled or CLI-only tools", () => {
      const test = fixture();
      try {
        const planned = test.plan();
        const installation = planned.items.find((item: SetupPlanItem) => item.kind === "recipe-install");
        expect(installation).toMatchObject({
          id: "recipe-install:cowsay",
          scope: "resource:tool:cowsay",
          dependsOn: ["tool-verify:npm"],
          detail: {
            arguments: ["install", "--global", "cowsay@1.6.0", "--ignore-scripts"],
            verifyExecutable: "cowsay",
            verifyArguments: ["--version"],
          },
        });
        expect(planned.items.find((item: SetupPlanItem) => item.id === "toolchain-verify").dependsOn)
          .toContain(installation.id);
        expect(planned.items.some((item: SetupPlanItem) => item.kind === "source-init")).toBe(false);
        expect(planned.items.some((item: SetupPlanItem) => item.id.includes("disabled-tool"))).toBe(false);
        expect(planned.exclusions).toEqual([]);

        rmSync(join(test.home, ".canonfig", "setup.json"));
        const cliOnly = test.plan("cli-only");
        expect(cliOnly.items.some((item: SetupPlanItem) =>
          item.kind === "recipe-install" || item.kind === "source-init")).toBe(false);
      } finally {
        rmSync(test.home, { recursive: true, force: true });
      }
    }, 60_000);

    it("preserves an executable already present instead of scheduling a reinstall", () => {
      const test = fixture();
      try {
        symlinkSync(process.execPath, join(test.bin, "cowsay"));
        const planned = test.plan();
        expect(planned.items.some((item: SetupPlanItem) => item.kind === "recipe-install")).toBe(false);
        expect(planned.catalog.some((entry: { readonly resource: string }) => entry.resource === "cowsay"))
          .toBe(false);
        expect(planned.evidence.some((entry: string) => entry.includes("installed and verified cowsay")))
          .toBe(false);
      } finally {
        rmSync(test.home, { recursive: true, force: true });
      }
    }, 60_000);

    it.each(["changed", "missing", "oversized", "legacy"] as const)(
      "rejects %s authoring inputs before executing an approved recipe",
      (change) => {
        const test = fixture();
        try {
          const planned = test.plan();
          test.setup(["approve", "--approver", "operator"]);
          const before = test.setup(["status"]);
          if (change === "changed") test.writeRecipe("1.5.0");
          else if (change === "missing") rmSync(test.file);
          else if (change === "oversized") writeFileSync(test.file, " ".repeat(maxSetupDiscoveryFileBytes + 1));
          else {
            const legacy = test.setup(["approve", "--approver", "operator"]);
            delete legacy.discoveryInputs;
            writeFileSync(join(test.home, ".canonfig", "setup.json"), JSON.stringify(legacy));
          }
          const rejected = test.invoke(["apply"]);
          expect(rejected.status, rejected.stderr || rejected.stdout).toBe(3);
          const status = test.setup(["status"]);
          expect(status.approved).toBe(false);
          expect(status.items).toEqual(before.items);
          expect(existsSync(join(test.home, "packages"))).toBe(false);

          test.writeRecipe("1.5.0");
          const replanned = test.plan();
          expect(replanned.planDigest).not.toBe(planned.planDigest);
          const declined = test.invoke(["apply"]);
          expect(declined.status, declined.stderr || declined.stdout).toBe(3);
          expect(existsSync(join(test.home, "packages"))).toBe(false);
          const approved = test.setup(["approve", "--approver", "operator"]);
          expect(approved.approvals).toEqual([expect.objectContaining({ digest: replanned.planDigest })]);
        } finally {
          rmSync(test.home, { recursive: true, force: true });
        }
      },
      60_000,
    );
  },
);

// Source setup's harnesses stage end to end through the real entrypoint: fake
// harness executables on a temporary PATH, fake harness homes, local-file keys.
describe.runIf(process.platform === "linux")("Source harness selection and import", () => {
  const projectRoot = resolve(import.meta.dirname, "..");
  const runtimeEntrypoint = resolve(projectRoot, "src/runtime/main.ts");
  // Assembled at runtime so no token-shaped literal sits in the repository.
  const token = ["gh", "p_", "Zq7x".repeat(9)].join("");
  const write = (path: string, content: string, mode?: number) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    if (mode !== undefined) chmodSync(path, mode);
  };
  const fixture = () => {
    const home = mkdtempSync(join(tmpdir(), "canonfig-setup-harnesses-"));
    const bin = join(home, "bin");
    for (const name of ["claude", "codex", "agent"]) write(join(bin, name), "#!/bin/sh\nexit 0\n", 0o755);
    write(join(home, ".claude", "CLAUDE.md"), "Prefer small diffs.\n");
    write(join(home, ".claude", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy the service\n---\nRun the deploy script.\n");
    write(join(home, ".claude.json"), JSON.stringify({
      oauthAccount: { emailAddress: "operator@example.invalid" },
      mcpServers: { github: { type: "stdio", command: "npx", args: ["-y", "server-github"], env: { GITHUB_TOKEN: token } } },
    }));
    // Never-touch credentials: unreadable, so a read would fail the plan.
    write(join(home, ".claude", ".credentials.json"), JSON.stringify({ accessToken: token }), 0o000);
    write(join(home, ".codex", "auth.json"), JSON.stringify({ token }), 0o000);
    write(join(home, ".codex", "config.toml"), "[mcp_servers.docs]\nurl = \"https://example.invalid/mcp\"\n");
    const invoke = (arguments_: ReadonlyArray<string>) => spawnSync(
      process.execPath,
      ["--import", "tsx", runtimeEntrypoint, "setup", ...arguments_, "--json"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          PATH: bin,
          XDG_CONFIG_HOME: join(home, ".config"),
          CODEX_HOME: "",
          CLAUDE_CONFIG_DIR: "",
          CANONFIG_LOCAL_CREDENTIAL_ROOT: join(home, ".canonfig-credentials"),
          CANONFIG_LOG: "off",
        },
      },
    );
    const setup = (arguments_: ReadonlyArray<string>) => {
      const result = invoke(arguments_);
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).not.toContain(token);
      return JSON.parse(result.stdout).data;
    };
    const item = (plan: { readonly items: ReadonlyArray<SetupPlanItem> }, id: string) =>
      plan.items.find((entry) => entry.id === id);
    // The ids and targets the plan's harness-import item would write.
    const imported = (plan: { readonly items: ReadonlyArray<SetupPlanItem> }) =>
      Schema.decodeUnknownSync(Schema.Struct({
        items: Schema.Array(Schema.Struct({ id: Schema.String, target: Schema.String })),
      }))(item(plan, "harness-import")?.detail).items;
    const cleanup = () => {
      chmodSync(join(home, ".claude", ".credentials.json"), 0o600);
      chmodSync(join(home, ".codex", "auth.json"), 0o600);
      rmSync(home, { recursive: true, force: true });
    };
    return { home, invoke, setup, item, imported, cleanup };
  };
  const filesBelow = (root: string): ReadonlyArray<string> =>
    readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? filesBelow(join(root, entry.name)) : [join(root, entry.name)]);

  it("preselects installed harnesses, ignores a generic agent without ~/.cursor, and binds approval to the list", () => {
    const test = fixture();
    try {
      const planned = test.setup(["plan", "--role", "source"]);
      expect(test.item(planned, "canonfig-folder")?.detail).toMatchObject({
        harnesses: ["codex", "claude-code"],
        detected: ["codex", "claude-code"],
      });
      expect(planned.stages.map((stage: { readonly stage: string }) => stage.stage))
        .toEqual(["role", "preflight", "inventory", "harnesses", "plan"]);
      // Offered for review, imported only on request.
      expect(test.item(planned, "harness-import")).toBeUndefined();
      expect(planned.imports.request).toBe("offer");
      expect(planned.imports.offered).toContainEqual(expect.objectContaining({
        id: "claude-code/mcp/github",
        target: "canonfig.jsonc#mcp.github",
        secrets: ["env.GITHUB_TOKEN -> fromEnv GITHUB_TOKEN"],
      }));

      const approved = test.setup(["approve", "--approver", "operator"]);
      expect(test.setup(["plan", "--role", "source"]).planDigest).toBe(approved.planDigest);
      expect(test.setup(["status"]).approved).toBe(true);

      const narrowed = test.setup(["plan", "--role", "source", "--harness", "codex"]);
      expect(narrowed.planDigest).not.toBe(approved.planDigest);
      expect(test.item(narrowed, "canonfig-folder")?.detail).toMatchObject({ harnesses: ["codex"] });
      const status = test.setup(["status"]);
      expect(status.approved).toBe(false);
      expect(status.stage).toBe("approve");

      mkdirSync(join(test.home, ".cursor"));
      const withCursor = test.setup(["plan", "--role", "source"]);
      expect(test.item(withCursor, "canonfig-folder")?.detail).toMatchObject({
        harnesses: ["codex", "claude-code", "cursor"],
      });
    } finally {
      test.cleanup();
    }
  }, 180_000);

  it("imports the chosen items with literal tokens as fromEnv references and never reads auth files", () => {
    const test = fixture();
    try {
      const planned = test.setup(["plan", "--role", "source", "--import", "claude-code"]);
      expect(test.imported(planned).map((entry) => entry.target).sort())
        .toEqual(["AGENTS.md", "canonfig.jsonc#mcp.github", "skills/deploy"]);
      test.setup(["approve", "--approver", "operator"]);
      const applied = test.setup(["apply"]);
      expect(applied.records.every((record: { readonly status: string }) => record.status === "completed")).toBe(true);

      const folder = join(test.home, ".canonfig");
      const config = parseJsonc(readFileSync(join(folder, "canonfig.jsonc"), "utf8"));
      expect(config.harnesses).toEqual(["codex", "claude-code"]);
      expect(config.mcp.github).toEqual({
        transport: "stdio",
        command: "npx",
        args: ["-y", "server-github"],
        env: { GITHUB_TOKEN: { fromEnv: "GITHUB_TOKEN" } },
      });
      expect(readFileSync(join(folder, "AGENTS.md"), "utf8")).toBe("Prefer small diffs.\n");
      expect(readFileSync(join(folder, "skills", "deploy", "SKILL.md"), "utf8")).toContain("name: deploy");
      for (const file of filesBelow(folder)) expect(readFileSync(file, "latin1"), file).not.toContain(token);
      expect(statSync(join(test.home, ".codex", "auth.json")).mode & 0o777).toBe(0);
      expect(statSync(join(test.home, ".claude", ".credentials.json")).mode & 0o777).toBe(0);
      expect(JSON.parse(readFileSync(join(test.home, ".claude.json"), "utf8")).mcpServers.github.env.GITHUB_TOKEN).toBe(token);
    } finally {
      test.cleanup();
    }
  }, 180_000);

  it("lists name collisions until one item is named, and reads nothing under --no-import", () => {
    const test = fixture();
    try {
      // Codex reads skills from the shared ~/.agents/skills/.
      write(join(test.home, ".agents", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Another deploy\n---\nDifferent.\n");
      const all = test.setup(["plan", "--role", "source", "--import-all"]);
      expect(all.exclusions).toContainEqual(expect.stringContaining("import collision: skills/deploy differs between"));
      const allTargets = test.imported(all).map((entry) => entry.target);
      expect(allTargets).not.toContain("skills/deploy");

      const named = test.setup(["plan", "--role", "source", "--import", "claude-code/skills/deploy"]);
      expect(test.imported(named).map((entry) => entry.id)).toEqual(["claude-code/skills/deploy"]);

      const declined = test.setup(["plan", "--role", "source", "--no-import"]);
      expect(declined.imports).toEqual({ request: "none", offered: [], present: [] });
      expect(test.item(declined, "harness-import")).toBeUndefined();

      rmSync(join(test.home, ".canonfig", "setup.json"));
      const follower = test.invoke(["plan", "--role", "follower", "--harness", "codex"]);
      expect(follower.status, follower.stderr || follower.stdout).toBe(2);
      expect(follower.stderr).toContain("apply only to a full Source setup");
    } finally {
      test.cleanup();
    }
  }, 180_000);
});
