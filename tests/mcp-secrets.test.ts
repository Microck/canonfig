import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";

import { Effect, Redacted } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { ConfigValue } from "../src/domain/resource.ts";
import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { MachineState } from "../src/machine/machine-state.service.ts";
import { literalCredentialLocation } from "../src/profile/publication-credentials.ts";
import { BUILTIN_ADAPTERS } from "../src/projection/adapters/index.ts";
import { emptyModel } from "../src/projection/detect.ts";
import { decodeFolderConfig, decodeLocalConfig } from "../src/projection/folder.ts";
import type { RootContext } from "../src/projection/harness.ts";
import { projectedMcpServer } from "../src/projection/mcp-launcher.ts";
import type { McpServer } from "../src/projection/model.ts";
import { MCP_REMOTE_VERSION, MCP_RUN_EXIT, npxCliPath, resolveMcpInvocation } from "../src/runtime/mcp-run.ts";
import { scheduleCommand } from "../src/schedule/schedule-command.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const entry = resolve("src/runtime/main.ts");
const loader = resolve("node_modules/tsx/dist/loader.mjs");
const remote: McpServer = {
  transport: "streamable-http", url: "https://example.invalid/mcp",
  headers: { Authorization: { fromSecret: "github.token" }, "X-Region": { fromEnv: "REGION", default: "eu" } },
};

const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-mcp-"));
  roots.push(root);
  const home = join(root, "home");
  const folder = join(home, ".canonfig");
  mkdirSync(folder, { recursive: true });
  const credentials = join(root, "credentials");
  const machine = linuxMachineStateLayer({
    environment: [{ name: "HOME", value: home }],
    credentialPolicy: { kind: "local-file", path: credentials },
  });
  // Exercise the real local-file credential implementation without claiming
  // it satisfies secrets set's native-store requirement.
  const token = "private-launch-fixture-7c311";
  const reference = await Effect.runPromise(Effect.gen(function*() {
    const state = yield* MachineState;
    return yield* state.storeCredential({ name: "github.token", value: Redacted.make(token) });
  }).pipe(Effect.provide(machine)));
  writeFileSync(join(folder, "secrets.json"), JSON.stringify({
    schemaVersion: 1, secrets: [{ name: "github.token", reference, origin: "source" }], retiredReferences: [],
  }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CANONFIG_LOCAL_CREDENTIAL_ROOT: credentials,
    CANONFIG_LOG_FILE: join(folder, "canonfig.log"), PATH: dirname(process.execPath) };
  const writeConfig = (mcp: Record<string, ConfigValue>) => writeFileSync(join(folder, "canonfig.jsonc"), JSON.stringify({
    version: 1, harnesses: [], local: { allow: ["mcp"] }, mcp,
  }));
  return { root, home, folder, credentials, machine, token, env, writeConfig };
};

const invoke = (env: NodeJS.ProcessEnv, name = "echo") => spawnSync(process.execPath,
  ["--import", loader, entry, "mcp", "run", name], { env, encoding: "utf8", timeout: 20_000 });

const hashServer = {
  transport: "stdio", command: process.execPath,
  args: ["-e", "process.stderr.write(require('node:crypto').createHash('sha256').update(process.env.TOKEN + ':' + process.env.REGION).digest('hex'));process.exit(7)"],
  env: { TOKEN: { fromSecret: "github.token" }, REGION: { fromEnv: "MCP_TEST_REGION", default: "eu" } },
};

