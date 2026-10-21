import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.each([false, true])("refuses schedule selection without a follower (Source initialized: %s)", (source) => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-unenrolled-schedule-"));
  const project = resolve(import.meta.dirname, "../..");
  const environment = {
    ...process.env, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"), APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"), CANONFIG_LOCAL_CREDENTIAL_ROOT: join(home, "credentials"),
    NODE_NO_WARNINGS: "1",
  };
  const run = (args: string[]) => spawnSync(process.execPath,
    ["--import", "tsx", "src/runtime/main.ts", ...args, "--json"],
    { cwd: project, env: environment, encoding: "utf8", timeout: 30_000 });
  try {
    if (source) {
      const initialized = run(["source", "init"]);
      expect(initialized.status, initialized.stderr).toBe(0);
    }
    for (const calendar of ["daily@02:30", "weekly:Mon@02:30", "--default"]) {
      const result = run(["schedule", "set", calendar]);
      expect(result.status, result.stderr || result.stdout).toBe(2);
      expect(result.stdout + result.stderr).toContain("needs an enrolled follower");
    }
    expect(existsSync(join(home, "config", "systemd", "user", "canonfig-sync.timer"))).toBe(false);
    expect(existsSync(join(home, "Library", "LaunchAgents", "canonfig-sync.plist"))).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 120_000);
