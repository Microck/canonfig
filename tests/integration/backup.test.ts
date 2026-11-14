import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Redacted, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { backupCommand } from "../../src/backup/backup.ts";
import { defaultBackupPolicy, LocalBackups, retainedSnapshots, type BackupPolicy, type BackupRequest, type BackupSnapshot } from "../../src/backup/backup.types.ts";
import { GuiBackupList } from "../../src/gui/contract/backup.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { stateRepositoryLayer } from "../../src/state/state-repository.layer.ts";
import { SynchronizationLive } from "../../src/synchronization/synchronization.layer.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = (path = process.env.PATH ?? "") => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-backup-test-"));
  roots.push(root);
  const home = join(root, "home");
  const folder = join(home, ".canonfig");
  mkdirSync(folder, { recursive: true });
  const original = "# Backup fixture\nPreserve these exact bytes.\n";
  writeFileSync(join(folder, "canonfig.jsonc"), '{"version":1,"harnesses":[]}\n');
  writeFileSync(join(folder, "AGENTS.md"), original);
  const statePath = join(folder, "state.sqlite");
  const machine = linuxMachineStateLayer({
    environment: [{ name: "HOME", value: home }, { name: "XDG_CACHE_HOME", value: join(home, ".cache") }, { name: "PATH", value: path }],
    credentialPolicy: { kind: "local-file", path: join(home, "credentials") },
  });
  const layer = SynchronizationLive.pipe(Layer.provideMerge(stateRepositoryLayer(statePath)), Layer.provideMerge(machine));
  const command = (request: BackupRequest) => backupCommand({ statePath, sourceSigner: Effect.die("Standalone backups do not sign"),
    environment: name => name === "HOME" ? home : undefined }, request).pipe(Effect.provide(layer));
  const run = (request: BackupRequest) => Effect.runPromise(command(request));
  const fail = (request: BackupRequest) => Effect.runPromise(command(request).pipe(Effect.flip));
  const policy = defaultBackupPolicy({ kind: "local", path: join(root, "destination") });
  const configure = (patch: Partial<BackupPolicy> = {}, allowCredentials = false) => run({ action: "configure", name: "daily", policy: { ...policy, ...patch }, allowCredentials });
  const list = async () => Schema.decodeUnknownSync(GuiBackupList)(await run({ action: "list", name: "daily" }));
  return { root, home, folder, original, run, fail, policy, configure, list };
};

