import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Schema } from "effect";

import type { CliIo } from "../cli/cli.ts";
import { exitCodeForFailure, type CliFailureCategory } from "../cli/exit-codes.ts";
import { FollowerCommands } from "../cli/follower-commands.ts";
import { sanitizeCliData } from "../cli/render.ts";
import { redactText } from "../cli/redaction.ts";
import { CliCommandFailure } from "../cli/source-commands.ts";
import { GuiStatus, guiEndpoints, type GuiError, type GuiSession } from "./contract.ts";
import { GuiQueries } from "./queries.ts";

export interface GuiOptions {
  readonly port: number;
  readonly open: boolean;
}

const cookieName = "canonfig_session";
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

const failureBody = (category: CliFailureCategory, message: string): GuiError => ({
  category, message: redactText(message), exitCode: exitCodeForFailure(category),
});

const json = (response: ServerResponse, status: number, body: GuiError | GuiSession | GuiStatus): void => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

const sameSecret = (actual: string | undefined, expected: string): boolean => {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

const sessionCookie = (request: IncomingMessage): string | undefined => {
  const cookies = (request.headers.cookie ?? "").split(";").map((entry) => entry.trim());
  const matches = cookies.filter((entry) => entry.startsWith(`${cookieName}=`));
  return matches.length === 1 ? matches[0]?.slice(cookieName.length + 1) : undefined;
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

const serveAsset = async (root: string, pathname: string, response: ServerResponse): Promise<void> => {
  const requested = resolve(root, `.${pathname}`);
  const local = relative(root, requested);
  if (local.startsWith(`..${sep}`) || local === ".." || local.startsWith(sep)) {
    json(response, 403, failureBody("authentication-or-revocation", "The requested path is outside the browser application."));
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
    json(response, 403, failureBody("authentication-or-revocation", "The requested path is outside the browser application."));
    return;
  }
  const body = await readFile(actual);
  response.writeHead(200, { "Content-Type": contentTypes[extname(actual)] ?? "application/octet-stream" });
  response.end(body);
};

/** The HTTP scope owns sockets and requests; interruption finishes them before the command lease exits. */
export const runGui = Effect.fn("Gui.run")(function*(options: GuiOptions, io: CliIo) {
  const commands = yield* FollowerCommands;
  const queries = yield* GuiQueries;
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
  const status = () => commands.status(undefined).pipe(
    Effect.map((payload) => sanitizeCliData(payload)),
    Effect.flatMap(Schema.decodeUnknownEffect(GuiStatus)),
    Effect.mapError((error) => error instanceof CliCommandFailure ? error : new CliCommandFailure({
      category: "internal", message: "The status service returned an invalid browser response.",
    })),
  );
  const pending = new Set<AbortController>();
  const token = randomBytes(32).toString("hex");
  const session = randomBytes(32).toString("hex");
  let tokenUsed = false;
  let origin = "";

  const handle = async (request: IncomingMessage, response: ServerResponse, signal: AbortSignal) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (`http://${request.headers.host}` !== origin || (request.headers.origin !== undefined && request.headers.origin !== origin)) {
      json(response, 403, failureBody("authentication-or-revocation", "This request must come from the Canonfig loopback origin."));
      return;
    }
    const url = new URL(request.url ?? "/", origin);
    if (url.origin !== origin) {
      json(response, 403, failureBody("authentication-or-revocation", "This request must use the Canonfig loopback origin."));
      return;
    }
    if (url.searchParams.has("token")) {
      if (request.method !== "GET" || url.pathname !== "/" || tokenUsed || url.searchParams.getAll("token").length !== 1 || !sameSecret(url.searchParams.get("token") ?? undefined, token)) {
        json(response, 401, failureBody("authentication-or-revocation", "This browser sign-in link is invalid or has already been used. Restart canonfig ui for a new link."));
        return;
      }
      // Consume synchronously before any await so concurrent exchanges cannot both win.
      tokenUsed = true;
      response.writeHead(303, { Location: "/", "Set-Cookie": `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/` });
      response.end();
      return;
    }
    if (!sameSecret(sessionCookie(request), session)) {
      json(response, 401, failureBody("authentication-or-revocation", "Open the sign-in URL printed by canonfig ui to start this browser session."));
      return;
    }
    if (request.method !== "GET") {
      json(response, 405, failureBody("usage-or-configuration", "This endpoint accepts GET requests only."));
      return;
    }
    if (url.pathname === guiEndpoints.status || url.pathname === guiEndpoints.session) {
      const query: Effect.Effect<GuiSession | GuiStatus, CliCommandFailure> =
        url.pathname === guiEndpoints.status ? status() : queries.session();
      await Effect.runPromise(query.pipe(Effect.match({
        onFailure: (failure) => json(response, failure.category === "internal" ? 500 : 400, failureBody(failure.category, failure.message)),
        onSuccess: (body) => json(response, 200, body),
      })), { signal });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      json(response, 404, failureBody("usage-or-configuration", "Unknown browser API endpoint."));
      return;
    }
    await serveAsset(root, decodeURIComponent(url.pathname), response);
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
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => new Promise<void>((accept, reject) => {
        server.once("error", reject);
        server.listen(options.port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          accept();
        });
      }),
      catch: (error) => new CliCommandFailure({
        category: "transport",
        message: `Could not start the browser server on 127.0.0.1${options.port === 0 ? "" : `:${options.port}`}: ${error instanceof Error ? error.message : String(error)}`,
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
  origin = `http://127.0.0.1:${address.port}`;
  const url = `${origin}/?token=${token}`;
  io.writeStdout(`${url}\n`);
  io.writeStderr("Canonfig browser interface is running. Press Ctrl-C to stop.\n");
  if (options.open) openBrowser(url, io);
  return yield* Effect.never;
}, Effect.scoped);
