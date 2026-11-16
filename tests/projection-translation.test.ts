import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { ConfigValue } from "../src/domain/resource.ts";
import {
  adapterFor,
  hookCommand,
} from "../src/projection/adapters/index.ts";
import type {
  HarnessProjection,
  ProjectionRuntime,
  RootContext,
  SurfaceContent,
} from "../src/projection/harness.ts";
import type { CanonicalModel, Hook, McpServer, TargetId } from "../src/projection/model.ts";
import {
  hookRegistryJson,
  hookRunnerSource,
  openCodePluginSource,
} from "../src/projection/templates/runtime.ts";

// The translators are pure: a model and a runtime in, surface contents out.
// Only the plugin and runner cases touch the disk, inside a temporary directory.

const FOLDER = "/home/user/.canonfig";
const RUNNER = `${FOLDER}/.runtime/hook-runner.mjs`;
const runtime: ProjectionRuntime = { folder: FOLDER, hookRunner: RUNNER, platform: "linux" };
const context: RootContext = {
  platform: "linux",
  home: "/home/user",
  appData: "/home/user/.config",
  environment: () => undefined,
  join: (...segments) => path.posix.join(...segments),
};

const guard: Hook = {
  id: "guard-shell",
  event: "before_tool",
  matcher: { capabilities: ["shell"], tools: [], inputRegex: "git\\s+push" },
  run: ["node", `${FOLDER}/hooks/guard.mjs`],
  timeoutMs: 5_000,
  onFailure: "block",
};

const servers: ReadonlyArray<readonly [string, McpServer]> = [
  ["docs", {
    transport: "streamable-http",
    url: "https://example.invalid/mcp",
    headers: { Authorization: { fromEnv: "DOCS_MCP_TOKEN" }, "X-Static": "safe-value" },
    timeoutMs: 10_000,
  }],
  ["local", {
    transport: "stdio",
    command: "fixture-tool",
    args: ["serve"],
    env: { API_KEY: { fromEnv: "API_KEY" }, PLAIN_SETTING: "safe-value" },
    timeoutMs: 15_000,
    enabledTools: ["read"],
    disabledTools: ["delete"],
  }],
];

function model(overrides: Partial<CanonicalModel> = {}): CanonicalModel {
  return {
    folder: FOLDER,
    harnesses: [],
    rules: [],
    skills: [],
    plugins: [],
    agents: [],
    commands: [],
    hooks: [],
    mcp: [],
    settings: {},
    ...overrides,
  };
}

function project(harness: TargetId, input: CanonicalModel): HarnessProjection {
  const adapter = adapterFor(harness);
  return adapter.project(input, adapter.layout(context, input), runtime);
}

function content(projection: HarnessProjection, surface: string): SurfaceContent {
  const found = projection.contents.find((entry) => entry.surface === surface);
  expect(found, surface).toBeDefined();
  return found!;
}

function configValue(projection: HarnessProjection, surface: string, key: string): ConfigValue {
  const found = content(projection, surface);
  if (found.kind !== "config") throw new Error(`${surface} is not a config surface`);
  const entry = found.keys.find((candidate) => candidate.path === key);
  expect(entry, key).toBeDefined();
  return entry!.value;
}

function fileText(projection: HarnessProjection, surface: string): string {
  const found = content(projection, surface);
  if (found.kind !== "file") throw new Error(`${surface} is not a file surface`);
  return String(found.content);
}

const codes = (projection: HarnessProjection) => projection.diagnostics.map((diagnostic) => diagnostic.code);

