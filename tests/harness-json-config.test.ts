import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CliExitCode } from "../src/cli/exit-codes.ts";
import { parseHarnessArguments } from "../src/harness-configuration/cli-arguments.ts";
import { runHarnessConfigurationCli } from "../src/harness-configuration/cli.ts";
import { HarnessConfigurationCompiler } from "../src/harness-configuration/core/compiler.ts";
import { loadConfig } from "../src/harness-configuration/core/config.ts";
import { scaffoldProject } from "../src/harness-configuration/core/scaffold.ts";
import { applyPlan, createPlan } from "../src/harness-configuration/core/planner.ts";
import { parseJsonDocument } from "../src/harness-configuration/core/render-utils.ts";
import type { DesiredArtifact } from "../src/harness-configuration/core/types.ts";
import { ampPluginSource } from "../src/harness-configuration/templates/runtime.ts";

const withTemporaryDirectory = async <Value>(
  use: (root: string) => Promise<Value>,
): Promise<Value> => {
  const root = await mkdtemp(path.join(tmpdir(), "canonfig-json-"));
  try {
    return await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("JSON harness configuration", () => {
  it.each(["\n", "\r\n"])("preserves nested JSONC comments through apply, rerender and cleanup (%j)", async (eol) =>
    withTemporaryDirectory(async (root) => {
      const original = [
        "// my servers", "{", '  "mcpServers": {',
        "    /* existing server */", '    "local": { "command": "keep", "url": "https://example.invalid/a//b" },',
        "  },", '  "flags": [', "    // keep this array comment", '    "user",', "  ],",
        '  "label": "literal /* not a comment */",', "}", "// trailing note", "",
      ].join(eol);
      await writeFile(path.join(root, ".mcp.json"), original);
      const artifact: DesiredArtifact = { kind: "json", owner: "claude-code", path: ".mcp.json", operations: [
        { kind: "managed-map", path: ["mcpServers"], entries: { generated: { command: "new-tool" } } },
        { kind: "managed-array", path: ["flags"], values: ["generated"] },
      ] };
      await applyPlan(await createPlan(root, ["claude-code"], [artifact]));
      const applied = await readFile(path.join(root, ".mcp.json"), "utf8");
      for (const comment of ["// my servers", "/* existing server */", "// keep this array comment", "// trailing note"]) expect(applied).toContain(comment);
      expect(applied).toContain('"command": "keep", "url": "https://example.invalid/a//b"');
      const repeated = await createPlan(root, ["claude-code"], [artifact]);
      expect(repeated.entries[0]?.action).toBe("unchanged");
      await applyPlan(await createPlan(root, ["claude-code"], []));
      const cleaned = await readFile(path.join(root, ".mcp.json"), "utf8");
      for (const comment of ["// my servers", "/* existing server */", "// keep this array comment", "// trailing note"]) expect(cleaned).toContain(comment);
      expect(parseJsonDocument(cleaned, [])).toEqual(parseJsonDocument(original, []));
      expect(cleaned.includes("\r\n")).toBe(eol === "\r\n");
    }));

  it("parses JSON as an init format without changing JSON output mode", () => {
    expect(parseHarnessArguments(["init", "--format", "json", "--json"]))
      .toMatchObject({
        command: "init",
        format: "json",
        json: true,
      });
    expect(() => parseHarnessArguments(["init", "--format", "toml"]))
      .toThrowError(expect.objectContaining({ code: "HARNESS_FORMAT_INVALID" }));
    expect(() => parseHarnessArguments(["apply", "--format", "json"]))
      .toThrowError(expect.objectContaining({
        code: "HARNESS_FORMAT_NOT_ALLOWED",
      }));
  });

  it("returns a usage exit code when --format is used outside init", async () => {
    let stdout = "";
    let stderr = "";
    let exitCode = CliExitCode.success;

    await runHarnessConfigurationCli(["apply", "--format", "json"], {
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      setExitCode: (value) => {
        exitCode = value;
      },
    });

    expect(stdout).toBe("");
    expect(stderr).toContain("--format is only valid with harness init.");
    expect(exitCode).toBe(CliExitCode.usageOrConfiguration);
  });

  it("scaffolds strict, editable JSON through the normal compiler path", async () =>
    withTemporaryDirectory(async (root) => {
      const written = await scaffoldProject(root, {
        format: "json",
        targets: ["codex"],
      });
      const configPath = path.join(root, ".canonfig", "harness.json");
      const raw = await readFile(configPath, "utf8");

      expect(written).toContain(".canonfig/harness.json");
      expect(() => JSON.parse(raw)).not.toThrow();
      expect(raw.endsWith("\n")).toBe(true);

      const loaded = await loadConfig(root);
      expect(loaded.path).toBe(configPath);
      expect(loaded.config.version).toBe(1);
      expect(loaded.config.project.name).toBe(path.basename(root));

      const compiled = await new HarnessConfigurationCompiler().build({ root });
      expect(compiled.configPath).toBe(configPath);
      expect(compiled.targets).toEqual(["codex"]);
      expect(compiled.artifacts.map((artifact) => artifact.path)).toContain(
        ".codex/agents/reviewer.toml",
      );
      expect(
        compiled.diagnostics.filter((diagnostic) => diagnostic.level === "error"),
      ).toEqual([]);
    }));

  it("does not create a config that would be shadowed by another format", async () =>
    withTemporaryDirectory(async (root) => {
      const configDirectory = path.join(root, ".canonfig");
      await mkdir(configDirectory, { recursive: true });
      await writeFile(
        path.join(configDirectory, "harness.yaml"),
        "version: 1\n",
        "utf8",
      );

      await expect(scaffoldProject(root, { format: "json" }))
        .rejects.toMatchObject({ code: "CONFIG_FORMAT_CONFLICT" });
    }));

  it("rejects multiple config formats instead of silently picking one", async () =>
    withTemporaryDirectory(async (root) => {
      await scaffoldProject(root, { format: "json" });
      await writeFile(
        path.join(root, ".canonfig", "harness.yaml"),
        "version: 1\n",
        "utf8",
      );

      await expect(loadConfig(root))
        .rejects.toMatchObject({ code: "CONFIG_FORMAT_CONFLICT" });
    }));

  it("keeps generated edit guidance independent of the source format", () => {
    const source = ampPluginSource([]);

    expect(source).toContain("Edit the active .canonfig/harness configuration");
    expect(source).not.toContain("harness.yaml");
  });
});
