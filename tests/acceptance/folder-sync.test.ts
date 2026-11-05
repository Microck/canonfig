import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { ConfigValue } from "../../src/domain/resource.ts";

import { adapterFor } from "../../src/projection/adapters/index.ts";
import type { TargetId } from "../../src/projection/model.ts";

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
      timeout: 60_000,
    });
    const text = result.stdout.trim().length > 0 ? result.stdout : result.stderr;
    let envelope: CliResult["envelope"] = {};
    try {
      envelope = JSON.parse(text);
    } catch {
      // The assertion on `status` reports stdout and stderr.
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, envelope };
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
const serve = async (source: Machine): Promise<string> => {
  const port = await unusedPort();
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

describe("folder sync across a Source and its followers", () => {
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
});
