import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe.each(["human", "json"] as const)("state startup in %s mode", (format) => {
it.each([
  ["state-root-file", ["status"]],
  ["corrupt-database", ["status"]],
  ["state-root-file", ["sync", "--plan"]],
  ["corrupt-database", ["source", "init"]],
  ["state-root-file", ["secrets", "list"]],
  ["corrupt-database", ["secrets", "list"]],
] as const)("reports %s for %j as one actionable envelope", (fixture, args) => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-state-startup-"));
  const stateRoot = join(home, ".canonfig");
  const badPath = fixture === "state-root-file" ? stateRoot : join(stateRoot, "state.sqlite");
  try {
    if (fixture === "corrupt-database") mkdirSync(stateRoot);
    writeFileSync(badPath, "not a database or directory");
    const result = spawnSync(process.execPath,
      ["--import", "tsx", resolve(import.meta.dirname, "../../src/runtime/main.ts"), ...args, ...(format === "json" ? ["--json"] : [])],
      { encoding: "utf8", timeout: 20000, env: { ...process.env, HOME: home, USERPROFILE: home,
        XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state") } });
    expect(result.status, result.stdout + result.stderr).toBe(3);
    expect(result.stdout).toBe("");
    if (format === "human") expect(result.stderr).toContain("exit 3");
    else expect(JSON.parse(result.stderr)).toMatchObject({ schema: "canonfig.cli/v1", status: "error", exitCode: 3 });
    expect(readFileSync(badPath, "utf8")).toBe("not a database or directory");
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30000);

});
