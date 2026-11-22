import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
      // Only the fake harness executables folderHome installs are on PATH.
      PATH: join(home, "bin"),
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
  mkdirSync(join(home, "bin"));
  writeFileSync(join(home, "bin", process.platform === "win32" ? "codex.exe" : "codex"), "", { mode: 0o755 });
  return home;
};

describe("local projection CLI", () => {
  it("plans, applies, and restores a takeover with no recovery needed afterward", () => {
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

    for (const [command, message] of [
      ["recover", "no interrupted local run is waiting for recovery"],
      ["abandon", "no interrupted local run is open"],
    ] as const) {
      const result = invoke(home, ["--json", command]);
      expect(result.status, result.stdout + result.stderr).toBe(2);
      expect(json(result).message).toContain(message);
    }
  }, 120_000);

  it("finds an interrupted Follower run after enrollment is gone", () => {
    const home = folderHome();
    const applied = invoke(home, ["--json", "sync", "--apply"]);
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);

    const database = new DatabaseSync(join(home, ".canonfig", "state.sqlite"));
    try {
      database.prepare("DELETE FROM deployment_receipts").run();
      database.prepare(`
        UPDATE synchronization_runs
        SET follower_id = 'retired-follower', phase = 'Applying', outcome_json = NULL, completed_at = NULL
      `).run();
      const recover = invoke(home, ["--json", "recover"]);
      expect(recover.status).not.toBe(0);
      expect(json(recover).message).toContain("cannot be resumed");
      expect(json(recover).message).toContain("Run 'canonfig abandon'");
      expect(database.prepare("SELECT phase FROM synchronization_runs").get()).toMatchObject({ phase: "Applying" });

      const abandon = invoke(home, ["--json", "abandon"]);
      expect(abandon.status, abandon.stdout + abandon.stderr).toBe(0);
      expect(database.prepare("SELECT phase FROM synchronization_runs").get()).toMatchObject({ phase: "Complete" });
    } finally {
      database.close();
    }
  });

  it("reports the creating build before decoding a foreign local run", () => {
    const home = folderHome();
    const applied = invoke(home, ["--json", "sync", "--apply"]);
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);

    const database = new DatabaseSync(join(home, ".canonfig", "state.sqlite"));
    try {
      database.prepare(`
        UPDATE synchronization_runs
        SET phase = 'Interrupted', creating_version = '7.1.6', plan_json = 'foreign plan'
      `).run();
      const staging = join(home, ".codex", ".cf-0123456789ab.tmp");
      writeFileSync(staging, "unfinished staging");
      for (const command of ["recover", "abandon"]) {
        const refused = invoke(home, ["--json", command]);
        expect(refused.status, refused.stdout + refused.stderr).toBe(4);
        expect(json(refused).message).toContain("was created by canonfig 7.1.6");
        expect(json(refused).message).toContain("run 'canonfig recover' with the creating build");
      }
      expect(readFileSync(staging, "utf8")).toBe("unfinished staging");
      expect(database.prepare("SELECT phase, plan_json FROM synchronization_runs").get())
        .toMatchObject({ phase: "Interrupted", plan_json: "foreign plan" });
    } finally {
      database.close();
    }
  });

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
