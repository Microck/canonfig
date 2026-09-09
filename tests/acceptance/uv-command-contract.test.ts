import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { buildToolCatalog } from "../../src/profile/tool-catalog.ts";

const uv = process.env.CANONFIG_TEST_UV ?? "uv";
const probe = spawnSync(uv, ["--version"], {
  encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true,
});
const available = probe.status === 0 && probe.error === undefined;

// Ordinary offline runs can omit uv, but the native installer CI must never
// silently skip the command contract it is specifically responsible for.
describe.runIf(available || process.env.CANONFIG_REQUIRE_UV_TESTS === "1")("native uv command contract", () => {
  it("accepts the generated no-build recipe without installing or contacting a registry", () => {
    expect(available, "the native uv job requires a working uv executable").toBe(true);
    const catalog = buildToolCatalog([{
      sourcePath: "fixture-package.json",
      location: { kind: "field", field: "canonfig.tools" },
      kind: "package-metadata",
      invocation: ["canonfig-command-fixture"],
      package: { ecosystem: "uv", name: "canonfig-command-fixture", version: "0.0.1", source: "uv.lock", upstream: "https://example.invalid/fixture" },
      confidence: "deterministic", reviewStatus: "accepted",
    }]);
    const recipe = catalog.tools[0]?.recipes.find((candidate) => candidate.method === "uv");
    if (recipe === undefined || recipe.method !== "uv") throw new Error("expected a deterministic uv recipe");
    expect(recipe.command).toContain("--no-build");
    expect(recipe.command).not.toContain("--only-binary=:all:");
    const result = spawnSync(uv, [...recipe.command.slice(1), "--help"], {
      encoding: "utf8", timeout: 5_000, maxBuffer: 256 * 1024, windowsHide: true,
      env: { ...process.env, UV_OFFLINE: "1", UV_NO_PROGRESS: "1" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("--no-build");
  });
});
