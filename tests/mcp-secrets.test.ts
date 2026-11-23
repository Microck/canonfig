import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";

import { Effect, Layer, Predicate, Redacted } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { ConfigValue } from "../src/domain/resource.ts";
import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { MachineState } from "../src/machine/machine-state.service.ts";
import { literalCredentialLocation } from "../src/profile/publication-credentials.ts";
import { BUILTIN_ADAPTERS } from "../src/projection/adapters/index.ts";
import { emptyModel } from "../src/projection/detect.ts";
import { decodeFolderConfig, decodeLocalConfig, loadCanonicalFolder } from "../src/projection/folder.ts";
import type { RootContext } from "../src/projection/harness.ts";
import { mcpProxyAuthorization, projectedMcpServer, readMcpProxyBinding } from "../src/projection/mcp-launcher.ts";
import type { CanonicalModel, McpServer } from "../src/projection/model.ts";
import { projectSurfaces } from "../src/projection/plan.ts";
import { checkMcpEntries } from "../src/runtime/mcp-check.ts";
import { launchMcp, MCP_REMOTE_VERSION, MCP_RUN_EXIT, npxCliPath, resolveMcpInvocation, resolveMcpValue } from "../src/runtime/mcp-run.ts";
import { scheduleCommand } from "../src/schedule/schedule-command.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const entry = resolve("src/runtime/main.ts");
// --import takes a URL; a bare C:\ path fails on Windows before the CLI starts.
const loader = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
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
  return { root, home, folder, credentials, machine, token, reference, env, writeConfig };
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

