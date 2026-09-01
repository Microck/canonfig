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

import { parseHarnessArguments } from "../src/harness-configuration/cli-arguments.ts";
import { loadConfig } from "../src/harness-configuration/core/config.ts";
import { scaffoldProject } from "../src/harness-configuration/core/scaffold.ts";
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
  it("parses JSON as an init format without changing JSON output mode", () => {
    expect(parseHarnessArguments(["init", "--format", "json", "--json"]))
      .toMatchObject({
        command: "init",
        format: "json",
        json: true,
      });
    expect(() => parseHarnessArguments(["init", "--format", "toml"]))
      .toThrowError(expect.objectContaining({ code: "HARNESS_FORMAT_INVALID" }));
  });

  it("scaffolds strict, editable JSON that the compiler can load", async () =>
    withTemporaryDirectory(async (root) => {
      const written = await scaffoldProject(root, { format: "json" });
      const configPath = path.join(root, ".canonfig", "harness.json");
      const raw = await readFile(configPath, "utf8");

      expect(written).toContain(".canonfig/harness.json");
      expect(() => JSON.parse(raw)).not.toThrow();
      expect(raw.endsWith("\n")).toBe(true);

      const loaded = await loadConfig(root);
      expect(loaded.path).toBe(configPath);
      expect(loaded.config.version).toBe(1);
      expect(loaded.config.project.name).toBe(path.basename(root));
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
