import { createHmac, timingSafeEqual } from "node:crypto";
import { Agent as HttpAgent, createServer, type IncomingMessage, request as httpRequest, type ServerResponse } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { Effect, Predicate } from "effect";

import { MachineState } from "../machine/machine-state.service.ts";
import { loadMcpServer } from "../projection/folder.ts";
import {
  mcpProxyAuthorization,
  mcpProxyBindingFile,
  mcpProxyDefaultPort,
  mcpProxyHost,
  mcpProxyRouteName,
  mcpProxyUrl,
  newMcpProxyBinding,
  readMcpProxyBinding,
} from "../projection/mcp-launcher.ts";
import type { RemoteMcpServer } from "../projection/model.ts";
import { parseMcpProxyArguments } from "./command-routing.ts";
import { MCP_RUN_EXIT, McpRunError, resolveMcpValue } from "./mcp-run.ts";
import type { ManagedCommandLease } from "./self-update/coordination.ts";

const clientHeaders = [
  "accept", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id", "content-length",
];
const blockedUpstreamHeaders = new Set([
  "connection", "content-length", "expect", "host", "keep-alive", "mcp-session-id", "proxy-authorization",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);

const reject = (response: ServerResponse, status: number, message: string) => {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end(message);
};

const authorized = (actual: string | undefined, expected: string): boolean =>
  actual !== undefined && Buffer.byteLength(actual) === expected.length
  && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));

const connectionHeaders = (message: IncomingMessage): ReadonlySet<string> =>
  new Set(message.headers.connection?.split(",").map((name) => name.trim().toLowerCase()));

const upstreamHeaders = (server: RemoteMcpServer, headers: Headers) =>
  Effect.gen(function*() {
    for (const [name, value] of Object.entries(server.headers)) {
      if (blockedUpstreamHeaders.has(name.toLowerCase())) return yield* Effect.fail(new McpRunError(
        "MCP proxy upstream configuration contains a transport header.",
        MCP_RUN_EXIT.configuration,
      ));
      headers.set(name, yield* resolveMcpValue(value, process.env));
    }
    return headers;
  });

type McpHttpMethod = "GET" | "POST" | "DELETE";
const upstreamConnectionTimeout = 15_000;

const reply = async (
  upstream: IncomingMessage, response: ServerResponse, sessionPrefix: string, signal: AbortSignal,
): Promise<void> => {
  const status = upstream.statusCode ?? 502;
  if (status < 200 || status >= 300) {
    upstream.destroy();
    if (status >= 300 && status < 400) {
      reject(response, 502, "MCP proxy upstream redirected. Configure its final URL.");
      return;
    }
    // A server can put its credential or request headers in an error body.
    reject(response, status, `MCP proxy upstream returned HTTP ${status}.`);
    return;
  }
  response.statusCode = status;
  response.setHeader("cache-control", "no-store, no-transform");
  const nominated = connectionHeaders(upstream);
  for (const name of ["content-type", "content-encoding", "mcp-protocol-version"]) {
    const value = upstream.headers[name];
    if (value !== undefined && !nominated.has(name)) response.setHeader(name, value);
  }
  const session = upstream.headers["mcp-session-id"];
  if (Predicate.isString(session) && !nominated.has("mcp-session-id")) {
    response.setHeader("mcp-session-id", sessionPrefix + session);
  }
  // Send the response headers before the first SSE event and preserve backpressure.
  response.flushHeaders();
  await pipeline(upstream, response, { signal });
};

