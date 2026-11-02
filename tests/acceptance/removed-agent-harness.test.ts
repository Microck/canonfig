import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { defaultScheduledInvocation } from "../../src/synchronization/follower-sync-config.ts";

// A follower that stored the `gemini` harness before 5.0.0 removed it (ADR 0002)
// gets a usage error naming the fix, and `agent harness <kind>` can replace it.
it("explains a stored removed agent harness and lets agent harness replace it", () => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-removed-harness-"));
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
    const initialized = run(["source", "init"]);
    expect(initialized.status, initialized.stderr).toBe(0);
    const source = JSON.parse(initialized.stdout).data;
    // The row a 4.x follower wrote after `agent harness gemini`, inserted as stored.
    const at = "2026-10-21T00:00:00Z";
    const follower = { id: "gemini-follower", name: "Gemini", groups: [], revoked: false,
      credentialReference: "gemini-credential", enrolledAt: at };
    const state = join(home, ".canonfig", "state.sqlite");
    const storedJson = JSON.stringify({
      schemaVersion: 1, follower, selectedProfile: "fixture-profile",
      source: { endpoint: "https://127.0.0.1:1", tlsFingerprint: source.tlsFingerprint,
        signingFingerprint: source.source.publicKeyFingerprint },
      credentialReference: follower.credentialReference, cacheDirectory: join(home, "cache"),
      stateLocation: state, agentPolicy: "deterministic-only",
      agentHarness: { kind: "gemini", executable: process.execPath, maximumInputBytes: 4096,
        allowedPaths: [home], allowedExecutables: [], allowedOrigins: [], allowedCapabilities: [] },
      scheduledInvocation: defaultScheduledInvocation, updatedAt: at,
    });
    const readStored = () => {
      const database = new DatabaseSync(state);
      try {
        return Schema.decodeUnknownSync(Schema.Struct({ configuration_json: Schema.String }))(
          database.prepare("SELECT configuration_json FROM follower_sync_configuration").get(),
        ).configuration_json;
      } finally { database.close(); }
    };
    const database = new DatabaseSync(state);
    try {
      database.prepare("INSERT INTO followers VALUES (?, ?, ?, ?, ?, ?)")
        .run(follower.id, follower.name, "[]", 0, follower.credentialReference, at);
      database.prepare("INSERT INTO follower_sync_configuration VALUES (1, ?, ?, ?)")
        .run(follower.id, storedJson, at);
    } finally { database.close(); }

    for (const command of [["status"], ["agent", "harness"]]) {
      const refused = run(command);
      expect(refused.status, refused.stdout + refused.stderr).toBe(2);
      expect(refused.stdout + refused.stderr).toContain(
        "the gemini agent harness was removed in 5.0.0; run 'canonfig agent harness codex|claude|custom ...' to replace it",
      );
    }
    // Reads report the removed kind; they never rewrite it.
    expect(readStored()).toBe(storedJson);

    const replaced = run(["agent", "harness", "claude", "--executable", process.execPath, "--allow-path", home]);
    expect(replaced.status, replaced.stdout + replaced.stderr).toBe(0);
    const harness = run(["agent", "harness"]);
    expect(harness.status, harness.stdout + harness.stderr).toBe(0);
    expect(JSON.parse(harness.stdout).data).toMatchObject({ kind: "claude", executable: process.execPath });
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 120_000);
