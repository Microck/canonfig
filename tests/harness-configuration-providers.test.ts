import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

async function fixture(targets: readonly TargetId[]): Promise<string> {
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
          enabled: true,
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
          enabled: true,
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
    ) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
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

    const kilo = JSON.parse(await readFile(path.join(root, "kilo.json"), "utf8")) as {
      $schema: string;
      mcp: Record<string, unknown>;
    };
    expect(kilo.$schema).toBe("https://app.kilo.ai/config.json");
    expect(kilo.mcp.local).toBeDefined();
    await expect(readFile(path.join(root, ".kilo/plugins/canonfig.ts"), "utf8"))
      .resolves.toContain('"--target", "kilo"');

    await expect(readFile(path.join(root, ".hermes.md"), "utf8"))
      .resolves.toContain("## Canonical commands");

    const qwen = JSON.parse(
      await readFile(path.join(root, ".qwen/settings.json"), "utf8"),
    ) as {
      mcpServers: Record<string, Record<string, unknown>>;
      hooks: Record<string, unknown>;
    };
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
      hooks: [expect.objectContaining({ timeout: 5 })],
    })]);
    await expect(readFile(path.join(root, ".qwen/commands/release-check.md"), "utf8"))
      .resolves.toContain("description: Check release readiness");

    const second = await compiler.plan({ root });
    expect(second.entries.filter((entry) => entry.action !== "unchanged"))
      .toEqual([]);
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