describe("MCP secret references", () => {
  it.each(["github.token", "A:b-c_d.1", "x".repeat(128)])("accepts %s in published and local definitions", (name) => {
    const mcp = { server: { transport: "stdio", command: "server", env: { TOKEN: { fromSecret: name } } } };
    expect(decodeFolderConfig("canonfig.jsonc", JSON.stringify({ version: 1, harnesses: [], mcp })).mcp).toEqual(mcp);
    expect(decodeLocalConfig("local.jsonc", JSON.stringify({ mcp })).mcp).toEqual(mcp);
    expect(literalCredentialLocation("mcp.server", mcp.server)).toBeUndefined();
  });

  it.each(["", "has space", "../token", "_token", "x".repeat(129)])("rejects invalid secret name %s", (name) => {
    const mcp = { server: { ...remote, headers: { Authorization: { fromSecret: name } } } };
    expect(() => decodeFolderConfig("canonfig.jsonc", JSON.stringify({ version: 1, harnesses: [], mcp }))).toThrow();
    expect(() => decodeLocalConfig("local.jsonc", JSON.stringify({ mcp }))).toThrow();
  });

  it.each([
    { fromSecret: "github.token", fromEnv: "TOKEN" },
    { fromSecret: "github.token", default: "unsafe" },
    { fromSecret: 12 },
  ])("rejects ambiguous or invalid references %j", (value) => {
    const mcp = { server: { ...remote, headers: { Authorization: value } } };
    expect(() => decodeFolderConfig("canonfig.jsonc", JSON.stringify({ version: 1, harnesses: [], mcp }))).toThrow();
  });

  it("does not exempt a literal attached to a secret reference", () => {
    expect(literalCredentialLocation("mcp.server", { headers: { Authorization: { fromSecret: "github.token", value: "private" } } }))
      .toBeDefined();
  });
});

for (const platform of ["linux", "windows"] as const) {
  describe(`${platform} adapter secret launchers`, () => {
    it.each(BUILTIN_ADAPTERS.map((adapter) => [adapter.descriptor.id, adapter] as const))("%s uses the same launcher and preserves ordinary entries", (_id, adapter) => {
      const home = platform === "windows" ? "C:\\Users\\MCP User" : "/home/mcp user";
      const pathJoin = platform === "windows" ? win32.join : join;
      const folder = pathJoin(home, ".canonfig");
      const context: RootContext = { platform, home, appData: pathJoin(home, "config"), environment: () => undefined, join: pathJoin };
      const ordinary: McpServer = { transport: "stdio", command: "server", args: ["--stdio"], env: { MODE: "safe", TOKEN: { fromEnv: "TOKEN" } } };
      const local: McpServer = { transport: "stdio", command: "private-server", args: [], cwd: "/private", env: { TOKEN: { fromSecret: "github.token" } } };
      const model = { ...emptyModel(folder), mcp: [["remote", remote], ["local", local], ["ordinary", ordinary]] as const };
      const binding = scheduleCommand();
      const wrapped: McpServer = { transport: "stdio", command: binding.executable, args: [binding.arguments[0]!, "mcp", "run", "remote"], env: {} };
      expect(projectedMcpServer("remote", remote)).toEqual(wrapped);
      expect(projectedMcpServer("ordinary", ordinary)).toBe(ordinary);
      const expected = { ...model, mcp: [["remote", wrapped], ["local", { ...wrapped, args: [binding.arguments[0]!, "mcp", "run", "local"] }], ["ordinary", ordinary]] as const };
      const runtime = { folder, hookRunner: pathJoin(folder, ".runtime", "hook-runner.mjs"), platform };
      const actual = adapter.project(model, adapter.layout(context, model), runtime);
      expect(actual).toEqual(adapter.project(expected, adapter.layout(context, expected), runtime));
      expect(JSON.stringify(actual.contents)).not.toContain("fromSecret");
      expect(JSON.stringify(actual.contents)).not.toContain("github.token");
    });
  });
}

