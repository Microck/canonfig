import { parse as parseToml } from "smol-toml";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { HarnessConfigurationCompiler } from "../src/harness-configuration/core/compiler.ts";
import { applyPlan } from "../src/harness-configuration/core/planner.ts";
import type { TargetId } from "../src/harness-configuration/core/types.ts";

const roots: string[] = [];

async function write(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function fixture(
  targets: readonly TargetId[],
  mcpEnabled = true,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "canonfig-new-targets-"));
  roots.push(root);
  const config = {
    version: 1,
    project: { name: "new-targets" },
    targets: Object.fromEntries(targets.map((target) => [target, {
      enabled: true,
      options: {},
    }])),
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
  };

  await write(root, ".canonfig/harness.json", `${JSON.stringify(config, undefined, 2)}\n`);
  await write(root, ".canonfig/instructions/AGENTS.md", "# Instructions\n\nRun tests.\n");
  await write(root, ".canonfig/rules/source.md", "# Source rules\n\nKeep changes scoped.\n");
  await write(root, ".canonfig/agents/reviewer.md", "Return severity-ranked findings.\n");
  await write(root, ".canonfig/commands/release-check.md", "Inspect the current release.\n");
  await write(root, ".canonfig/hooks/guard.mjs", "process.exit(0);\n");
  await write(root, ".canonfig/skills/repository-checks/SKILL.md", [
    "---",
    "name: repository-checks",
    "description: Run repository checks.",
    "---",
    "",
    "Run the relevant checks.",
    "",
  ].join("\n"));
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("Kimi, Kilo, Hermes, and Qwen harness adapters", () => {
  it("projects the researched native equivalents and remains idempotent", async () => {
    const root = await fixture(["kimi", "kilo", "hermes", "qwen"]);
    const compiler = new HarnessConfigurationCompiler();
    const first = await compiler.plan({ root });

    expect(first.diagnostics.filter((diagnostic) => diagnostic.level === "error"))
      .toEqual([]);
    expect(first.entries.some((entry) => entry.action === "conflict")).toBe(false);
    await applyPlan(first);

    const kimiMcp = JSON.parse(
      await readFile(path.join(root, ".kimi-code/mcp.json"), "utf8"),
    );
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
    await expect(readFile(path.join(root, ".kimi-code/agents/reviewer.md"), "utf8"))
      .resolves.toContain("mcp__*");

    const kilo = JSON.parse(
      await readFile(path.join(root, "kilo.json"), "utf8"),
    );
    expect(kilo.$schema).toBe("https://app.kilo.ai/config.json");
    expect(kilo.mcp.local).toBeDefined();
    await expect(readFile(path.join(root, ".kilo/plugins/canonfig.ts"), "utf8"))
      .resolves.toContain('"--target", "kilo"');

    await expect(readFile(path.join(root, ".hermes.md"), "utf8"))
      .resolves.toContain("## Canonical commands");

    const qwen = JSON.parse(
      await readFile(path.join(root, ".qwen/settings.json"), "utf8"),
    );
    expect(qwen.mcpServers.docs).toMatchObject({
      httpUrl: "https://example.invalid/mcp",
      timeout: 10_000,
    });
    expect(qwen.mcpServers.local).toMatchObject({
      includeTools: ["read"],
      excludeTools: ["delete"],
    });
    expect(qwen.hooks.PreToolUse).toEqual([expect.objectContaining({
      matcher: "*",
      hooks: [expect.objectContaining({ timeout: 5_000 })],
    })]);
    await expect(readFile(path.join(root, ".qwen/commands/release-check.md"), "utf8"))
      .resolves.toContain("description: Check release readiness");

    const second = await compiler.plan({ root });
    expect(second.entries.filter((entry) => entry.action !== "unchanged"))
      .toEqual([]);
  });

  it("stages no MCP material when every server is disabled", async () => {
    const root = await fixture(["kimi", "kilo"], false);
    const plan = await new HarnessConfigurationCompiler().plan({ root });
    const paths = plan.entries.map((entry) => entry.path);

    expect(paths).not.toContain(".kimi-code/mcp.json");
    expect(paths).not.toContain("kilo.json");
  });

  it("rejects Hermes profile-scoped losses in strict mode", async () => {
    const root = await fixture(["hermes"]);
    const plan = await new HarnessConfigurationCompiler().plan({
      root,
      strict: true,
    });

    expect(plan.diagnostics).toContainEqual(expect.objectContaining({
      target: "hermes",
      code: "FEATURE_LOSSY",
      level: "error",
    }));
  });
});

