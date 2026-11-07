import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { ConfigValue } from "../../src/domain/resource.ts";

import { adapterFor } from "../../src/projection/adapters/index.ts";
import type { TargetId } from "../../src/projection/model.ts";
import { CredentialReference } from "../../src/domain/brand.ts";
import { cancelFollowerEnrollment } from "../../src/enrollment/follower-client.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";

/**
 * The folder model end to end through the CLI: a Source and its followers
 * each run in their own temporary HOME with real SQLite, a real
 * `canonfig source serve` over loopback HTTPS, and fake harness executables
 * on a PATH that holds nothing else. Nothing is mocked.
 */

const project = resolve(import.meta.dirname, "../..");
const roots: Array<string> = [];
const servers: Array<ChildProcess> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.exitCode === null && server.signalCode === null) {
      const closed = once(server, "close");
      server.kill("SIGKILL");
      await closed;
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 60_000);

const write = (path: string, content: string, mode?: number) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
};

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: {
    readonly status?: string;
    readonly message?: string;
    readonly data?: Readonly<Record<string, ConfigValue>>;
    readonly details?: Readonly<Record<string, ConfigValue>>;
  };
}

interface Machine {
  readonly home: string;
  /** This machine's `~/.canonfig/`. */
  readonly folder: string;
  readonly state: string;
  readonly bin: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly run: (arguments_: ReadonlyArray<string>, input?: string) => CliResult;
}

/**
 * One machine: a HOME of its own and a PATH holding only `harnesses`' fake
 * executables, so harnesses installed on the host running the tests are
 * never detected. No inherited variable such as CODEX_HOME leaks in.
 */
const machine = (name: string, harnesses: ReadonlyArray<TargetId> = []): Machine => {
  const root = mkdtempSync(join(tmpdir(), `canonfig-folder-sync-${name}-`));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const harness of harnesses) {
    const name = adapterFor(harness).descriptor.executables[0]!;
    write(join(bin, process.platform === "win32" ? `${name}.exe` : name), "", 0o755);
  }
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    PATH: bin,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    CANONFIG_LOCAL_CREDENTIAL_ROOT: join(root, "credentials"),
    CANONFIG_LOG: "off",
    NODE_NO_WARNINGS: "1",
  };
  const run = (arguments_: ReadonlyArray<string>, input?: string): CliResult => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/runtime/main.ts", ...arguments_, "--json"], {
      cwd: project,
      env: environment,
      encoding: "utf8",
      input,
      // A full follower apply under tsx can exceed a minute on hosted Windows
      // runners; past the budget spawnSync kills it and reports status null.
      timeout: 180_000,
    });
    const text = result.stdout.trim().length > 0 ? result.stdout : result.stderr;
    let envelope: CliResult["envelope"] = {};
    try {
      envelope = JSON.parse(text);
    } catch {
      // The assertion on `status` reports stdout and stderr.
    }
    // Name a kill or spawn failure (e.g. ETIMEDOUT) in stderr, so a null status explains itself.
    const stderr = result.error === undefined ? result.stderr : `${result.stderr}\n${result.error.message}`;
    return { status: result.status, stdout: result.stdout, stderr, envelope };
  };
  const folder = join(home, ".canonfig");
  return { home, folder, state: join(folder, "state.sqlite"), bin, environment, run };
};

const succeed = (result: CliResult, label: string): CliResult => {
  expect(result.status, `${label}: ${result.stdout}${result.stderr}`).toBe(0);
  return result;
};

