import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type OutgoingHttpHeaders } from "node:http";
import { createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateCli } from "../../src/cli/cli.ts";
import { programVersion } from "../../src/cli/help.ts";

const entry = resolve(import.meta.dirname, "../../src/runtime/main.ts");
const children = new Set<ChildProcess>();
const homes: string[] = [];

// Node's fetch normalizes Host; use HTTP directly to exercise the server's actual boundary.
const requestStatus = (url: string, headers: OutgoingHttpHeaders): Promise<number | undefined> =>
  new Promise((accept, reject) => {
    const outgoing = request(url, { headers }, (response) => {
      response.resume();
      response.once("end", () => accept(response.statusCode));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });

const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-gui-"));
  homes.push(home);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".state"),
    CANONFIG_LOCAL_CREDENTIAL_ROOT: join(home, "credentials"),
    CANONFIG_LOG: "off",
  };
  return {
    home, env,
    invoke: (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", entry, "--json", ...args], {
      env, encoding: "utf8", timeout: 30_000,
    }),
  };
};

const start = async (env: NodeJS.ProcessEnv, args: string[] = []) => {
  const child = spawn(process.execPath, ["--import", "tsx", entry, "ui", "--no-open", ...args], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const { promise, resolve: ready, reject } = Promise.withResolvers<string>();
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    const match = output.match(/https?:\/\/\S+\/\?token=[a-f0-9]+/u);
    if (match) ready(match[0]);
  });
  child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  child.once("error", reject);
  child.once("exit", (code) => reject(new Error(`GUI exited ${code}: ${errors}`)));
  const deadline = setTimeout(() => reject(new Error(`GUI did not start: ${errors}`)), 30_000);
  try {
    const url = await promise;
    return { child, url, origin: new URL(url).origin };
  } finally { clearTimeout(deadline); }
};

const stop = async (child: ChildProcess, signal: "SIGINT" | "SIGTERM" = "SIGTERM") => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  const [code, receivedSignal] = await exited;
  children.delete(child);
  // Node's Windows kill API forcibly terminates; it cannot send console Ctrl-C.
  // As in the Source-process tests, assert termination and port reuse instead.
  if (process.platform === "win32") {
    expect(receivedSignal).toBe(signal);
    expect(code).toBeNull();
  } else {
    expect(receivedSignal).toBeNull();
    expect(code).toBe(signal === "SIGINT" ? 130 : 143);
  }
};

