import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BlockList, isIP } from "node:net";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Deferred, Effect, Schema } from "effect";

import type { CliIo } from "../cli/cli.ts";
import { CliCommandFailure } from "../cli/source-commands.ts";
import { guiMutationHeader, guiMutationValue } from "./contract.ts";
import { failureBody } from "./routing.ts";
import { GuiOperations, makeGuiOperations } from "./operations.ts";
import { sessionRoutes } from "./routes/session.ts";
import { profileRoutes } from "./routes/profile.ts";
import { enrollmentRoutes } from "./routes/enrollment.ts";
import { synchronizationRoutes } from "./routes/synchronization.ts";
import { administrationRoutes } from "./routes/administration.ts";
import { managedCommandLease, type ManagedCommandLease } from "../runtime/self-update/coordination.ts";
import { detectTailnet, isTailnetAddress, tailnetBinding } from "../enrollment/tailnet.ts";

export interface GuiOptions {
  readonly port: number;
  readonly open: boolean;
  /** Loopback/Tailscale address, or `tailnet` for automatic verified binding. */
  readonly host: string;
  /** An extra https origin that reaches this server through a TLS proxy such as `tailscale serve`, if any. */
  readonly origin: string | undefined;
}

// Addresses the GUI may bind: loopback, and Tailscale's ranges (CGNAT IPv4 and its ULA IPv6 prefix). Traffic to
// the latter stays inside the tailnet's WireGuard tunnels, so the sign-in token and session cookie never cross a
// LAN in clear text. A BlockList matches any spelling of an address, such as 0:0:0:0:0:0:0:1 for ::1.
const bindable = new BlockList();
bindable.addAddress("127.0.0.1", "ipv4");
bindable.addAddress("::1", "ipv6");
bindable.addSubnet("100.64.0.0", 10, "ipv4");
bindable.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

/** Why `host` cannot carry the GUI, or undefined when it can: loopback or a Tailscale address only. */
export const guiHostProblem = (host: string): string | undefined => {
  const family = isIP(host);
  if (family === 0) return `--host needs an IP address, not ${host}`;
  if (bindable.check(host, family === 4 ? "ipv4" : "ipv6")) return undefined;
  return `--host ${host} is not a loopback or Tailscale address; the browser interface only listens on 127.0.0.1, ::1, 100.64.0.0/10 or fd7a:115c:a1e0::/48`;
};

/** The normalized https origin for `--origin`, or a problem: an origin only, without path, query or credentials. */
export const guiOrigin = (value: string): { readonly origin: string } | { readonly problem: string } => {
  if (!URL.canParse(value)) return { problem: `--origin ${value} is not a URL` };
  const url = new URL(value);
  if (url.protocol !== "https:") return { problem: "--origin must be an https URL, such as the address tailscale serve prints" };
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return { problem: "--origin must be an origin only, such as https://machine.tailnet.ts.net" };
  }
  return { origin: url.origin };
};

interface AssetContentTypes {
  readonly [extension: string]: string | undefined;
}
const contentTypes: AssetContentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};


const json = (response: ServerResponse, status: number, body: Schema.Json): void => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

/** Browser navigations need recovery instructions, while API clients keep the diagnostic contract. */
const authenticationFailure = (request: IncomingMessage, response: ServerResponse, status: 401 | 403, message: string): void => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method !== "GET" || pathname === "/api" || pathname.startsWith("/api/")
    || !request.headers.accept?.toLowerCase().includes("text/html")) {
    json(response, status, failureBody("authentication-or-revocation", message));
    return;
  }
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in to Canonfig</title><body><main><h1>Sign in to Canonfig</h1><p>Open the sign-in link printed by <code>canonfig ui</code> in your terminal.</p><p>Restart <code>canonfig ui</code> for a new link if the old one has expired or already been used.</p></main></body></html>`);
};

const sameSecret = (actual: string | undefined, expected: string): boolean => {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

const sessionCookie = (request: IncomingMessage, cookieName: string): string | undefined => {
  const cookies = (request.headers.cookie ?? "").split(";").map((entry) => entry.trim());
  const matches = cookies.filter((entry) => entry.startsWith(`${cookieName}=`));
  return matches.length === 1 ? matches[0]?.slice(cookieName.length + 1) : undefined;
};

/**
 * Whether a request's Host names the same authority as `origin`, compared the way URLs compare them: host case
 * and the scheme's default port do not matter (`ATLAS.tailnet.ts.net:443` matches `https://atlas.tailnet.ts.net`).
 * A Host carrying anything beyond host and port, such as `x@atlas.tailnet.ts.net`, never matches.
 */
