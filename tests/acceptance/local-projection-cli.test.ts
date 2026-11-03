import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * `canonfig sync` and `canonfig restore` on an unenrolled machine, through
 * the real entrypoint with a temporary HOME.
 */

const homes: Array<string> = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const invoke = (home: string, args: ReadonlyArray<string>, environment: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "../../src/runtime/main.ts"), ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CANONFIG_LOG_FILE: join(home, "command.log"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, "state"),
      CODEX_HOME: "",
      ...environment,
    },
  });

const json = (result: SpawnSyncReturns<string>) => JSON.parse(result.stdout || result.stderr);

const folderHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-local-cli-"));
  homes.push(home);
  mkdirSync(join(home, ".canonfig"), { recursive: true });
  writeFileSync(join(home, ".canonfig", "canonfig.jsonc"), "{\n  // projected harnesses\n  \"version\": 1,\n  \"harnesses\": [\"codex\"]\n}\n");
  writeFileSync(join(home, ".canonfig", "AGENTS.md"), "Global instructions.\n");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "AGENTS.md"), "my old codex instructions\n");
  writeFileSync(join(home, ".codex", "auth.json"), "{\"token\":\"never touch\"}\n");
  return home;
};

describe("local projection CLI", () => {
  it("plans, applies, and restores a takeover", () => {
    const home = folderHome();
    const plan = invoke(home, ["--json", "sync", "--plan"]);
    expect(plan.status, plan.stdout + plan.stderr).toBe(0);
    expect(json(plan).data.takeovers).toEqual([
      expect.objectContaining({ harness: "codex", root: join(home, ".codex"), backup: "takeover snapshot" }),
    ]);

    const human = invoke(home, ["sync", "--plan", "--no-backup"]);
    expect(human.status, human.stdout + human.stderr).toBe(0);
    expect(human.stdout).toContain("no backup");

    const applied = invoke(home, ["--json", "sync", "--apply"]);
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
    expect(json(applied).data.outcome.outcome).toBe("Converged");
    expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8")).toContain("Global instructions.");
    expect(readdirSync(join(home, ".canonfig", ".backups"))).toHaveLength(1);

    const restored = invoke(home, ["--json", "restore"]);
    expect(restored.status, restored.stdout + restored.stderr).toBe(0);
    expect(json(restored).data.excludedHarnesses).toEqual(["codex"]);
    expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8")).toBe("my old codex instructions\n");
    expect(readFileSync(join(home, ".codex", "auth.json"), "utf8")).toBe("{\"token\":\"never touch\"}\n");
    expect(readFileSync(join(home, ".canonfig", "local", "local.jsonc"), "utf8")).toContain("codex");
  }, 120_000);

  it("exits with Human Action Required when CODEX_HOME moved after takeover", () => {
    const home = folderHome();
    const first = invoke(home, ["--json", "sync", "--apply"], { CODEX_HOME: join(home, ".codex") });
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const moved = invoke(home, ["--json", "sync", "--apply"], { CODEX_HOME: join(home, "elsewhere") });
    expect(moved.status, moved.stdout + moved.stderr).toBe(3);
    expect(json(moved).message).toContain(join(home, ".codex"));
    expect(existsSync(join(home, "elsewhere"))).toBe(false);
  }, 120_000);

  it("refuses restore when there is no snapshot", () => {
    const home = folderHome();
    const result = invoke(home, ["--json", "restore", "2026-01-01T00-00-00-000Z"]);
    expect(result.status, result.stdout + result.stderr).toBe(2);
  }, 60_000);
});