afterEach(async () => {
  for (const child of children) await stop(child);
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("canonfig ui command", () => {
  it("parses the foreground server flags and rejects invalid input", () => {
    expect(evaluateCli(["ui"])).toMatchObject({ command: { _tag: "Ui", port: 0, open: true, host: "127.0.0.1" } });
    expect(evaluateCli(["ui", "--no-open", "--port", "5317"])).toMatchObject({ command: { _tag: "Ui", port: 5317, open: false } });
    // Loopback and Tailscale addresses only: a LAN or wildcard bind would put the token on the wire in clear text.
    for (const host of ["::1", "100.64.0.1", "100.127.255.254", "fd7a:115c:a1e0::1"]) {
      expect(evaluateCli(["ui", "--host", host])).toMatchObject({ command: { _tag: "Ui", host } });
    }
    expect(evaluateCli(["ui", "--port", "5317", "--origin", "https://Atlas.Tailnet.ts.net/"]))
      .toMatchObject({ command: { _tag: "Ui", origin: "https://atlas.tailnet.ts.net" } });
    for (const args of [
      ["--port", "0"], ["--port", "65536"], ["--port", "no"], ["extra"], ["--json"],
      ["--host", "0.0.0.0"], ["--host", "::"], ["--host", "192.168.1.20"], ["--host", "100.128.0.1"], ["--host", "localhost"],
      ["--origin", "https://atlas.tailnet.ts.net"],
      ["--port", "5317", "--origin", "http://atlas.tailnet.ts.net"],
      ["--port", "5317", "--origin", "https://atlas.tailnet.ts.net/ui"],
      ["--port", "5317", "--origin", "https://user@atlas.tailnet.ts.net"],
    ]) {
      expect(evaluateCli(["ui", ...args])).toMatchObject({ _tag: "InvalidInput", exitCode: 2 });
    }
  });

  it.each(["SIGINT", "SIGTERM"] as const)("authenticates once, guards every resource and frees the port on %s", async (signal) => {
    const machine = fixture();
    const server = await start(machine.env);
    expect((await fetch(`${server.origin}/api/session`)).status).toBe(401);
    expect((await fetch(`${server.origin}/`)).status).toBe(401);
    expect(await requestStatus(server.url, { Host: "example.invalid" })).toBe(403);
    expect((await fetch(server.url, { headers: { Origin: "https://example.invalid" }, redirect: "manual" })).status).toBe(403);
    const exchange = await fetch(server.url, { redirect: "manual" });
    expect(exchange.status).toBe(303);
    expect(exchange.headers.get("location")).toBe("/");
    const setCookie = exchange.headers.get("set-cookie");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie?.split(";")[0];
    if (cookie === undefined) throw new Error("No session cookie issued");
    expect((await fetch(server.url, { redirect: "manual" })).status).toBe(401);
    const headers = { Cookie: cookie, Origin: server.origin };
    expect(await requestStatus(`${server.origin}/api/session`, { ...headers, Host: "localhost" })).toBe(403);
    expect((await fetch(`${server.origin}/api/session`, { headers: { ...headers, Origin: "null" } })).status).toBe(403);
    expect((await fetch(`${server.origin}/api/session`, { headers: { Cookie: `${cookie.split("=")[0]}=wrong` } })).status).toBe(401);
    const session = await fetch(`${server.origin}/api/session`, { headers });
    expect(await session.json()).toEqual({ role: "unconfigured", machineName: hostname(), version: programVersion, folderPath: join(machine.home, ".canonfig") });
    const index = await fetch(`${server.origin}/`, { headers });
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain('<div id="root">');
    expect((await fetch(`${server.origin}/api/no-such-endpoint`, { headers })).status).toBe(404);
    for (const method of ["POST", "PUT", "DELETE"]) {
      const withoutHeader = await fetch(`${server.origin}/api/status`, { method, headers, body: "{}" });
      expect(withoutHeader.status).toBe(403);
      expect(await withoutHeader.json()).toMatchObject({ category: "authentication-or-revocation", exitCode: 5 });
      expect((await fetch(`${server.origin}/api/status`, {
        method, headers: { ...headers, "x-canonfig-request": "browser", "Content-Type": "text/plain" }, body: "{}",
      })).status).toBe(415);
      expect((await fetch(`${server.origin}/api/status`, {
        method, headers: { ...headers, Origin: "https://example.invalid", "x-canonfig-request": "browser", "Content-Type": "application/json" }, body: "{}",
      })).status).toBe(403);
    }
    await stop(server.child, signal);
    const listener = createServer();
    listener.listen(Number(new URL(server.origin).port), "127.0.0.1");
    await once(listener, "listening");
    listener.close();
    await once(listener, "close");
  }, 60_000);

  it("keeps two GUI instances authorized in one host cookie jar", async () => {
    const machine = fixture();
    const servers = [await start(machine.env), await start(machine.env)];
    const jar = new Map<string, string>();
    for (const server of servers) {
      const exchange = await fetch(server.url, { redirect: "manual" });
      expect(exchange.status).toBe(303);
      const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
      if (cookie === undefined) throw new Error("No session cookie issued");
      const separator = cookie.indexOf("=");
      jar.set(cookie.slice(0, separator), cookie.slice(separator + 1));
    }
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    for (const server of servers) {
      expect((await fetch(`${server.origin}/api/session`, { headers: { Cookie: cookie } })).status).toBe(200);
    }
    expect(jar.size).toBe(2);
  }, 60_000);

  it("signs in through an https proxy origin with a Secure cookie and keeps the loopback origin", async () => {
    const machine = fixture();
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    if (address === null || Schema.is(Schema.String)(address)) throw new Error("No probe port");
    probe.close();
    await once(probe, "close");
    const proxyOrigin = "https://atlas.tailnet.ts.net";
    const server = await start(machine.env, ["--port", String(address.port), "--origin", proxyOrigin]);
    // The printed link is the proxy's: the token works once, so it names the origin the user will open.
    expect(new URL(server.url).origin).toBe(proxyOrigin);
    const local = `http://127.0.0.1:${address.port}`;
    const token = new URL(server.url).search;
    // tailscale serve forwards to loopback with the public Host, as this raw request does.
    const send = (path: string, headers: OutgoingHttpHeaders) => {
      const { promise, resolve: accept, reject } = Promise.withResolvers<{ status?: number; setCookie?: string[] }>();
      const outgoing = request(`${local}${path}`, { headers }, (response) => {
        response.resume();
        response.once("end", () => accept({ status: response.statusCode, setCookie: response.headers["set-cookie"] }));
      });
      outgoing.once("error", reject);
      outgoing.end();
      return promise;
    };
    const proxied = { Host: "atlas.tailnet.ts.net" };
    expect((await send(`/${token}`, { ...proxied, Origin: "http://atlas.tailnet.ts.net" })).status).toBe(403);
    expect((await send(`/${token}`, { Host: "other.tailnet.ts.net" })).status).toBe(403);
    expect((await send(`/${token}`, { Host: "evil.example@atlas.tailnet.ts.net" })).status).toBe(403);
    // Host case and the scheme's default port do not matter, as for any URL authority.
    const exchange = await send(`/${token}`, { Host: "ATLAS.tailnet.ts.net:443" });
    expect(exchange.status).toBe(303);
    const setCookie = exchange.setCookie?.[0] ?? "";
    expect(setCookie).toContain("Secure");
    const cookie = setCookie.split(";")[0];
    expect((await send("/api/session", { ...proxied, Cookie: cookie, Origin: proxyOrigin })).status).toBe(200);
    // The session is the server's, not the origin's, so the loopback origin still accepts it.
    expect((await send("/api/session", { Host: `127.0.0.1:${address.port}`, Cookie: cookie })).status).toBe(200);
  }, 60_000);

  // The expanded spelling of ::1 must bind and still match requests, which carry the normalized origin.
  it.each(["::1", "0:0:0:0:0:0:0:1"])("binds IPv6 %s and checks the bracketed origin", async (host) => {
    const machine = fixture();
    const server = await start(machine.env, ["--host", host]);
    expect(server.origin).toMatch(/^http:\/\/\[::1\]:\d+$/u);
    const exchange = await fetch(server.url, { redirect: "manual" });
    expect(exchange.status).toBe(303);
    expect(exchange.headers.get("set-cookie")).not.toContain("Secure");
    const cookie = exchange.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect((await fetch(`${server.origin}/api/session`, { headers: { Cookie: cookie } })).status).toBe(200);
    expect(await requestStatus(`${server.origin}/api/session`, { Cookie: cookie, Host: "127.0.0.1" })).toBe(403);
  }, 60_000);

  it("returns the CLI status payload unchanged for an initialized Source", async () => {
    const machine = fixture();
    const initialized = machine.invoke(["source", "init"]);
    expect(initialized.status, initialized.stdout + initialized.stderr).toBe(0);
    const cliStatus = machine.invoke(["status"]);
    expect(cliStatus.status, cliStatus.stdout + cliStatus.stderr).toBe(0);
    const server = await start(machine.env);
    const exchange = await fetch(server.url, { redirect: "manual" });
    const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
    if (cookie === undefined) throw new Error("No session cookie issued");
    const headers = { Cookie: cookie };
    const session = await fetch(`${server.origin}/api/session`, { headers });
    expect(await session.json()).toEqual({ role: "source", machineName: hostname(), version: programVersion, folderPath: join(machine.home, ".canonfig") });
    const status = await fetch(`${server.origin}/api/status`, { headers });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual(JSON.parse(cliStatus.stdout).data);
  }, 90_000);
});