/** The Source's Canonical Folder: instructions, a skill, a rule, two hooks out of id order, MCP and tools. */
const authorSource = (folder: string, config: Readonly<Record<string, ConfigValue>> = {}) => {
  write(join(folder, "canonfig.jsonc"), `// The Source's folder\n${JSON.stringify({
    version: 1,
    profile: { id: "workstation", name: "Workstation" },
    harnesses: ["claude-code", "codex"],
    mcp: {
      docs: { transport: "streamable-http", url: "https://example.invalid/mcp", headers: { Authorization: { fromEnv: "DOCS_MCP_TOKEN" } } },
    },
    hooks: [
      { id: "zeta", event: "after_tool", run: ["hooks/format.sh"] },
      { id: "alpha", event: "before_tool", run: ["hooks/format.sh"] },
    ],
    local: { allow: ["skills"] },
    ...config,
  }, undefined, 2)}\n`);
  write(join(folder, "AGENTS.md"), "# Source instructions\n\nPrefer small diffs.\n");
  write(join(folder, "rules", "style.md"), "---\ndescription: Style\n---\nUse two spaces.\n");
  write(join(folder, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy the service\n---\nDeploy carefully.\n");
  write(join(folder, "hooks", "format.sh"), "#!/bin/sh\nexit 0\n", 0o755);
};

const unusedPort = (): Promise<number> =>
  new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const decoded = Schema.decodeUnknownOption(Schema.Struct({ port: Schema.Int }))(server.address());
      const port = decoded._tag === "Some" ? decoded.value.port : 0;
      server.close(() => resolvePort(port));
    });
  });

/** `canonfig source serve` in the background; resolves with its endpoint once it listens. */
const serve = async (source: Machine, requestedPort?: number): Promise<string> => {
  const port = requestedPort ?? await unusedPort();
  const child = spawn(process.execPath, [
    "--import", "tsx", "src/runtime/main.ts", "source", "serve", "--host", "127.0.0.1", "--port", `${port}`, "--json",
  ], { cwd: project, env: source.environment, stdio: ["ignore", "pipe", "pipe"] });
  servers.push(child);
  return new Promise((resolveEndpoint, rejectEndpoint) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => rejectEndpoint(new Error(`source serve did not start: ${stderr}`)), 60_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolveEndpoint(JSON.parse(stdout.slice(0, newline)).data.endpoint);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (stdout.length === 0) rejectEndpoint(new Error(`source serve exited (${String(code)}): ${stderr}`));
    });
  });
};

/** Issue an invitation and enroll `follower` with it over stdin, expecting exit `status`. */
const enroll = (
  source: Machine,
  endpoint: string,
  follower: Machine,
  name: string,
  groups: ReadonlyArray<string> = [],
  status = 0,
) => {
  const output = join(source.home, `${name}.invite`);
  succeed(source.run(["source", "invite", "--endpoint", endpoint, "--output", output, ...groups.flatMap((group) => ["--group", group])]), "invite");
  const envelope = readFileSync(output, "utf8");
  rmSync(output);
  const result = follower.run(["follower", "enroll", "--stdin", "--name", name], envelope);
  expect(result.status, `enroll ${name}: ${result.stdout}${result.stderr}`).toBe(status);
  return result;
};

/** A Source with its folder published and served. */
const startSource = async (config: Readonly<Record<string, ConfigValue>> = {}) => {
  const source = machine("source");
  authorSource(source.folder, config);
  succeed(source.run(["source", "init"]), "source init");
  succeed(source.run(["source", "publish", "--reviewer", "reviewer@example.test"]), "publish");
  return { source, endpoint: await serve(source) };
};

const appliedFollowers = (state: string): Record<string, number> => {
  const database = new DatabaseSync(state, { readOnly: true });
  try {
    const rows = database.prepare("SELECT follower_id AS follower, COUNT(*) AS count FROM applied_resources GROUP BY follower_id").all();
    return Object.fromEntries(rows.map((row) => [String(row.follower), Number(row.count)]));
  } finally {
    database.close();
  }
};

const read = (path: string) => readFileSync(path, "utf8");

/** Every file under `folder` but the state database, by relative path, with its bytes. */
const folderFiles = (folder: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(folder, { recursive: true, encoding: "utf8" })
      .filter((path) => !path.startsWith("state.sqlite") && statSync(join(folder, path)).isFile())
      .sort()
      .map((path) => [path, readFileSync(join(folder, path), "base64")]),
  );

const rowCount = (state: string, table: string): number => {
  const database = new DatabaseSync(state, { readOnly: true });
  try {
    return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count);
  } finally {
    database.close();
  }
};