describe("OpenCode hook execution", () => {
  it("uses Node even when the client executable embeds its own runtime", async () => {
    const root = await fixture(["opencode"], false);
    await write(root, ".canonfig/hooks/guard.mjs", [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(".canonfig/hook-hit", "hit\\n");',
      "",
    ].join("\n"));
    await applyPlan(await new HarnessConfigurationCompiler().plan({ root }));

    const plugin = pathToFileURL(path.join(root, ".opencode/plugins/canonfig.ts")).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", [
      `Object.defineProperty(process, "execPath", { value: ${JSON.stringify(path.join(root, "embedded-client"))} });`,
      `const { CanonfigPlugin } = await import(${JSON.stringify(plugin)});`,
      'await (await CanonfigPlugin())["tool.execute.before"]({ tool: "bash" }, { args: { command: "git push" } });',
    ].join("\n")], { cwd: root, encoding: "utf8", timeout: 10_000 });

    expect(child.status).toBe(0);
    await expect(readFile(path.join(root, ".canonfig/hook-hit"), "utf8"))
      .resolves.toBe("hit\n");
  });
});


describe("native MCP environment references", () => {
  async function referenceFixture(alias = false) {
    const targets: TargetId[] = ["codex", "cursor", "opencode", "kilo"];
    const root = await fixture(targets);
    await write(root, ".canonfig/harness.json", JSON.stringify({
      version: 1, targets: Object.fromEntries(targets.map((id) => [id, { enabled: true }])),
      instructions: { root: "instructions/AGENTS.md" },
      mcp: { servers: {
        local: { transport: "stdio", command: "fixture-tool", env: {
          API_KEY: { fromEnv: alias ? "OTHER_API_KEY" : "API_KEY" }, PLAIN_SETTING: "safe-value",
        } },
        docs: { transport: "streamable-http", url: "https://example.invalid/mcp", headers: {
          Authorization: { fromEnv: "DOCS_MCP_TOKEN" }, "X-Static": "safe-value",
        } },
      } },
    }));
    return root;
  }

  it("writes each client's documented reference syntax without resolving secrets", async () => {
    const root = await referenceFixture();
    const plan = await new HarnessConfigurationCompiler().plan({ root, targets: ["codex", "cursor", "opencode"], strict: true });
    expect(plan.diagnostics.filter((item) => item.level === "error")).toEqual([]);
    await applyPlan(plan);
    const codex = await readFile(path.join(root, ".codex/config.toml"), "utf8");
    expect(parseToml(codex)).toMatchObject({ mcp_servers: {
      local: { env_vars: ["API_KEY"], env: { PLAIN_SETTING: "safe-value" } },
      docs: { env_http_headers: { Authorization: "DOCS_MCP_TOKEN" }, http_headers: { "X-Static": "safe-value" } },
    } });
    expect(codex).not.toContain("${");
    const cursor = JSON.parse(await readFile(path.join(root, ".cursor/mcp.json"), "utf8"));
    expect(cursor.mcpServers.local.env.API_KEY).toBe("${env:API_KEY}");
    expect(cursor.mcpServers.docs.headers.Authorization).toBe("${env:DOCS_MCP_TOKEN}");
    for (const file of ["opencode.json"]) {
      const native = JSON.parse(await readFile(path.join(root, file), "utf8"));
      expect(native.mcp.local.environment.API_KEY).toBe("{env:API_KEY}");
      expect(native.mcp.docs.headers.Authorization).toBe("{env:DOCS_MCP_TOKEN}");
    }
  });

  it.each([false, true])("warns and rejects Kilo project references (literal syntax: %s)", async (literal) => {
    const root = await referenceFixture();
    if (literal) {
      const source = JSON.parse(await readFile(path.join(root, ".canonfig/harness.json"), "utf8"));
      source.mcp.servers.local.env.API_KEY = "{env:API_KEY}";
      source.mcp.servers.docs.headers.Authorization = "{env:DOCS_MCP_TOKEN}";
      await write(root, ".canonfig/harness.json", JSON.stringify(source));
    }
    const compiler = new HarnessConfigurationCompiler();
    const ordinary = await compiler.plan({ root, targets: ["kilo"] });
    expect(ordinary.diagnostics.filter((item) => item.code === "MCP_ENV_PROJECT_UNSUPPORTED"))
      .toHaveLength(2);
    const strict = await compiler.plan({ root, targets: ["kilo"], strict: true });
    expect(strict.diagnostics.filter((item) => item.code === "MCP_ENV_PROJECT_UNSUPPORTED")
      .every((item) => item.level === "error")).toBe(true);
    await expect(applyPlan(strict)).rejects.toThrow();
    await expect(readFile(path.join(root, "kilo.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsupported Codex environment renaming in strict mode", async () => {
    const root = await referenceFixture(true);
    const compiler = new HarnessConfigurationCompiler();
    const ordinary = await compiler.plan({ root, targets: ["codex"] });
    expect(ordinary.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MCP_ENV_RENAME_UNSUPPORTED", target: "codex", level: "warning" }),
    ]));
    const strict = await compiler.plan({ root, targets: ["codex"], strict: true });
    expect(strict.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MCP_ENV_RENAME_UNSUPPORTED", target: "codex", level: "error" }),
    ]));
    await expect(applyPlan(strict)).rejects.toThrow();
    await expect(readFile(path.join(root, ".codex/config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
