import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { ConfigValue } from "../src/domain/resource.ts";

import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { adapterFor } from "../src/projection/adapters/index.ts";
import { loadCanonicalFolder, type FolderMcpServer, type FolderTool } from "../src/projection/folder.ts";
import type { RootContext } from "../src/projection/harness.ts";
import {
  diagnoseMcpConfiguration,
  foreignOsPath,
  type McpDiagnosticInput,
} from "../src/projection/mcp-diagnostics.ts";
import { TARGET_IDS, type TargetId } from "../src/projection/model.ts";
import { synchronizeLocal } from "../src/projection/sync.ts";
import { runDoctorProbes } from "../src/runtime/doctor.ts";
import { scheduleManagerLayer } from "../src/schedule/schedule-manager.layer.ts";
import { stateRepositoryLayer } from "../src/state/state-repository.layer.ts";
import { SynchronizationLive } from "../src/synchronization/synchronization.layer.ts";

const projectRoot = resolve(import.meta.dirname, "..");
const runtimeEntrypoint = resolve(projectRoot, "src/runtime/main.ts");

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const write = (path: string, content: string, mode?: number) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
};

const makeContext = (
  home: string,
  platform: RootContext["platform"] = "linux",
  environment: Readonly<Record<string, string>> = {},
): RootContext => ({
  platform,
  home,
  appData: home,
  environment: (name) => environment[name],
  join: (...segments) => join(...segments),
});

const runDiagnostics = (
  input: Partial<McpDiagnosticInput>,
  home: string,
  platform: RootContext["platform"] = "linux",
  binDirectories: ReadonlyArray<string> = [],
) => {
  const environment = { HOME: home, PATH: binDirectories.join(":") };
  const machine = linuxMachineStateLayer({
    environment: Object.entries(environment).map(([name, value]) => ({ name, value })),
    credentialPolicy: { kind: "local-file", path: join(home, "credentials") },
  });
  const full: McpDiagnosticInput = {
    harnesses: ["codex", "claude-code"],
    preserveMcp: new Set(),
    publishedMcp: {},
    localMcp: {},
    rawLocalMcp: {},
    effectiveMcp: [],
    tools: {},
    ...input,
  };
  return Effect.runPromise(
    diagnoseMcpConfiguration(full, makeContext(home, platform, environment)).pipe(
      Effect.provide(machine),
    ),
  );
};

describe("foreignOsPath", () => {
  it("flags paths belonging to another OS and ignores native paths and URLs", () => {
    expect(foreignOsPath("/home/ubuntu/.local/bin/apify", "windows")).toBe("/home/ubuntu/.local/bin/apify");
    expect(foreignOsPath("/Users/alice/bin/mcp", "windows")).toBe("/Users/alice/bin/mcp");
    expect(foreignOsPath("/opt/homebrew/bin/node", "windows")).toBe("/opt/homebrew/bin/node");
    expect(foreignOsPath("--config=/home/ubuntu/cfg.json", "windows")).toBe("/home/ubuntu/cfg.json");

    expect(foreignOsPath("C:\\Users\\alice\\mcp.exe", "linux")).toBe("C:\\Users\\alice\\mcp.exe");
    expect(foreignOsPath("D:/tools/mcp.exe", "macos")).toBe("D:/tools/mcp.exe");
    expect(foreignOsPath("\\\\fileserver\\share\\mcp.exe", "linux")).toBe("\\\\fileserver\\share\\mcp.exe");
    expect(foreignOsPath("/Users/alice/bin/mcp", "linux")).toBe("/Users/alice/bin/mcp");
    expect(foreignOsPath("/home/ubuntu/bin/mcp", "macos")).toBe("/home/ubuntu/bin/mcp");

    expect(foreignOsPath("/home/ubuntu/bin/mcp", "linux")).toBeUndefined();
    expect(foreignOsPath("/Users/alice/bin/mcp", "macos")).toBeUndefined();
    expect(foreignOsPath("C:\\Users\\alice\\mcp.exe", "windows")).toBeUndefined();
    expect(foreignOsPath("/usr/local/bin/node", "linux")).toBeUndefined();
    expect(foreignOsPath("/usr/local/bin/node", "macos")).toBeUndefined();
    expect(foreignOsPath("https://example.invalid/Users/alice/mcp", "linux")).toBeUndefined();
    expect(foreignOsPath("--url=https://example.invalid/home/ubuntu", "windows")).toBeUndefined();
    expect(foreignOsPath("/c", "windows")).toBeUndefined();
    expect(foreignOsPath("@apify/actors-mcp-server", "windows")).toBeUndefined();
  });
});