describe("folder sync across a Source and its followers", () => {
  it("retains both credentials and reports rollback pending while the previous Source is offline", async () => {
    const previous = await startSource();
    const candidate = await startSource();
    const follower = machine("offline-rollback");
    enroll(previous.source, previous.endpoint, follower, "old-name");
    succeed(follower.run(["sync", "--apply"]), "initial mirror");
    const remote = new DatabaseSync(candidate.source.state);
    remote.exec(`
      CREATE TRIGGER interrupt_finalize BEFORE INSERT ON followers
      BEGIN SELECT RAISE(FAIL, 'interrupted Source finalization'); END;
    `);
    remote.close();
    const invitation = join(candidate.source.home, "offline.invite");
    succeed(candidate.source.run(["source", "invite", "--endpoint", candidate.endpoint, "--output", invitation]), "candidate invitation");
    const envelope = read(invitation);
    const command = ["follower", "enroll", "--replace", "--stdin", "--name", "replacement"];
    const failed = follower.run(command, envelope);
    expect(failed.status, failed.stdout + failed.stderr).not.toBe(0);
    const local = new DatabaseSync(follower.state, { readOnly: true });
    const pending = JSON.parse(String(local.prepare("SELECT configuration_json FROM follower_sync_configuration").get()?.configuration_json));
    local.close();
    expect(pending.lifecycle._tag).toBe("Finalizing");
    // Cancel only the Source's prepared half, as restart recovery would do.
    // Transport leaves the locally owned item in place until rollback settles.
    await Effect.runPromise(cancelFollowerEnrollment({
      endpoint: candidate.endpoint,
      tlsFingerprint: pending.source.tlsFingerprint,
      credentialReference: Schema.decodeUnknownSync(CredentialReference)(pending.credentialReference),
    }).pipe(Effect.provide(linuxMachineStateLayer({
      environment: [{ name: "HOME", value: follower.home }],
      credentialPolicy: { kind: "local-file", path: String(follower.environment.CANONFIG_LOCAL_CREDENTIAL_ROOT) },
    }))));
    const repaired = new DatabaseSync(candidate.source.state);
    repaired.exec("DROP TRIGGER interrupt_finalize");
    repaired.close();
    const previousServer = servers[0];
    if (previousServer === undefined) throw new Error("disposable previous Source server is missing");
    const stopped = once(previousServer, "close");
    previousServer.kill("SIGTERM");
    await stopped;
    servers.splice(servers.indexOf(previousServer), 1);
    const store = String(follower.environment.CANONFIG_LOCAL_CREDENTIAL_ROOT);
    const retained = readdirSync(store).sort();
    expect(retained).toHaveLength(2);
    const offline = follower.run(command, envelope);
    expect(offline.status, offline.stdout + offline.stderr).not.toBe(0);
    expect(offline.stdout + offline.stderr).toContain("rollback is pending");
    const status = succeed(follower.run(["status"]), "rollback status");
    expect(status.envelope.data).toMatchObject({ enrollmentLifecycle: "RollbackPending" });
    expect(status.stdout).toContain("canonfig follower enroll");
    const doctor = follower.run(["doctor", "--no-input", "--timeout-ms", "1000"]);
    expect(doctor.stdout + doctor.stderr).toContain("rollback is pending");
    expect(doctor.stdout + doctor.stderr).toContain("canonfig follower enroll");
    expect(readdirSync(store).sort()).toEqual(retained);
    await serve(previous.source, Number(new URL(previous.endpoint).port));
    succeed(follower.run(command, envelope), "verified rollback and replacement retry");
    expect(readdirSync(store)).toHaveLength(1);
    const settled = new DatabaseSync(follower.state, { readOnly: true });
    const active = JSON.parse(String(settled.prepare("SELECT configuration_json FROM follower_sync_configuration").get()?.configuration_json));
    expect(active.lifecycle).toEqual({ _tag: "Active" });
    expect(active.source.endpoint).toBe(candidate.endpoint);
    expect(settled.prepare("SELECT count(*) AS count FROM enrollment_credential_retirements").get()?.count).toBe(0);
    settled.close();
  }, 240_000);

  it("resumes replacement after remote finalization without treating the existing mirror as authored content", async () => {
    const { source, endpoint } = await startSource();
    const follower = machine("replacement");
    enroll(source, endpoint, follower, "old-name");
    succeed(follower.run(["sync", "--apply"]), "initial sync");
    const database = new DatabaseSync(follower.state);
    const previous = JSON.parse(String(database.prepare("SELECT configuration_json FROM follower_sync_configuration").get()?.configuration_json));
    database.exec(`
      CREATE TRIGGER interrupt_confirmation BEFORE UPDATE ON follower_sync_configuration
      WHEN json_extract(NEW.configuration_json, '$.enrollmentPending') IS NULL
        AND (json_extract(NEW.configuration_json, '$.lifecycle._tag') IS NULL
          OR json_extract(NEW.configuration_json, '$.lifecycle._tag') = 'RetiringPrevious')
      BEGIN SELECT RAISE(FAIL, 'interrupted local confirmation'); END;
    `);
    database.close();
    const invitation = join(source.home, "replacement.invite");
    succeed(source.run(["source", "invite", "--endpoint", endpoint, "--output", invitation]), "replacement invitation");
    const envelope = read(invitation);
    const failed = follower.run(["follower", "enroll", "--replace", "--stdin", "--name", "new-name"], envelope);
    expect(failed.status, failed.stdout + failed.stderr).not.toBe(0);
    const interrupted = new DatabaseSync(follower.state);
    interrupted.exec("DROP TRIGGER interrupt_confirmation");
    interrupted.close();
    const resumed = follower.run(["follower", "enroll", "--replace", "--stdin", "--name", "new-name"], envelope);
    succeed(resumed, "resume replacement with an existing mirror");
    const local = new DatabaseSync(follower.state, { readOnly: true });
    const active = JSON.parse(String(local.prepare("SELECT configuration_json FROM follower_sync_configuration").get()?.configuration_json));
    local.close();
    expect(active.lifecycle).toEqual({ _tag: "Active" });
    expect(active.follower.name).toBe("new-name");
    expect(existsSync(previous.credentialReference.slice("local-file:".length))).toBe(false);
    const remote = new DatabaseSync(source.state, { readOnly: true });
    expect(remote.prepare("SELECT revoked FROM followers WHERE id = ?").get(previous.follower.id)?.revoked).toBe(1);
    remote.close();
    succeed(follower.run(["sync", "--apply"]), "sync replacement");
  }, 180_000);

  it("publishes, enrolls, mirrors and projects, and re-keys an earlier local projection", async () => {
    const { source, endpoint } = await startSource();
    const follower = machine("laptop", ["claude-code"]);

    // Before enrolling, the laptop projected a folder of its own.
    const notes = "---\nname: notes\ndescription: Laptop notes\n---\nKeep notes.\n";
    write(join(follower.folder, "canonfig.jsonc"), JSON.stringify({ version: 1, harnesses: ["claude-code"] }));
    write(join(follower.folder, "AGENTS.md"), "# Laptop instructions\n");
    write(join(follower.folder, "skills", "notes", "SKILL.md"), notes);
    succeed(follower.run(["sync", "--apply"]), "local sync");
    expect(read(join(follower.home, ".claude", "CLAUDE.md"))).toContain("Laptop instructions");
    const localRecords = appliedFollowers(follower.state).local ?? 0;
    expect(localRecords).toBeGreaterThan(0);

    // Those authored files sit where the mirror goes, so enrolling stops
    // before it contacts the Source and says how to keep them.
    const refused = enroll(source, endpoint, follower, "laptop", [], 2);
    expect(refused.envelope.message).toContain("canonfig.jsonc, AGENTS.md, skills");
    expect(refused.envelope.message).toContain(join(follower.folder, "local"));
    expect(appliedFollowers(follower.state)).toEqual({ local: localRecords });
    expect(read(join(follower.folder, "AGENTS.md"))).toBe("# Laptop instructions\n");

    // The laptop keeps its skill as a local item and drops the rest.
    write(join(follower.folder, "local", "skills", "notes", "SKILL.md"), notes);
    rmSync(join(follower.folder, "skills"), { recursive: true });
    rmSync(join(follower.folder, "AGENTS.md"));
    rmSync(join(follower.folder, "canonfig.jsonc"));

    // Enrolling hands the local records to the follower identity in one step.
    const enrolled = enroll(source, endpoint, follower, "laptop").envelope.data;
    expect(enrolled).toMatchObject({ profile: "workstation", adoptedLocalRecords: localRecords });
    // Every record now belongs to the enrolled identity; none is left under `local`.
    const owners = appliedFollowers(follower.state);
    expect(owners.local).toBeUndefined();
    expect(Object.values(owners)).toEqual([localRecords]);

    const applied = succeed(follower.run(["sync", "--apply"]), "follower sync").envelope.data;
    expect(applied).toMatchObject({ outcome: { outcome: "Converged" }, notInstalled: ["codex"] });

    // The mirror holds what the Source published; canonfig.jsonc keeps the
    // Source's hook order, not id order.
    expect(read(join(follower.folder, "AGENTS.md"))).toBe(read(join(source.folder, "AGENTS.md")));
    expect(read(join(follower.folder, "skills", "deploy", "SKILL.md"))).toContain("Deploy carefully.");
    const hook = join(follower.folder, "hooks", "format.sh");
    // An enabled direct hook conveys execute intent on Windows, where stat
    // cannot expose a POSIX execute bit; the follower stores it in NTFS.
    const mode = process.platform === "win32"
      ? Number.parseInt(readFileSync(`${hook}:canonfig.mode`, "utf8"), 8)
      : statSync(hook).mode;
    expect(mode & 0o100).toBe(0o100);
    const mirrorConfig = JSON.parse(read(join(follower.folder, "canonfig.jsonc")).replace(/^\/\/.*$/gmu, ""));
    expect(mirrorConfig.hooks.map((hook: { id: string }) => hook.id)).toEqual(["zeta", "alpha"]);
    expect(mirrorConfig.profile).toBeUndefined();

    // The projection was updated from the Source, not refused as foreign:
    // the re-keyed record says Canonfig wrote it. The local skill stays.
    expect(read(join(follower.home, ".claude", "CLAUDE.md"))).toContain("Source instructions");
    expect(read(join(follower.home, ".claude", "skills", "deploy", "SKILL.md"))).toContain("Deploy carefully.");
    expect(read(join(follower.home, ".claude", "skills", "notes", "SKILL.md"))).toBe(notes);
    expect(existsSync(join(follower.home, ".codex"))).toBe(false);

    const again = succeed(follower.run(["sync", "--apply"]), "second sync").envelope.data;
    expect(again).toMatchObject({ outcome: { outcome: "Converged" } });
  }, 240_000);

  it("hides grouped items and every item that depends on one", async () => {
    const { source, endpoint } = await startSource({
      mcp: {
        docs: { transport: "streamable-http", url: "https://example.invalid/mcp" },
        git: { transport: "stdio", command: "uvx", args: ["mcp-server-git"], requires: ["tools/uv"] },
      },
      tools: { uv: { executable: "uv", recipes: [{ platform: "linux", method: "uv", package: "uv", version: "0.4.0" }] } },
      groups: { work: ["tools/uv", "skills/deploy"] },
    });
    const outsider = machine("outsider", ["claude-code"]);
    const worker = machine("worker", ["claude-code"]);
    // The work machine already has uv, so the tool verifies without installing.
    write(join(worker.bin, process.platform === "win32" ? "uv.exe" : "uv"), "", 0o755);
    enroll(source, endpoint, outsider, "outsider");
    enroll(source, endpoint, worker, "worker", ["work"]);

    succeed(outsider.run(["sync", "--apply"]), "outsider sync");
    succeed(worker.run(["sync", "--apply"]), "worker sync");

    const mcpOf = (follower: Machine) =>
      Object.keys(JSON.parse(read(join(follower.folder, "canonfig.jsonc")).replace(/^\/\/.*$/gmu, "")).mcp ?? {}).sort();
    // mcp/git requires the grouped tool, so it is hidden with it.
    expect(mcpOf(outsider)).toEqual(["docs"]);
    expect(existsSync(join(outsider.folder, "skills", "deploy"))).toBe(false);
    expect(existsSync(join(outsider.home, ".claude", "skills", "deploy"))).toBe(false);
    expect(Object.keys(JSON.parse(read(join(outsider.home, ".claude.json"))).mcpServers).sort()).toEqual(["docs"]);

    expect(mcpOf(worker)).toEqual(["docs", "git"]);
    expect(read(join(worker.home, ".claude", "skills", "deploy", "SKILL.md"))).toContain("Deploy carefully.");
    expect(Object.keys(JSON.parse(read(join(worker.home, ".claude.json"))).mcpServers).sort()).toEqual(["docs", "git"]);
  }, 240_000);

  it("keeps an edited mirror file as drift and holds what is projected from it", async () => {
    const { source, endpoint } = await startSource();
    const follower = machine("laptop", ["claude-code"]);
    enroll(source, endpoint, follower, "laptop");
    succeed(follower.run(["sync", "--apply"]), "first sync");
    const projected = read(join(follower.home, ".claude", "CLAUDE.md"));

    write(join(follower.folder, "AGENTS.md"), "# Edited on the laptop\n");
    write(join(source.folder, "AGENTS.md"), "# Source instructions, second edition\n");
    succeed(source.run(["source", "publish", "--reviewer", "reviewer@example.test"]), "republish");

    const drifted = follower.run(["sync", "--apply"]);
    expect(drifted.status, drifted.stdout + drifted.stderr).toBe(4);
    expect(JSON.stringify(drifted.envelope)).toContain("FollowerDrift");
    expect(read(join(follower.folder, "AGENTS.md"))).toBe("# Edited on the laptop\n");
    expect(read(join(follower.home, ".claude", "CLAUDE.md"))).toBe(projected);
  }, 240_000);

  it("stops with Human Action Required when local/ reuses a published name", async () => {
    const { source, endpoint } = await startSource();
    const follower = machine("laptop", ["claude-code"]);
    enroll(source, endpoint, follower, "laptop");
    write(join(follower.folder, "local", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Mine\n---\nMine.\n");

    const collided = follower.run(["sync", "--apply"]);
    expect(collided.status, collided.stdout + collided.stderr).toBe(3);
    expect(JSON.stringify(collided.envelope)).toContain("deploy");
    expect(existsSync(join(follower.home, ".claude"))).toBe(false);
    expect(read(join(follower.folder, "local", "skills", "deploy", "SKILL.md"))).toContain("Mine.");
  }, 240_000);

  it("keeps each machine a Source or a Follower, never both", async () => {
    // A plain machine becomes a Source (startSource runs init and publish)
    // and another plain machine follows it.
    const { source, endpoint } = await startSource();
    const follower = machine("laptop", ["claude-code"]);
    enroll(source, endpoint, follower, "laptop");
    succeed(follower.run(["sync", "--apply"]), "follower sync");
    const mirror = folderFiles(follower.folder);

    // The Follower's folder is the Source's mirror: it cannot also become a
    // Source, plan a Source setup, or run any Source command that scans,
    // publishes, serves or grants access.
    const inviteOutput = join(follower.home, "follower.invite");
    for (const [command, action] of [
      [["source", "init"], "become a Source"],
      [["source", "scan"], "scan its folder for tools"],
      [["source", "publish", "--reviewer", "reviewer@example.test"], "publish a revision"],
      [["source", "serve", "--port", "1"], "serve as a Source"],
      [["source", "service", "install", "--port", "1"], "install the Source service"],
      [["source", "invite", "--endpoint", endpoint, "--output", inviteOutput], "invite followers"],
      [["source", "revoke", "desk"], "revoke followers"],
      [["setup", "plan", "--role", "source"], "be set up as a Source"],
    ] as const) {
      const refused = follower.run(command);
      expect(refused.status, `${command.join(" ")}: ${refused.stdout}${refused.stderr}`).toBe(2);
      expect(refused.envelope.message).toContain(`follows the Source at ${endpoint}`);
      expect(refused.envelope.message).toContain(`as laptop`);
      expect(refused.envelope.message).toContain(`so it cannot ${action}`);
      expect(refused.envelope.message).toContain("canonfig follower unenroll");
    }
    expect(folderFiles(follower.folder)).toEqual(mirror);
    expect(existsSync(inviteOutput)).toBe(false);
    expect(rowCount(follower.state, "enrollment_source")).toBe(0);

    // An enrollment the Source accepted but this machine has not finished
    // already holds the Follower role.
    const state = new DatabaseSync(follower.state);
    try {
      state.prepare("UPDATE follower_sync_configuration SET configuration_json = json_set(configuration_json, '$.lifecycle', json('{\"_tag\":\"Finalizing\"}'))").run();
    } finally {
      state.close();
    }
    const pending = follower.run(["source", "init"]);
    expect(pending.status, pending.stdout + pending.stderr).toBe(2);
    expect(pending.envelope.message).toContain(`is enrolling with the Source at ${endpoint}`);
    expect(rowCount(follower.state, "enrollment_source")).toBe(0);

    // The Source cannot enroll as a Follower or plan a Follower setup. The
    // refusal comes before the invitation is used.
    const invitation = join(source.home, "self.invite");
    succeed(source.run(["source", "invite", "--endpoint", endpoint, "--output", invitation]), "invite");
    const envelope = read(invitation);
    for (const [command, input] of [
      [["follower", "enroll", "--stdin", "--name", "self"], envelope],
      [["setup", "plan", "--role", "follower"], undefined],
    ] as const) {
      const refused = source.run(command, input);
      expect(refused.status, `${command.join(" ")}: ${refused.stdout}${refused.stderr}`).toBe(2);
      expect(refused.envelope.message).toContain("this machine is a Source");
      expect(refused.envelope.message).toContain(`move ${source.folder} aside`);
    }
    expect(rowCount(source.state, "follower_sync_configuration")).toBe(0);
    expect(existsSync(join(source.folder, "setup.json"))).toBe(false);

    const desk = machine("desk");
    succeed(desk.run(["follower", "enroll", "--stdin", "--name", "desk"], envelope), "enroll with the unused invitation");

    // A plan made before the machine took the other role is refused at apply,
    // before any item runs and without touching setup.json.
    const planAndApprove = (target: Machine, role: string) => {
      succeed(target.run(["setup", "plan", "--role", role]), `setup plan --role ${role}`);
      succeed(target.run(["setup", "approve", "--approver", "reviewer@example.test"]), "setup approve");
      return readFileSync(join(target.folder, "setup.json"));
    };
    // A Follower plan, then source init.
    const bench = machine("bench");
    const followerPlan = planAndApprove(bench, "follower");
    succeed(bench.run(["source", "init"]), "bench source init");
    const benchApply = bench.run(["setup", "apply"]);
    expect(benchApply.status, benchApply.stdout + benchApply.stderr).toBe(2);
    expect(benchApply.envelope.message).toContain("this machine is a Source");
    expect(readFileSync(join(bench.folder, "setup.json"))).toEqual(followerPlan);
    // A Source plan, then follower enroll.
    const studio = machine("studio");
    const sourcePlan = planAndApprove(studio, "source");
    enroll(source, endpoint, studio, "studio");
    const studioApply = studio.run(["setup", "apply"]);
    expect(studioApply.status, studioApply.stdout + studioApply.stderr).toBe(2);
    expect(studioApply.envelope.message).toContain(`follows the Source at ${endpoint}`);
    expect(readFileSync(join(studio.folder, "setup.json"))).toEqual(sourcePlan);
    expect(rowCount(studio.state, "enrollment_source")).toBe(0);
    expect(existsSync(join(studio.folder, "canonfig.jsonc"))).toBe(false);
  }, 240_000);
});
