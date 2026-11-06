import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { GuiArchiveDownload, GuiBackups, GuiLocalItems, GuiOperation, GuiOperationTicket } from "../../src/gui/contract.ts";

const project = resolve(import.meta.dirname, "../..");
const children = new Set<ChildProcess>();
const homes: string[] = [];
const write = (path: string, contents: string, mode = 0o600) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents, { mode }); };

function fixture(label: string) {
  const home = mkdtempSync(join(tmpdir(), `canonfig-gui-sync-${label}-`));
  homes.push(home);
  const bin = join(home, "bin");
  mkdirSync(bin);
  const env: NodeJS.ProcessEnv = {
    HOME: home, USERPROFILE: home, PATH: bin, TMPDIR: tmpdir(), NODE_NO_WARNINGS: "1",
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"), CANONFIG_LOCAL_CREDENTIAL_ROOT: join(home, "credentials"), CANONFIG_LOG: "off",
  };
  const invoke = (args: string[], input?: string) => spawnSync(process.execPath, ["--import", "tsx", "src/runtime/main.ts", ...args, "--json"], { cwd: project, env, input, encoding: "utf8", timeout: 120_000 });
  return { home, folder: join(home, ".canonfig"), bin, env, invoke };
}

type Fixture = ReturnType<typeof fixture>;
const success = (result: ReturnType<Fixture["invoke"]>) => { expect(result.status, result.stdout + result.stderr).toBe(0); return result; };

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || Schema.is(Schema.String)(address)) throw new Error("No listening address");
  const { promise, resolve: closed, reject } = Promise.withResolvers<void>();
  server.close((error) => error ? reject(error) : closed());
  await promise;
  return address.port;
}

async function launch(machine: Fixture, args: string[], ready: RegExp) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/runtime/main.ts", ...args], { cwd: project, env: machine.env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const { promise, resolve: resolveReady, reject } = Promise.withResolvers<string>();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); const match = stdout.match(ready); if (match) resolveReady(match[0]); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.once("error", reject);
  child.once("exit", (code) => reject(new Error(`Child exited ${code}: ${stderr}`)));
  const timer = setTimeout(() => reject(new Error(`Startup timeout: ${stderr}`)), 60_000);
  try { return { child, ready: await promise }; } finally { clearTimeout(timer); }
}

async function gui(machine: Fixture) {
  const launched = await launch(machine, ["ui", "--no-open"], /http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/u);
  const origin = new URL(launched.ready).origin;
  const exchange = await fetch(launched.ready, { redirect: "manual" });
  const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("GUI did not establish a session");
  const call = async (path: string, method = "GET", body?: Schema.Json) => {
    const options: RequestInit = { method, headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "x-canonfig-request": "browser" } };
    if (method !== "GET") options.body = Schema.is(Schema.String)(body) ? body : JSON.stringify(body ?? {});
    const response = await fetch(origin + path, options);
    const payload: unknown = await response.json();
    return { status: response.status, payload };
  };
  const operation = async (path: string, body: Schema.Json = {}) => {
    const started = await call(path, "POST", body);
    expect(started.status).toBe(202);
    const ticket = Schema.decodeUnknownSync(GuiOperationTicket)(started.payload);
    let polled = Schema.decodeUnknownSync(GuiOperation)((await call(`/api/operations/${ticket.id}`)).payload);
    const deadline = Date.now() + 60_000;
    while (polled.state === "running") {
      if (Date.now() > deadline) throw new Error("Operation did not finish");
      // This polls a separate CLI process over HTTP, not an in-process timer under TestClock.
      const { promise, resolve: tick } = Promise.withResolvers<void>();
      setTimeout(tick, 20);
      await promise;
      polled = Schema.decodeUnknownSync(GuiOperation)((await call(`/api/operations/${ticket.id}`)).payload);
    }
    return polled;
  };
  return { call, operation };
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill("SIGTERM"); await closed;
    }
  }
  children.clear();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

