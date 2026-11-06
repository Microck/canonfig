import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { FollowerCommands } from "../../src/cli/follower-commands.ts";
import { GuiAgentHarnessRead, GuiAgentPolicyRead } from "../../src/gui/contract/administration.ts";
import { GuiQueries } from "../../src/gui/queries.ts";
import { runtimeLayer } from "../../src/runtime/layers.ts";

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

it("reads absent Source agent settings normally and preserves save refusals and policy roundtrips", async () => {
  const machine = fixture();
  const initialized = machine.invoke(["source", "init"]);
  expect(initialized.status, initialized.stderr).toBe(0);
  expect(machine.invoke(["agent", "policy"]).status).toBe(2);
  const api = await start(machine.env);
  const policy = await api("/api/agent/policy");
  expect(policy).toEqual({ status: 200, body: { configured: false, default: "deterministic-only" } });
  expect(Schema.decodeUnknownSync(GuiAgentPolicyRead)(policy.body)).toEqual(policy.body);
  expect(await api("/api/agent/policy", "PUT", "agent-propose")).toEqual({ status: 200, body: "agent-propose" });
  expect(await api("/api/agent/policy")).toEqual({ status: 200, body: { configured: true, value: "agent-propose" } });
  expect((await api("/api/agent/policy", "PUT", "unknown")).body).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  const absentHarness = await api("/api/agent/harness");
  expect(absentHarness).toEqual({ status: 200, body: { configured: false } });
  expect(Schema.decodeUnknownSync(GuiAgentHarnessRead)(absentHarness.body)).toEqual(absentHarness.body);
  const harness = { kind: "codex", executable: "codex", maximumInputBytes: 1024,
    allowedPaths: [], allowedExecutables: [], allowedOrigins: [], allowedCapabilities: [] };
  expect((await api("/api/agent/harness", "PUT", harness)).body).toMatchObject({ category: "usage-or-configuration", exitCode: 2, message: "follower synchronization configuration is not enrolled" });
  expect((await api("/api/agent/harness", "PUT", { ...harness, maximumInputBytes: 0 })).body).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect((await api("/api/agent/policy")).body).toEqual({ configured: true, value: "agent-propose" });
}, 60_000);

it("keeps malformed and unreadable Source policy failures distinct from missing setup", async () => {
  const machine = fixture();
  expect(machine.invoke(["source", "init"]).status).toBe(0);
  const api = await start(machine.env);
  const path = join(machine.home, ".canonfig", "policy.json");
  for (const [content, message] of [
    ["{", "agent policy configuration is malformed"],
    [JSON.stringify({ policy: "unknown" }), "agent policy configuration is invalid"],
  ] as const) {
    writeFileSync(path, content);
    const response = await api("/api/agent/policy");
    expect(response.status).not.toBe(200);
    expect(response.body).toMatchObject({ category: "usage-or-configuration", exitCode: 2, message });
    expect(response.body).not.toHaveProperty("configured");
  }
  rmSync(path);
  // A directory is a real read failure even under privileged test runners.
  mkdirSync(path);
  const unreadable = await api("/api/agent/policy");
  expect(unreadable.status).not.toBe(200);
  expect(unreadable.body).toMatchObject({
    category: "usage-or-configuration", exitCode: 2, message: "agent policy configuration could not be read",
  });
}, 60_000);

it("reads agent policy from the configured runtime path without changing CLI absence semantics", async () => {
  const machine = fixture();
  const policyPath = join(machine.home, "custom-policy.json");
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const queries = yield* GuiQueries;
    const commands = yield* FollowerCommands;
    expect(yield* queries.agentPolicy()).toBeUndefined();
    expect(yield* commands.getAgentPolicy().pipe(Effect.flip)).toMatchObject({
      category: "usage-or-configuration", message: "agent policy is not configured",
    });
    yield* commands.setAgentPolicy("agent-apply");
    expect(yield* queries.agentPolicy()).toBe("agent-apply");
    expect(yield* commands.getAgentPolicy()).toBe("agent-apply");
  }).pipe(Effect.provide(runtimeLayer({ statePath: join(machine.home, "state.sqlite"), policyPath })))));
  expect(JSON.parse(readFileSync(policyPath, "utf8"))).toEqual({ policy: "agent-apply" });
}, 30_000);

