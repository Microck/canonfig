import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HarnessConfigurationCompiler } from "../src/harness-configuration/core/compiler.ts";
import { applyPlan } from "../src/harness-configuration/core/planner.ts";

const roots: string[] = [];

async function write(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "canonfig-antigravity-"));
  roots.push(root);
  const config = {
    version: 1,
    project: { name: "antigravity-regression" },
    targets: { antigravity: { enabled: true, options: {} } },
    instructions: { root: "instructions/AGENTS.md", rules: [] },
    skills: { roots: ["skills"] },
    mcp: { servers: {} },
    hooks: [],
    agents: [],
    commands: [],
    permissions: { rules: [] },
    extensions: {},
  };

  await write(root, ".canonfig/harness.json", `${JSON.stringify(config, undefined, 2)}\n`);
  await write(root, ".canonfig/instructions/AGENTS.md", "# Instructions\n");
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

describe("Antigravity harness adapter", () => {
  it("retains canonical skills without duplicate output", async () => {
    const root = await fixture();
    const compiler = new HarnessConfigurationCompiler();
    const skillPath = ".agents/skills/repository-checks/SKILL.md";

    const adapterOnly = await compiler.build({ root, includeCommon: false });
    expect(adapterOnly.artifacts.filter((artifact) => artifact.path === skillPath))
      .toHaveLength(1);

    const first = await compiler.plan({ root });
    expect(first.entries.filter((entry) => entry.path === skillPath))
      .toHaveLength(1);
    expect(first.entries.some((entry) => entry.action === "conflict")).toBe(false);
    await applyPlan(first);

    await expect(readFile(path.join(root, skillPath), "utf8"))
      .resolves.toContain("Run the relevant checks.");

    const second = await compiler.plan({ root });
    expect(second.entries.filter((entry) => entry.action !== "unchanged"))
      .toEqual([]);
  });
});