describe("hook mapping", () => {
  it("calls the runner by absolute path", () => {
    expect(hookCommand(runtime, "codex", guard)).toBe(
      `node "${RUNNER}" --hook guard-shell --target codex --event before_tool`,
    );
  });

  it.each([
    ["claude-code", "before_agent"], ["claude-code", "after_agent"],
    ["factory-droid", "before_agent"], ["factory-droid", "after_compact"], ["factory-droid", "subagent_start"],
  ] as const)("reports unsupported %s event %s and writes no hooks", (harness, event) => {
    const result = project(harness, model({ hooks: [{ ...guard, event }] }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "HOOK_EVENT_UNSUPPORTED", harness, level: "warning" }));
    expect(result.contents.filter((entry) => entry.surface === "hooks" || entry.surface === "settings")).toEqual([]);
  });

  it("keys a standalone Factory hooks.json by event name", () => {
    const hooks = JSON.parse(fileText(project("factory-droid", model({ hooks: [guard] })), "hooks"));
    expect(hooks).toEqual({
      PreToolUse: [{
        matcher: ".*",
        hooks: [{ type: "command", command: hookCommand(runtime, "factory-droid", guard), timeout: 5 }],
      }],
    });
  });

  it("writes Kimi `[[hooks]]` tables and Hermes shell hooks", () => {
    expect(configValue(project("kimi", model({ hooks: [guard] })), "config", "hooks")).toEqual([
      { event: "PreToolUse", command: hookCommand(runtime, "kimi", guard), timeout: 5 },
    ]);
    expect(configValue(project("hermes", model({ hooks: [guard] })), "config", "hooks")).toEqual({
      pre_tool_call: [{ command: hookCommand(runtime, "hermes", guard), timeout: 5, fail_closed: true }],
    });
  });

  it("rounds hook timeouts up to whole seconds and says so", () => {
    const result = project("claude-code", model({ hooks: [{ ...guard, timeoutMs: 1_500 }] }));
    expect(configValue(result, "settings", "hooks")).toMatchObject({ PreToolUse: [{ hooks: [{ timeout: 2 }] }] });
    expect(codes(result)).toContain("HOOK_TIMEOUT_ROUNDED");
  });

  it("keeps Qwen timeouts in milliseconds", () => {
    expect(configValue(project("qwen", model({ hooks: [guard] })), "settings", "hooks")).toEqual({
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand(runtime, "qwen", guard), timeout: 5_000 }] }],
    });
  });
});

describe("MCP mapping", () => {
  it("writes each client's reference syntax and never a secret value", () => {
    const input = model({ mcp: servers });
    expect(configValue(project("codex", input), "config", "mcp_servers")).toEqual({
      docs: {
        url: "https://example.invalid/mcp",
        http_headers: { "X-Static": "safe-value" },
        env_http_headers: { Authorization: "DOCS_MCP_TOKEN" },
      },
      local: {
        command: "fixture-tool",
        args: ["serve"],
        env: { PLAIN_SETTING: "safe-value" },
        env_vars: ["API_KEY"],
        enabled_tools: ["read"],
        disabled_tools: ["delete"],
      },
    });
    expect(configValue(project("cursor", input), "mcp", "mcpServers")).toMatchObject({
      docs: { type: "http", headers: { Authorization: "${env:DOCS_MCP_TOKEN}" } },
      local: { type: "stdio", env: { API_KEY: "${env:API_KEY}" } },
    });
    expect(configValue(project("opencode", input), "config", "mcp")).toEqual({
      docs: {
        type: "remote",
        url: "https://example.invalid/mcp",
        enabled: true,
        headers: { Authorization: "{env:DOCS_MCP_TOKEN}", "X-Static": "safe-value" },
        timeout: 10_000,
      },
      local: {
        type: "local",
        command: ["fixture-tool", "serve"],
        enabled: true,
        environment: { API_KEY: "{env:API_KEY}", PLAIN_SETTING: "safe-value" },
        timeout: 15_000,
      },
    });
    expect(configValue(project("claude-code", input), "mcp", "mcpServers")).toMatchObject({
      docs: { type: "http", headers: { Authorization: "${DOCS_MCP_TOKEN}" } },
    });
  });

  it("projects the Kimi, Qwen, Antigravity and Grok native fields", () => {
    const input = model({ mcp: servers });
    expect(configValue(project("kimi", input), "mcp", "mcpServers")).toMatchObject({
      docs: { transport: "http", bearerTokenEnvVar: "DOCS_MCP_TOKEN", headers: { "X-Static": "safe-value" } },
      local: { transport: "stdio", startupTimeoutMs: 15_000, toolTimeoutMs: 15_000, enabledTools: ["read"], disabledTools: ["delete"] },
    });
    expect(configValue(project("qwen", input), "settings", "mcpServers")).toMatchObject({
      docs: { httpUrl: "https://example.invalid/mcp", timeout: 10_000 },
      local: { includeTools: ["read"], excludeTools: ["delete"] },
    });
    expect(configValue(project("antigravity", input), "mcp", "mcpServers")).toMatchObject({
      docs: { serverUrl: "https://example.invalid/mcp", timeoutSeconds: 10 },
      local: { enabledTools: ["read"], disabledTools: ["delete"], timeoutSeconds: 15 },
    });
    expect(configValue(project("grok-build", input), "config", "mcp_servers")).toMatchObject({
      local: { env: { API_KEY: "${API_KEY}" }, startup_timeout_sec: 15, tool_timeout_sec: 15 },
    });
  });

  it("reports Codex environment renames and SSE servers Pi cannot load", () => {
    const renamed: McpServer = { transport: "stdio", command: "tool", args: [], env: { API_KEY: { fromEnv: "OTHER_KEY" } } };
    const codex = project("codex", model({ mcp: [["local", renamed]] }));
    expect(codes(codex)).toContain("MCP_ENV_RENAME_UNSUPPORTED");
    expect(configValue(codex, "config", "mcp_servers")).toEqual({ local: { command: "tool" } });

    const sse: McpServer = { transport: "sse", url: "https://example.invalid/sse", headers: {} };
    const pi = project("pi", model({ mcp: [["legacy", sse]] }));
    expect(codes(pi)).toContain("MCP_TRANSPORT_UNSUPPORTED");
    expect(pi.contents.filter((entry) => entry.surface === "mcp")).toEqual([]);
  });
});

