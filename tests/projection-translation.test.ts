import { parse as parseToml } from "smol-toml";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  claudeAdapter,
  codexAdapter,
  cursorAdapter,
  droidAdapter,
  hermesAdapter,
  kiloAdapter,
  kimiAdapter,
  opencodeAdapter,
  qwenAdapter,
} from "../src/projection/adapters/index.ts";
import { enabledHooks } from "../src/projection/adapters/shared.ts";
import {
  compatibilityDiagnostics,
  strictDiagnostics,
  usedFeatures,
} from "../src/projection/core/compatibility.ts";
import { renderArtifacts } from "../src/projection/core/render.ts";
import { CanonfigConfigSchema } from "../src/projection/core/schema.ts";
import type {
  BuildContext,
  BuildResult,
  CleanupInstruction,
  DesiredArtifact,
  HarnessAdapter,
} from "../src/projection/core/types.ts";
import { validateFolder } from "../src/projection/core/validation.ts";
import { hookRegistryJson, hookRunnerSource } from "../src/projection/templates/runtime.ts";

// The translators read canonical sources from a folder and return artifacts.
// These tests drive them directly: no planner, no state file, no writes
// outside a temporary directory.

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

async function write(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

const baseConfig = (mcpEnabled: boolean) => ({
  version: 1,
  targets: {},
  instructions: {
    root: "instructions/AGENTS.md",
    rules: [{
      id: "source",
      file: "rules/source.md",
      paths: ["src/**"],
      activation: "path",
      description: "Source rules",
    }],
  },
  skills: { roots: ["skills"] },
  mcp: {
    servers: {
      local: {
        enabled: mcpEnabled,
        transport: "stdio",
        command: "node",
        args: ["tools/server.mjs"],
        cwd: ".",
        env: { API_KEY: { fromEnv: "TEST_API_KEY" } },
        timeoutMs: 15_000,
        enabledTools: ["read"],
        disabledTools: ["delete"],
      },
      docs: {
        enabled: mcpEnabled,
        transport: "streamable-http",
        url: "https://example.invalid/mcp",
        headers: { Authorization: { fromEnv: "DOCS_TOKEN" } },
        timeoutMs: 10_000,
      },
    },
  },
  hooks: [{
    id: "guard-shell",
    event: "before_tool",
    enabled: true,
    matcher: {
      capabilities: ["shell"],
      tools: [],
      inputRegex: "git\\s+push",
    },
    run: ["node", ".canonfig/hooks/guard.mjs"],
    timeoutMs: 5_000,
    onFailure: "block",
  }],
  agents: [{
    id: "reviewer",
    file: "agents/reviewer.md",
    description: "Review changes",
    model: "inherit",
    tools: ["read", "search", "mcp"],
    writable: false,
  }],
  commands: [{
    id: "release-check",
    file: "commands/release-check.md",
    description: "Check release readiness",
    argumentHint: "[scope]",
  }],
  permissions: { rules: [] },
  extensions: {},
});

/** A canonical folder holding every source `baseConfig` names. */
async function canonicalFolder(): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), "canonfig-projection-"));
  roots.push(folder);
  await write(folder, "instructions/AGENTS.md", "# Instructions\n\nRun tests.\n");
  await write(folder, "rules/source.md", "# Source rules\n\nKeep changes scoped.\n");
  await write(folder, "agents/reviewer.md", "Return severity-ranked findings.\n");
  await write(folder, "commands/release-check.md", "Inspect the current release.\n");
  await write(folder, "hooks/guard.mjs", "process.exit(0);\n");
  await write(folder, "skills/repository-checks/SKILL.md", [
    "---",
    "name: repository-checks",
    "description: Run repository checks.",
    "---",
    "",
    "Run the relevant checks.",
    "",
  ].join("\n"));
  return folder;
}

const contextFor = (
  canonfigDir: string,
  config: unknown,
  adapter: HarnessAdapter,
): BuildContext => ({
  canonfigDir,
  config: CanonfigConfigSchema.parse(config),
  target: adapter.descriptor.id,
  targetOptions: {},
});

