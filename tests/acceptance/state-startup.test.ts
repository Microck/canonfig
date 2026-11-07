import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    else expect(JSON.parse(result.stderr)).toMatchObject({ command: args[0] === "status" ? "status" : args[0] === "sync" ? "sync.plan" : `${args[0]}.${args[1]}`, schema: "canonfig.cli/v1", status: "error", exitCode: 3 });
    expect(readFileSync(badPath, "utf8")).toBe("not a database or directory");
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30000);

});

it("reports a locked startup database as retryable human action", () => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-locked-state-"));
  const root = join(home, ".canonfig");
  mkdirSync(root);
  const database = new DatabaseSync(join(root, "state.sqlite"));
  try {
    database.exec("CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES ('keep'); BEGIN EXCLUSIVE");
    const result = spawnSync(process.execPath,
      ["--import", "tsx", resolve(import.meta.dirname, "../../src/runtime/main.ts"), "status", "--json"],
      { encoding: "utf8", timeout: 60000, env: { ...process.env, CANONFIG_DEBUG: "1", CANONFIG_LOG: "off", HOME: home, USERPROFILE: home,
        XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state") } });
    expect({ status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }).toMatchObject({ status: 3, signal: null, error: undefined, stdout: "" });
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ schema: "canonfig.cli/v1", command: "status", exitCode: 3 });
    expect(JSON.parse(result.stderr).message).toContain("busy");
    expect(database.prepare("SELECT value FROM preserved").get()?.value).toBe("keep");
  } finally { database.close(); rmSync(home, { recursive: true, force: true }); }
}, 70000);


it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each([0o500, 0o000])(
  "reports an inaccessible state directory (mode %i) without creating a database", (mode) => {
    const home = mkdtempSync(join(tmpdir(), "canonfig-inaccessible-state-"));
    const root = join(home, ".canonfig");
    mkdirSync(root);
    chmodSync(root, mode);
    try {
      for (const json of [false, true]) {
        const result = spawnSync(process.execPath,
          ["--import", "tsx", resolve(import.meta.dirname, "../../src/runtime/main.ts"), "status", ...(json ? ["--json"] : [])],
          { encoding: "utf8", timeout: 20000, env: { ...process.env, HOME: home, XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state") } });
        expect(result.status, result.stdout + result.stderr).toBe(3);
        expect(result.stdout).toBe("");
        if (json) expect(JSON.parse(result.stderr)).toMatchObject({ schema: "canonfig.cli/v1", command: "status", exitCode: 3 });
        else expect(result.stderr).toContain("exit 3:");
        expect(statSync(root).mode & 0o777).toBe(mode);
      }
      chmodSync(root, 0o700);
      expect(existsSync(join(root, "state.sqlite"))).toBe(false);
    } finally { chmodSync(root, 0o700); rmSync(home, { recursive: true, force: true }); }
  }, 50000,
);

// An earlier state format wrote another migration history. Canonfig
// refuses that database before it migrates or writes anything, and names the
// fix: move the database aside and set the machine up again.
it("refuses state an earlier release wrote without changing it", () => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-earlier-state-"));
  const root = join(home, ".canonfig");
  mkdirSync(root);
  const state = join(root, "state.sqlite");
  const database = new DatabaseSync(state);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE effect_sql_migrations (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    );
    INSERT INTO effect_sql_migrations (migration_id, name) VALUES (1, 'state_repository'), (21, 'resource_blob_chunks');
  `);
  database.close();
  const before = { bytes: readFileSync(state), entries: readdirSync(root) };
  try {
    for (const json of [false, true]) {
      const result = spawnSync(process.execPath,
        ["--import", "tsx", resolve(import.meta.dirname, "../../src/runtime/main.ts"), "status", ...(json ? ["--json"] : [])],
        { encoding: "utf8", timeout: 20000, env: { ...process.env, CANONFIG_LOG: "off", HOME: home, USERPROFILE: home,
          XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state") } });
      expect(result.status, result.stdout + result.stderr).toBe(3);
      expect(result.stdout).toBe("");
      const message = json ? String(JSON.parse(result.stderr).message) : result.stderr;
      expect(message).toContain("created by an earlier Canonfig version");
      expect(message).toContain(`move ${state} aside`);
      expect(message).toContain("canonfig setup plan");
      expect(readFileSync(state).equals(before.bytes)).toBe(true);
      expect(readdirSync(root)).toEqual(before.entries);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 50000);