describe("canonfig mcp run", () => {
  it("loads a real local credential into a child, preserves its code and leaves stdout clean", async () => {
    const f = await fixture();
    f.writeConfig({ echo: hashServer });
    const child = invoke({ ...f.env, MCP_TEST_REGION: "us" });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(7);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe(createHash("sha256").update(`${f.token}:us`).digest("hex"));
    expect(readFileSync(join(f.folder, "canonfig.log"), "utf8")).not.toContain(f.token);
  });

  it("passes stdin and stdout MCP frames through without Canonfig output", async () => {
    const f = await fixture();
    f.writeConfig({ echo: { ...hashServer, args: ["-e", "process.stdin.pipe(process.stdout)"] } });
    const frame = '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n';
    const child = spawnSync(process.execPath, ["--import", loader, entry, "mcp", "run", "echo"], {
      env: f.env, input: frame, encoding: "utf8", timeout: 20_000,
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(frame);
    expect(child.stderr).toBe("");
  });

  it("finds npm beside a Windows Node path with spaces without a shell", () => {
    expect(npxCliPath("C:\\Program Files\\nodejs\\node.exe", "win32"))
      .toBe("C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js");
  });

  it("reads an allowed local overlay instead of the published definition", async () => {
    const f = await fixture();
    f.writeConfig({ echo: { ...hashServer, command: "must-not-start" } });
    mkdirSync(join(f.folder, "local"));
    writeFileSync(join(f.folder, "local", "local.jsonc"), JSON.stringify({ overlays: ["mcp/echo"], mcp: { echo: hashServer } }));
    const child = invoke(f.env);
    expect(child.status).toBe(7);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe(createHash("sha256").update(`${f.token}:eu`).digest("hex"));
  });

  it("fails on a missing secret without launching or leaking anything", async () => {
    const f = await fixture();
    f.writeConfig({ echo: { ...hashServer, env: { TOKEN: { fromSecret: "missing.token" } } } });
    const child = invoke(f.env);
    expect(child.status).toBe(MCP_RUN_EXIT.missingSecret);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("Secret missing.token is missing");
    expect(child.stderr).toContain("canonfig secrets sync");
    expect(child.stderr).not.toContain(f.token);
  });

  it("fails closed when credential storage is unreadable", async () => {
    const f = await fixture();
    f.writeConfig({ echo: hashServer });
    rmSync(f.credentials, { recursive: true });
    const child = invoke(f.env);
    expect(child.status).toBe(MCP_RUN_EXIT.storage);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("Secret github.token could not be read");
    expect(child.stderr).not.toContain(f.token);
  });

  it("reports unknown servers and failed executable starts", async () => {
    const f = await fixture();
    f.writeConfig({ echo: { ...hashServer, command: join(f.root, "not-installed") } });
    expect(invoke(f.env, "unknown").status).toBe(MCP_RUN_EXIT.configuration);
    const child = invoke(f.env);
    expect(child.status).toBe(MCP_RUN_EXIT.launch);
    expect(child.stdout).toBe("");
    expect(child.stderr).not.toContain(f.token);
  });

  it("builds pinned HTTP bridge argv with headers only in environment variables", async () => {
    const f = await fixture();
    const invocation = await Effect.runPromise(resolveMcpInvocation(remote, { PATH: "", REGION: "us" })
      .pipe(Effect.provide(f.machine)));
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([
      npxCliPath(process.execPath), "-y", "--silent", `mcp-remote@${MCP_REMOTE_VERSION}`, remote.url,
      "--silent", "--transport", "http-only", "--header", "Authorization:${CANONFIG_MCP_HEADER_0}",
      "--header", "X-Region:${CANONFIG_MCP_HEADER_1}",
    ]);
    expect(invocation.env.CANONFIG_MCP_HEADER_0).toBe(f.token);
    expect(invocation.env.CANONFIG_MCP_HEADER_1).toBe("us");
    expect(invocation.env.PATH).toContain(dirname(process.execPath));
    expect(JSON.stringify(invocation.args)).not.toContain(f.token);
  });

  it.skipIf(process.platform === "win32")("forwards SIGTERM to its disposable child and returns the child's exit code", async () => {
    const f = await fixture();
    f.writeConfig({ echo: { ...hashServer, args: ["-e", "process.on('SIGTERM',()=>process.exit(37));process.stderr.write('ready');setInterval(()=>{},1000)"] } });
    const child = spawn(process.execPath, ["--import", loader, entry, "mcp", "run", "echo"], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number | null>((done, reject) => { child.once("exit", done); child.once("error", reject); });
    try {
      await new Promise<void>((done, reject) => {
        // This watchdog bounds a real subprocess startup, not a guessed wait.
        const timer = setTimeout(() => reject(new Error("disposable MCP child did not become ready")), 15_000);
        child.stderr.on("data", (bytes: Buffer) => { if (bytes.toString().includes("ready")) { clearTimeout(timer); done(); } });
        child.once("error", reject);
      });
      child.kill("SIGTERM");
      expect(await exited).toBe(37);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
});