async function project(
  adapter: HarnessAdapter,
  config: unknown = baseConfig(true),
  canonfigDir?: string,
): Promise<BuildResult> {
  return adapter.build(contextFor(canonfigDir ?? await canonicalFolder(), config, adapter));
}

const atPath = (artifacts: readonly DesiredArtifact[], target: string) =>
  artifacts.filter((artifact) => artifact.path === target);

/** Render every artifact for one path onto `current`, failing on conflicts. */
function render(
  artifacts: readonly DesiredArtifact[],
  target: string,
  current?: string,
): { content: string; cleanup: CleanupInstruction[] } {
  const owned = atPath(artifacts, target);
  expect(owned, target).not.toEqual([]);
  const rendered = renderArtifacts(owned, current, undefined);
  expect(rendered.conflicts).toEqual([]);
  return { content: String(rendered.content), cleanup: rendered.cleanup };
}

const json = (artifacts: readonly DesiredArtifact[], target: string) =>
  JSON.parse(render(artifacts, target).content);

describe("native Claude and Droid hook events", () => {
  it.each([
    ["claude-code", "before_agent"], ["claude-code", "after_agent"],
    ["factory-droid", "before_agent"], ["factory-droid", "after_agent"],
    ["factory-droid", "after_compact"], ["factory-droid", "subagent_start"],
  ] as const)("reports unsupported %s event %s and rejects it in strict mode", async (target, event) => {
    const adapter = target === "claude-code" ? claudeAdapter : droidAdapter;
    const config = baseConfig(false);
    config.hooks = [{ ...config.hooks[0]!, event }];
    const result = await project(adapter, config);

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "HOOK_EVENT_UNSUPPORTED", target, level: "warning" }),
    ]));
    expect(atPath(result.artifacts, target === "claude-code" ? ".claude/settings.json" : ".factory/hooks.json"))
      .toEqual([]);
    expect(strictDiagnostics(result.diagnostics)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "HOOK_EVENT_UNSUPPORTED", target, level: "error" }),
    ]));
  });

  it("writes Droid hooks at the documented root and removes only owned hooks on cleanup", async () => {
    const result = await project(droidAdapter, baseConfig(false));
    const native = { Notification: [{ matcher: ".*", hooks: [{ type: "command", command: "echo user" }] }] };
    const first = render(result.artifacts, ".factory/hooks.json", JSON.stringify(native));
    const generated = JSON.parse(first.content);

    expect(generated.hooks).toBeUndefined();
    expect(generated.Notification).toEqual(native.Notification);
    expect(generated.PreToolUse[0].hooks[0].command)
      .toContain("$FACTORY_PROJECT_DIR/.canonfig/.runtime/hook-runner.mjs");

    const previous = { owner: "factory-droid" as const, hash: "", existedBefore: true, cleanup: first.cleanup };
    const again = renderArtifacts(atPath(result.artifacts, ".factory/hooks.json"), first.content, previous);
    expect(again.conflicts).toEqual([]);
    expect(again.content).toBe(first.content);

    const removed = renderArtifacts([], first.content, previous);
    expect(removed.conflicts).toEqual([]);
    expect(JSON.parse(String(removed.content))).toEqual(native);
  });
});

