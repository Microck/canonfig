import { parse as parseToml } from "smol-toml";
import { spawnSync } from "node:child_process";
import { chmod, stat, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
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
import { formatPlanDiff } from "../src/harness-configuration/core/diff.ts";
import { parseMarkdownDocument } from "../src/harness-configuration/core/frontmatter.ts";
import { runHarnessConfigurationCli } from "../src/harness-configuration/cli.ts";
import { loadState } from "../src/harness-configuration/core/state.ts";
import { isHarnessPlanBlocked } from "../src/harness-configuration/cli-output.ts";
import { applyJsonArtifact } from "../src/harness-configuration/core/render-json.ts";
import { unapplyPrevious } from "../src/harness-configuration/core/render-cleanup.ts";
import { findTomlSection } from "../src/harness-configuration/core/render-utils.ts";
import { scaffoldProject } from "../src/harness-configuration/core/scaffold.ts";
import {
  TARGET_IDS,
  type ArtifactState,
  type DesiredArtifact,
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
  it.each([false, true])("redacts credentials in real harness diffs (json: %s) without changing files", async (json) => {
    const root = await fixture(["claude-code"]);
    const native = JSON.stringify({ mcpServers: { existing: {
      command: "existing-tool", env: { GITHUB_TOKEN: "test-only-native-token" },
      args: ["test-only-native-token", "test-only-native-bearer"],
      headers: { Authorization: "Bearer test-only-native-bearer" },
    } } }, null, 2);
    await write(root, ".mcp.json", native);
    const output: string[] = [];
    let exitCode = -1;
    await runHarnessConfigurationCli(["diff", "--root", root, ...(json ? ["--json"] : [])], {
      writeStdout: (value) => output.push(value), writeStderr: (value) => output.push(value),
      setExitCode: (value) => { exitCode = value; },
    });
    expect(exitCode, output.join("")).toBe(0);
    const rendered = output.join("");
    expect(rendered).not.toContain("test-only-native-token");
    expect(rendered).not.toContain("test-only-native-bearer");
    if (!json) {
      expect(rendered).toContain("[REDACTED]");
      expect(rendered).toContain("existing-tool");
      expect(rendered).toContain("${TEST_API_KEY}");
      expect(rendered).toContain("${DOCS_TOKEN}");
      expect(rendered).toContain("+++ b/.mcp.json");
    }
    expect(await readFile(path.join(root, ".mcp.json"), "utf8")).toBe(native);
  });

  it("cleans only selected target artifacts and retains shared files until the last target", async () => {
    const root = await fixture(["codex", "claude-code"]);
    const compiler = new HarnessConfigurationCompiler();
    await applyPlan(await compiler.plan({ root }));
    const before = await loadState(root);
    const retained = Object.entries(before.artifacts).filter(([, state]) => state.owner !== "codex");
    const bytes = new Map(await Promise.all(retained.map(async ([file]) => [file, await readFile(path.join(root, file))] as const)));
    const output: string[] = [];
    let exitCode = -1;
    const io = { writeStdout: (value: string) => output.push(value), writeStderr: (value: string) => output.push(value),
      setExitCode: (value: number) => { exitCode = value; } };
    await runHarnessConfigurationCli(["clean", "--root", root, "--target", "codex", "--dry-run"], io);
    expect(exitCode, output.join("")).toBe(0);
    expect((await loadState(root)).artifacts).toEqual(before.artifacts);
    await runHarnessConfigurationCli(["clean", "--root", root, "--target", "codex"], io);
    expect(exitCode, output.join("")).toBe(0);
    for (const [file, content] of bytes) expect(await readFile(path.join(root, file))).toEqual(content);
    const after = await loadState(root);
    expect(Object.keys(after.artifacts).sort()).toEqual(retained.map(([file]) => file).sort());
    for (const [file, state] of Object.entries(before.artifacts)) {
      if (state.owner === "codex") await expect(readFile(path.join(root, file))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await runHarnessConfigurationCli(["clean", "--root", root, "--target", "claude-code"], io);
    expect(exitCode, output.join("")).toBe(0);
    expect((await loadState(root)).artifacts).toEqual({});
    await expect(readFile(path.join(root, "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains common-only Codex configuration when cleaning Claude", async () => {
    const root = await temporaryRoot();
    await write(root, ".canonfig/harness.json", JSON.stringify({ version: 1,
      targets: { codex: { enabled: true }, "claude-code": { enabled: true } },
      instructions: { root: "instructions/AGENTS.md" } }));
    await write(root, ".canonfig/instructions/AGENTS.md", "# Shared instructions\n");
    await applyPlan(await new HarnessConfigurationCompiler().plan({ root }));
    const before = await readFile(path.join(root, "AGENTS.md"));
    let exitCode = -1;
    const io = { writeStdout: (_value: string) => {}, writeStderr: (_value: string) => {},
      setExitCode: (value: number) => { exitCode = value; } };
    await runHarnessConfigurationCli(["clean", "--root", root, "--target", "claude-code"], io);
    expect(exitCode).toBe(0);
    expect(await readFile(path.join(root, "AGENTS.md"))).toEqual(before);
    await runHarnessConfigurationCli(["clean", "--root", root, "--target", "codex"], io);
    expect(exitCode).toBe(0);
    await expect(readFile(path.join(root, "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

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
    const codexHooks = JSON.parse(await readFile(path.join(root, ".codex/hooks.json"), "utf8"));
    expect(codexHooks).toEqual({
      hooks: expect.objectContaining({ PreToolUse: expect.any(Array) }),
    });
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

  it.each([false, true])("adopts generated files in a real clone (autocrlf=%s), then accepts source edits", async (autocrlf) => {
    const root = await fixture(["codex", "claude-code", "hermes"]);
    const compiler = new HarnessConfigurationCompiler();
    await applyPlan(await compiler.plan({ root }));
    const git = (cwd: string, args: string[]) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
      expect(result.status, result.stderr).toBe(0);
    };
    git(root, ["init", "--quiet"]);
    git(root, ["-c", "core.autocrlf=false", "add", "."]);
    git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Generated fixture"]);
    const clone = path.join(await temporaryRoot(), "clone");
    git(root, ["-c", `core.autocrlf=${autocrlf}`, "clone", "--quiet", root, clone]);
    expect((await loadState(clone)).artifacts).toEqual({});
    const before = await readFile(path.join(clone, "AGENTS.md"), "utf8");
    expect(before.includes("\r\n")).toBe(autocrlf);
    const adoption = await compiler.plan({ root: clone });
    expect(adoption.entries.filter((entry) => entry.action === "conflict")).toEqual([]);
    await applyPlan(adoption);
    expect(await readFile(path.join(clone, "AGENTS.md"), "utf8")).toBe(before);
    expect((await loadState(clone)).artifacts[".claude/agents/reviewer.md"]).toBeDefined();
    await write(clone, ".canonfig/agents/reviewer.md", "Review the changed canonical source.\n");
    const changed = await compiler.plan({ root: clone });
    expect(changed.entries.filter((entry) => entry.action === "conflict")).toEqual([]);
    await applyPlan(changed);
    expect(await readFile(path.join(clone, ".claude/agents/reviewer.md"), "utf8")).toContain("changed canonical source");
  });

  it.each([false, true])("cleans raw binary receipts without decoding bytes (edited=%s)", async (edited) => {
    const root = await temporaryRoot();
    const artifact: DesiredArtifact = { kind: "replace", owner: "codex", path: "skill/logo.bin", content: new Uint8Array([255, 254, 0, 1, 13, 10]) };
    await applyPlan(await createPlan(root, ["codex"], [artifact]));
    if (edited) await writeFile(path.join(root, artifact.path), new Uint8Array([255, 254, 0, 2, 13, 10]));
    const clean = await createPlan(root, ["codex"], []);
    expect(clean.entries[0]?.action).toBe(edited ? "conflict" : "delete");
    expect(formatPlanDiff(clean)).toContain(`Binary file ${edited ? "conflict" : "delete"}`);
    if (!edited) {
      await applyPlan(clean);
      await expect(readFile(path.join(root, artifact.path))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("adopts and updates TOML blocks in place without changing operator key scope", async () => {
    const root = await temporaryRoot();
    const file = "config.toml";
    await write(root, file, '# canonfig:begin local\n[mcp_servers.local]\ncommand = "old"\n# canonfig:end local\nenabled = false\n');
    const artifact: DesiredArtifact = { kind: "toml", owner: "codex", path: file,
      blocks: [{ marker: "local", content: '[mcp_servers.local]\ncommand = "old"' }] };
    await applyPlan(await createPlan(root, ["codex"], [artifact]));
    let parsed = parseToml(await readFile(path.join(root, file), "utf8"));
    expect(parsed).toEqual({ mcp_servers: { local: { command: "old", enabled: false } } });
    const changed: DesiredArtifact = { ...artifact, blocks: [{ marker: "local", content: '[mcp_servers.local]\ncommand = "new"' }] };
    await applyPlan(await createPlan(root, ["codex"], [changed]));
    parsed = parseToml(await readFile(path.join(root, file), "utf8"));
    expect(parsed).toEqual({ mcp_servers: { local: { command: "new", enabled: false } } });
    const clean = await createPlan(root, ["codex"], []);
    expect(clean.entries[0]?.action).toBe("conflict");
    await expect(applyPlan(clean)).rejects.toThrow();
    expect(parseToml(await readFile(path.join(root, file), "utf8"))).toEqual(parsed);
  });

  it.each([false, true])("shows the removed text in deletion and rename previews (rename=%s)", async (rename) => {
    const root = await temporaryRoot();
    const artifact: DesiredArtifact = { kind: "replace", owner: "codex", path: "old.md", content: "Review this removed text.\n" };
    await applyPlan(await createPlan(root, ["codex"], [artifact]));
    const plan = await createPlan(root, ["codex"], rename ? [{ ...artifact, path: "new.md" }] : []);
    expect(plan.entries.find((entry) => entry.path === "old.md")?.before).toBe(artifact.content);
    expect(formatPlanDiff(plan)).toContain("-Review this removed text.");
    if (rename) expect(formatPlanDiff(plan)).toContain("+Review this removed text.");
  });

  it("retains exact-byte protection for a binary artifact that happens to contain UTF-8", async () => {
    const root = await temporaryRoot();
    const artifact: DesiredArtifact = { kind: "replace", owner: "codex", path: "skill/data.bin", content: new Uint8Array([65, 13, 10]) };
    await applyPlan(await createPlan(root, ["codex"], [artifact]));
    await writeFile(path.join(root, artifact.path), new Uint8Array([65, 10]));
    expect((await createPlan(root, ["codex"], [])).entries[0]?.action).toBe("conflict");
  });

  it("recognizes an owned CRLF block but still rejects edits inside it", async () => {
    const root = await fixture(["codex"]);
    const compiler = new HarnessConfigurationCompiler();
    await applyPlan(await compiler.plan({ root }));
    const file = path.join(root, "AGENTS.md");
    const converted = (await readFile(file, "utf8")).replace(/\n/gu, "\r\n");
    await writeFile(file, converted);
    expect((await compiler.plan({ root })).entries.find((entry) => entry.path === "AGENTS.md")?.action).toBe("unchanged");
    await writeFile(file, converted.replace("Run tests before finishing.", "Local edit."));
    expect((await compiler.plan({ root })).entries.find((entry) => entry.path === "AGENTS.md")?.action).toBe("conflict");
  });

  it("accepts checkout-only CRLF changes during cleanup but preserves real edits", async () => {
    const root = await temporaryRoot();
    const artifact: DesiredArtifact = { kind: "replace", owner: "codex", path: "generated.md", content: "one\ntwo\n" };
    await applyPlan(await createPlan(root, ["codex"], [artifact]));
    await write(root, artifact.path, "one\r\ntwo\r\n");
    expect((await createPlan(root, ["codex"], [])).entries[0]?.action).toBe("delete");
    await write(root, artifact.path, "one\r\nlocal change\r\n");
    expect((await createPlan(root, ["codex"], [])).entries[0]?.action).toBe("conflict");
  });

  it("retires explicitly disabled targets on full apply, but not on a filtered apply", async () => {
    const root = await fixture(["codex", "claude-code"]);
    const compiler = new HarnessConfigurationCompiler();
    await applyPlan(await compiler.plan({ root }));
    const file = path.join(root, ".canonfig/harness.json");
    const config = JSON.parse(await readFile(file, "utf8"));
    config.targets["claude-code"].enabled = false;
    await writeFile(file, JSON.stringify(config));
    await applyPlan(await compiler.plan({ root, targets: ["codex"] }));
    expect((await loadState(root)).appliedTargets).toContain("claude-code");
    expect(await readFile(path.join(root, "CLAUDE.md"), "utf8")).toContain("AGENTS.md");
    const full = await compiler.plan({ root });
    expect(full.entries.find((entry) => entry.path === "CLAUDE.md")?.action).toBe("delete");
    await applyPlan(full);
    expect((await loadState(root)).appliedTargets).toEqual(["codex"]);
    await expect(readFile(path.join(root, "CLAUDE.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toContain("Canonical instructions");
    config.targets.codex.enabled = false;
    await writeFile(file, JSON.stringify(config));
    await rm(path.join(root, ".canonfig/instructions/AGENTS.md"));
    const none = await compiler.plan({ root });
    expect(none.entries.some((entry) => entry.action === "conflict")).toBe(false);
    await applyPlan(none);
    expect((await loadState(root)).artifacts).toEqual({});
    await expect(readFile(path.join(root, "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not erase local edits when disabling a target", async () => {
    const root = await fixture(["claude-code"]);
    const compiler = new HarnessConfigurationCompiler();
    await applyPlan(await compiler.plan({ root }));
    const output = path.join(root, ".claude/agents/reviewer.md");
    await writeFile(output, "local edits\n");
    const file = path.join(root, ".canonfig/harness.json");
    const config = JSON.parse(await readFile(file, "utf8"));
    config.targets["claude-code"].enabled = false;
    await writeFile(file, JSON.stringify(config));
    const plan = await compiler.plan({ root });
    expect(plan.entries.find((entry) => entry.path === ".claude/agents/reviewer.md")?.action).toBe("conflict");
    await expect(applyPlan(plan)).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe("local edits\n");
  });

  it.skipIf(process.platform === "win32")("copies repository-contained linked skills and nested linked files", async () => {
    const root = await fixture(["claude-code"]);
    await write(root, "vendor/skills/lint/SKILL.md", "---\nname: lint\ndescription: Run lint.\n---\nRun lint.\n");
    await symlink("../../vendor/skills/lint", path.join(root, ".canonfig/skills/lint"), "dir");
    await write(root, ".canonfig/shared/run.sh", "#!/bin/sh\nexit 0\n");
    await chmod(path.join(root, ".canonfig/shared/run.sh"), 0o755);
    await mkdir(path.join(root, ".canonfig/skills/repository-checks/scripts"));
    await symlink("../../../shared/run.sh", path.join(root, ".canonfig/skills/repository-checks/scripts/run.sh"));
    const compiler = new HarnessConfigurationCompiler();
    const plan = await compiler.plan({ root });
    expect(plan.diagnostics.filter((entry) => entry.level === "error")).toEqual([]);
    await applyPlan(plan);
    expect(await readFile(path.join(root, ".claude/skills/lint/SKILL.md"), "utf8")).toContain("Run lint.");
    const copied = path.join(root, ".claude/skills/repository-checks/scripts/run.sh");
    expect((await lstat(copied)).isSymbolicLink()).toBe(false);
    expect((await stat(copied)).mode & 0o111).not.toBe(0);
    expect(await readFile(copied, "utf8")).toContain("exit 0");
  });

  it.skipIf(process.platform === "win32").each(["escape", "cycle", "dangling"])("reports a %s skill symlink instead of silently omitting it", async (kind) => {
    const root = await fixture(["claude-code"]);
    const destination = path.join(root, ".canonfig/skills/repository-checks/link");
    const outside = await temporaryRoot();
    const target = kind === "escape" ? outside : kind === "cycle" ? "." : "missing";
    await symlink(target, destination, "dir");
    const plan = await new HarnessConfigurationCompiler().plan({ root });
    expect(plan.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SKILL_SOURCE_INVALID", level: "error" }),
    ]));
    await expect(applyPlan(plan)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("preserves a CLAUDE.md link to AGENTS.md through apply and cleanup", async () => {
    const root = await fixture(["claude-code"]);
    await write(root, "AGENTS.md", "# Team notes\nOriginal note.\n");
    await symlink("AGENTS.md", path.join(root, "CLAUDE.md"));
    const compiler = new HarnessConfigurationCompiler();
    const plan = await compiler.plan({ root });
    expect(plan.entries.find((entry) => entry.path === "CLAUDE.md")?.action).toBe("unchanged");
    await applyPlan(plan);
    expect(await readlink(path.join(root, "CLAUDE.md"))).toBe("AGENTS.md");
    expect((await loadState(root)).artifacts["CLAUDE.md"]).toBeUndefined();
    const notes = await readFile(path.join(root, "AGENTS.md"), "utf8");
    await writeFile(path.join(root, "AGENTS.md"), notes.replace("Original note.", "Updated live note."));
    expect(await readFile(path.join(root, "CLAUDE.md"), "utf8")).toContain("Updated live note.");
    expect(await readFile(path.join(root, "CLAUDE.md"), "utf8")).not.toContain("@AGENTS.md");
    await applyPlan(await createPlan(root, ["claude-code"], []));
    expect(await readlink(path.join(root, "CLAUDE.md"))).toBe("AGENTS.md");
    expect(await readFile(path.join(root, "CLAUDE.md"), "utf8")).toContain("Updated live note.");
  });

  it.skipIf(process.platform === "win32")("refuses other native symlinks even under force", async () => {
    const root = await fixture(["claude-code"]);
    await write(root, "other.md", "Keep this separate file.\n");
    await symlink("other.md", path.join(root, "CLAUDE.md"));
    const plan = await new HarnessConfigurationCompiler().plan({ root, force: true });
    expect(plan.entries.find((entry) => entry.path === "CLAUDE.md")?.action).toBe("conflict");
    await expect(applyPlan(plan)).rejects.toThrow();
    expect(await readlink(path.join(root, "CLAUDE.md"))).toBe("other.md");
    expect(await readFile(path.join(root, "other.md"), "utf8")).toBe("Keep this separate file.\n");
  });

  it.skipIf(process.platform === "win32")("does not delete a symlink substituted for an owned output", async () => {
    const root = await fixture(["claude-code"]);
    await applyPlan(await new HarnessConfigurationCompiler().plan({ root }));
    const output = path.join(root, ".claude/agents/reviewer.md");
    await rm(output);
    await write(root, "other.md", "Keep me.\n");
    await symlink("../../other.md", output);
    const clean = await createPlan(root, ["claude-code"], [], [], { force: true });
    expect(clean.entries.find((entry) => entry.path === ".claude/agents/reviewer.md")?.action).toBe("conflict");
    await expect(applyPlan(clean)).rejects.toThrow();
    expect((await lstat(output)).isSymbolicLink()).toBe(true);
  });

  it("keeps operator text on both sides of a managed block", async () => {
    // The block was removed and re-appended, so with placement "end" it always
    // landed last and any text the operator had written after it was silently
    // relocated above it. Nothing was lost, but the order changed, and for a
    // file like AGENTS.md the order is the meaning.
    const root = await fixture(["codex"]);
    const compiler = new HarnessConfigurationCompiler(createDefaultRegistry());
    await applyPlan(await compiler.plan({ root }));

    const agents = path.join(root, "AGENTS.md");
    const before = await readFile(agents, "utf8");
    await writeFile(agents, `a note before\n\n${before}my own note after\n`, "utf8");

    await applyPlan(await compiler.plan({ root }));

    const after = await readFile(agents, "utf8");
    expect(after.startsWith("a note before\n")).toBe(true);
    expect(after.trimEnd().endsWith("my own note after")).toBe(true);
    // Exactly one block, replaced where it stood rather than moved.
    expect(after.match(/canonfig:begin instructions/gu)).toHaveLength(1);
  });

  it("reports an unmanaged block claiming a managed marker as a conflict", async () => {
    // A block Canonfig does not own is still a conflict rather than something
    // to overwrite.
    const root = await fixture(["codex"]);
    const compiler = new HarnessConfigurationCompiler(createDefaultRegistry());
    await writeFile(
      path.join(root, "AGENTS.md"),
      "<!-- canonfig:begin instructions -->\nnot ours\n<!-- canonfig:end instructions -->\n",
      "utf8",
    );

    const plan = await compiler.plan({ root });
    const entry = plan.entries.find((candidate) => candidate.path === "AGENTS.md");
    expect(entry?.action).toBe("conflict");
    expect(entry?.reason).toContain("unmanaged block");
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

  it("rejects lossy MCP projections in strict mode and only warns otherwise", async () => {
    const root = await fixture(["codex"]);
    const configPath = path.join(root, ".canonfig", "harness.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.mcp.servers.local.timeoutMs = 1500;
    config.mcp.servers.docs.transport = "sse";
    await writeFile(configPath, `${JSON.stringify(config, undefined, 2)}\n`, "utf8");

    const lenient = await new HarnessConfigurationCompiler().plan({ root });
    expect(lenient.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "codex", code: "MCP_OPTION_UNSUPPORTED", level: "warning" }),
      expect.objectContaining({ target: "codex", code: "MCP_TRANSPORT_UNSUPPORTED", level: "warning" }),
    ]));
    expect(isHarnessPlanBlocked(lenient)).toBe(false);

    const strict = await new HarnessConfigurationCompiler().plan({ root, strict: true });
    expect(strict.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "codex", code: "MCP_OPTION_UNSUPPORTED", level: "error" }),
      expect.objectContaining({ target: "codex", code: "MCP_TRANSPORT_UNSUPPORTED", level: "error" }),
    ]));
    expect(isHarnessPlanBlocked(strict)).toBe(true);
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


describe("native harness file permissions", () => {
  it.skipIf(process.platform === "win32")("preserves existing private merge modes through apply and clean", async () => {
    const root = await fixture(["claude-code"]);
    await write(root, ".mcp.json", JSON.stringify({ mcpServers: { existing: { command: "existing-tool" } } }));
    await write(root, "AGENTS.md", "# Local instructions\n");
    await chmod(path.join(root, ".mcp.json"), 0o600);
    await chmod(path.join(root, "AGENTS.md"), 0o640);
    const compiler = new HarnessConfigurationCompiler();
    await applyPlan(await compiler.plan({ root }));
    expect((await stat(path.join(root, ".mcp.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(root, "AGENTS.md"))).mode & 0o777).toBe(0o640);
    await applyPlan(await createPlan(root, [...TARGET_IDS], [], []));
    expect((await stat(path.join(root, ".mcp.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(root, "AGENTS.md"))).mode & 0o777).toBe(0o640);
    expect((await readFile(path.join(root, "AGENTS.md"), "utf8")).trim()).toBe("# Local instructions");
  });
});

describe("deleted native TOML configuration", () => {
  it.each(["codex", "grok-build"] as const)("recreates a deleted %s config and cleans an absent config", async (target) => {
    const root = await fixture([target]);
    const compiler = new HarnessConfigurationCompiler();
    await applyPlan(await compiler.plan({ root }));
    const relative = target === "codex" ? ".codex/config.toml" : ".grok/config.toml";
    const file = path.join(root, relative);
    const expected = await readFile(file, "utf8");
    await rm(file);
    const plan = await compiler.plan({ root });
    expect(plan.entries.filter((entry) => entry.action === "conflict")).toEqual([]);
    await applyPlan(plan);
    expect(await readFile(file, "utf8")).toBe(expected);
    await rm(file);
    const output: string[] = [];
    let exitCode = -1;
    await runHarnessConfigurationCli(["clean", "--root", root, "--target", target], {
      writeStdout: (value) => output.push(value), writeStderr: (value) => output.push(value),
      setExitCode: (value) => { exitCode = value; },
    });
    expect(exitCode, output.join("")).toBe(0);
    expect((await loadState(root)).artifacts[relative]).toBeUndefined();
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still protects an existing TOML file whose managed markers were removed", async () => {
    const root = await fixture(["codex"]);
    const compiler = new HarnessConfigurationCompiler();
    await applyPlan(await compiler.plan({ root }));
    const file = path.join(root, ".codex/config.toml");
    const outsideEdit = '# user replaced the file\nmodel = "keep-me"\n';
    await writeFile(file, outsideEdit);
    const plan = await compiler.plan({ root });
    expect(plan.entries.some((entry) => entry.action === "conflict")).toBe(true);
    expect(await readFile(file, "utf8")).toBe(outsideEdit);
  });
});

it.skipIf(process.platform === "win32").each(["file", "ancestor"])("does not mistake a dangling native %s symlink for a deleted file", async (location) => {
  const root = await fixture(["codex"]);
  const compiler = new HarnessConfigurationCompiler();
  await applyPlan(await compiler.plan({ root }));
  const previous = await loadState(root);
  const file = path.join(root, ".codex/config.toml");
  const link = location === "file" ? file : path.dirname(file);
  const target = location === "file" ? "missing-config.toml" : "missing-config-directory";
  await rm(link, { recursive: location === "ancestor" });
  await symlink(target, link);
  for (const force of [false, true]) {
    const plan = await compiler.plan({ root, force });
    expect(plan.entries.find((entry) => entry.path === ".codex/config.toml")?.action).toBe("conflict");
    const output: string[] = [];
    let exitCode = -1;
    await runHarnessConfigurationCli(["clean", "--root", root, "--target", "codex", ...(force ? ["--force"] : [])], {
      writeStdout: (value) => output.push(value), writeStderr: (value) => output.push(value),
      setExitCode: (value) => { exitCode = value; },
    });
    expect(exitCode, output.join("")).toBe(4);
    expect(await readlink(link)).toBe(target);
    expect((await loadState(root)).artifacts).toEqual(previous.artifacts);
  }
});


it.each(["codex", "grok-build"] as const)("resets provenance when recreating a deleted pre-existing %s config", async (target) => {
  const root = await fixture([target]);
  const relative = target === "codex" ? ".codex/config.toml" : ".grok/config.toml";
  await write(root, relative, '# operator-owned original\nmodel = "fixture-model"\n');
  const compiler = new HarnessConfigurationCompiler();
  await applyPlan(await compiler.plan({ root }));
  expect((await loadState(root)).artifacts[relative]?.existedBefore).toBe(true);
  await rm(path.join(root, relative));
  await applyPlan(await compiler.plan({ root }));
  expect((await loadState(root)).artifacts[relative]?.existedBefore).toBe(false);
  expect(await readFile(path.join(root, relative), "utf8")).not.toContain("fixture-model");
  let exitCode = -1;
  await runHarnessConfigurationCli(["clean", "--root", root, "--target", target], {
    writeStdout: () => undefined, writeStderr: () => undefined,
    setExitCode: (value) => { exitCode = value; },
  });
  expect(exitCode).toBe(0);
  await expect(readFile(path.join(root, relative))).rejects.toMatchObject({ code: "ENOENT" });
});
