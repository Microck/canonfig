import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type OutgoingHttpHeaders } from "node:http";
import { createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

const start = async (env: NodeJS.ProcessEnv) => {
  const child = spawn(process.execPath, ["--import", "tsx", entry, "ui", "--no-open"], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const { promise, resolve: ready, reject } = Promise.withResolvers<string>();
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/u);
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
    expect(evaluateCli(["ui"])).toMatchObject({ command: { _tag: "Ui", port: 0, open: true } });
    expect(evaluateCli(["ui", "--no-open", "--port", "5317"])).toMatchObject({ command: { _tag: "Ui", port: 5317, open: false } });
    for (const args of [["--port", "0"], ["--port", "65536"], ["--port", "no"], ["--host", "0.0.0.0"], ["extra"], ["--json"]]) {
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