describe("MCP configuration diagnostics", () => {
  const tempHome = () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-mcp-diag-"));
    roots.push(root);
    return root;
  };

  it("warns on active preserveMcp locks and names the locked harnesses", async () => {
    const home = tempHome();
    const subset = await runDiagnostics({ preserveMcp: new Set<TargetId>(["pi", "codex"]) }, home);
    expect(subset).toEqual([
      expect.objectContaining({
        level: "warning",
        code: "MCP_PRESERVE_ACTIVE",
        message: expect.stringContaining("codex, pi"),
      }),
    ]);
    expect(subset[0]?.message).toContain("canonfig local mcp project --harness codex --harness pi");

    const all = await runDiagnostics({
      harnesses: ["codex", "claude-code"],
      preserveMcp: new Set<TargetId>(TARGET_IDS),
    }, home);
    expect(all).toEqual([
      expect.objectContaining({
        level: "warning",
        code: "MCP_PRESERVE_ACTIVE",
        message: expect.stringContaining("all harnesses (claude-code, codex)"),
      }),
    ]);

    const clean = await runDiagnostics({ preserveMcp: new Set() }, home);
    expect(clean).toEqual([]);
  });

  it("warns when a local overlay disables a published cross-platform MCP or references another OS path", async () => {
    const home = tempHome();
    const publishedMcp = {
      apify: { transport: "streamable-http", url: "https://mcp.apify.example.invalid" },
      git: { transport: "stdio", command: "uvx", args: ["mcp-server-git"] },
      macOnly: { transport: "stdio", command: "/Users/alice/bin/mac-only" },
      alreadyOff: { transport: "streamable-http", url: "https://off.example.invalid", enabled: false },
    } satisfies Record<string, FolderMcpServer>;
    const localMcp = {
      apify: { transport: "stdio", command: "/home/ubuntu/.local/bin/apify", enabled: false },
      git: { transport: "stdio", command: "uvx", args: ["mcp-server-git"], enabled: false },
      // Disabling a platform-specific or already-disabled published MCP should not warn.
      macOnly: { transport: "stdio", command: "disabled", enabled: false },
      alreadyOff: { transport: "streamable-http", url: "https://off.example.invalid", enabled: false },
    } satisfies Record<string, FolderMcpServer>;

    const windowsDiagnostics = await runDiagnostics({ publishedMcp, localMcp, rawLocalMcp: localMcp }, home, "windows");
    expect(windowsDiagnostics.map((entry) => entry.code)).toEqual([
      "MCP_OVERLAY_DISABLED",
      "MCP_OVERLAY_WRONG_OS_PATH",
      "MCP_OVERLAY_DISABLED",
    ]);
    expect(windowsDiagnostics[0]?.message).toContain("apify");
    expect(windowsDiagnostics[1]?.message).toContain("/home/ubuntu/.local/bin/apify");
    expect(windowsDiagnostics[2]?.message).toContain("git");

    // On Linux, Windows paths in command/args trigger MCP_OVERLAY_WRONG_OS_PATH, and secret flags never leak values.
    const secretMarker = "SUPER-SECRET-FLAG-VALUE-999";
    const linuxLocal = {
      winTool: {
        transport: "stdio",
        command: "C:\\Users\\alice\\bin\\mcp.exe",
        args: [`--api-key=C:\\secrets\\${secretMarker}`],
        enabled: false,
      },
    } satisfies Record<string, FolderMcpServer>;
    const linuxDiagnostics = await runDiagnostics({ localMcp: linuxLocal, rawLocalMcp: linuxLocal }, home, "linux");
    expect(linuxDiagnostics).toEqual([
      expect.objectContaining({
        level: "warning",
        code: "MCP_OVERLAY_WRONG_OS_PATH",
        message: expect.stringContaining("C:\\Users\\alice\\bin\\mcp.exe"),
      }),
    ]);
    expect(JSON.stringify(linuxDiagnostics)).not.toContain(secretMarker);
  });

  it("warns when an overlay drops fromSecret or embeds plaintext tokens without ever echoing token values", async () => {
    const home = tempHome();
    const bearerSecret = "bearer-super-secret-value-495";
    const envSecret = "apify_api_topSecretValue495";
    const rawPrefixSecret = "sk-proj-rawCustomHeaderSecret495";

    const publishedMcp = {
      remoteAuth: {
        transport: "streamable-http",
        url: "https://api.example.invalid/mcp",
        headers: { Authorization: { fromSecret: "api.token" } },
      },
      stdioAuth: {
        transport: "stdio",
        command: "node",
        env: { APIFY_TOKEN: { fromSecret: "apify.token" } },
      },
      keptAuth: {
        transport: "streamable-http",
        url: "https://kept.example.invalid/mcp",
        headers: { Authorization: { fromSecret: "kept.token" } },
      },
    } satisfies Record<string, FolderMcpServer>;
    const localMcp = {
      // Dropped fromSecret header and replaced with a plaintext Bearer token.
      remoteAuth: {
        transport: "streamable-http",
        url: "https://api.example.invalid/mcp",
        headers: { Authorization: `Bearer ${bearerSecret}`, "X-Custom": rawPrefixSecret },
      },
      // Replaced fromSecret env var with fromEnv, and added a plaintext secret env var.
      stdioAuth: {
        transport: "stdio",
        command: "node",
        env: { APIFY_TOKEN: { fromEnv: "APIFY_TOKEN" }, EXTRA_API_KEY: envSecret },
      },
      // Clean overlay: keeps fromSecret (case-insensitive header) and non-secret values + env refs.
      keptAuth: {
        transport: "streamable-http",
        url: "https://kept.example.invalid/mcp",
        headers: {
          authorization: { fromSecret: "kept.local" },
          "X-Trace": "${TRACE_ID}",
          Accept: "application/json",
        },
      },
    } satisfies Record<string, FolderMcpServer>;

    const diagnostics = await runDiagnostics({ publishedMcp, localMcp, rawLocalMcp: localMcp }, home, "linux");
    const codesByMessage = diagnostics.map((entry) => [entry.code, entry.message]);
    expect(codesByMessage).toEqual(expect.arrayContaining([
      ["MCP_OVERLAY_DROPPED_SECRET", expect.stringContaining("remoteAuth")],
      ["MCP_OVERLAY_DROPPED_SECRET", expect.stringContaining("stdioAuth")],
      ["MCP_OVERLAY_PLAINTEXT_SECRET", expect.stringContaining("headers.Authorization")],
      ["MCP_OVERLAY_PLAINTEXT_SECRET", expect.stringContaining("env.EXTRA_API_KEY")],
    ]));
    expect(diagnostics.some((entry) => entry.message.includes("keptAuth"))).toBe(false);

    // Crucial security invariant: none of the plaintext token values may ever appear in diagnostic text.
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain(bearerSecret);
    expect(serialized).not.toContain(envSecret);
    expect(serialized).not.toContain(rawPrefixSecret);
  });

  it("produces zero false positives for symbolic env references and ordinary non-secret headers/env", async () => {
    const home = tempHome();
    const localMcp = {
      cleanRemote: {
        transport: "streamable-http",
        url: "https://clean.example.invalid/mcp",
        headers: {
          Authorization: "Bearer ${API_TOKEN}",
          "X-Api-Key": "${env:MY_KEY}",
          "Content-Type": "application/json",
        },
      },
      cleanStdio: {
        transport: "stdio",
        command: "node",
        env: {
          NODE_ENV: "production",
          LOG_LEVEL: "debug",
          API_TOKEN: "{env:API_TOKEN}",
        },
      },
    } satisfies Record<string, FolderMcpServer>;
    const diagnostics = await runDiagnostics({ localMcp, rawLocalMcp: localMcp }, home, "linux");
    expect(diagnostics).toEqual([]);
  });

  it("warns for missing absolute paths and bare commands without PATH or tools recipe, and passes clean cases", async () => {
    const home = tempHome();
    const bin = join(home, "bin");
    const existingAbsolute = join(home, "custom-bin", "real-mcp");
    write(existingAbsolute, "#!/bin/sh\nexit 0\n", 0o755);
    write(join(bin, "on-path-mcp"), "#!/bin/sh\nexit 0\n", 0o755);
    mkdirSync(join(home, "a-directory"), { recursive: true });

    const tools = {
      uv: {
        executable: "uv",
        recipes: [{ platform: "linux", method: "uv", package: "uv", version: "0.5.0" }],
      },
      backedByName: {
        executable: "recipe-mcp",
        recipes: [{ platform: "linux", method: "npm", package: "recipe-mcp", version: "1.0.0" }],
      },
      emptyRecipes: {
        executable: "no-recipe-mcp",
        recipes: [],
      },
    } satisfies Record<string, FolderTool>;

    const diagnostics = await runDiagnostics({
      tools,
      effectiveMcp: [
        ["deadAbs", { transport: "stdio", command: join(home, "missing", "dead-mcp"), args: [], env: {} }],
        ["dirNotFile", { transport: "stdio", command: join(home, "a-directory"), args: [], env: {} }],
        ["missingBare", { transport: "stdio", command: "missing-bare-mcp", args: [], env: {} }],
        ["emptyRecipe", { transport: "stdio", command: "no-recipe-mcp", args: [], env: {} }],
        // Clean cases:
        ["goodAbs", { transport: "stdio", command: existingAbsolute, args: [], env: {} }],
        ["goodPath", { transport: "stdio", command: "on-path-mcp", args: [], env: {} }],
        ["goodRecipeExec", { transport: "stdio", command: "recipe-mcp", args: [], env: {} }],
        ["goodRequires", { transport: "stdio", command: "uvx", args: ["mcp-server-git"], env: {}, requires: ["tools/uv"] }],
        ["goodRemote", { transport: "streamable-http", url: "https://example.invalid/mcp", headers: {} }],
      ],
    }, home, "linux", [bin]);

    expect(diagnostics.map((entry) => entry.code)).toEqual([
      "MCP_COMMAND_MISSING",
      "MCP_COMMAND_MISSING",
      "MCP_COMMAND_MISSING",
      "MCP_COMMAND_MISSING",
    ]);
    const messages = diagnostics.map((entry) => entry.message).join("\n");
    expect(messages).toContain("deadAbs");
    expect(messages).toContain("dirNotFile");
    expect(messages).toContain("missingBare");
    expect(messages).toContain("emptyRecipe");
    for (const clean of ["goodAbs", "goodPath", "goodRecipeExec", "goodRequires", "goodRemote"]) {
      expect(messages).not.toContain(clean);
    }
  });

  it("respects stdio cwd, server.env.PATH, and platform-applicable tool recipes", async () => {
    const home = tempHome();
    const projectDir = join(home, "mcp-project");
    const customPathBin = join(home, "custom-env-bin");
    const machinePathBin = join(home, "machine-bin");
    write(join(projectDir, "bin", "server"), "#!/bin/sh\nexit 0\n", 0o755);
    write(join(customPathBin, "env-only-mcp"), "#!/bin/sh\nexit 0\n", 0o755);
    write(join(machinePathBin, "machine-only-mcp"), "#!/bin/sh\nexit 0\n", 0o755);

    const tools = {
      macosOnly: {
        executable: "macos-only-mcp",
        recipes: [{ platform: "macos", method: "brew", package: "macos-only-mcp", version: "1.0.0" }],
      },
      linuxTool: {
        executable: "linux-only-mcp",
        recipes: [{ platform: "linux", method: "apt", package: "linux-only-mcp", version: "1.0.0" }],
      },
    } satisfies Record<string, FolderTool>;

    const diagnostics = await runDiagnostics({
      tools,
      effectiveMcp: [
        // Relative command resolved against cwd: exists -> clean; missing -> warns
        ["goodRelCwd", { transport: "stdio", command: "./bin/server", cwd: projectDir, args: [], env: {} }],
        ["badRelCwd", { transport: "stdio", command: "./bin/missing", cwd: projectDir, args: [], env: {} }],
        // Bare command checked against server.env.PATH override
        ["goodEnvPath", { transport: "stdio", command: "env-only-mcp", args: [], env: { PATH: customPathBin } }],
        ["badEnvPath", { transport: "stdio", command: "machine-only-mcp", args: [], env: { PATH: customPathBin } }],
        // Foreign-platform recipe must NOT suppress warning on linux, whereas linux recipe does
        ["otherOsRecipe", { transport: "stdio", command: "macos-only-mcp", args: [], env: {}, requires: ["tools/macosOnly"] }],
        ["thisOsRecipe", { transport: "stdio", command: "linux-only-mcp", args: [], env: {}, requires: ["tools/linuxTool"] }],
      ],
    }, home, "linux", [machinePathBin]);

    expect(diagnostics.map((entry) => entry.code)).toEqual([
      "MCP_COMMAND_MISSING",
      "MCP_COMMAND_MISSING",
      "MCP_COMMAND_MISSING",
    ]);
    const messages = diagnostics.map((entry) => entry.message).join("\n");
    expect(messages).toContain("badRelCwd");
    expect(messages).toContain("badEnvPath");
    expect(messages).toContain("otherOsRecipe");
    for (const clean of ["goodRelCwd", "goodEnvPath", "thisOsRecipe"]) {
      expect(messages).not.toContain(clean);
    }
  });
});