describe("Kimi, Kilo, Hermes, and Qwen translators", () => {
  it("project the researched native equivalents", async () => {
    const folder = await canonicalFolder();
    const config = baseConfig(true);
    const [kimi, kilo, hermes, qwen] = await Promise.all(
      [kimiAdapter, kiloAdapter, hermesAdapter, qwenAdapter].map((adapter) => project(adapter, config, folder)),
    );
    for (const result of [kimi!, kilo!, hermes!, qwen!]) {
      expect(result.diagnostics.filter((diagnostic) => diagnostic.level === "error")).toEqual([]);
    }

    const kimiMcp = json(kimi!.artifacts, ".kimi-code/mcp.json");
    expect(kimiMcp.mcpServers.local).toMatchObject({
      transport: "stdio",
      startupTimeoutMs: 15_000,
      toolTimeoutMs: 15_000,
      enabledTools: ["read"],
      disabledTools: ["delete"],
    });
    expect(kimiMcp.mcpServers.docs).toMatchObject({
      transport: "http",
      bearerTokenEnvVar: "DOCS_TOKEN",
    });
    expect(render(kimi!.artifacts, ".kimi-code/agents/reviewer.md").content).toContain("mcp__*");

    const kiloConfig = json(kilo!.artifacts, "kilo.json");
    expect(kiloConfig.$schema).toBe("https://app.kilo.ai/config.json");
    expect(kiloConfig.mcp.local).toBeDefined();
    expect(render(kilo!.artifacts, ".kilo/plugins/canonfig.ts").content).toContain('"--target", "kilo"');

    expect(render(hermes!.artifacts, ".hermes.md").content).toContain("## Canonical commands");

    const qwenSettings = json(qwen!.artifacts, ".qwen/settings.json");
    expect(qwenSettings.mcpServers.docs).toMatchObject({
      httpUrl: "https://example.invalid/mcp",
      timeout: 10_000,
    });
    expect(qwenSettings.mcpServers.local).toMatchObject({
      includeTools: ["read"],
      excludeTools: ["delete"],
    });
    expect(qwenSettings.hooks.PreToolUse).toEqual([expect.objectContaining({
      matcher: "*",
      hooks: [expect.objectContaining({ timeout: 5_000 })],
    })]);
    expect(render(qwen!.artifacts, ".qwen/commands/release-check.md").content)
      .toContain("description: Check release readiness");
  });

  it("stage no MCP material when every server is disabled", async () => {
    const folder = await canonicalFolder();
    const kimi = await project(kimiAdapter, baseConfig(false), folder);
    const kilo = await project(kiloAdapter, baseConfig(false), folder);

    expect(atPath(kimi.artifacts, ".kimi-code/mcp.json")).toEqual([]);
    expect(atPath(kilo.artifacts, "kilo.json")).toEqual([]);
  });

  it("reject Hermes profile-scoped losses in strict mode", () => {
    const config = CanonfigConfigSchema.parse(baseConfig(true));
    expect(compatibilityDiagnostics(hermesAdapter.descriptor, usedFeatures(config), true))
      .toContainEqual(expect.objectContaining({
        target: "hermes",
        code: "FEATURE_LOSSY",
        level: "error",
      }));
  });
});

describe("OpenCode hook execution", () => {
  it("uses Node even when the client executable embeds its own runtime", async () => {
    // The generated plugin finds the runner under `<root>/.canonfig/.runtime`.
    const root = await mkdtemp(path.join(tmpdir(), "canonfig-opencode-hook-"));
    roots.push(root);
    const folder = path.join(root, ".canonfig");
    await mkdir(folder);
    await write(folder, "instructions/AGENTS.md", "# Instructions\n");
    await write(folder, "hooks/guard.mjs", [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(".canonfig/hook-hit", "hit\\n");',
      "",
    ].join("\n"));
    const config = { ...baseConfig(false), instructions: { root: "instructions/AGENTS.md" }, skills: { roots: [] }, agents: [], commands: [] };
    const context = contextFor(folder, config, opencodeAdapter);
    const result = await opencodeAdapter.build(context);
    await write(root, ".opencode/plugins/canonfig.ts", render(result.artifacts, ".opencode/plugins/canonfig.ts").content);
    await write(root, ".canonfig/.runtime/hook-runner.mjs", hookRunnerSource());
    await write(root, ".canonfig/.runtime/hooks.json", hookRegistryJson(enabledHooks(context)));

    const plugin = pathToFileURL(path.join(root, ".opencode/plugins/canonfig.ts")).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", [
      `Object.defineProperty(process, "execPath", { value: ${JSON.stringify(path.join(root, "embedded-client"))} });`,
      `const { CanonfigPlugin } = await import(${JSON.stringify(plugin)});`,
      'await (await CanonfigPlugin())["tool.execute.before"]({ tool: "bash" }, { args: { command: "git push" } });',
    ].join("\n")], { cwd: root, encoding: "utf8", timeout: 10_000 });

    expect(child.status, child.stderr).toBe(0);
    await expect(readFile(path.join(root, ".canonfig/hook-hit"), "utf8"))
      .resolves.toBe("hit\n");
  });
});