const serve = (
  folder: string, binding: ReturnType<typeof newMcpProxyBinding>, hold: ManagedCommandLease["hold"] | undefined,
) =>
  Effect.gen(function*() {
    const context = yield* Effect.context<MachineState>();
    const run = Effect.runPromiseWith(context);
    const { host, origin } = mcpProxyUrl(binding.port);
    // Only these agents open upstream sockets. A global environment proxy
    // must never carry a credential sent to a loopback HTTP destination.
    const httpAgent = new HttpAgent({ keepAlive: true });
    const httpsAgent = new HttpsAgent({ keepAlive: true });
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      httpAgent.destroy();
      httpsAgent.destroy();
    }));

    const requestUpstream = (
      url: string, method: McpHttpMethod, headers: Headers, request: IncomingMessage, signal: AbortSignal,
    ) => new Promise<IncomingMessage>((resolve, fail) => {
      const target = new URL(url);
      const tls = target.protocol === "https:";
      const send = tls ? httpsRequest : httpRequest;
      const upstream = send(target, {
        method, headers: Object.fromEntries(headers), signal, agent: tls ? httpsAgent : httpAgent,
      }, resolve);
      // Bound connection setup only. An open SSE stream may remain idle
      // indefinitely, until the client disconnects or the proxy stops.
      const deadline = setTimeout(() => upstream.destroy(new Error("MCP upstream connection timed out")), upstreamConnectionTimeout);
      const connected = () => clearTimeout(deadline);
      upstream.once("socket", (socket) => {
        if (socket.connecting) socket.once(tls ? "secureConnect" : "connect", connected);
        else connected();
      });
      upstream.once("error", fail);
      upstream.once("close", () => {
        connected();
        fail(new Error("MCP upstream connection closed"));
      });
      if (method === "POST") {
        request.once("error", (error) => upstream.destroy(error));
        request.pipe(upstream);
      } else {
        upstream.end();
      }
    });

    const prepare = async (name: string, incoming: Headers, signal: AbortSignal) => {
      // Leave the lease before upstream I/O so long-lived SSE streams cannot
      // keep an update from activating. Later requests check for replacement.
      const release = hold?.();
      try {
        const server = await loadMcpServer(folder, name);
        if (server === undefined || server.transport !== "streamable-http" || !server.proxy) return undefined;
        // Tie sessions to the selected URL without retaining a session map
        // or routing to an upstream the operator has since replaced.
        const sessionPrefix = createHmac("sha256", binding.seed).update(JSON.stringify(["session", name, server.url])).digest("hex") + ".";
        const session = incoming.get("mcp-session-id");
        if (session !== null) {
          if (!session.startsWith(sessionPrefix) || session.length === sessionPrefix.length) return { expired: true };
          incoming.set("mcp-session-id", session.slice(sessionPrefix.length));
        }
        const headers = await run(upstreamHeaders(server, incoming).pipe(Effect.match({
          onFailure: (error) => error,
          onSuccess: (headers) => headers,
        })), { signal });
        return { url: server.url, headers, sessionPrefix };
      } finally {
        release?.();
      }
    };

    const forward = async (request: IncomingMessage, response: ServerResponse) => {
      const name = mcpProxyRouteName(request.url);
      if (request.headers.host !== host || (request.headers.origin !== undefined && request.headers.origin !== origin)) {
        return reject(response, 403, "MCP proxy rejected the request origin.");
      }
      if (name === undefined || !authorized(request.headers.authorization, mcpProxyAuthorization(binding, name))) {
        return reject(response, 404, "MCP proxy route not found.");
      }
      const { method } = request;
      if (method !== "GET" && method !== "POST" && method !== "DELETE") {
        response.setHeader("allow", "GET, POST, DELETE");
        return reject(response, 405, "MCP proxy method not allowed.");
      }
      const abort = new AbortController();
      response.once("close", () => abort.abort());
      const incoming = new Headers();
      const nominated = connectionHeaders(request);
      for (const header of clientHeaders) {
        if (nominated.has(header) || (header === "content-length" && method !== "POST")) continue;
        const value = request.headers[header];
        if (Predicate.isString(value)) incoming.set(header, value);
      }
      const route = await prepare(name, incoming, abort.signal);
      if (route === undefined) return reject(response, 404, "MCP proxy route not found.");
      if ("expired" in route) return reject(response, 404, "MCP session expired. Initialize a new session.");
      const { headers } = route;
      if (headers instanceof McpRunError) return reject(response, 503, headers.message);
      // Forward to the configured destination verbatim. Client paths, query
      // strings, Host and Authorization can never select an upstream.
      const upstream = await requestUpstream(route.url, method, headers, request, abort.signal);
      await reply(upstream, response, route.sessionPrefix, abort.signal);
    };

    const server = createServer((request, response) => {
      void forward(request, response).catch(() => {
        if (response.destroyed) return;
        if (response.headersSent) response.destroy();
        else reject(response, 502, "MCP proxy could not forward the request. Check the applied configuration and upstream availability.");
      });
    });

    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen({ host: mcpProxyHost, port: binding.port, exclusive: true }, () => {
            server.removeListener("error", reject);
            resolve();
          });
        }),
        catch: () => new McpRunError(`Cannot bind the MCP proxy at ${origin}. Stop the process already using this port or choose a free port before first start.`, MCP_RUN_EXIT.launch),
      }),
      () => Effect.promise(() => new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      })),
    );
  });

/** This process has no dependency on the GUI, Source server or harness sessions. */
export const runMcpProxy = (
  args: ReadonlyArray<string>, output: (message: string) => void, hold?: ManagedCommandLease["hold"],
) =>
  Effect.scoped(Effect.gen(function*() {
    const parsed = parseMcpProxyArguments(args);
    if (parsed === undefined) {
      return yield* Effect.fail(new McpRunError("Usage: canonfig mcp proxy [--port <1-65535>]", MCP_RUN_EXIT.configuration));
    }
    const requested = parsed.port;
    const machine = yield* MachineState;
    const directories = yield* machine.userDirectories().pipe(Effect.mapError(() =>
      new McpRunError("Home directory is unavailable.", MCP_RUN_EXIT.configuration)));
    const folder = join(directories.home.absolute, ".canonfig");
    // A new Follower needs a local binding to plan its first projection,
    // before it has an applied MCP configuration to serve.
    const binding = yield* Effect.tryPromise({
      try: () => readMcpProxyBinding(folder),
      catch: () => new McpRunError(`Cannot read the private MCP proxy binding. Check ${mcpProxyBindingFile} in the Canonical Folder.`, MCP_RUN_EXIT.configuration),
    });
    if (binding !== undefined && requested !== undefined && requested !== binding.port) {
      return yield* Effect.fail(new McpRunError(`This machine's MCP proxy is configured for port ${binding.port}. Start it without --port.`, MCP_RUN_EXIT.configuration));
    }
    const selected = binding ?? newMcpProxyBinding(requested ?? mcpProxyDefaultPort);
    yield* serve(folder, selected, hold);
    // Publish after listening and refuse to replace another process's binding.
    if (binding === undefined) yield* machine.atomicWrite({
      path: { ...directories.home, absolute: join(folder, mcpProxyBindingFile) },
      anchor: directories.home,
      createAnchoredParents: true,
      content: new TextEncoder().encode(JSON.stringify(selected)),
      mode: 0o600,
      noReplace: true,
    }).pipe(Effect.mapError(() => new McpRunError(
      "Cannot create the private MCP proxy binding. Check the Canonical Folder or retry after the other start finishes.",
      MCP_RUN_EXIT.configuration,
    )));
    yield* Effect.sync(() => output(`MCP proxy listening at ${mcpProxyUrl(selected.port).origin}.\n`));
    return yield* Effect.never;
  }));
