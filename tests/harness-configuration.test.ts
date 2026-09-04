import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HarnessConfigurationCompiler,
  createDefaultRegistry,
} from "../src/harness-configuration/core/compiler.ts";
import {
  applyPlan,
  createPlan,
} from "../src/harness-configuration/core/planner.ts";
import { parseMarkdownDocument } from "../src/harness-configuration/core/frontmatter.ts";
import { applyJsonArtifact } from "../src/harness-configuration/core/render-json.ts";
import { unapplyPrevious } from "../src/harness-configuration/core/render-cleanup.ts";
import { findTomlSection } from "../src/harness-configuration/core/render-utils.ts";
import { scaffoldProject } from "../src/harness-configuration/core/scaffold.ts";
import {
  TARGET_IDS,
  type ArtifactState,
  type Plan,
  type TargetId,
} from "../src/harness-configuration/core/types.ts";

const temporaryRoots: string[] = [];

const temporaryRoot = async (prefix = "canonfig-harness-"): Promise<string> => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(tmpdir(), prefix))
  );
  temporaryRoots.push(root);
  return root;
};

const write = async (
  root: string,
  relative: string,
  content: string,
): Promise<void> => {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
};

const fixture = async (
  targets: ReadonlyArray<TargetId> = TARGET_IDS,
): Promise<string> => {
  const root = await temporaryRoot();
  const config = {
    version: 1,
    project: { name: "fixture" },
    targets: Object.fromEntries(targets.map((target) => [
      target,
      {
        enabled: true,
        options: target === "pi"
          ? { mcpPackage: "@canonfig/pi-mcp" }
          : {},
      },
    ])),
    instructions: {
      root: "instructions/AGENTS.md",
      rules: [{
        id: "source",
        file: "rules/source.md",
        paths: ["src/**", "tests/**"],
        activation: "path",
        description: "Source rules",
      }],
    },
    skills: { roots: ["skills"] },
    mcp: {
      servers: {
        local: {
          transport: "stdio",
          command: "node",
          args: ["tools/server.mjs"],
          env: { API_KEY: { fromEnv: "TEST_API_KEY" } },
        },
        docs: {
          transport: "streamable-http",
          url: "https://example.invalid/mcp",
          headers: { Authorization: { fromEnv: "DOCS_TOKEN" } },
        },
      },
    },
    hooks: [{
      id: "guard-shell",
      event: "before_tool",
      matcher: {
        capabilities: ["shell", "git"],
        tools: [],
        inputRegex: "git\\s+push",
      },
      run: ["node", ".canonfig/hooks/guard.mjs"],
      timeoutMs: 10_000,
      onFailure: "block",
    }],
    agents: [{
      id: "reviewer",
      file: "agents/reviewer.md",
      description: "Review changes",
      model: "inherit",
      tools: ["read", "search", "test", "git"],
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
  await write(root, ".canonfig/instructions/AGENTS.md", "# Canonical instructions\n\nRun tests before finishing.\n");
  await write(root, ".canonfig/rules/source.md", "# Source rules\n\nKeep changes scoped.\n");
  await write(root, ".canonfig/agents/reviewer.md", "Review correctness, regressions, and tests.\n");
  await write(root, ".canonfig/commands/release-check.md", "Run checks and report release blockers.\n");
  await write(root, ".canonfig/hooks/guard.mjs", "process.exit(0);\n");
  await write(root, ".canonfig/skills/repository-checks/SKILL.md", [
    "---",
    "name: repository-checks",
    "description: Run repository validation.",
    "---",
    "",
    "# Repository checks",
    "",
    "Run the smallest relevant checks.",
    "",
  ].join("\n"));
  return root;
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("harness configuration compiler", () => {
  it("compiles every requested target and becomes idempotent", async () => {
    const root = await fixture();
    const compiler = new HarnessConfigurationCompiler();

    const first = await compiler.plan({ root });
    expect(first.diagnostics.filter((diagnostic) => diagnostic.level === "error"))
      .toEqual([]);
    expect(first.entries.some((entry) => entry.action === "conflict")).toBe(false);
    await applyPlan(first);

    await expect(readFile(path.join(root, "AGENTS.md"), "utf8"))
      .resolves.toContain("Canonical instructions");
    await expect(readFile(path.join(root, ".codex/config.toml"), "utf8"))
      .resolves.toContain("canonfig:begin");
    await expect(readFile(path.join(root, ".claude/settings.json"), "utf8"))
      .resolves.toContain("PreToolUse");
    await expect(readFile(path.join(root, ".cursor/mcp.json"), "utf8"))
      .resolves.toContain("mcpServers");
    await expect(readFile(path.join(root, ".agents/mcp_config.json"), "utf8"))
      .resolves.toContain("mcpServers");

    const second = await compiler.plan({ root });
    expect(second.entries.filter((entry) => entry.action !== "unchanged"))
      .toEqual([]);
  });

  it("preserves unrelated JSON keys and removes only owned material", async () => {
    const root = await fixture(["claude-code"]);
    await write(
      root,
      ".claude/settings.json",
      `${JSON.stringify({
        theme: "dark",
        hooks: { Existing: [{ command: "echo keep" }] },
      }, undefined, 2)}\n`,
    );
    const compiler = new HarnessConfigurationCompiler();

    await applyPlan(await compiler.plan({ root }));
    const applied = JSON.parse(
      await readFile(path.join(root, ".claude/settings.json"), "utf8"),
    ) as {
      theme: string;
      hooks: Record<string, unknown>;
    };
    expect(applied.theme).toBe("dark");
    expect(applied.hooks.Existing).toEqual([{ command: "echo keep" }]);
    expect(applied.hooks.PreToolUse).toBeDefined();

    await applyPlan(await createPlan(root, ["claude-code"], [], []));
    const cleaned = JSON.parse(
      await readFile(path.join(root, ".claude/settings.json"), "utf8"),
    );
    expect(cleaned).toEqual({
      theme: "dark",
      hooks: { Existing: [{ command: "echo keep" }] },
    });
  });

  it("reports a missing source as a diagnostic instead of a raw ENOENT", async () => {
    // Compilation read the canonical sources after validation without checking
    // whether validation had failed, so a harness.yaml naming a source that
    // does not exist produced `ENOENT: no such file or directory, open '...'`
    // and exit 1, throwing away the SOURCE_MISSING diagnostic that validation
    // had just produced for exactly that case.
    const root = await fixture(["codex"]);
    await rm(path.join(root, ".canonfig", "instructions", "AGENTS.md"));

    const compiler = new HarnessConfigurationCompiler(createDefaultRegistry());
    const plan = await compiler.plan({ root });

    expect(plan.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SOURCE_MISSING", level: "error" }),
    ]));
    expect(plan.entries).toEqual([]);
  });

  it("rejects extension-backed shims in strict mode", async () => {
    const root = await fixture(["pi"]);
    const plan = await new HarnessConfigurationCompiler().plan({
      root,
      strict: true,
    });

    expect(plan.diagnostics).toContainEqual(expect.objectContaining({
      target: "pi",
      code: "FEATURE_SHIM",
      level: "error",
    }));
  });

  it("registers the complete requested harness set", () => {
    const registered = createDefaultRegistry()
      .list()
      .map((adapter) => adapter.descriptor.id)
      .sort();
    expect(registered).toEqual([...TARGET_IDS].sort());
  });

  it("creates a missing root and generates a strict-valid default project", async () => {
    const parent = await temporaryRoot();
    const root = path.join(parent, "missing", "project");

    await scaffoldProject(root);
    const plan = await new HarnessConfigurationCompiler().plan({
      root,
      strict: true,
    });

    expect(plan.diagnostics.filter((diagnostic) => diagnostic.level === "error"))
      .toEqual([]);
    expect(plan.targets).not.toContain("pi");
  });

  it("layers same-named skills by root precedence", async () => {
    const root = await fixture(["codex"]);
    const configPath = path.join(root, ".canonfig", "harness.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.skills.roots = ["user-skills", "project-skills"];
    await writeFile(configPath, `${JSON.stringify(config, undefined, 2)}\n`, "utf8");
    await write(root, ".canonfig/user-skills/change-impact-map/SKILL.md", [
      "---", "name: change-impact-map", "description: User default.", "---", "", "user", "",
    ].join("\n"));
    await write(root, ".canonfig/user-skills/change-impact-map/scripts/old.sh", "old\n");
    await write(root, ".canonfig/project-skills/change-impact-map/SKILL.md", [
      "---", "name: change-impact-map", "description: Project override.", "---", "", "project", "",
    ].join("\n"));

    const plan = await new HarnessConfigurationCompiler().plan({ root });

    expect(plan.diagnostics.filter((diagnostic) => diagnostic.level === "error"))
      .toEqual([]);
    const skill = plan.entries.find((entry) =>
      entry.path === ".agents/skills/change-impact-map/SKILL.md"
    );
    expect(skill).toBeDefined();
    const content = typeof skill!.content === "string"
      ? skill!.content
      : new TextDecoder().decode(skill!.content);
    expect(content).toContain("project");
    expect(content).not.toContain("user\n");
    expect(plan.entries.some((entry) =>
      entry.path === ".agents/skills/change-impact-map/scripts/old.sh"
    )).toBe(false);
  });

  it("rejects same-named skills at different artifact paths", async () => {
    const root = await fixture(["codex"]);
    const configPath = path.join(root, ".canonfig", "harness.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.skills.roots = ["user-skills", "project-skills"];
    await writeFile(configPath, `${JSON.stringify(config, undefined, 2)}\n`, "utf8");
    await write(root, ".canonfig/user-skills/first/SKILL.md", [
      "---", "name: shared-skill", "description: User default.", "---", "", "user", "",
    ].join("\n"));
    await write(root, ".canonfig/project-skills/second/SKILL.md", [
      "---", "name: shared-skill", "description: Project override.", "---", "", "project", "",
    ].join("\n"));

    const plan = await new HarnessConfigurationCompiler().plan({ root });

    expect(plan.diagnostics).toContainEqual(expect.objectContaining({
      code: "SKILL_NAME_DUPLICATE",
      level: "error",
      path: ".canonfig/project-skills/second/SKILL.md",
    }));
  });

  it.skipIf(process.platform === "win32")("restores symlink identity when apply rolls back", async () => {
    const root = await temporaryRoot();
    await write(root, "target.txt", "original\n");
    await symlink("target.txt", path.join(root, "link.txt"));

    const plan: Plan = {
      root,
      targets: ["codex"],
      diagnostics: [],
      entries: [
        { path: "link.txt", owner: "common", action: "update", after: "changed\n", content: "changed\n" },
        { path: "later.txt", owner: "common", action: "create" },
      ],
      nextState: {
        version: 1,
        generatedAt: new Date().toISOString(),
        canonfigVersion: "1",
        artifacts: {},
      },
    };

    await expect(applyPlan(plan)).rejects.toThrow("Missing output content");
    expect((await lstat(path.join(root, "link.txt"))).isSymbolicLink()).toBe(true);
    await expect(readlink(path.join(root, "link.txt"))).resolves.toBe("target.txt");
    await expect(readFile(path.join(root, "target.txt"), "utf8")).resolves.toBe("original\n");
  });

  it("accepts empty frontmatter and a closing fence at EOF", () => {
    expect(parseMarkdownDocument("---\n---")).toEqual({ data: {}, content: "" });
    expect(parseMarkdownDocument("---\nname: test\n---")).toEqual({ data: { name: "test" }, content: "" });
  });

  it("stops TOML sections at the next single-bracket table", () => {
    expect(findTomlSection(["[one]", "value = 1", "[two]", "value = 2"], "one"))
      .toEqual({ header: 0, end: 2 });
  });

  it("conflicts instead of replacing wrong-type managed JSON containers", () => {
    const mapConflicts: string[] = [];
    const mapped = applyJsonArtifact(
      '{"mcpServers":[]}\n',
      {
        kind: "json",
        path: ".mcp.json",
        owner: "common",
        operations: [{ kind: "managed-map", path: ["mcpServers"], entries: { local: {} } }],
      },
      false,
      mapConflicts,
    );
    expect(mapConflicts).toHaveLength(1);
    expect(JSON.parse(mapped.text)).toEqual({ mcpServers: [] });

    const arrayConflicts: string[] = [];
    const arrayed = applyJsonArtifact(
      '{"packages":{}}\n',
      {
        kind: "json",
        path: "settings.json",
        owner: "common",
        operations: [{ kind: "managed-array", path: ["packages"], values: ["pkg"] }],
      },
      false,
      arrayConflicts,
    );
    expect(arrayConflicts).toHaveLength(1);
    expect(JSON.parse(arrayed.text)).toEqual({ packages: {} });
  });

  it("does not recreate absent or empty JSON during cleanup", () => {
    const previous: ArtifactState = {
      owner: "common",
      hash: "unused",
      existedBefore: true,
      cleanup: [{
        kind: "json-managed-map",
        path: ["mcpServers"],
        entries: { local: {} },
        originals: { local: { existed: false } },
      }],
    };
    const missingConflicts: string[] = [];
    expect(unapplyPrevious(undefined, previous, false, missingConflicts)).toBeUndefined();
    expect(missingConflicts).toEqual([]);

    const emptyConflicts: string[] = [];
    expect(unapplyPrevious("", previous, false, emptyConflicts)).toBe("");
    expect(emptyConflicts).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("rejects scaffold writes through symlink escapes", async () => {
    const root = await temporaryRoot("canonfig-scaffold-root-");
    const outside = await temporaryRoot("canonfig-scaffold-outside-");
    await symlink(outside, path.join(root, ".canonfig"), "dir");

    await expect(scaffoldProject(root, { force: true })).rejects.toMatchObject({ code: "SYMLINK_ESCAPE" });
    await expect(readFile(path.join(outside, "harness.yaml"), "utf8")).rejects.toThrow();

    await rm(path.join(root, ".canonfig"));
    await mkdir(path.join(root, ".canonfig"), { recursive: true });
    const outsideTarget = path.join(outside, "existing.yaml");
    await writeFile(outsideTarget, "keep\n", "utf8");
    await symlink(outsideTarget, path.join(root, ".canonfig", "harness.yaml"));

    await expect(scaffoldProject(root, { force: true })).rejects.toMatchObject({ code: "SYMLINK_ESCAPE" });
    await expect(readFile(outsideTarget, "utf8")).resolves.toBe("keep\n");
  });
});