describe("generated hook runtime", () => {
  const roots: Array<string> = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  /** A Canonical Folder with the runner, its registry and a hook that records its environment. */
  async function folderWithRunner(): Promise<{ readonly root: string; readonly folder: string; readonly runner: string; readonly hook: Hook }> {
    const root = await mkdtemp(path.join(tmpdir(), "canonfig-runtime-"));
    roots.push(root);
    const folder = path.join(root, ".canonfig");
    const runner = path.join(folder, ".runtime", "hook-runner.mjs");
    const script = path.join(folder, "hooks", "record.mjs");
    await mkdir(path.dirname(runner), { recursive: true });
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, [
      'import { writeFileSync } from "node:fs";',
      'import path from "node:path";',
      "writeFileSync(path.join(process.env.CANONFIG_ROOT, \"hook-hit\"), JSON.stringify({",
      "  cwd: process.cwd(), target: process.env.CANONFIG_TARGET, event: process.env.CANONFIG_EVENT,",
      "}));",
      "",
    ].join("\n"));
    const hook: Hook = { ...guard, run: ["node", script] };
    await writeFile(runner, hookRunnerSource("hooks.json"));
    await chmod(runner, 0o755);
    await writeFile(path.join(folder, ".runtime", "hooks.json"), hookRegistryJson([hook]));
    return { root, folder, runner, hook };
  }

  it("runs a hook in the caller's directory with CANONFIG_ROOT set to the folder", async () => {
    const { root, folder, runner, hook } = await folderWithRunner();
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const child = spawnSync(process.execPath, [runner, "--hook", hook.id, "--target", "codex", "--event", "before_tool"], {
      cwd: workspace,
      input: JSON.stringify({ tool_name: "bash", tool_input: { command: "git push" } }),
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(await readFile(path.join(folder, "hook-hit"), "utf8"))).toEqual({
      cwd: workspace, target: "codex", event: "before_tool",
    });
  });

  it("skips a hook whose canonical matcher does not match", async () => {
    const { folder, runner, hook } = await folderWithRunner();
    const child = spawnSync(process.execPath, [runner, "--hook", hook.id, "--target", "codex", "--event", "before_tool"], {
      input: JSON.stringify({ tool_name: "bash", tool_input: { command: "git status" } }),
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(child.status, child.stderr).toBe(0);
    await expect(readFile(path.join(folder, "hook-hit"), "utf8")).rejects.toThrow();
  });

  it("runs the OpenCode plugin through node even when the client embeds its own runtime", async () => {
    const { root, folder, runner, hook } = await folderWithRunner();
    const plugin = path.join(root, "opencode", "plugins", "canonfig.ts");
    await mkdir(path.dirname(plugin), { recursive: true });
    await writeFile(plugin, openCodePluginSource("opencode", runner, [{ hook, event: "tool.execute.before" }]));

    // The generated module has a per-test temporary path, so it must be loaded at runtime.
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", [
      `Object.defineProperty(process, "execPath", { value: ${JSON.stringify(path.join(root, "embedded-client"))} });`,
      `const { default: plugin } = await import(${JSON.stringify(pathToFileURL(plugin).href)});`,
      'const hooks = new Map(); await plugin.setup({ tool: { hook: async (name, handler) => { hooks.set(name, handler); } } });',
      'await hooks.get("execute.before")({ tool: "bash", input: { command: "git push" } });',
    ].join("\n")], { cwd: root, encoding: "utf8", timeout: 10_000 });

    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(await readFile(path.join(folder, "hook-hit"), "utf8"))).toMatchObject({ cwd: root, target: "opencode" });
  });
});