it("enforces Source role and keeps unsupported operations absent", async () => {
  const machine = fixture();
  const api = await start(machine.env);
  for (const method of ["GET", "POST", "DELETE"]) {
    const response = await api("/api/source-service", method, method === "POST" ? { hostname: "127.0.0.1", port: 17342 } : {});
    expect(response.body).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  }
  expect((await api("/api/source-service/restart", "POST")).status).toBe(404);
  for (const path of ["/api/self-update/enable", "/api/self-update/disable", "/api/self-update/apply"]) {
    expect((await api(path, "POST", { extra: true })).body).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
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

it("reads fresh enrolled Follower settings, saves them, and preserves malformed state failures", async () => {
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
  expect(await api("/api/local/overlays")).toEqual({
    status: 200, body: { configured: false, overlays: [], pending: [] },
  });
  expect(await api("/api/local/items")).toEqual({
    status: 200, body: { items: [], config: {}, canonicalConfig: {} },
  });
  const localDirectory = join(follower.home, ".canonfig", "local");
  mkdirSync(localDirectory, { recursive: true });
  const localConfig = join(localDirectory, "local.jsonc");
  writeFileSync(localConfig, JSON.stringify({ overlays: ["rules/pending"] }));
  expect(await api("/api/local/overlays")).toEqual({
    status: 200, body: { configured: false, overlays: [], pending: ["rules/pending"] },
  });
  writeFileSync(localConfig, "{");
  expect((await api("/api/local/overlays")).status).not.toBe(200);
  rmSync(localConfig);
  const mirror = join(follower.home, ".canonfig", "canonfig.jsonc");
  writeFileSync(mirror, "{");
  for (const path of ["/api/local/overlays", "/api/local/items"]) {
    const failed = await api(path);
    expect(failed.status).not.toBe(200);
    expect(failed.body).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  }
  writeFileSync(mirror, JSON.stringify({ version: 1, harnesses: [] }));
  expect(await api("/api/local/overlays")).toEqual({ status: 200, body: { overlays: [] } });
  const initialPolicy = await api("/api/agent/policy");
  expect(initialPolicy).toEqual({ status: 200, body: { configured: true, value: "deterministic-only" } });
  expect(Schema.decodeUnknownSync(GuiAgentPolicyRead)(initialPolicy.body)).toEqual(initialPolicy.body);
  const initialHarness = await api("/api/agent/harness");
  expect(initialHarness).toEqual({ status: 200, body: { configured: false } });
  expect(Schema.decodeUnknownSync(GuiAgentHarnessRead)(initialHarness.body)).toEqual(initialHarness.body);
  expect(await api("/api/agent/policy", "PUT", "agent-propose")).toEqual({ status: 200, body: "agent-propose" });
  expect(await api("/api/agent/policy")).toEqual({ status: 200, body: { configured: true, value: "agent-propose" } });
  const harness = { kind: "custom", executable: process.execPath, arguments: ["--version"], maximumInputBytes: 4096,
    allowedPaths: [follower.home], allowedExecutables: [], allowedOrigins: [], allowedCapabilities: [] };
  expect(await api("/api/agent/harness", "PUT", harness)).toEqual({ status: 200, body: harness });
  const configuredHarness = await api("/api/agent/harness");
  expect(configuredHarness).toEqual({ status: 200, body: { configured: true, value: harness } });
  expect(Schema.decodeUnknownSync(GuiAgentHarnessRead)(configuredHarness.body)).toEqual(configuredHarness.body);
  expect((await api("/api/agent/harness", "PUT", { ...harness, model: "invalid-for-custom" })).body)
    .toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect((await api("/api/agent/harness")).body).toEqual({ configured: true, value: harness });
  expect((await api("/api/source-service")).body).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  const database = new DatabaseSync(join(follower.home, ".canonfig", "state.sqlite"));
  try {
    database.prepare("UPDATE follower_sync_configuration SET configuration_json = ? WHERE singleton = 1").run("{");
  } finally {
    database.close();
  }
  for (const path of ["/api/agent/policy", "/api/agent/harness"]) {
    const response = await api(path);
    expect(response.status).not.toBe(200);
    expect(response.body).toHaveProperty("category");
    expect(response.body.exitCode).not.toBe(0);
    expect(response.body).not.toHaveProperty("configured");
  }
}, 120_000);