describe("end-to-end sync --plan and doctor MCP diagnostics", () => {
  const makeWorkspace = (options: {
    readonly mcp: Record<string, FolderMcpServer>;
    readonly local?: Readonly<Record<string, ConfigValue>>;
    readonly tools?: Record<string, FolderTool>;
    readonly binaries?: ReadonlyArray<string>;
  }) => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-mcp-e2e-"));
    roots.push(root);
    const home = join(root, "home");
    const folder = join(home, ".canonfig");
    const bin = join(root, "bin");
    write(join(bin, adapterFor("codex").descriptor.executables[0]!), "#!/bin/sh\nexit 0\n", 0o755);
    write(join(bin, "npm"), "#!/bin/sh\nexit 0\n", 0o755);
    for (const name of options.binaries ?? []) {
      write(join(bin, name), "#!/bin/sh\nexit 0\n", 0o755);
    }
    const folderConfig = options.tools === undefined
      ? { version: 1, harnesses: ["codex"], local: { allow: ["mcp"] }, mcp: options.mcp }
      : { version: 1, harnesses: ["codex"], local: { allow: ["mcp"] }, mcp: options.mcp, tools: options.tools };
    write(join(folder, "canonfig.jsonc"), JSON.stringify(folderConfig, undefined, 2));
    if (options.local !== undefined) {
      write(join(folder, "local", "local.jsonc"), JSON.stringify(options.local, undefined, 2));
    }
    const environment = { HOME: home, PATH: bin, XDG_CACHE_HOME: join(home, ".cache") };
    const statePath = join(folder, "state.sqlite");
    const machine = linuxMachineStateLayer({
      environment: Object.entries(environment).map(([name, value]) => ({ name, value })),
      credentialPolicy: { kind: "local-file", path: join(home, "credentials") },
    });
    const layer = SynchronizationLive.pipe(
      Layer.provideMerge(stateRepositoryLayer(statePath)),
      Layer.provideMerge(machine),
      Layer.provideMerge(scheduleManagerLayer.pipe(Layer.provide(machine))),
    );
    return { root, home, folder, bin, statePath, environment, layer };
  };

  it("surfaces all four warning categories in sync --plan and doctor without blocking sync --apply or leaking secrets", async () => {
    const leakedToken = "Bearer_NEVER_PRINT_THIS_SECRET_495";
    const workspace = makeWorkspace({
      mcp: {
        apify: {
          transport: "streamable-http",
          url: "https://apify.example.invalid/mcp",
          headers: { Authorization: { fromSecret: "apify.token" } },
        },
        composio: {
          transport: "streamable-http",
          url: "https://composio.example.invalid/mcp",
          headers: { Authorization: { fromSecret: "composio.token" } },
        },
        dead: {
          transport: "stdio",
          command: "/nonexistent/canonfig/dead-mcp-binary",
        },
        missingCmd: {
          transport: "stdio",
          command: "uninstalled-mcp-cli",
        },
      },
      local: {
        preserveMcp: ["codex"],
        overlays: ["mcp/apify", "mcp/composio"],
        mcp: {
          apify: {
            transport: "stdio",
            command: "C:\\Users\\alice\\apify.exe",
            enabled: false,
          },
          composio: {
            transport: "streamable-http",
            url: "https://composio.example.invalid/mcp",
            headers: { Authorization: `Bearer ${leakedToken}` },
          },
        },
      },
    });

    const loaded = await loadCanonicalFolder(workspace.folder);
    expect(loaded.mcpDiagnostics.preserveMcp.has("codex")).toBe(true);

    const planned = await Effect.runPromise(
      synchronizeLocal(workspace.statePath, "plan", {
        noBackup: true,
        environment: (name) => workspace.environment[name],
      }).pipe(Effect.provide(workspace.layer)),
    );
    const planCodes = (planned.diagnostics ?? []).map((diagnostic) => diagnostic.code);
    expect(planCodes).toEqual(expect.arrayContaining([
      "MCP_PRESERVE_ACTIVE",
      "MCP_OVERLAY_DISABLED",
      "MCP_OVERLAY_WRONG_OS_PATH",
      "MCP_OVERLAY_DROPPED_SECRET",
      "MCP_OVERLAY_PLAINTEXT_SECRET",
      "MCP_COMMAND_MISSING",
    ]));
    expect((planned.diagnostics ?? []).every((diagnostic) => diagnostic.level === "warning")).toBe(true);
    expect(JSON.stringify(planned)).not.toContain(leakedToken);

    // Non-blocking: sync --apply still converges cleanly despite warnings.
    const applied = await Effect.runPromise(
      synchronizeLocal(workspace.statePath, "apply", {
        noBackup: true,
        environment: (name) => workspace.environment[name],
      }).pipe(Effect.provide(workspace.layer)),
    );
    expect(applied.outcome?.outcome).toBe("Converged");

    // Doctor reports the same warnings under the non-blocking mcp-config probe.
    const report = await Effect.runPromise(
      runDoctorProbes({
        noInput: true,
        timeoutMilliseconds: 5_000,
        statePath: workspace.statePath,
        environment: (name) => workspace.environment[name],
      }).pipe(Effect.provide(workspace.layer)),
    );
    const probe = report.probes.find((candidate) => candidate.name === "mcp-config");
    expect(probe).toMatchObject({
      name: "mcp-config",
      status: "warning",
    });
    const detailValues = Object.values(probe?.details ?? {}).map(String);
    expect(detailValues).toEqual(expect.arrayContaining([
      expect.stringContaining("[MCP_PRESERVE_ACTIVE]"),
      expect.stringContaining("[MCP_OVERLAY_DISABLED]"),
      expect.stringContaining("[MCP_OVERLAY_WRONG_OS_PATH]"),
      expect.stringContaining("[MCP_OVERLAY_DROPPED_SECRET]"),
      expect.stringContaining("[MCP_OVERLAY_PLAINTEXT_SECRET]"),
      expect.stringContaining("[MCP_COMMAND_MISSING]"),
    ]));
    expect(detailValues.join("\n")).toContain("composio");
    expect(detailValues.join("\n")).toContain("headers.Authorization");
    expect(JSON.stringify(report)).not.toContain(leakedToken);

    // CLI doctor exits 0 (degraded, not unhealthy), keeps warning messages readable, and never prints the secret.
    for (const args of [["doctor", "--json", "--no-input", "--timeout-ms", "5000"], ["doctor", "--no-input", "--timeout-ms", "5000"]]) {
      const cli = spawnSync(
        process.execPath,
        ["--import", "tsx", runtimeEntrypoint, ...args],
        {
          cwd: projectRoot,
          encoding: "utf8",
          env: { ...process.env, ...workspace.environment },
          timeout: 60_000,
        },
      );
      expect(cli.status, cli.stderr).toBe(0);
      const combined = `${cli.stdout}\n${cli.stderr}`;
      expect(combined).toContain("mcp-config");
      expect(combined).toContain("MCP_PRESERVE_ACTIVE");
      expect(combined).toContain("composio");
      expect(combined).not.toContain(leakedToken);
    }
  }, 60_000);

  it("reports zero MCP warnings and passes mcp-config probe for a clean configuration", async () => {
    const workspace = makeWorkspace({
      binaries: ["healthy-mcp"],
      mcp: {
        localGood: { transport: "stdio", command: "healthy-mcp" },
        remoteGood: {
          transport: "streamable-http",
          url: "https://docs.example.invalid/mcp",
          headers: { Authorization: { fromEnv: "DOCS_TOKEN" } },
        },
        recipeBacked: {
          transport: "stdio",
          command: "uvx",
          args: ["mcp-server-git"],
          requires: ["tools/uv"],
        },
      },
      tools: {
        uv: {
          executable: "uv",
          recipes: [{ platform: "linux", method: "uv", package: "uv", version: "0.5.0" }],
        },
      },
    });

    const planned = await Effect.runPromise(
      synchronizeLocal(workspace.statePath, "plan", {
        noBackup: true,
        environment: (name) => workspace.environment[name],
      }).pipe(Effect.provide(workspace.layer)),
    );
    expect(planned.diagnostics).toBeUndefined();

    const report = await Effect.runPromise(
      runDoctorProbes({
        noInput: true,
        timeoutMilliseconds: 5_000,
        statePath: workspace.statePath,
        environment: (name) => workspace.environment[name],
      }).pipe(Effect.provide(workspace.layer)),
    );
    expect(report.probes.find((candidate) => candidate.name === "mcp-config")).toMatchObject({
      name: "mcp-config",
      status: "pass",
      details: { warnings: 0 },
    });
  });
});
