import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import type { Schema } from "effect";

const entry = resolve(import.meta.dirname, "../../src/runtime/main.ts");
const children: ChildProcess[] = [];
const homes: string[] = [];

// Both the filesystem and native service session are disposable. Never inherit
// the operator's D-Bus or systemd session when exercising administration routes.
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "canonfig-administration-"));
  homes.push(home);
  const runtime = join(home, "runtime");
  mkdirSync(runtime, { mode: 0o700 });
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".state"), XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
    CANONFIG_LOCAL_CREDENTIAL_ROOT: join(home, "credentials"), CANONFIG_LOG: "off" };
  return { home, env, invoke: (args: string[], input?: string) => spawnSync(process.execPath,
    ["--import", "tsx", entry, "--json", ...args], { env, input, encoding: "utf8", timeout: 30_000 }) };
}

async function start(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", entry, "ui", "--no-open"],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const ready = Promise.withResolvers<string>();
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/u);
    if (match) ready.resolve(match[0]);
  });
  child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  child.once("error", ready.reject);
  child.once("exit", (code) => ready.reject(new Error(`GUI exited ${code}: ${errors}`)));
  const deadline = setTimeout(() => ready.reject(new Error(`GUI did not start: ${errors}`)), 30_000);
  try {
    const launch = await ready.promise;
    const origin = new URL(launch).origin;
    const exchange = await fetch(launch, { redirect: "manual" });
    const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("No GUI session cookie");
    return async (path: string, method = "GET", body?: Schema.Json) => {
      const options: RequestInit = { method,
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "x-canonfig-request": "browser" } };
      if (method !== "GET") options.body = JSON.stringify(body ?? {});
      const response = await fetch(`${origin}${path}`, options);
      return { status: response.status, body: await response.json() };
    };
  } finally { clearTimeout(deadline); }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped;
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it("persists policy, preserves harness refusal, and rejects malformed requests", async () => {
  const machine = fixture();
  const api = await start(machine.env);
  expect((await api("/api/agent/policy")).body).toMatchObject({ category: "usage-or-configuration", exitCode: 2, message: "agent policy is not configured" });
  expect(await api("/api/agent/policy", "PUT", "agent-propose")).toEqual({ status: 200, body: "agent-propose" });
  expect((await api("/api/agent/policy")).body).toBe("agent-propose");
  expect((await api("/api/agent/policy", "PUT", "unknown")).body).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect((await api("/api/agent/harness")).body).toMatchObject({ category: "usage-or-configuration", exitCode: 2, message: "agent harness is not configured" });
  const harness = { kind: "codex", executable: "codex", maximumInputBytes: 1024,
    allowedPaths: [], allowedExecutables: [], allowedOrigins: [], allowedCapabilities: [] };
  expect((await api("/api/agent/harness", "PUT", harness)).body).toMatchObject({ category: "usage-or-configuration", exitCode: 2, message: "follower synchronization configuration is not enrolled" });
  expect((await api("/api/agent/harness", "PUT", { ...harness, maximumInputBytes: 0 })).body).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect((await api("/api/agent/policy")).body).toBe("agent-propose");
}, 60_000);

it("enforces Source role and keeps unsupported operations absent", async () => {
  const machine = fixture();
  const api = await start(machine.env);
  for (const method of ["GET", "POST", "DELETE"]) {
    const response = await api("/api/source-service", method, method === "POST" ? { hostname: "127.0.0.1", port: 17342 } : {});
    expect(response.body).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  }
  for (const path of ["/api/source-service/restart", "/api/self-update/enable", "/api/self-update/disable", "/api/self-update/apply"]) {
    expect((await api(path, "POST")).status).toBe(404);
  }
}, 60_000);

it("lists and checks real installer bindings and preserves doctor failure evidence", async () => {
  const machine = fixture();
  const npmCli = process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
    : realpathSync(join(dirname(process.execPath), "npm"));
  const bound = machine.invoke(["installer", "set", "npm", "--executable", process.execPath, "--arg", npmCli]);
  expect(bound.status, bound.stderr).toBe(0);
  const api = await start(machine.env);
  expect((await api("/api/installers")).body).toMatchObject({ bindings: [{ method: "npm", executable: process.execPath }], suggestions: [] });
  expect((await api("/api/installers/npm/check", "POST")).body).toMatchObject({ verified: true, scope: "current-process" });
  expect((await api("/api/installers/brew/check", "POST")).body).toMatchObject({ category: "human-action-required", exitCode: 3 });
  expect((await api("/api/installers/npm/check", "POST", { extra: true })).body).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  const doctor = await api("/api/doctor", "POST");
  expect(doctor.status).toBe(200);
  expect(doctor.body.report).toMatchObject({ schema: "canonfig.doctor/v1", noInput: true });
  expect(doctor.body.report.probes.length).toBeGreaterThan(0);
  if (doctor.body.report.status === "unhealthy") expect(doctor.body.error).toMatchObject({ message: "one or more doctor probes failed" });
  expect((await api("/api/self-update")).body).toMatchObject({ enabled: false, pending: false, settings: null });
  expect((await api("/api/self-update/check", "POST")).body).toMatchObject({ category: "human-action-required", exitCode: 3 });
}, 90_000);