describe("portable backup recovery", () => {
  it.each(["fast", "balanced"] as const)("restores %s bytes without copying runtime state and refuses occupied destinations", async compression => {
    const machine = fixture();
    await machine.configure({ compression });
    await machine.run({ action: "run", name: "daily" });
    const output = join(machine.root, "restored");
    await machine.run({ action: "restore", name: "daily", target: { kind: "home", path: output, recoverCredentials: false } });
    expect(readFileSync(join(output, ".canonfig", "AGENTS.md"), "utf8")).toBe(machine.original);
    expect(readFileSync(join(output, ".canonfig", "canonfig.jsonc"))).toEqual(readFileSync(join(machine.folder, "canonfig.jsonc")));
    expect(readdirSync(join(output, ".canonfig")).sort()).toEqual(["AGENTS.md", "canonfig.jsonc"]);
    const refused = await machine.fail({ action: "restore", name: "daily", target: { kind: "home", path: output, recoverCredentials: false } });
    expect(refused._tag).toBe("BackupError");
    expect(readFileSync(join(output, ".canonfig", "AGENTS.md"), "utf8")).toBe(machine.original);
    expect(await machine.run({ action: "drill", name: "daily" })).toMatchObject({ verified: true, restoredFiles: 2 });
    // The status the GUI reads carries the latest run and drill of the policy.
    expect(await machine.run({ action: "status" })).toMatchObject({ runs: { daily: { run: { ok: true, files: 2 }, drill: { ok: true, files: 2 } } } });
  });

  it("never reads an excluded Canonical Folder file, so a file over the content budget can be excluded", async () => {
    const machine = fixture();
    mkdirSync(join(machine.folder, "skills", "big"), { recursive: true });
    writeFileSync(join(machine.folder, "skills", "big", "SKILL.md"), "---\nname: big\ndescription: Big\n---\n");
    // Sparse, so the test writes nothing close to 130 MiB.
    writeFileSync(join(machine.folder, "skills", "big", "data.bin"), "");
    truncateSync(join(machine.folder, "skills", "big", "data.bin"), 130 * 1024 * 1024);
    await machine.configure({ exclude: ["folder/skills/big/**"] });
    expect(await machine.run({ action: "run", name: "daily" })).toMatchObject({ snapshot: { files: 2 } });
  }, 60_000);

  it("fails closed for a wrong password and a corrupted stored object", async () => {
    const machine = fixture();
    await machine.run({ action: "password", name: "recovery", value: Redacted.make("frost library maple canvas") });
    await machine.run({ action: "password", name: "wrong", value: Redacted.make("different backup password") });
    await machine.configure({ passwordReference: "recovery" });
    await machine.run({ action: "run", name: "daily" });
    await machine.configure({ passwordReference: "wrong" });
    const output = join(machine.root, "wrong-password");
    expect(await machine.fail({ action: "restore", name: "daily", target: { kind: "home", path: output, recoverCredentials: false } })).toMatchObject({ code: "BACKUP_VERIFY_FAILED" });
    expect(existsSync(output)).toBe(false);
    await machine.configure({ passwordReference: "recovery" });
    const listing = await machine.list();
    const snapshot = listing.snapshots[0]!;
    const destination = join(machine.root, "destination", "canonfig-backup", "daily", listing.owner, "objects", snapshot.parts[0]!.sha256);
    writeFileSync(destination, "damaged");
    expect(await machine.fail({ action: "restore", name: "daily", target: { kind: "home", path: output, recoverCredentials: false } })).toMatchObject({ code: "BACKUP_VERIFY_FAILED" });
    expect(existsSync(output)).toBe(false);
  }, 60_000);

  it("encrypts full harness capture, excludes credentials and links, and requires local consent for credentials", async () => {
    const machine = fixture();
    const harness = join(machine.home, ".codex");
    mkdirSync(harness);
    writeFileSync(join(harness, "config.toml"), 'model = "fixture"\n');
    writeFileSync(join(harness, "auth.json"), '{"token":"private-fixture-token"}');
    symlinkSync(join(machine.folder, "AGENTS.md"), join(harness, "linked.md"));
    await machine.run({ action: "password", name: "recovery", value: Redacted.make("frost library maple canvas") });
    const capture: Partial<BackupPolicy> = { folder: false, harnesses: { mode: "full", targets: ["codex"] }, passwordReference: "recovery" };
    await machine.configure(capture);
    expect(await machine.run({ action: "run", name: "daily" })).toMatchObject({ skippedCredentials: 1, skippedLinks: 1 });
    const output = join(machine.root, "restored");
    await machine.run({ action: "restore", name: "daily", target: { kind: "home", path: output, recoverCredentials: false } });
    expect(readdirSync(join(output, ".codex"))).toEqual(["config.toml"]);
    expect(readFileSync(join(output, ".codex", "config.toml"))).toEqual(readFileSync(join(harness, "config.toml")));
    await machine.configure({ ...capture, includeCredentials: true });
    expect(await machine.fail({ action: "run", name: "daily" })).toMatchObject({ code: "BACKUP_CREDENTIAL_REQUIRED" });
    // A refused run is recorded with Canonfig's own diagnostic, so the GUI can say why.
    expect(await machine.run({ action: "status" })).toMatchObject({ runs: { daily: { run: { ok: false, message: expect.stringContaining("needs local consent") } } } });
    await machine.run({ action: "allow-credentials", name: "daily" });
    await machine.run({ action: "run", name: "daily" });
    const privateOutput = join(machine.root, "restored-private");
    await machine.run({ action: "restore", name: "daily", target: { kind: "home", path: privateOutput, recoverCredentials: false } });
    expect(readFileSync(join(privateOutput, ".codex", "auth.json"))).toEqual(readFileSync(join(harness, "auth.json")));
    await machine.configure({ ...capture, includeCredentials: true }, false);
    expect(await machine.fail({ action: "run", name: "daily" })).toMatchObject({ code: "BACKUP_CREDENTIAL_REQUIRED" });
  }, 60_000);

  it("captures harness state outside the config root and skips an excluded pipe", async () => {
    const machine = fixture();
    const config = join(machine.home, ".config", "opencode");
    const data = join(machine.home, ".local", "share", "opencode");
    mkdirSync(config, { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(join(config, "opencode.json"), "{}\n");
    writeFileSync(join(data, "opencode.db"), "fixture database");
    expect(spawnSync("mkfifo", [join(data, "events.pipe")]).status).toBe(0);
    // Claude keeps its user config beside, not inside, ~/.claude.
    mkdirSync(join(machine.home, ".claude"));
    writeFileSync(join(machine.home, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(machine.home, ".claude.json"), '{"mcpServers":{}}\n');
    // Codex reads skills from the shared ~/.agents/skills as well as its own root.
    mkdirSync(join(machine.home, ".codex"));
    mkdirSync(join(machine.home, ".agents", "skills", "team"), { recursive: true });
    writeFileSync(join(machine.home, ".agents", "skills", "team", "SKILL.md"), "---\nname: team\ndescription: Team\n---\n");
    await machine.run({ action: "password", name: "recovery", value: Redacted.make("frost library maple canvas") });
    // The exact path the special-file error names.
    await machine.configure({ folder: false, harnesses: { mode: "full", targets: ["opencode", "claude-code", "codex"] }, passwordReference: "recovery", exclude: ["harnesses/opencode/.local/share/opencode/events.pipe"] });
    await machine.run({ action: "run", name: "daily" });
    const output = join(machine.root, "restored");
    await machine.run({ action: "restore", name: "daily", target: { kind: "home", path: output, recoverCredentials: false } });
    expect(readFileSync(join(output, ".local", "share", "opencode", "opencode.db"), "utf8")).toBe("fixture database");
    expect(readFileSync(join(output, ".config", "opencode", "opencode.json"), "utf8")).toBe("{}\n");
    expect(existsSync(join(output, ".local", "share", "opencode", "events.pipe"))).toBe(false);
    expect(readFileSync(join(output, ".claude.json"), "utf8")).toBe('{"mcpServers":{}}\n');
    expect(readFileSync(join(output, ".agents", "skills", "team", "SKILL.md"), "utf8")).toContain("name: team");
  }, 60_000);

  it("leaves out harness credential files with generic names unless credentials are included", async () => {
    const machine = fixture();
    mkdirSync(join(machine.home, ".config", "amp"), { recursive: true });
    mkdirSync(join(machine.home, ".local", "share", "amp", "threads"), { recursive: true });
    writeFileSync(join(machine.home, ".local", "share", "amp", "secrets.json"), '{"token":"private-fixture-token"}');
    writeFileSync(join(machine.home, ".local", "share", "amp", "threads", "t1.json"), "{}\n");
    await machine.run({ action: "password", name: "recovery", value: Redacted.make("frost library maple canvas") });
    await machine.configure({ folder: false, harnesses: { mode: "full", targets: ["amp"] }, passwordReference: "recovery" });
    expect(await machine.run({ action: "run", name: "daily" })).toMatchObject({ skippedCredentials: 1 });
    const output = join(machine.root, "restored");
    await machine.run({ action: "restore", name: "daily", target: { kind: "home", path: output, recoverCredentials: false } });
    expect(readFileSync(join(output, ".local", "share", "amp", "threads", "t1.json"), "utf8")).toBe("{}\n");
    expect(existsSync(join(output, ".local", "share", "amp", "secrets.json"))).toBe(false);
  }, 60_000);

  it("requires explicit native-store recovery and never falls back to credential files", async () => {
    const machine = fixture();
    await machine.run({ action: "password", name: "recovery", value: Redacted.make("synthetic recovery credential") });
    const local = Schema.decodeUnknownSync(LocalBackups)(JSON.parse(readFileSync(join(machine.folder, "backups.json"), "utf8")));
    writeFileSync(join(machine.folder, "secrets.json"), JSON.stringify({ schemaVersion: 1, retiredReferences: [],
      secrets: [{ name: "fixture", reference: local.passwords.recovery, origin: "local" }] }));
    await machine.configure({ passwordReference: "recovery", sharedSecrets: true }, true);
    await machine.run({ action: "run", name: "daily" });
    const output = join(machine.root, "recovery");
    const credentialsBefore = readdirSync(join(machine.home, "credentials"));
    expect(await machine.fail({ action: "restore", name: "daily", target: { kind: "home", path: output, recoverCredentials: false } })).toMatchObject({ code: "BACKUP_INVALID" });
    expect(await machine.fail({ action: "restore", name: "daily", target: { kind: "home", path: output, recoverCredentials: true } })).toMatchObject({ code: "BACKUP_CREDENTIAL_REQUIRED" });
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(join(machine.home, "credentials"))).toEqual(credentialsBefore);
  }, 60_000);

  it("prunes only this owner's snapshots after verified publication", async () => {
    const machine = fixture();
    await machine.configure({ retention: { last: 1, daily: 0, weekly: 0 } });
    await machine.run({ action: "run", name: "daily" });
    const first = (await machine.list()).snapshots[0]!;
    writeFileSync(join(machine.folder, "AGENTS.md"), "Second snapshot\n");
    await machine.run({ action: "run", name: "daily" });
    const listing = await machine.list();
    expect(listing.snapshots.map(snapshot => snapshot.id)).not.toContain(first.id);
    expect(listing.snapshots).toHaveLength(1);
    const output = join(machine.root, "retained");
    await machine.run({ action: "restore", name: "daily", target: { kind: "home", path: output, recoverCredentials: false } });
    expect(readFileSync(join(output, ".canonfig", "AGENTS.md"), "utf8")).toBe("Second snapshot\n");
  });
});

it("retains the union of latest, UTC days and Monday-based weeks across a year boundary", () => {
  const snapshot = (createdAt: string): BackupSnapshot => {
    const id = createHash("sha256").update(createdAt).digest("hex");
    return { version: 1, id, createdAt, policy: "daily", owner: "machine", compression: "fast", codec: "zstd", encrypted: false,
      archiveSha256: id, parts: [{ sha256: id, bytes: 1 }], bytes: 1, files: 1 };
  };
  const dates = ["2027-01-04T12:00:00.000Z", "2027-01-04T09:00:00.000Z", "2027-01-03T12:00:00.000Z", "2026-12-28T12:00:00.000Z", "2026-12-27T12:00:00.000Z"];
  const snapshots = dates.map(snapshot);
  const kept = retainedSnapshots(snapshots, { last: 2, daily: 2, weekly: 3 });
  expect(snapshots.filter(item => kept.has(item.id)).map(item => item.createdAt)).toEqual([dates[0], dates[1], dates[2], dates[4]]);
});

// The destination probes run the real git and rclone found on the process PATH, as the CLI and GUI do.
const hasRclone = spawnSync("rclone", ["version"]).status === 0;
const asRoot = process.getuid?.() === 0;
const withEnvironment = async <A>(changes: Record<string, string>, body: () => Promise<A>): Promise<A> => {
  const before = Object.fromEntries(Object.keys(changes).map(name => [name, process.env[name]]));
  Object.assign(process.env, changes);
  try { return await body(); } finally {
    for (const [name, value] of Object.entries(before)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
};
const bareRepository = (path: string) => expect(spawnSync("git", ["init", "--bare", "--quiet", path]).status).toBe(0);

describe("backup preflight on save, enable and check", () => {
  const secret = "private-fixture-token";
  const rcloneConfig = (root: string, body: string) => {
    const path = join(root, "rclone.conf");
    writeFileSync(path, body);
    return { RCLONE_CONFIG: path };
  };
  interface Saving { readonly policy: BackupPolicy; readonly fail: (request: BackupRequest) => Promise<Error> }
  const refused = async (machine: Saving, patch: Partial<BackupPolicy>, environment: Record<string, string> = {}) => {
    const error = await withEnvironment(environment, () => machine.fail({ action: "configure", name: "daily", policy: { ...machine.policy, ...patch }, allowCredentials: false }));
    // Nothing was saved, and no tool output (which can hold credentials) reached the message.
    expect(await machine.fail({ action: "check", name: "daily" })).toMatchObject({ message: "No backup policy has that name" });
    expect(JSON.stringify(error)).not.toContain(secret);
    return error;
  };

  it("refuses a Git destination when Git is missing, the repository is missing or it can't be written", async () => {
    const machine = fixture();
    const empty = join(machine.root, "empty-path");
    mkdirSync(empty);
    const repository = join(machine.root, "backups.git");
    bareRepository(repository);
    expect(await refused(machine, { destination: { kind: "git", remote: `file://${repository}` } }, { PATH: empty }))
      .toMatchObject({ code: "BACKUP_TOOL_REQUIRED", message: expect.stringContaining("Git isn't installed") });
    expect(await refused(machine, { destination: { kind: "git", remote: `file://${join(machine.root, "missing.git")}` } }))
      .toMatchObject({ code: "BACKUP_INVALID", message: expect.stringContaining("There is no Git repository") });
    if (!asRoot) {
      chmodSync(repository, 0o555);
      try {
        expect(await refused(machine, { destination: { kind: "git", remote: `file://${repository}` } }))
          .toMatchObject({ code: "BACKUP_INVALID", message: expect.stringContaining("can't write to the Git repository") });
      } finally { chmodSync(repository, 0o755); }
    }
  }, 60_000);

  it("refuses an unwritable folder and a missing password alias, and saves a folder the first run will create", async () => {
    const machine = fixture();
    expect(await refused(machine, { passwordReference: "nope" }))
      .toMatchObject({ code: "BACKUP_CREDENTIAL_REQUIRED", message: expect.stringContaining("canonfig backup password nope") });
    if (!asRoot) {
      const locked = join(machine.root, "locked");
      mkdirSync(locked, { mode: 0o555 });
      try {
        expect(await refused(machine, { destination: { kind: "local", path: join(locked, "backups") } }))
          .toMatchObject({ code: "BACKUP_INVALID", message: `Canonfig can't write to ${locked}. Choose a folder this account can write to.` });
      } finally { chmodSync(locked, 0o755); }
    }
    const later = join(machine.root, "not-yet", "backups");
    expect(await machine.configure({ destination: { kind: "local", path: later } })).toMatchObject({ warnings: [expect.stringContaining("doesn't exist yet")] });
    expect(existsSync(later)).toBe(false);
  }, 60_000);

  it("accepts a writable file Git repository, including the push check", async () => {
    const machine = fixture();
    const repository = join(machine.root, "backups.git");
    bareRepository(repository);
    expect(await machine.configure({ destination: { kind: "git", remote: `file://${repository}` } })).toMatchObject({ warnings: [] });
    // The dry-run push created nothing at the destination.
    expect(spawnSync("git", ["--git-dir", repository, "for-each-ref"], { encoding: "utf8" }).stdout).toBe("");
  }, 60_000);

  it.skipIf(!hasRclone)("refuses a missing rclone, an unknown remote name, and accepts a configured one", async () => {
    const machine = fixture();
    const empty = join(machine.root, "empty-path");
    mkdirSync(empty);
    const config = rcloneConfig(machine.root, "[vault]\ntype = local\n");
    expect(await refused(machine, { destination: { kind: "rclone", remote: "vault:backups" } }, { ...config, PATH: empty }))
      .toMatchObject({ code: "BACKUP_TOOL_REQUIRED", message: expect.stringContaining("rclone isn't installed") });
    expect(await refused(machine, { destination: { kind: "rclone", remote: "drive:backups" } }, config))
      .toMatchObject({ code: "BACKUP_INVALID", message: 'rclone has no remote called "drive". Run rclone config to add it, or use one of: vault.' });
    const target = join(machine.root, "cloud");
    expect(await withEnvironment(config, () => machine.configure({ destination: { kind: "rclone", remote: `vault:${target}` } }))).toMatchObject({ warnings: [] });
    // The write probe removed its marker again.
    expect(readdirSync(join(target, "canonfig-backup", "daily"), { recursive: true }).map(String).filter(name => name.includes(".canonfig-check"))).toEqual([]);
  }, 60_000);

  it.skipIf(!hasRclone)("saves an unreachable cloud destination with a warning that names no credential", async () => {
    const machine = fixture();
    const config = rcloneConfig(machine.root, `[offline]\ntype = webdav\nurl = http://127.0.0.1:9/dav\nbearer_token = ${secret}\n`);
    const saved = await withEnvironment(config, () => machine.configure({ destination: { kind: "rclone", remote: "offline:backups" } }));
    expect(saved).toMatchObject({ warnings: [expect.stringContaining("Couldn't reach offline:")] });
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(Object.keys((await machine.run({ action: "status" })).policies)).toEqual(["daily"]);
  }, 90_000);

  it.skipIf(asRoot)("checks again before a paused backup is turned back on", async () => {
    const machine = fixture();
    const destination = join(machine.root, "destination");
    mkdirSync(destination);
    await machine.configure({ destination: { kind: "local", path: destination } });
    await machine.run({ action: "disable", name: "daily" });
    chmodSync(destination, 0o555);
    try {
      expect(await machine.fail({ action: "enable", name: "daily" })).toMatchObject({ code: "BACKUP_INVALID", message: expect.stringContaining("can't write to") });
      expect(await machine.fail({ action: "check", name: "daily" })).toMatchObject({ code: "BACKUP_INVALID" });
    } finally { chmodSync(destination, 0o755); }
    expect(await machine.run({ action: "check", name: "daily" })).toMatchObject({ checked: "daily", warnings: [] });
  }, 60_000);
});