describe("launcher environment passthrough", () => {
  it.each(["linux", "darwin", "win32"] as const)("forwards only session and fromEnv source names on %s", (platform) => {
    const server: McpServer = {
      transport: "stdio", command: "server", args: [],
      env: { TOKEN: { fromSecret: "github.token" }, RENAMED: { fromEnv: "REGION", default: "eu" },
        DUPLICATE: { fromEnv: "REGION" }, LITERAL: "not-forwarded" },
    };
    const session = platform === "linux"
      ? { DBUS_SESSION_BUS_ADDRESS: { fromEnv: "DBUS_SESSION_BUS_ADDRESS" }, XDG_RUNTIME_DIR: { fromEnv: "XDG_RUNTIME_DIR" } }
      : {};
    const stdio = projectedMcpServer("server", server, platform);
    expect(stdio.transport === "stdio" && stdio.env).toEqual({ ...session, REGION: { fromEnv: "REGION" } });
    const projected = projectedMcpServer("remote", remote, platform);
    expect(projected.transport === "stdio" && projected.env).toEqual({ ...session, REGION: { fromEnv: "REGION" } });
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
      const sessionEnv = process.platform === "linux"
        ? { DBUS_SESSION_BUS_ADDRESS: { fromEnv: "DBUS_SESSION_BUS_ADDRESS" }, XDG_RUNTIME_DIR: { fromEnv: "XDG_RUNTIME_DIR" } }
        : {};
      const wrapped: McpServer = { transport: "stdio", command: binding.executable,
        args: [binding.arguments[0]!, "mcp", "run", "remote"], env: { ...sessionEnv, REGION: { fromEnv: "REGION" } } };
      expect(projectedMcpServer("remote", remote)).toEqual(wrapped);
      expect(projectedMcpServer("ordinary", ordinary)).toBe(ordinary);
      const expected = { ...model, mcp: [["remote", wrapped], ["local", { ...wrapped, env: sessionEnv, args: [binding.arguments[0]!, "mcp", "run", "local"] }], ["ordinary", ordinary]] as const };
      const runtime = { folder, hookRunner: pathJoin(folder, ".runtime", "hook-runner.mjs"), platform };
      const project = (input: CanonicalModel) => adapter.project(
        { ...input, mcpPermissionNames: input.mcp.map(([name]) => name) }, adapter.layout(context, input), runtime,
      );
      const actual = project(model);
      expect(actual).toEqual(project(expected));
      if (adapter.descriptor.id === "codex") {
        const config = actual.contents.find((content) => content.kind === "config");
        expect(config?.kind === "config" && config.keys).toContainEqual({
          path: "mcp_servers",
          value: expect.objectContaining({
            remote: { command: binding.executable, args: wrapped.args, env_vars: [...Object.keys(sessionEnv), "REGION"] },
          }),
        });
      }
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

  it.skipIf(process.platform !== "win32")("finds an installed npm beside a Windows Node path with spaces", () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig npm "));
    roots.push(root);
    const cli = join(root, "node_modules", "npm", "bin", "npx-cli.js");
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, "process.exit(0)");
    expect(npxCliPath(join(root, "node.exe"), "win32", "")).toBe(realpathSync(cli));
  });

  it.skipIf(process.platform === "win32").each(["standard", "libexec", "bin-symlink", "path-symlink"] as const)(
    "resolves the installed npx JavaScript entrypoint in a %s layout", (layout) => {
      const root = mkdtempSync(join(tmpdir(), "canonfig-npm-"));
      roots.push(root);
      const bin = join(root, "Cellar", "node", "24", "bin");
      mkdirSync(bin, { recursive: true });
      const cli = layout === "standard" ? join(bin, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js")
        : layout === "libexec" ? join(bin, "..", "libexec", "lib", "node_modules", "npm", "bin", "npx-cli.js")
        : join(root, "prefix", "lib", "node_modules", "npm", "bin", "npx-cli.js");
      mkdirSync(dirname(cli), { recursive: true });
      writeFileSync(cli, "process.stdout.write('installed-npx')");
      const searchBin = layout === "path-symlink" ? join(root, "prefix", "bin") : bin;
      mkdirSync(searchBin, { recursive: true });
      if (layout.endsWith("symlink")) symlinkSync(cli, join(searchBin, "npx"));
      const resolved = npxCliPath(join(bin, "node"), "linux", searchBin);
      const child = spawnSync(process.execPath, [resolved], { encoding: "utf8" });
      expect(child.status).toBe(0);
      expect(child.stdout).toBe("installed-npx");
    },
  );

  it("reports missing npm instead of returning a nonexistent entrypoint", async () => {
    const f = await fixture();
    const root = mkdtempSync(join(tmpdir(), "canonfig-no-npm-"));
    roots.push(root);
    expect(() => npxCliPath(join(root, "bin", "node"), "linux", "")).toThrow("Install npm");
    const error = await Effect.runPromise(resolveMcpInvocation(remote, { PATH: "" }, join(root, "bin", "node"), "linux")
      .pipe(Effect.provide(f.machine), Effect.match({ onFailure: (failure) => failure, onSuccess: () => undefined })));
    expect(error).toMatchObject({ exitCode: MCP_RUN_EXIT.launch, message: expect.stringContaining("Install npm") });
  });

  it.each(["win32", "linux", "darwin"] as const)("replaces environment aliases only on Windows (%s)", async (platform) => {
    const f = await fixture();
    const inherited = { TOKEN: "stale", token: "also-stale", REGION: "us" };
    const server: McpServer = { transport: "stdio", command: process.execPath, args: [],
      env: { Token: { fromSecret: "github.token" } } };
    const invocation = await Effect.runPromise(resolveMcpInvocation(server, inherited, process.execPath, platform)
      .pipe(Effect.provide(f.machine)));
    expect(invocation.env).toEqual(platform === "win32"
      ? { Token: f.token, REGION: "us" } : { ...inherited, Token: f.token });
    expect(inherited.TOKEN).toBe("stale");
  });

  it.each(["C:\\Tools\\server.cmd", "C:\\Tools With Spaces\\server.BAT", "server.CmD"])(
    "rejects Windows batch command %s with an actionable error", async (command) => {
      await expect(launchMcp({ command, args: ["%TOKEN%", "!TOKEN!", "& whoami", "\""], env: {} }, "win32"))
        .rejects.toMatchObject({ name: "McpRunError", exitCode: MCP_RUN_EXIT.launch,
          message: expect.stringContaining("use node.exe") });
    },
  );

  it("keeps native executable launches shell-free on Windows", async () => {
    expect(await launchMcp({ command: process.execPath, args: ["-e", "process.exit(17)"], env: {} }, "win32")).toBe(17);
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

const listen = (server: Server) => new Promise<number>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.removeListener("error", reject);
    const address = server.address();
    if (address === null || Predicate.isString(address)) reject(new Error("Expected a TCP listener"));
    else resolve(address.port);
  });
});

const stopListening = (server: Server) => new Promise<void>((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
  server.closeAllConnections();
});

describe("canonfig mcp proxy", () => {
  it("rereads a reference retired between lookup and native credential read", async () => {
    const f = await fixture();
    const replacement = "replacement-proxy-fixture";
    const reads: string[] = [];
    const rotatingStore = Layer.effect(MachineState, Effect.gen(function*() {
      const machine = yield* MachineState;
      const next = yield* machine.storeCredential({ name: "github.token.replacement", value: Redacted.make(replacement) });
      return MachineState.of({
        ...machine,
        loadCredential: (input) => Effect.gen(function*() {
          reads.push(input.reference);
          if (input.reference === f.reference && reads.length === 1) {
            writeFileSync(join(f.folder, "secrets.json"), JSON.stringify({
              schemaVersion: 1, secrets: [{ name: "github.token", reference: next, origin: "source" }], retiredReferences: [],
            }));
            yield* machine.removeCredential(f.reference);
          }
          return yield* machine.loadCredential(input);
        }),
      });
    })).pipe(Layer.provide(f.machine));
    const resolved = await Effect.runPromise(resolveMcpValue({ fromSecret: "github.token" }, {}).pipe(Effect.provide(rotatingStore)));
    expect(resolved).toBe(replacement);
    expect(reads).toHaveLength(2);
    expect(reads[0]).toBe(f.reference);
    expect(reads[1]).not.toBe(f.reference);
  });

  it.each([
    { transport: "sse" },
    { headers: { Authorization: "literal" } },
    { url: "http://example.invalid/mcp" },
    { url: "https://login@example.invalid/mcp" },
    { url: "https://example.invalid/mcp#fragment" },
  ])("rejects invalid proxy declarations %j", (overrides) => {
    const config = { version: 1, harnesses: [], mcp: { remote: { ...remote, proxy: true, ...overrides } } };
    expect(() => decodeFolderConfig("canonfig.jsonc", JSON.stringify(config))).toThrow();
  });

  it("does not require a proxy binding when the server targets another harness", async () => {
    const f = await fixture();
    writeFileSync(join(f.folder, "canonfig.jsonc"), JSON.stringify({
      version: 1, harnesses: ["claude-code"],
      mcp: { remote: { ...remote, proxy: true, harnesses: ["codex"] } },
    }));
    const loaded = await loadCanonicalFolder(f.folder);
    const context: RootContext = { platform: process.platform, home: f.home, appData: f.home, environment: () => undefined, join };
    const { surfaces } = await Effect.runPromise(projectSurfaces(loaded, context, [], new Set()).pipe(Effect.provide(f.machine)));
    expect(surfaces.some(({ surface }) => surface.id === "mcp")).toBe(false);
  });

  it("uses one listener for native HTTP projections and keeps upstream credentials private", async () => {
    const f = await fixture();
    const requests: Array<{ url: string | undefined; method: string | undefined; headers: IncomingHttpHeaders; body: string }> = [];
    let streamClosed: Promise<unknown> | undefined;
    const upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ url: request.url, method: request.method, headers: request.headers, body });
      if (request.url === "/redirect") {
        response.writeHead(307, { location: "/private" }).end(f.token);
      } else if (request.url === "/error") {
        response.writeHead(401, { "www-authenticate": f.token }).end(f.token);
      } else if (request.url === "/rpc-error") {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0", id: 1, error: { code: -32000, message: `Credential ${f.token} was rejected` },
        }));
      } else if (request.url === "/stream") {
        streamClosed = once(response, "close", { signal: AbortSignal.timeout(5_000) });
        response.writeHead(200, { "content-type": "text/event-stream" }).write("data: active\n\n");
      } else if (request.url === "/connection") {
        response.writeHead(200, { connection: "close, Mcp-Session-Id", "mcp-session-id": "hop-only" }).end();
      } else if (request.method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream" }).end("data: {\"jsonrpc\":\"2.0\"}\n\n");
      } else if (request.method === "DELETE") {
        response.writeHead(204).end();
      } else {
        response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "upstream-session" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } }));
      }
    });
    const url = `http://127.0.0.1:${await listen(upstream)}`;
    let proxy: ReturnType<typeof spawn> | undefined;
    let stopped: Promise<unknown> | undefined;
    const output: string[] = [];
    try {
      const spare = createServer();
      const port = await listen(spare);
      await stopListening(spare);
      const proxied = { ...remote, url: `${url}/ignored`, proxy: true };
      const configPath = join(f.folder, "canonfig.jsonc");
      const pendingConfigPath = join(f.root, "pending-config.jsonc");
      writeFileSync(configPath, JSON.stringify({
        version: 1, harnesses: ["codex", "claude-code"], local: { allow: ["mcp"] },
        tools: { probe: { executable: "probe-tool", recipes: [] } },
        mcp: {
          remote: proxied,
          scoped: { ...proxied, url: `${url}/scoped`, harnesses: ["codex"], requires: ["tools/probe"] },
          other: { ...proxied, url: `${url}/other` },
          missing: { ...proxied, headers: { Authorization: { fromSecret: "missing.token" } } },
          ordinary: { ...remote, url: `${url}/ordinary` },
        },
      }));
      mkdirSync(join(f.folder, "local"));
      const writeOverlay = (path: string, preserveMcp = false, secretName = "github.token") =>
        writeFileSync(join(f.folder, "local", "local.jsonc"), JSON.stringify({
          overlays: ["mcp/remote"],
          mcp: { remote: { ...proxied, url: `${url}${path}`,
            headers: { ...remote.headers, Authorization: { fromSecret: secretName } } } },
          preserveMcp,
        }));
      writeOverlay("/mcp?configured=true");
      const project = async () => {
        const loaded = await loadCanonicalFolder(f.folder);
        const context: RootContext = { platform: process.platform, home: f.home, appData: f.home, environment: () => undefined, join };
        return Effect.runPromise(projectSurfaces(loaded, context, [], new Set()).pipe(Effect.provide(f.machine)));
      };
      await expect(project()).rejects.toThrow("Start 'canonfig mcp proxy'");
      writeOverlay("/mcp?configured=true", true);
      await expect(project()).resolves.toBeDefined();
      writeOverlay("/mcp?configured=true");
      renameSync(configPath, pendingConfigPath);
      proxy = spawn(process.execPath, ["--import", loader, entry, "mcp", "proxy", "--port", String(port)], {
        // An environment proxy would send an absolute URL to this server.
        env: { ...f.env, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: url, http_proxy: url, NO_PROXY: "", no_proxy: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      stopped = once(proxy, "close");
      proxy.stderr?.setEncoding("utf8").on("data", (text: string) => output.push(text));
      const [ready] = await Promise.race([
        once(proxy.stdout!.setEncoding("utf8"), "data", { signal: AbortSignal.timeout(20_000) }),
        stopped.then(() => { throw new Error(output.join("")); }),
      ]);
      const origin = `http://127.0.0.1:${port}`;
      expect(ready).toBe(`MCP proxy listening at ${origin}.\n`);
      renameSync(pendingConfigPath, configPath);
      const { surfaces, requiredMcpTools } = await project();
      expect([...requiredMcpTools]).toEqual(["tools:probe"]);
      const projection = JSON.stringify(surfaces);
      const binding = await readMcpProxyBinding(f.folder);
      expect(binding).toBeDefined();
      for (const privateValue of [f.token, binding!.seed, "fromSecret", "/ignored", "/mcp?configured=true"]) {
        expect(projection).not.toContain(privateValue);
      }
      const authorization = mcpProxyAuthorization(binding!, "remote");
      const endpoint = `${origin}/mcp/remote`;
      const scopedAuthorization = mcpProxyAuthorization(binding!, "scoped");
      const scopedEndpoint = `${origin}/mcp/scoped`;
      const codex = surfaces.find(({ harness, surface }) => harness === "codex" && surface.id === "config")?.content;
      const claude = surfaces.find(({ harness, surface }) => harness === "claude-code" && surface.id === "mcp")?.content;
      expect(codex?.kind === "config" && codex.keys).toContainEqual({
        path: "mcp_servers", value: expect.objectContaining({
          remote: { url: endpoint, http_headers: { Authorization: authorization } },
          scoped: { url: scopedEndpoint, http_headers: { Authorization: scopedAuthorization } },
          ordinary: expect.objectContaining({ args: expect.arrayContaining(["mcp", "run", "ordinary"]) }),
        }),
      });
      expect(claude?.kind === "config" && claude.keys).toContainEqual({
        path: "mcpServers", value: expect.objectContaining({
          remote: { type: "http", url: endpoint, headers: { Authorization: authorization } },
        }),
      });
      expect(claude?.kind === "config" && claude.keys.find(({ path }) => path === "mcpServers")?.value).not.toHaveProperty("scoped");

      expect((await fetch(endpoint)).status).toBe(404);
      expect((await fetch(endpoint, { headers: { authorization, origin: "https://example.invalid" } })).status).toBe(403);
      expect((await fetch(`${origin}/mcp/other`, { headers: { authorization } })).status).toBe(404);
      expect((await fetch(`${endpoint}?injected=1`, { headers: { authorization } })).status).toBe(404);
      expect((await fetch(endpoint, { method: "PUT", headers: { authorization } })).status).toBe(405);
      expect(requests).toHaveLength(0);

      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });
      const initialized = await fetch(endpoint, {
        method: "POST", body, headers: { authorization, cookie: "do-not-forward=1", "content-type": "application/json" },
      });
      const session = initialized.headers.get("mcp-session-id");
      expect(session).toMatch(/^[a-f0-9]{64}\.upstream-session$/u);
      expect(await initialized.json()).toMatchObject({ result: { protocolVersion: "2025-03-26" } });
      expect(requests[0]).toMatchObject({
        url: "/mcp?configured=true", method: "POST", body, headers: { authorization: f.token, "x-region": "eu" },
      });
      expect(requests[0]?.headers.cookie).toBeUndefined();

      const headers = { authorization, "mcp-session-id": session!, "mcp-protocol-version": "2025-03-26", "last-event-id": "event-1" };
      const stream = await fetch(endpoint, { headers });
      expect(stream.headers.get("content-type")).toBe("text/event-stream");
      expect(await stream.text()).toBe("data: {\"jsonrpc\":\"2.0\"}\n\n");
      expect(requests[1]).toMatchObject({ method: "GET", headers: {
        "mcp-session-id": "upstream-session", "mcp-protocol-version": "2025-03-26", "last-event-id": "event-1",
      } });
      expect((await fetch(endpoint, { method: "DELETE", headers })).status).toBe(204);

      const other = await fetch(`${origin}/mcp/other`, { headers: { authorization: mcpProxyAuthorization(binding!, "other") } });
      expect(await other.text()).toContain("data:");
      expect(requests[3]?.url).toBe("/other");
      const missing = await fetch(`${origin}/mcp/missing`, { headers: { authorization: mcpProxyAuthorization(binding!, "missing") } });
      expect(missing.status).toBe(503);
      expect(await missing.text()).toContain("Secret missing.token is missing");
      expect(requests).toHaveLength(4);

      writeOverlay("/redirect", false, "missing.token");
      expect((await fetch(endpoint, { headers })).status).toBe(404);
      expect(requests).toHaveLength(4);
      writeOverlay("/redirect");
      const redirected = await fetch(endpoint, { headers: { authorization } });
      expect(redirected.status).toBe(502);
      expect(redirected.headers.get("location")).toBeNull();
      expect(await redirected.text()).not.toContain(f.token);
      expect(requests.map((request) => request.url)).not.toContain("/private");

      writeOverlay("/error");
      const denied = await fetch(endpoint, { headers: { authorization } });
      expect(denied.status).toBe(401);
      expect(denied.headers.get("www-authenticate")).toBeNull();
      expect(await denied.text()).not.toContain(f.token);

      writeOverlay("/rpc-error");
      const report = await checkMcpEntries([{
        harness: "codex", name: "remote", path: configPath,
        launch: { kind: "http", url: endpoint, headers: { Authorization: authorization }, sse: false,
          secrets: [authorization], timeoutMilliseconds: undefined },
      }], 5_000);
      expect(report).toMatchObject([{ status: "fail", detail: "initialize failed: the upstream returned a JSON-RPC error" }]);
      expect(JSON.stringify(report)).not.toContain(f.token);

      writeOverlay("/connection");
      const response = await new Promise<IncomingHttpHeaders>((resolve, reject) => {
        const request = httpRequest(endpoint, {
          headers: { authorization, connection: "close, Mcp-Session-Id", "mcp-session-id": "hop-only" },
        }, (response) => {
          response.resume();
          response.once("end", () => resolve(response.headers));
        });
        request.once("error", reject);
        request.end();
      });
      expect(requests.at(-1)).toMatchObject({ url: "/connection" });
      expect(requests.at(-1)?.headers["mcp-session-id"]).toBeUndefined();
      expect(response["mcp-session-id"]).toBeUndefined();

      writeOverlay("/stream");
      const active = await fetch(endpoint, { headers: { authorization }, signal: AbortSignal.timeout(5_000) });
      const reader = active.body!.getReader();
      const firstEvent = await reader.read();
      expect(new TextDecoder().decode(firstEvent.value)).toBe("data: active\n\n");
      expect(streamClosed).toBeDefined();
      await reader.cancel();
      await streamClosed;

      const rotated = "rotated-proxy-fixture";
      const reference = await Effect.runPromise(Effect.gen(function*() {
        const machine = yield* MachineState;
        return yield* machine.storeCredential({ name: "github.token.rotated", value: Redacted.make(rotated) });
      }).pipe(Effect.provide(f.machine)));
      writeFileSync(join(f.folder, "secrets.json"), JSON.stringify({
        schemaVersion: 1, secrets: [{ name: "github.token", reference, origin: "source" }], retiredReferences: [],
      }));
      writeOverlay("/rotated");
      const afterRotation = await fetch(endpoint, { headers: { authorization } });
      expect(await afterRotation.text()).toContain("data:");
      expect(requests.at(-1)?.headers.authorization).toBe(rotated);

      const scopedResponse = await fetch(scopedEndpoint, { headers: { authorization: scopedAuthorization } });
      expect(await scopedResponse.text()).toContain("data:");
      expect(requests.at(-1)).toMatchObject({ url: "/scoped", headers: { authorization: rotated } });

      await stopListening(upstream);
      const unavailable = await fetch(endpoint, { headers: { authorization } });
      expect(unavailable.status).toBe(502);
      expect(await unavailable.text()).not.toContain(f.token);
    } finally {
      proxy?.kill();
      await stopped;
      if (upstream.listening) await stopListening(upstream);
    }
    expect(output.join("")).not.toContain(f.token);
    expect(readFileSync(f.env.CANONFIG_LOG_FILE, "utf8")).not.toContain(f.token);
  });
});