const sameAuthority = (origin: string, host: string | undefined): boolean => {
  if (host === undefined || /[@/?#\\]/u.test(host)) return false;
  const expected = new URL(origin);
  const candidate = `${expected.protocol}//${host}`;
  return URL.canParse(candidate) && new URL(candidate).host === expected.host;
};

/** No shell interpolation: the URL is passed as one argument on every platform. */
const openBrowser = (url: string, io: CliIo): void => {
  const executable = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(executable, args, { stdio: "ignore", detached: true, windowsHide: true });
  let reported = false;
  const failed = () => {
    if (reported) return;
    reported = true;
    io.writeStderr("Could not open the browser. Open the printed URL manually.\n");
  };
  child.once("error", failed);
  child.once("exit", (code) => { if (code !== 0) failed(); });
  child.unref();
};

const serveAsset = async (root: string, pathname: string, request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const requested = resolve(root, `.${pathname}`);
  const local = relative(root, requested);
  if (local.startsWith(`..${sep}`) || local === ".." || local.startsWith(sep)) {
    authenticationFailure(request, response, 403, "The requested path is outside the browser application.");
    return;
  }
  // Only extensionless browser routes fall back to index; missing assets stay 404.
  const asset = pathname === "/" || extname(pathname) === "" ? join(root, "index.html") : requested;
  let actual: string;
  try {
    actual = await realpath(asset);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    json(response, 404, failureBody("usage-or-configuration", "Browser asset not found."));
    return;
  }
  const resolved = relative(root, actual);
  if (resolved.startsWith(`..${sep}`) || resolved === ".." || resolved.startsWith(sep)) {
    authenticationFailure(request, response, 403, "The requested path is outside the browser application.");
    return;
  }
  const body = await readFile(actual);
  response.writeHead(200, { "Content-Type": contentTypes[extname(actual)] ?? "application/octet-stream" });
  response.end(body);
};

/** The HTTP scope owns sockets and requests; interruption finishes them before the command lease exits. */
export const runGui = Effect.fn("Gui.run")(function*(options: GuiOptions, io: CliIo, commandLease?: ManagedCommandLease) {
  const lease = commandLease ?? managedCommandLease(fileURLToPath(new URL("../../", import.meta.url)));
  yield* Effect.addFinalizer(() => Effect.sync(lease.close));
  const tailnet = options.host === "tailnet"
    ? yield* detectTailnet().pipe(Effect.flatMap((report) => Effect.try({
      try: () => {
        if (options.origin !== undefined) throw new Error("Tailnet mode cannot use a proxy origin.");
        return tailnetBinding(report);
      },
      catch: (cause) => new CliCommandFailure({ category: "usage-or-configuration", message: cause instanceof Error ? cause.message : "Tailscale is unavailable." }),
    })))
    : undefined;
  const host = tailnet?.address ?? options.host;
  const stopped = yield* Deferred.make<void>();
  let updating = false;
  const updateSettled = () => { if (!lease.suspended) updating = false; };
  const operations = yield* makeGuiOperations;
  // Area registration is complete here. Area owners only fill their own modules.
  const routes = (yield* Effect.all([
    sessionRoutes,
    profileRoutes,
    enrollmentRoutes,
    synchronizationRoutes,
    administrationRoutes(lease, () => { Effect.runSync(Deferred.succeed(stopped, undefined)); }, updateSettled),
  ]).pipe(Effect.provideService(GuiOperations, operations))).flat();
  routes.push(operations.route);
  const root = yield* Effect.tryPromise({
    try: async () => {
      const path = await realpath(fileURLToPath(new URL("../../dist/ui/", import.meta.url)));
      if (!(await stat(join(path, "index.html"))).isFile()) throw new Error("index.html is missing");
      return path;
    },
    catch: () => new CliCommandFailure({
      category: "usage-or-configuration",
      message: "The bundled browser application is missing. Reinstall Canonfig, or build the CLI and UI before running canonfig ui.",
    }),
  });
  const pending = new Set<AbortController>();
  const token = randomBytes(32).toString("hex");
  const session = randomBytes(32).toString("hex");
  // Cookies are host-scoped, not port-scoped. Concurrent GUIs need distinct names.
  const cookieName = `canonfig_session_${randomBytes(16).toString("hex")}`;
  let tokenUsed = false;
  // The bound address's own http origin, plus the optional https proxy origin. Known once listening.
  let origins: ReadonlyArray<string> = [];

  const handle = async (request: IncomingMessage, response: ServerResponse, signal: AbortSignal) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    // Host picks the origin (a proxy such as tailscale serve passes the public Host through). Anything
    // else, a rebound DNS name included, is refused, as is a request whose Origin names another site.
    const origin = origins.find((candidate) => sameAuthority(candidate, request.headers.host));
    if (origin === undefined || (request.headers.origin !== undefined && request.headers.origin !== origin)) {
      authenticationFailure(request, response, 403, "This request must come from a Canonfig browser origin.");
      return;
    }
    const url = new URL(request.url ?? "/", origin);
    if (url.origin !== origin) {
      authenticationFailure(request, response, 403, "This request must use a Canonfig browser origin.");
      return;
    }
    if (url.searchParams.has("token")) {
      if (request.method !== "GET" || url.pathname !== "/" || tokenUsed || url.searchParams.getAll("token").length !== 1 || !sameSecret(url.searchParams.get("token") ?? undefined, token)) {
        authenticationFailure(request, response, 401, "This browser sign-in link is invalid or has already been used. Restart canonfig ui for a new link.");
        return;
      }
      // Consume synchronously before any await so concurrent exchanges cannot both win.
      tokenUsed = true;
      // Secure keeps a cookie set over the https proxy origin from ever being sent in clear text.
      const secure = url.protocol === "https:" ? "; Secure" : "";
      response.writeHead(303, { Location: "/", "Set-Cookie": `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/${secure}` });
      response.end();
      return;
    }
    if (!sameSecret(sessionCookie(request, cookieName), session)) {
      authenticationFailure(request, response, 401, "Open the sign-in URL printed by canonfig ui to start this browser session.");
      return;
    }
    if (request.method !== "GET") {
      if (!["POST", "PUT", "DELETE"].includes(request.method ?? "")) {
        json(response, 405, failureBody("usage-or-configuration", "Use GET, POST, PUT or DELETE for browser API requests."));
        return;
      }
      if (request.headers[guiMutationHeader] !== guiMutationValue) {
        authenticationFailure(request, response, 403, "Mutations require the Canonfig browser request header.");
        return;
      }
      if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        json(response, 415, failureBody("usage-or-configuration", "Mutations require application/json."));
        return;
      }
    }
    const operationPoll = request.method === "GET" && /^\/api\/operations\/[^/]+$/u.test(url.pathname);
    if (updating && !operationPoll) {
      json(response, 409, failureBody("human-action-required", "A self-update operation is in progress. Wait for its result before running another GUI operation."));
      return;
    }
    const selfUpdateMutation = request.method === "POST"
      && ["/api/self-update/enable", "/api/self-update/disable", "/api/self-update/apply"].includes(url.pathname);
    if (selfUpdateMutation) {
      if (operations.running() || pending.size > 1) {
        json(response, 409, failureBody("human-action-required", "Another GUI operation is active. Wait for it to finish before changing self-updates."));
        return;
      }
      updating = true;
    }
    const route = routes.find((candidate) => candidate.method === request.method && candidate.matches(url.pathname));
    if (route !== undefined) {
      try {
        await Effect.runPromise(route.handle(request, url).pipe(Effect.match({
          onFailure: (failure) => json(response, failure.category === "internal" ? 500 : failure.category === "conflict-or-drift" ? 409 : 400, failureBody(failure.category, failure.message)),
          onSuccess: (body) => {
            if (route.afterResponse !== undefined) response.once("finish", () => route.afterResponse?.(body));
            json(response, route.status ?? 200, body);
          },
        })), { signal });
      } finally {
        // Body parsing owns the reservation too. A detached apply releases it
        // through its own finalizer, not when its ticket response is sent.
        if (selfUpdateMutation && !operations.running()) updateSettled();
      }
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      json(response, 404, failureBody("usage-or-configuration", "Unknown browser API endpoint."));
      return;
    }
    if (request.method !== "GET") {
      json(response, 405, failureBody("usage-or-configuration", "Browser assets accept GET requests only."));
      return;
    }
    await serveAsset(root, decodeURIComponent(url.pathname), request, response);
  };

  const server = createServer((request, response) => {
    const controller = new AbortController();
    pending.add(controller);
    response.once("close", () => controller.abort());
    void handle(request, response, controller.signal).catch(() => {
      if (!response.destroyed && !response.headersSent) {
        json(response, 500, failureBody("internal", "The browser request failed. Check canonfig status in a terminal."));
      } else response.destroy();
    }).finally(() => pending.delete(controller));
  });
  if (tailnet !== undefined) server.on("connection", (socket) => {
    if (!isTailnetAddress(socket.remoteAddress ?? "")) socket.destroy();
  });
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => new Promise<void>((accept, reject) => {
        server.once("error", reject);
        server.listen(options.port, host, () => {
          server.removeListener("error", reject);
          accept();
        });
      }),
      catch: (error) => new CliCommandFailure({
        category: "transport",
        message: `Could not start the browser server on ${host}${options.port === 0 ? "" : ` port ${options.port}`}: ${error instanceof Error ? error.message : String(error)}`,
      }),
    }),
    () => Effect.promise(() => new Promise<void>((accept) => {
      for (const controller of pending) controller.abort();
      server.close(() => accept());
      server.closeAllConnections();
    })),
  );
  const address = server.address();
  if (address === null || Schema.is(Schema.String)(address)) return yield* Effect.die("The browser server has no TCP address");
  // URL normalizes the spelling (IPv6 case and zero groups), so it matches the origin of every parsed request.
  const bound = new URL(`http://${isIP(host) === 6 ? `[${host}]` : host}:${address.port}`).origin;
  const advertised = tailnet === undefined ? options.origin ?? bound : `http://${tailnet.dnsName}:${address.port}`;
  origins = tailnet !== undefined ? [advertised] : options.origin === undefined ? [bound] : [bound, options.origin];
  // Tailnet mode accepts only its discovered MagicDNS authority, not proxy or forwarded hosts.
  const url = `${advertised}/?token=${token}`;
  io.writeStdout(`${url}\n`);
  io.writeStderr("Canonfig browser interface is running. Press Ctrl-C to stop.\n");
  if (options.open) openBrowser(url, io);
  yield* Deferred.await(stopped);
  return { stopped: true };
}, Effect.scoped);
