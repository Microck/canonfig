import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { Schema } from "effect";
import { GuiAgentHarnessRead } from "../../src/gui/contract/administration.ts";

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

it("refuses agent settings on a Source and skips its agent health check", async () => {
  const machine = fixture();
  const initialized = machine.invoke(["source", "init"]);
  expect(initialized.status, initialized.stderr).toBe(0);
  // Agents run only on Followers, so a Source has no agent policy to read or set.
  for (const args of [["agent", "policy"], ["agent", "policy", "agent-apply"]]) {
    const refused = machine.invoke(args);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("agent policy is set on each Follower Machine");
  }
  const api = await start(machine.env);
  const harness = { kind: "codex", executable: "codex", maximumInputBytes: 1024,
    allowedPaths: [], allowedExecutables: [], allowedOrigins: [], allowedCapabilities: [] };
  for (const [path, method, body] of [
    ["/api/agent/policy", "GET", undefined], ["/api/agent/policy", "PUT", "agent-propose"],
    ["/api/agent/harness", "GET", undefined], ["/api/agent/harness", "PUT", harness],
  ] as const) {
    const response = await api(path, method, body);
    expect(response.status, `${method} ${path}`).not.toBe(200);
    expect(response.body).toMatchObject({ category: "usage-or-configuration", exitCode: 2, message: "Agent settings require an enrolled Follower Machine." });
  }
  // A policy file an earlier release wrote on the Source no longer makes the health check fail.
  writeFileSync(join(machine.home, ".canonfig", "policy.json"), JSON.stringify({ policy: "agent-apply" }));
  const doctor = await api("/api/doctor", "POST");
  expect(doctor.status).toBe(200);
  expect(doctor.body.probes).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "agent-adapter", status: "skipped" }),
  ]));
}, 60_000);

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

it("adds, lists, checks and removes real installer bindings and preserves doctor failure evidence", async () => {
  const machine = fixture();
  const npmCli = process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
    : realpathSync(join(dirname(process.execPath), "npm"));
  const api = await start(machine.env);
  // A relative path is refused before anything is written.
  expect((await api("/api/installers", "POST", { method: "npm", executable: "node", arguments: [] })).body)
    .toMatchObject({ category: "human-action-required", exitCode: 3 });
  expect((await api("/api/installers")).body.bindings).toEqual([]);
  const added = await api("/api/installers", "POST", { method: "npm", executable: process.execPath, arguments: [npmCli] });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  expect(added.body).toMatchObject({ binding: { method: "npm", executable: process.execPath } });
  const listed = (await api("/api/installers")).body;
  expect(listed).toMatchObject({ bindings: [{ method: "npm", executable: process.execPath }] });
  // A bound method is no longer offered as a detected choice.
  expect(listed.detected.map((choice: { method: string }) => choice.method)).not.toContain("npm");
  // The CLI reads the binding the GUI wrote.
  expect(JSON.parse(machine.invoke(["installer", "list"]).stdout).data.bindings).toMatchObject([{ method: "npm" }]);
  expect((await api("/api/installers/npm/check", "POST")).body).toMatchObject({ verified: true, scope: "current-process" });
  expect((await api("/api/installers/brew/check", "POST")).body).toMatchObject({ category: "human-action-required", exitCode: 3 });
  expect((await api("/api/installers/npm/check", "POST", { extra: true })).body).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect((await api("/api/installers/npm", "DELETE")).body).toEqual({ removed: true });
  expect((await api("/api/installers")).body.bindings).toEqual([]);
  expect((await api("/api/installers/npm/check", "POST")).body).toMatchObject({ category: "human-action-required", exitCode: 3 });
  expect((await api("/api/installers/npm", "DELETE")).body).toEqual({ removed: false });
  const doctor = await api("/api/doctor", "POST");
  expect(doctor.status).toBe(200);
  expect(doctor.body).toMatchObject({ schema: "canonfig.doctor/v1", noInput: true });
  expect(doctor.body.probes.length).toBeGreaterThan(0);
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
  expect(await api("/api/agent/policy")).toEqual({ status: 200, body: "deterministic-only" });
  const initialHarness = await api("/api/agent/harness");
  expect(initialHarness).toEqual({ status: 200, body: { configured: false } });
  expect(Schema.decodeUnknownSync(GuiAgentHarnessRead)(initialHarness.body)).toEqual(initialHarness.body);
  expect(await api("/api/agent/policy", "PUT", "agent-propose")).toEqual({ status: 200, body: "agent-propose" });
  expect(await api("/api/agent/policy")).toEqual({ status: 200, body: "agent-propose" });
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
  const privateHarness = {
    ...harness,
    arguments: ["--token", "fixture-argument-credential"],
    environment: [{ name: "API_TOKEN", value: "fixture-environment-credential" }],
    secretBindings: [{ name: "OTHER_TOKEN", secret: "stored-token-name" }],
  };
  const savedPrivate = await api("/api/agent/harness", "PUT", privateHarness);
  expect(savedPrivate.status).toBe(200);
  expect(JSON.stringify(savedPrivate.body)).not.toContain("fixture-argument-credential");
  expect(JSON.stringify(savedPrivate.body)).not.toContain("fixture-environment-credential");
  const safeHarness = Schema.decodeUnknownSync(GuiAgentHarnessRead)((await api("/api/agent/harness")).body);
  if (!safeHarness.configured) throw new Error("Harness was not saved");
  expect(safeHarness.value.arguments).toBeUndefined();
  expect(safeHarness.value.environment).toBeUndefined();
  expect(safeHarness.value.secretBindings).toEqual(privateHarness.secretBindings);
  expect(JSON.stringify(safeHarness)).not.toContain("[REDACTED]");
  const savedBounds = await api("/api/agent/harness", "PUT", { ...safeHarness.value, maximumInputBytes: 8192 });
  expect(savedBounds.status).toBe(200);
  const readStoredHarness = () => {
    const database = new DatabaseSync(join(follower.home, ".canonfig", "state.sqlite"));
    try {
      const row = Schema.decodeUnknownSync(Schema.Struct({ configuration_json: Schema.String }))(
        database.prepare("SELECT configuration_json FROM follower_sync_configuration WHERE singleton = 1").get(),
      );
      return JSON.parse(row.configuration_json).agentHarness;
    } finally { database.close(); }
  };
  expect(readStoredHarness()).toMatchObject({ ...privateHarness, maximumInputBytes: 8192 });
  expect((await api("/api/agent/harness", "PUT", { ...safeHarness.value, arguments: ["--version"], environment: [] })).status).toBe(200);
  expect(readStoredHarness()).toMatchObject({ arguments: ["--version"], environment: [] });
  expect((await api("/api/agent/harness", "PUT", { ...harness, arguments: ["--token", "[REDACTED]"] })).status).not.toBe(200);
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
