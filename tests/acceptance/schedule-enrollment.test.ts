import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { FollowerSynchronizationConfiguration, defaultScheduledInvocation } from "../../src/synchronization/follower-sync-config.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

/** Runs the CLI from source against an isolated home and state database. */
const isolatedCli = (prefix: string) => {
  const home = mkdtempSync(join(tmpdir(), prefix));
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
  return { home, state: join(home, ".canonfig", "state.sqlite"), run };
};

/**
 * Stores a follower and its synchronization configuration as persisted state.
 * `source init` must have run first so the database holds a real Source identity.
 */
const storeFollowerConfiguration = (
  home: string,
  state: string,
  fields: Partial<typeof FollowerSynchronizationConfiguration.Encoded>,
) => {
  const at = "2026-10-21T00:00:00Z";
  const follower = { id: "fixture-follower", name: "Fixture", groups: [], revoked: false,
    credentialReference: "fixture-credential", enrolledAt: at };
  const configuration = Schema.decodeUnknownSync(FollowerSynchronizationConfiguration)({
    schemaVersion: 1, follower, profile: "fixture-profile",
    source: { endpoint: "https://127.0.0.1:1", tlsFingerprint: "fixture-tls", signingFingerprint: "fixture-signing" },
    credentialReference: follower.credentialReference, cacheDirectory: join(home, "cache"),
    stateLocation: state, agentPolicy: "deterministic-only",
    scheduledInvocation: defaultScheduledInvocation, updatedAt: at,
    ...fields,
  });
  const database = new DatabaseSync(state);
  try {
    database.prepare("INSERT INTO followers VALUES (?, ?, ?, ?, ?, ?)")
      .run(follower.id, follower.name, "[]", 0, follower.credentialReference, at);
    database.prepare("INSERT INTO follower_sync_configuration VALUES (1, ?, ?, ?)")
      .run(follower.id, JSON.stringify(configuration), at);
  } finally { database.close(); }
};

it.each(["fresh", "source-only", "pending", "pending-rotation"])("refuses schedule selection without finalized enrollment (%s)", (mode) => {
  const { home, state, run } = isolatedCli("canonfig-unenrolled-schedule-");
  try {
    if (mode !== "fresh") {
      const initialized = run(["source", "init"]);
      expect(initialized.status, initialized.stderr).toBe(0);
    }
    if (mode.startsWith("pending")) {
      // Faithful persisted state at the prepare/finalize boundary.
      storeFollowerConfiguration(home, state, {
        enrollmentPending: true,
        scheduleDefault: mode === "pending-rotation" ? { type: "daily", at: "04:30", timezone: "local" } : undefined,
        scheduleOverride: mode === "pending-rotation" ? { kind: "schedule", schedule: { kind: "daily", localTime: "04:30" } } : undefined,
      });
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

// A shell expands `--allow-path ~/x`, but a quoted `~` arrives as written.
// `agent harness` stores it resolved against this machine's home.
it("stores a quoted ~ allow-path as an absolute path", () => {
  const { home, state, run } = isolatedCli("canonfig-allow-path-");
  try {
    const initialized = run(["source", "init"]);
    expect(initialized.status, initialized.stderr).toBe(0);
    // Saving a harness checks the stored Source against this database's identity.
    const source = JSON.parse(initialized.stdout).data;
    // A follower keeps its Source's key in source_identity but holds no
    // enrollment_source row; drop that row so this machine is only a Follower.
    const database = new DatabaseSync(state);
    try { database.prepare("DELETE FROM enrollment_source").run(); } finally { database.close(); }
    storeFollowerConfiguration(home, state, {
      source: { endpoint: "https://127.0.0.1:1", tlsFingerprint: source.tlsFingerprint,
        signingFingerprint: source.source.publicKeyFingerprint },
    });

    // No shell runs here, so `~` arrives as written, as it does when quoted.
    const stored = run(["agent", "harness", "claude", "--executable", process.execPath, "--allow-path", "~/.local/bin"]);
    expect(stored.status, stored.stdout + stored.stderr).toBe(0);
    const harness = run(["agent", "harness"]);
    expect(harness.status, harness.stdout + harness.stderr).toBe(0);
    expect(JSON.parse(harness.stdout).data).toMatchObject({
      kind: "claude", executable: process.execPath, allowedPaths: [join(home, ".local", "bin")],
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 120_000);
