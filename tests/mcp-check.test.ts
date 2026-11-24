import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { RootContext } from "../src/projection/harness.ts";
import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { checkMcpEntries, readHarnessMcpEntries, responseEvents, withLauncherSecrets, type McpEntry } from "../src/runtime/mcp-check.ts";

// A minimal stdio MCP server: it lists one tool per name in FIXTURE_TOOLS, or
// exits with an error when FIXTURE_FAIL is set.
const SERVER = `
const tools = (process.env.FIXTURE_TOOLS ?? "").split(",").filter(Boolean);
if (process.argv[2] === "--echo-arg") { console.error("argument " + process.argv[3] + " rejected"); process.exit(3); }
if (process.env.FIXTURE_FAIL) { console.error("token " + process.env.FIXTURE_FAIL + " key " + (process.env.API_TOKEN ?? "") + " rejected"); process.exit(3); }
let buffer = "";
let pinged;
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let i = buffer.indexOf("\\n"); i >= 0; i = buffer.indexOf("\\n")) {
    let message = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    // With FIXTURE_PING the server pings first and answers initialize only once the ping is answered.
    if (message.method === "initialize" && process.env.FIXTURE_PING && !pinged) { pinged = message.id; process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "ping-1", method: "ping" }) + "\\n"); continue; }
    if (message.id === "ping-1" && message.result) message = { id: pinged, method: "initialize" };
    if (message.method === "initialize") reply(message.id, { protocolVersion: "2025-06-18", capabilities: process.env.FIXTURE_NO_TOOLS ? { prompts: {} } : { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
    if (message.method === "tools/list" && process.env.FIXTURE_ECHO) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "token " + process.env.FIXTURE_ECHO + " was rejected" } }) + "\\n");
    else if (message.method === "tools/list") reply(message.id, { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) });
  }
});
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
`;

/** What the fixture HTTP server reads from each JSON-RPC request and from its own bound address. */
const FixtureRequest = Schema.Struct({
  id: Schema.optionalKey(Schema.Number),
  result: Schema.optionalKey(Schema.Json),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Struct({ protocolVersion: Schema.optionalKey(Schema.String) })),
});
const ListeningAddress = Schema.Struct({ port: Schema.Number });

function sseEntry(url: string): McpEntry {
  return { harness: "claude-code", path: ".claude.json", name: "fixture-sse",
    launch: { kind: "http", url, headers: { Authorization: "Bearer fixture", "X-Fixture-Credential": "fixture" }, sse: true, secrets: ["fixture"], timeoutMilliseconds: undefined },
  };
}

const homes: Array<string> = [];
const servers: Array<Server> = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  for (const server of servers.splice(0)) server.close();
});

const listen = async (server: Server): Promise<string> => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + Schema.decodeUnknownSync(ListeningAddress)(server.address()).port;
};

const fixtureHome = () => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-mcp-check-"));
  homes.push(home);
  const script = join(home, "server.cjs");
  writeFileSync(script, SERVER);
  const context: RootContext = {
    platform: "linux",
    home,
    appData: join(home, ".config"),
    environment: () => undefined,
    join: (...segments) => join(...segments),
  };
  return { home, script, context };
};

const read = (context: RootContext, harnesses: Parameters<typeof readHarnessMcpEntries>[0]["harnesses"], environment: NodeJS.ProcessEnv = {}) =>
  readHarnessMcpEntries({ context, folder: join(context.home, ".canonfig"), harnesses, environment: { PATH: process.env.PATH, ...environment }, cwd: context.home });

