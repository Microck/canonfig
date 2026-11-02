import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { FollowerSynchronizationConfiguration, defaultScheduledInvocation } from "../../src/synchronization/follower-sync-config.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.each(["fresh", "source-only", "pending", "pending-rotation"])("refuses schedule selection without finalized enrollment (%s)", (mode) => {
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
    if (mode !== "fresh") {
      const initialized = run(["source", "init"]);
      expect(initialized.status, initialized.stderr).toBe(0);
    }
    if (mode.startsWith("pending")) {
      const at = "2026-10-21T00:00:00Z";
      const follower = { id: "pending-follower", name: "Pending", groups: [], revoked: false,
        credentialReference: "pending-credential", enrolledAt: at };
      const state = join(home, ".canonfig", "state.sqlite");
      const configuration = Schema.decodeUnknownSync(FollowerSynchronizationConfiguration)({
        schemaVersion: 1, follower, selectedProfile: "fixture-profile",
        source: { endpoint: "https://127.0.0.1:1", tlsFingerprint: "fixture-tls", signingFingerprint: "fixture-signing" },
        credentialReference: follower.credentialReference, cacheDirectory: join(home, "cache"),
        stateLocation: state, agentPolicy: "deterministic-only", enrollmentPending: true,
        scheduleDefault: mode === "pending-rotation" ? { type: "daily", at: "04:30", timezone: "local" } : undefined,
        scheduleOverride: mode === "pending-rotation" ? { kind: "schedule", schedule: { kind: "daily", localTime: "04:30" } } : undefined,
        scheduledInvocation: defaultScheduledInvocation, updatedAt: at,
      });
      // Faithful persisted state at the prepare/finalize boundary. Source init
      // above already stored a real Source identity in this isolated database.
      const database = new DatabaseSync(state);
      try {
        database.prepare("INSERT INTO followers VALUES (?, ?, ?, ?, ?, ?)")
          .run(follower.id, follower.name, "[]", 0, follower.credentialReference, at);
        database.prepare("INSERT INTO follower_sync_configuration VALUES (1, ?, ?, ?)")
          .run(follower.id, JSON.stringify(configuration), at);
      } finally { database.close(); }
    }
    for (const calendar of ["daily@02:30", "weekly:Mon@02:30", "--default"]) {
      const result = run(["schedule", "set", calendar]);
      expect(result.status, result.stderr || result.stdout).toBe(2);
      expect(result.stdout + result.stderr).toContain(mode.startsWith("pending") ? "enrollment is pending" : "needs an enrolled follower");
    }
    const status = run(["schedule", "status"]);
    expect(status.status, status.stderr || status.stdout).toBe(0);
    expect(status.stdout).toContain(mode.startsWith("pending") ? "enrollment is pending" : "no follower is enrolled");
    if (mode.startsWith("pending")) {
      expect(JSON.parse(status.stdout).data.state).toBe("enrollment-pending");
      const doctor = run(["doctor"]);
      expect(doctor.stdout + doctor.stderr).toContain("enrollment is pending");
    }
    expect(existsSync(join(home, "config", "systemd", "user", "canonfig-sync.timer"))).toBe(false);
    expect(existsSync(join(home, "Library", "LaunchAgents", "canonfig-sync.plist"))).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 120_000);