it("serves real role-gated secrets and a verified Source archive without leaking secret input", async () => {
  const machine = fixture("source");
  success(machine.invoke(["source", "init"]));
  write(join(machine.folder, "canonfig.jsonc"), JSON.stringify({ version: 1, profile: { id: "gui-test", name: "GUI test" }, harnesses: [] }));
  write(join(machine.folder, "AGENTS.md"), "Source instructions\n");
  const api = await gui(machine);
  const marker = "private-value-do-not-echo";
  for (const body of [JSON.stringify({ name: "test", value: { private: marker } }), `{"name":"test","value":"${marker}",bad}`]) {
    const failed = await api.call("/api/secrets", "PUT", body);
    expect(failed.payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
    expect(JSON.stringify(failed.payload)).not.toContain(marker);
  }
  const storageFailure = await api.call("/api/secrets", "PUT", { name: "test", value: marker });
  expect(storageFailure.payload).toMatchObject({ category: "human-action-required", exitCode: 3 });
  expect(JSON.stringify(storageFailure.payload)).not.toContain(marker);
  expect((await api.call("/api/secrets")).payload).toMatchObject({ secrets: [] });
  expect((await api.call("/api/secrets", "DELETE", { name: "test" })).payload).toEqual({ name: "test", removed: false });
  expect((await api.call("/api/secrets", "DELETE", { name: "../invalid" })).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  for (const [path, method, body] of [
    ["/api/sync/plan", "POST", {}], ["/api/sync/apply", "POST", {}], ["/api/sync/reviews", "POST", {}],
    ["/api/recovery", "POST", {}], ["/api/recovery/abandon", "POST", {}], ["/api/secrets/sync", "POST", {}],
    ["/api/schedule", "GET", undefined], ["/api/schedule", "PUT", { profileDefault: true }],
    ["/api/local/items", "GET", undefined], ["/api/local/items", "PUT", { changes: [] }],
    ["/api/local/preferences", "PUT", { expectedDigest: null, edits: [] }],
    ["/api/harnesses", "PUT", { harness: "codex", action: "include" }], ["/api/local/overlays", "GET", undefined],
    ["/api/local/overlays", "PUT", { item: "rules/test" }], ["/api/local/overlays", "DELETE", { item: "rules/test" }],
    ["/api/backups", "GET", undefined], ["/api/backups/restore", "POST", { snapshot: "missing" }],
    ["/api/tunnel", "GET", undefined], ["/api/tunnel/start", "POST", {}], ["/api/tunnel/stop", "POST", {}], ["/api/enrollment", "DELETE", {}],
  ] as const) expect((await api.call(path, method, body)).payload, path).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  const exported = await api.call("/api/exports", "POST", { includeHarnesses: false });
  expect(exported.status).toBe(200);
  const archive = Schema.decodeUnknownSync(GuiArchiveDownload)(exported.payload);
  expect(createHash("sha256").update(Buffer.from(archive.base64, "base64")).digest("hex")).toBe(archive.sha256);
  expect(archive.signer).not.toBe("unsigned");
  const path = join(machine.home, "download.tar.gz");
  writeFileSync(path, Buffer.from(archive.base64, "base64"));
  success(machine.invoke(["import", path, "--dry-run", "--replace"]));
}, 180_000);

it("plans and applies an enrolled follower and performs digest-checked local operations", async () => {
  const source = fixture("source");
  success(source.invoke(["source", "init"]));
  write(join(source.folder, "canonfig.jsonc"), JSON.stringify({ version: 1, profile: { id: "gui-test", name: "GUI test" }, harnesses: ["codex"], local: { allow: ["instructions", "rules", "skills", "agents", "mcp", "settings"] } }));
  write(join(source.folder, "AGENTS.md"), "Source instructions\n");
  success(source.invoke(["source", "publish", "--reviewer", "gui-test"]));
  const port = await unusedPort();
  await launch(source, ["source", "serve", "--host", "127.0.0.1", "--port", String(port), "--json"], /"endpoint":"https:\/\/127\.0\.0\.1:\d+"/u);
  const follower = fixture("follower");
  write(join(follower.bin, "codex"), "", 0o755);
  const invitation = join(source.home, "invitation");
  success(source.invoke(["source", "invite", "--endpoint", `https://127.0.0.1:${port}`, "--output", invitation]));
  success(follower.invoke(["follower", "enroll", "--stdin", "--name", "GUI follower"], readFileSync(invitation, "utf8")));
  const api = await gui(follower);
  for (const path of [
    "/api/sync/plan", "/api/sync/apply", "/api/sync/reviews", "/api/recovery",
    "/api/recovery/abandon", "/api/secrets/sync", "/api/tunnel/start", "/api/tunnel/stop", "/api/enrollment",
  ]) {
    const refused = await api.call(path, path === "/api/enrollment" ? "DELETE" : "POST", { unexpected: true });
    expect(refused.payload, path).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  }
  expect((await api.operation("/api/sync/plan")).state).toBe("succeeded");
  const applied = await api.operation("/api/sync/apply");
  expect(applied.state, JSON.stringify(applied)).toBe("succeeded");
  expect(applied.journal).toMatchObject({ evidence: { outcome: "Converged" } });
  expect(readFileSync(join(follower.home, ".codex/AGENTS.md"), "utf8")).toContain("Source instructions");
  expect((await api.operation("/api/sync/reviews")).state).toBe("succeeded");
  for (const path of ["/api/recovery", "/api/recovery/abandon"]) {
    const failed = await api.operation(path);
    expect(failed.state).toBe("failed");
    expect(failed.failure).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  }
  const localInstructions = `Local instructions\n${"a".repeat(1024 * 1024)}`;
  const change = { path: "AGENTS.md", expectedDigest: null, files: [{ path: "AGENTS.md", base64: Buffer.from(localInstructions).toString("base64"), executable: false }] };
  const created = await api.call("/api/local/items", "PUT", { changes: [change] });
  expect(created.status).toBe(200);
  const items = Schema.decodeUnknownSync(GuiLocalItems)(created.payload).items;
  expect(created.payload).toMatchObject({
    config: {},
    canonicalConfig: { local: { allow: ["instructions", "rules", "skills", "agents", "mcp", "settings"] } },
  });
  const item = items.find((value) => value.path === "AGENTS.md");
  expect(item?.digest).toBeTypeOf("string");
  expect((await api.call("/api/local/items", "PUT", { changes: [change] })).payload).toMatchObject({ category: "conflict-or-drift", exitCode: 4 });
  expect(readFileSync(join(follower.folder, "local/AGENTS.md"), "utf8")).toBe(localInstructions);
  expect((await api.call("/api/local/items", "PUT", { changes: [{ ...change, path: "../escape" }] })).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect((await api.call("/api/local/items", "PUT", { changes: [{
    ...change, files: [{ ...change.files[0], base64: "invalid base64!" }],
  }] })).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect((await api.call("/api/local/items", "PUT", { changes: [{
    path: "commands/blocked.md", expectedDigest: null,
    files: [{ path: "commands/blocked.md", base64: Buffer.from("Not allowed\n").toString("base64"), executable: false }],
  }] })).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect((await api.call("/api/local/items", "PUT", { changes: [{ ...change, expectedDigest: item?.digest, files: [] }] })).status).toBe(200);
  const rule = { path: "rules/first.md", expectedDigest: null, files: [{ path: "rules/first.md", base64: Buffer.from("First\n").toString("base64"), executable: false }] };
  const ruleCreated = Schema.decodeUnknownSync(GuiLocalItems)((await api.call("/api/local/items", "PUT", { changes: [rule] })).payload).items.find((entry) => entry.path === rule.path);
  const ruleEdited = Schema.decodeUnknownSync(GuiLocalItems)((await api.call("/api/local/items", "PUT", { changes: [{
    ...rule, expectedDigest: ruleCreated?.digest, files: [{ ...rule.files[0], base64: Buffer.from("Edited\n").toString("base64") }],
  }] })).payload).items.find((entry) => entry.path === rule.path);
  expect(readFileSync(join(follower.folder, "local/rules/first.md"), "utf8")).toBe("Edited\n");
  const renamed = await api.call("/api/local/items", "PUT", { changes: [
    { path: "rules/renamed.md", expectedDigest: null, files: [{ path: "rules/renamed.md", base64: Buffer.from("Edited\n").toString("base64"), executable: false }] },
    { path: rule.path, expectedDigest: ruleEdited?.digest, files: [] },
  ] });
  expect(renamed.status).toBe(200);
  const renamedRule = Schema.decodeUnknownSync(GuiLocalItems)(renamed.payload).items.find((entry) => entry.path === "rules/renamed.md");
  expect((await api.call("/api/local/items", "PUT", { changes: [{ path: "rules/renamed.md", expectedDigest: renamedRule?.digest, files: [] }] })).status).toBe(200);
  const skillFiles = [
    { path: "skills/binary/SKILL.md", base64: Buffer.from("---\nname: binary\ndescription: Test binary assets\n---\nInstructions\n").toString("base64"), executable: false },
    { path: "skills/binary/data.bin", base64: Buffer.from([0, 255, 128, 239, 187, 191]).toString("base64"), executable: true },
  ];
  const skill = await api.call("/api/local/items", "PUT", { changes: [{ path: "skills/binary", expectedDigest: null, files: skillFiles }] });
  expect(skill.status).toBe(200);
  const skillItem = Schema.decodeUnknownSync(GuiLocalItems)(skill.payload).items.find((entry) => entry.path === "skills/binary");
  expect(skillItem?.files.find((file) => file.path.endsWith("data.bin"))).toMatchObject(skillFiles[1]!);
  expect((await api.call("/api/local/items", "PUT", { changes: [{ path: "skills/binary", expectedDigest: skillItem?.digest, files: [] }] })).status).toBe(200);
  const getConfig = async () => Schema.decodeUnknownSync(GuiLocalItems)((await api.call("/api/local/items")).payload).items.find((entry) => entry.path === "local.jsonc");
  const config = await getConfig();
  const preference = { expectedDigest: config?.digest ?? null, edits: [{ path: ["backups"], value: false }] };
  expect((await api.call("/api/local/preferences", "PUT", preference)).status).toBe(200);
  expect((await api.call("/api/local/items")).payload).toMatchObject({ config: { backups: false } });
  expect((await api.call("/api/local/preferences", "PUT", preference)).payload).toMatchObject({ category: "conflict-or-drift", exitCode: 4 });
  const beforeInvalidOverlay = readFileSync(join(follower.folder, "local/local.jsonc"), "utf8");
  for (const method of ["PUT", "DELETE"]) {
    const refused = await api.call("/api/local/overlays", method, { item: "instructions" });
    expect(refused.payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
    expect(readFileSync(join(follower.folder, "local/local.jsonc"), "utf8")).toBe(beforeInvalidOverlay);
  }
  expect((await api.call("/api/local/overlays", "PUT", { item: "settings/codex#model" })).status).toBe(200);
  expect((await api.call("/api/local/overlays")).status).toBe(200);
  expect((await api.call("/api/local/overlays", "DELETE", { item: "settings/codex#model" })).status).toBe(200);
  expect((await api.call("/api/local/overlays", "PUT", { item: "settings/hermes#model" })).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  for (const action of ["exclude", "include"]) expect((await api.call("/api/harnesses", "PUT", { harness: "codex", action })).status).toBe(200);
  expect((await api.call("/api/harnesses")).status).toBe(200);
  expect((await api.call("/api/harnesses", "PUT", { harness: "unknown", action: "include" })).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect((await api.call("/api/schedule")).status).toBe(200);
  expect((await api.call("/api/schedule", "PUT", { schedule: { kind: "daily", localTime: "99:99" } })).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  const noDefault = await api.call("/api/schedule", "PUT", { profileDefault: true });
  expect(noDefault.payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect((await api.call("/api/tunnel")).status).toBe(200);
  expect((await api.call("/api/tunnel/start", "POST", {})).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect((await api.call("/api/tunnel/stop", "POST", {})).status).toBe(200);
  expect((await api.call("/api/secrets")).status).toBe(200);
  expect((await api.call("/api/secrets/sync", "POST", {})).status).toBe(200);
  expect((await api.call("/api/secrets", "PUT", { name: "no", value: "private" })).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect((await api.call("/api/secrets", "DELETE", { name: "no" })).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  const backups = Schema.decodeUnknownSync(GuiBackups)((await api.call("/api/backups")).payload);
  expect(backups.snapshots.length).toBeGreaterThan(0);
  const failedRestore = await api.operation("/api/backups/restore", { snapshot: "missing" });
  expect(failedRestore.state).toBe("failed");
  expect(failedRestore.failure).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  const restored = await api.operation("/api/backups/restore", { snapshot: backups.snapshots[0] });
  expect(restored.state, JSON.stringify(restored)).toBe("succeeded");
  expect(restored.result).toMatchObject({ restored: backups.snapshots[0], excludedHarnesses: ["codex"] });
  expect((await api.call("/api/exports", "POST", { includeHarnesses: false })).status).toBe(200);
  const unenrolled = await api.call("/api/enrollment", "DELETE", {});
  expect(unenrolled.payload).toMatchObject({ unenrolled: true, credentialRemoved: true });
  expect((await api.call("/api/sync/plan", "POST", {})).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
}, 300_000);