describe.skipIf(process.platform === "win32")("MCP server check", () => {
  it("launches what each harness declares and reports one result per distinct launch", async () => {
    const { home, script, context } = fixtureHome();
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), [
      "[mcp_servers.tools]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(script)}]`,
      "env = { FIXTURE_TOOLS = \"a,b\" }",
      "[mcp_servers.missing]",
      "command = \"/nonexistent/mcp-server\"",
      "[mcp_servers.off]",
      "command = \"/nonexistent/mcp-server\"",
      "enabled = false",
      "[mcp_servers.prompts]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(script)}]`,
      "env = { FIXTURE_NO_TOOLS = \"1\" }",
      "[mcp_servers.pings]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(script)}]`,
      "env = { FIXTURE_PING = \"1\", FIXTURE_TOOLS = \"a\" }",
      "[mcp_servers.echoes]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(script)}]`,
      "env = { FIXTURE_ECHO = \"fixture-echoed-secret\" }",
      "[mcp_servers.broken]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(script)}]`,
      "env = { FIXTURE_FAIL = \"fixture-secret-value\", API_TOKEN = \"k3y9\" }",
    ].join("\n"));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      mcpServers: { tools: { command: process.execPath, args: [script], env: { FIXTURE_TOOLS: "a,b" } } },
    }));

    const results = await checkMcpEntries(await read(context, ["codex", "claude-code"]), 10_000);
    const byName = Object.fromEntries(results.map((result) => [`${result.name}:${result.harnesses.join(",")}`, result]));

    // With nothing but PATH in the environment, Codex and Claude Code start the identical process, so it is probed once.
    expect(byName["tools:codex,claude-code"]).toMatchObject({ status: "pass", tools: 2 });
    expect(byName["missing:codex"]).toMatchObject({ status: "fail", detail: "command not found: /nonexistent/mcp-server" });
    expect(byName["off:codex"]).toMatchObject({ status: "skipped", detail: "disabled" });
    // A server that pings during the handshake gets an answer and then completes it.
    expect(byName["pings:codex"]).toMatchObject({ status: "pass", tools: 1 });
    // A server without a tools capability is not asked for tools/list.
    expect(byName["prompts:codex"]).toMatchObject({ status: "pass", tools: 0 });
    expect(byName["broken:codex"]?.status).toBe("fail");
    expect(byName["broken:codex"]?.detail).toContain("exited with code 3 before the initialize reply");
    expect(byName["broken:codex"]?.detail).not.toContain("fixture-secret-value");
    // A credential-named value is redacted however short it is.
    expect(byName["broken:codex"]?.detail).not.toContain("k3y9");
    expect(byName["echoes:codex"]?.detail).toContain("tools/list failed: token");
    expect(byName["echoes:codex"]?.detail).not.toContain("fixture-echoed-secret");
  });

  it("gives Codex servers only Codex's inherited variables", async () => {
    const { home, script, context } = fixtureHome();
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), [
      "[mcp_servers.inherits]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(script)}]`,
      "[mcp_servers.forwards]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(script)}]`,
      "env_vars = [\"FIXTURE_TOOLS\"]",
    ].join("\n"));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      mcpServers: { inherits: { command: process.execPath, args: [script] } },
    }));

    const results = await checkMcpEntries(await read(context, ["codex", "claude-code"], { FIXTURE_TOOLS: "only" }), 10_000);

    expect(results.map(({ name, harnesses, tools }) => [name, harnesses, tools])).toEqual(expect.arrayContaining([
      ["inherits", ["codex"], 0],
      ["forwards", ["codex"], 1],
      ["inherits", ["claude-code"], 1],
    ]));
  });

  it("launches Codex values literally and expands references for other harnesses", async () => {
    const { home, script, context } = fixtureHome();
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), [
      "[mcp_servers.literal]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(script)}]`,
      "env = { FIXTURE_TOOLS = \"${FIXTURE_LIST}\" }",
    ].join("\n"));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      mcpServers: {
        literal: { command: process.execPath, args: [script], env: { FIXTURE_TOOLS: "${FIXTURE_LIST}" } },
        argument: { command: process.execPath, args: [script, "--echo-arg", "${FIXTURE_ARG}"] },
      },
    }));

    const results = await checkMcpEntries(await read(context, ["codex", "claude-code"], { FIXTURE_LIST: "a,b,c", FIXTURE_ARG: "argument-secret-value" }), 10_000);
    // A credential substituted into the arguments is redacted from what the server prints back.
    const argument = results.find((result) => result.name === "argument");
    expect(argument?.detail).toContain("exited with code 3");
    expect(argument?.detail).not.toContain("argument-secret-value");

    expect(results.map(({ harnesses, tools }) => [harnesses, tools])).toEqual(expect.arrayContaining([[["codex"], 1], [["claude-code"], 3]]));
  });

  it("stops every server it started when the run is cancelled", async () => {
    const { home, context } = fixtureHome();
    const hang = join(home, "hang.cjs");
    // Never answers, so only cancellation can end the probe; it records its pid for the check below.
    writeFileSync(hang, `require("node:fs").writeFileSync(${JSON.stringify(join(home, "hang.pid"))}, String(process.pid)); setInterval(() => {}, 1000);`);
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { hang: { command: process.execPath, args: [hang] } } }));
    const controller = new AbortController();
    const running = checkMcpEntries(await read(context, ["claude-code"]), 60_000, controller.signal);
    // Abort even if the poll fails, so the hanging child never outlives the test.
    try { await expect.poll(() => existsSync(join(home, "hang.pid"))).toBe(true); } finally { controller.abort(); }
    expect(await running).toEqual([expect.objectContaining({ name: "hang", status: "skipped" })]);
    const pid = Number(readFileSync(join(home, "hang.pid"), "utf8"));
    await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
  });

  it("redacts credentials that only the canonfig launcher resolves", async () => {
    const { home, script, context } = fixtureHome();
    // The applied folder gives the server a credential the harness entry never sees.
    mkdirSync(join(home, ".canonfig"));
    writeFileSync(join(home, ".canonfig", "canonfig.jsonc"), JSON.stringify({ version: 1, harnesses: [], mcp: {
      leaky: { transport: "stdio", command: process.execPath, args: [script], env: {
        FIXTURE_FAIL: "x", API_TOKEN: { fromEnv: "FIXTURE_UNSET_TOKEN", default: "launcher-only-secret" },
      } },
      // The credential already sits in the inherited environment under the same name.
      inherited: { transport: "stdio", command: process.execPath, args: [script], env: {
        FIXTURE_FAIL: "x", API_TOKEN: { fromEnv: "API_TOKEN" },
      } },
    } }));
    const loader = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {
      leaky: { command: process.execPath, args: ["--import", loader, resolve("src/runtime/main.ts"), "mcp", "run", "leaky"] },
      inherited: { command: process.execPath, args: ["--import", loader, resolve("src/runtime/main.ts"), "mcp", "run", "inherited"] },
    } }));
    const machine = linuxMachineStateLayer({
      environment: [{ name: "HOME", value: home }],
      credentialPolicy: { kind: "local-file", path: join(home, "credentials") },
    });

    const entries = await read(context, ["claude-code"], { HOME: home, API_TOKEN: "inherited-token-value" });
    const guarded = await Effect.runPromise(Effect.forEach(entries, withLauncherSecrets).pipe(Effect.provide(machine)));
    const byName = Object.fromEntries((await checkMcpEntries(guarded, 20_000)).map((result) => [result.name, result]));

    expect(byName.leaky?.detail).toContain("exited with code 3");
    expect(byName.leaky?.detail).not.toContain("launcher-only-secret");
    expect(byName.inherited?.detail).toContain("exited with code 3");
    expect(byName.inherited?.detail).not.toContain("inherited-token-value");
  });

  it("completes the Streamable HTTP handshake and leaves OAuth servers to the harness", async () => {
    const { home, context } = fixtureHome();
    const closedSessions: Array<string> = [];
    const pingAnswered = Promise.withResolvers<void>();
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        if (request.url === "/oauth") return void response.writeHead(401).end();
        if (request.url === "/login") return void response.writeHead(200).end("Sign in");
        if (request.method === "DELETE") {
          closedSessions.push(`${request.url} ${request.headers["mcp-session-id"]}`);
          if (request.url === "/stalled-close") return;
          if (request.url === "/failed-close") return void response.writeHead(503).end();
          if (request.url === "/redirected-close") return void response.writeHead(303, { location: "/login" }).end();
          if (request.url === "/unsupported-close") return void response.writeHead(405).end();
          return void response.writeHead(204).end();
        }
        if (request.headers.authorization !== "Bearer fixture") return void response.writeHead(403).end();
        const message = Schema.decodeUnknownSync(Schema.fromJsonString(FixtureRequest))(body);
        // The check's answer to the fixture's ping is a response, not a request.
        if (message.method === undefined) {
          if (request.url === "/failed-reply") return void response.writeHead(502).end();
          if (request.url === "/redirected-reply") return void response.writeHead(302, { location: "/login" }).end();
          // The answer is a POST like any other, so it must accept both reply formats.
          if (request.headers.accept === "application/json, text/event-stream") pingAnswered.resolve();
          return void response.writeHead(202).end();
        }
        // Every request after initialize must carry the negotiated protocol version.
        if (message.method !== "initialize" && request.headers["mcp-protocol-version"] !== "2025-06-18") return void response.writeHead(400).end();
        if (message.id === undefined) return void response.writeHead(202).end();
        if ((request.url === "/broken-list" || request.url === "/stalled-close") && message.method === "tools/list") return void response.writeHead(500).end();
        const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } } : { tools: [{ name: "x" }] };
        response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s1" });
        // A server request with the same id comes first; only the reply to the check's request counts.
        response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, method: "ping" })}\n\n`);
        // The reply is split across two data lines, as SSE allows; the check must join them.
        const frame = JSON.stringify({ jsonrpc: "2.0", id: message.id, result }, null, 1).split("\n");
        const middle = Math.ceil(frame.length / 2);
        response.end(`event: message\ndata: ${frame.slice(0, middle).join(" ")}\ndata: ${frame.slice(middle).join(" ")}\n\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${Schema.decodeUnknownSync(ListeningAddress)(server.address()).port}`;
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      mcpServers: {
        remote: { type: "http", url: `${base}/mcp`, headers: { Authorization: "Bearer ${FIXTURE_TOKEN}" } },
        cursorStyle: { type: "http", url: `${base}/mcp`, headers: { Authorization: "Bearer ${env:FIXTURE_TOKEN}" } },
        openCodeStyle: { type: "http", url: `${base}/mcp`, headers: { Authorization: "Bearer {env:FIXTURE_TOKEN}" } },
        kimiStyle: { type: "http", url: `${base}/mcp`, bearerTokenEnvVar: "FIXTURE_TOKEN" },
        brokenList: { type: "http", url: `${base}/broken-list`, headers: { Authorization: "Bearer ${FIXTURE_TOKEN}" } },
        failedReply: { type: "http", url: `${base}/failed-reply`, headers: { Authorization: "Bearer ${FIXTURE_TOKEN}" } },
        failedClose: { type: "http", url: `${base}/failed-close`, headers: { Authorization: "Bearer ${FIXTURE_TOKEN}" } },
        redirectedClose: { type: "http", url: `${base}/redirected-close`, headers: { Authorization: "Bearer ${FIXTURE_TOKEN}" } },
        redirectedReply: { type: "http", url: `${base}/redirected-reply`, headers: { Authorization: "Bearer ${FIXTURE_TOKEN}" } },
        stalledClose: { type: "http", url: `${base}/stalled-close`, headers: { Authorization: "Bearer ${FIXTURE_TOKEN}" } },
        unsupportedClose: { type: "http", url: `${base}/unsupported-close`, headers: { Authorization: "Bearer ${FIXTURE_TOKEN}" } },
        rejected: { type: "http", url: `${base}/mcp`, headers: { Authorization: "Bearer wrong" } },
        oauth: { type: "http", url: `${base}/oauth` },
      },
    }));

    const results = await checkMcpEntries(await read(context, ["claude-code"], { FIXTURE_TOKEN: "fixture" }), 10_000);
    const byName = Object.fromEntries(results.map((result) => [result.name, result]));

    expect(byName.remote).toMatchObject({ status: "pass", tools: 1 });
    // Canonfig projects these spellings for Cursor, OpenCode/Kilo and Kimi.
    expect(byName.cursorStyle).toMatchObject({ status: "pass", tools: 1 });
    expect(byName.openCodeStyle).toMatchObject({ status: "pass", tools: 1 });
    expect(byName.kimiStyle).toMatchObject({ status: "pass", tools: 1 });
    expect(byName.rejected).toMatchObject({ status: "fail", detail: "initialize returned HTTP 403" });
    expect(byName.oauth?.status).toBe("skipped");
    // A probe that fails after initialize still ends the session it opened.
    expect(byName.brokenList).toMatchObject({ status: "fail", detail: "tools/list returned HTTP 500" });
    expect(closedSessions).toContain("/broken-list s1");
    expect(byName.failedReply).toMatchObject({ status: "fail", detail: "reply to server ping returned HTTP 502" });
    expect(closedSessions).toContain("/failed-reply s1");
    expect(byName.redirectedReply).toMatchObject({ status: "fail", detail: "reply to server ping returned HTTP 302" });
    expect(closedSessions).toContain("/redirected-reply s1");
    expect(byName.redirectedClose).toMatchObject({ status: "pass", tools: 1, detail: "1 tools; session cleanup failed: DELETE returned HTTP 303" });
    expect(byName.failedClose).toMatchObject({ status: "pass", tools: 1, detail: "1 tools; session cleanup failed: DELETE returned HTTP 503" });
    expect(byName.stalledClose).toMatchObject({ status: "fail", detail: "tools/list returned HTTP 500; session cleanup timed out after 2000 ms" });
    expect(byName.unsupportedClose).toMatchObject({ status: "pass", tools: 1, detail: "1 tools" });
    // The fixture pings before every reply, and the check answers each ping.
    await pingAnswered.promise;
  });
});

describe("Legacy HTTP+SSE MCP check", () => {
  it("reads an endpoint across split CRLF delimiters", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of ["event: endpoint\r", "\ndata: /message", "\r", "\n", "\r", "\n"]) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    expect(await Array.fromAsync(responseEvents(new Response(body, {
      headers: { "content-type": "text/event-stream" },
    })))).toEqual([{ event: "endpoint", data: "/message" }]);
  });

  it("completes a legacy SSE handshake on the advertised message endpoint", async () => {
    let stream: ServerResponse | undefined;
    const closed = Promise.withResolvers<void>();
    const messages: Array<string> = [];
    const sessionQuery = "/message?sessionId=fixture";
    const server = createServer(async (request, response) => {
      if (request.headers.authorization !== "Bearer fixture") return void response.writeHead(403).end();
      if (request.method === "GET" && request.url === "/stream") {
        stream = response;
        stream.once("close", closed.resolve);
        stream.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        stream.write(": connected\r\nevent: endpoint\r\ndata: " + sessionQuery + "\r\n\r\n");
        return;
      }
      if (request.method !== "POST" || request.url !== sessionQuery || !stream) return void response.writeHead(404).end();
      let body = "";
      for await (const chunk of request) body += chunk;
      const message = Schema.decodeUnknownSync(Schema.fromJsonString(FixtureRequest))(body);
      const pong = message.id === 91 && JSON.stringify(message.result) === "{}";
      messages.push(message.method ?? (pong ? "pong" : "unexpected reply"));
      response.writeHead(202).end();
      const send = (value: Schema.Json) => stream?.write("event: message\ndata: " + JSON.stringify(value) + "\n\n");
      if (message.method === "initialize" && message.params?.protocolVersion === "2024-11-05") {
        send({ jsonrpc: "2.0", id: 91, method: "ping" });
      }
      if (pong) send({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } });
      if (message.method === "tools/list") send({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "example" }] } });
    });
    const base = await listen(server);

    const result = await checkMcpEntries([sseEntry(base + "/stream")], 10_000);
    expect(result).toMatchObject([{ status: "pass", detail: "1 tools", tools: 1 }]);
    expect(messages).toEqual(["initialize", "pong", "notifications/initialized", "tools/list"]);
    await closed.promise;
  });

  it.each(["GET", "POST"] as const)("does not follow redirected legacy %s requests", async (redirectMethod) => {
    const forwarded: Array<string | undefined> = [];
    const destination = await listen(createServer((request, response) => {
      forwarded.push(request.headers["x-fixture-credential"]?.toString());
      response.writeHead(200).end();
    }));
    const requests: Array<string | undefined> = [];
    const source = await listen(createServer((request, response) => {
      requests.push(request.headers["x-fixture-credential"]?.toString());
      if (request.method === redirectMethod) {
        request.resume();
        return void response.writeHead(307, { Location: destination }).end();
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: endpoint\ndata: /message\n\n");
    }));
    const expected = redirectMethod === "GET" ? "HTTP 307 opening the SSE stream" : "initialize returned HTTP 307";
    expect(await checkMcpEntries([sseEntry(source)], 10_000)).toMatchObject([{ status: "fail", detail: expected }]);
    expect(requests).toEqual(redirectMethod === "GET" ? ["fixture"] : ["fixture", "fixture"]);
    expect(forwarded).toEqual([]);
  });

  it("closes an oversized stream before reading its endpoint", async () => {
    const closed = Promise.withResolvers<void>();
    const base = await listen(createServer((_request, response) => {
      response.once("close", closed.resolve);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(Buffer.alloc(4 * 1024 * 1024 + 1, "x"));
      response.write("\nevent: endpoint\ndata: /message\n\n");
    }));
    expect(await checkMcpEntries([sseEntry(base)], 10_000)).toMatchObject([{
      status: "fail", detail: "SSE stream did not advertise a usable same-origin message endpoint",
    }]);
    await closed.promise;
  });

  it.each(["broken", "stalled", "cancelled", "cross-origin"] as const)("handles a %s legacy SSE handshake", async (behavior) => {
    const received = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const server = createServer((request, response) => {
      if (request.method === "POST") {
        request.resume();
        return void response.writeHead(500).end();
      }
      response.once("close", closed.resolve);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const endpoint = behavior === "cross-origin" ? "http://127.0.0.1:1/message" : "/message";
      response.write(behavior === "stalled" ? ": waiting\n\n" : "event: endpoint\ndata: " + endpoint + "\n\n");
      if (behavior === "cancelled") received.resolve();
    });
    const base = await listen(server);
    const controller = new AbortController();
    const operation = checkMcpEntries([sseEntry(base + "/stream")], behavior === "stalled" ? 1_000 : 10_000, controller.signal);
    if (behavior === "cancelled") {
      await received.promise;
      controller.abort();
    }
    const outcomes = {
      broken: { status: "fail", detail: "initialize returned HTTP 500" },
      stalled: { status: "fail", detail: "no reply within 1000 ms" },
      cancelled: { status: "skipped", detail: "not checked: the doctor run was cancelled" },
      "cross-origin": { status: "fail", detail: "SSE stream did not advertise a usable same-origin message endpoint" },
    };
    expect(await operation).toMatchObject([outcomes[behavior]]);
    await closed.promise;
  });
});