it.runIf(process.platform === "linux")("reads real Source service evidence and preserves native installation failures", async () => {
  const machine = fixture();
  const initialized = machine.invoke(["source", "init"]);
  expect(initialized.status, initialized.stderr).toBe(0);
  const cliStatus = machine.invoke(["source", "service", "status"]);
  const api = await start(machine.env);
  const status = await api("/api/source-service");
  if (cliStatus.status === 0) {
    expect(status.body).toEqual({ report: JSON.parse(cliStatus.stdout).data, error: null });
  } else {
    expect(status.body.error ?? status.body).toMatchObject({ exitCode: cliStatus.status });
  }
  expect((await api("/api/source-service", "POST", { hostname: "0.0.0.0", port: 17342 })).body)
    .toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect((await api("/api/source-service", "POST", { hostname: "127.0.0.1", port: 0 })).body)
    .toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  // The isolated nonexistent user bus prevents this test from controlling any
  // host service. A native refusal must remain a failure, not a successful toggle.
  const installed = await api("/api/source-service", "POST", { hostname: "127.0.0.1", port: 17342 });
  expect(installed.body).toHaveProperty("category");
  expect(installed.body.exitCode).not.toBe(0);
  const removed = await api("/api/source-service", "DELETE");
  if (removed.status === 200) expect(removed.body.change).toMatch(/removed|unchanged/);
  else expect(removed.body.exitCode).not.toBe(0);
}, 90_000);

it("saves the actual enrolled Follower harness and rejects Source-only settings", async () => {
  const source = fixture();
  expect(source.invoke(["source", "init"]).status).toBe(0);
  writeFileSync(join(source.home, ".canonfig", "canonfig.jsonc"), JSON.stringify({
    version: 1, profile: { id: "administration", name: "Administration" }, harnesses: [],
  }));
  const published = source.invoke(["source", "publish", "--reviewer", "gui-test"]);
  expect(published.status, published.stderr).toBe(0);
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  // SAFETY: The TCP listener is bound to 127.0.0.1 and its listening event has fired.
  const port = (listener.address() as AddressInfo).port;
  const closed = once(listener, "close"); listener.close(); await closed;
  const server = spawn(process.execPath, ["--import", "tsx", entry, "source", "serve", "--host", "127.0.0.1", "--port", String(port), "--json"], {
    env: source.env, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(server);
  const ready = Promise.withResolvers<void>();
  let stdout = "";
  server.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.includes("\n")) ready.resolve(); });
  server.once("error", ready.reject);
  server.once("exit", (code) => ready.reject(new Error(`Source test server exited ${code}`)));
  await ready.promise;
  const invitation = join(source.home, "follower.invite");
  expect(source.invoke(["source", "invite", "--endpoint", `https://127.0.0.1:${port}`, "--output", invitation]).status).toBe(0);
  const follower = fixture();
  const enrolled = follower.invoke(["follower", "enroll", "--stdin", "--name", "admin-follower"], readFileSync(invitation, "utf8"));
  expect(enrolled.status, enrolled.stderr).toBe(0);
  const api = await start(follower.env);
  const harness = { kind: "custom", executable: process.execPath, arguments: ["--version"], maximumInputBytes: 4096,
    allowedPaths: [follower.home], allowedExecutables: [], allowedOrigins: [], allowedCapabilities: [] };
  expect(await api("/api/agent/harness", "PUT", harness)).toEqual({ status: 200, body: harness });
  expect((await api("/api/agent/harness")).body).toEqual(harness);
  expect((await api("/api/agent/harness", "PUT", { ...harness, model: "invalid-for-custom" })).body)
    .toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect((await api("/api/agent/harness")).body).toEqual(harness);
  expect((await api("/api/source-service")).body).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
}, 120_000);