describe("native MCP environment references", () => {
  const referenceConfig = (alias = false) => ({
    version: 1,
    targets: {},
    instructions: { root: "instructions/AGENTS.md" },
    mcp: { servers: {
      local: { transport: "stdio", command: "fixture-tool", env: {
        API_KEY: { fromEnv: alias ? "OTHER_API_KEY" : "API_KEY" }, PLAIN_SETTING: "safe-value",
      } },
      docs: { transport: "streamable-http", url: "https://example.invalid/mcp", headers: {
        Authorization: { fromEnv: "DOCS_MCP_TOKEN" }, "X-Static": "safe-value",
      } },
    } },
  });

  it("writes each client's documented reference syntax without resolving secrets", async () => {
    const folder = await canonicalFolder();
    const config = referenceConfig();
    const codex = await project(codexAdapter, config, folder);
    const cursor = await project(cursorAdapter, config, folder);
    const opencode = await project(opencodeAdapter, config, folder);
    for (const result of [codex, cursor, opencode]) {
      expect(strictDiagnostics(result.diagnostics).filter((item) => item.level === "error")).toEqual([]);
    }

    const codexToml = render(codex.artifacts, ".codex/config.toml").content;
    expect(parseToml(codexToml)).toMatchObject({ mcp_servers: {
      local: { env_vars: ["API_KEY"], env: { PLAIN_SETTING: "safe-value" } },
      docs: { env_http_headers: { Authorization: "DOCS_MCP_TOKEN" }, http_headers: { "X-Static": "safe-value" } },
    } });
    expect(codexToml).not.toContain("${");
    const cursorMcp = json(cursor.artifacts, ".cursor/mcp.json");
    expect(cursorMcp.mcpServers.local.env.API_KEY).toBe("${env:API_KEY}");
    expect(cursorMcp.mcpServers.docs.headers.Authorization).toBe("${env:DOCS_MCP_TOKEN}");
    const opencodeConfig = json(opencode.artifacts, "opencode.json");
    expect(opencodeConfig.mcp.local.environment.API_KEY).toBe("{env:API_KEY}");
    expect(opencodeConfig.mcp.docs.headers.Authorization).toBe("{env:DOCS_MCP_TOKEN}");
  });

  it.each([false, true])("warns about and strictly rejects Kilo references (literal syntax: %s)", async (literal) => {
    const config = referenceConfig();
    if (literal) {
      config.mcp.servers.local.env.API_KEY = "{env:API_KEY}" as never;
      config.mcp.servers.docs.headers.Authorization = "{env:DOCS_MCP_TOKEN}" as never;
    }
    const result = await project(kiloAdapter, config);
    expect(result.diagnostics.filter((item) => item.code === "MCP_ENV_PROJECT_UNSUPPORTED")).toHaveLength(2);
    expect(strictDiagnostics(result.diagnostics)
      .filter((item) => item.code === "MCP_ENV_PROJECT_UNSUPPORTED")
      .every((item) => item.level === "error")).toBe(true);
  });

  it("rejects unsupported Codex environment renaming in strict mode", async () => {
    const result = await project(codexAdapter, referenceConfig(true));
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MCP_ENV_RENAME_UNSUPPORTED", target: "codex", level: "warning" }),
    ]));
    expect(strictDiagnostics(result.diagnostics)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MCP_ENV_RENAME_UNSUPPORTED", target: "codex", level: "error" }),
    ]));
  });
});

describe("canonical folder validation", () => {
  it("reports missing sources relative to the folder", async () => {
    const folder = await canonicalFolder();
    await rm(path.join(folder, "agents/reviewer.md"));
    const diagnostics = await validateFolder(folder, CanonfigConfigSchema.parse(baseConfig(true)));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      level: "error",
      code: "SOURCE_MISSING",
      path: "agents/reviewer.md",
    }));
  });
});
