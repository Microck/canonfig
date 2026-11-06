import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { GuiProfileSnapshot, GuiRevisions, GuiSkills } from "../../src/gui/contract/profile.ts";
import { GuiOperation, GuiOperationTicket } from "../../src/gui/contract/operations.ts";

const entry = resolve("src/runtime/main.ts");
const homes: string[] = [];
const children: ChildProcess[] = [];
const base64 = (value: string) => Buffer.from(value).toString("base64");
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "canonfig-profile-")); homes.push(home);
  const folder = join(home, ".canonfig");
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".state"), CANONFIG_LOCAL_CREDENTIAL_ROOT: join(home, "credentials"), CANONFIG_LOG: "off" };
  const invoke = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", entry, "--json", ...args], { env, encoding: "utf8", timeout: 30_000 });
  return { home, folder, env, invoke };
}
async function server(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", entry, "ui", "--no-open"], { env, stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
  const { promise, resolve: ready, reject } = Promise.withResolvers<string>();
  let output = ""; let errors = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/u); if (match) ready(match[0]); });
  child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  child.once("exit", (code) => reject(new Error(`GUI exited ${code}: ${errors}`))); child.once("error", reject);
  const deadline = setTimeout(() => reject(new Error(`GUI did not start: ${errors}`)), 30_000);
  const url = await promise.finally(() => clearTimeout(deadline));
  const origin = new URL(url).origin;
  const exchange = await fetch(url, { redirect: "manual" });
  const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("No session cookie");
  async function request(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${origin}${path}`, { method, headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "x-canonfig-request": "browser" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value: unknown = await response.json(); return { status: response.status, value };
  }
  const snapshot = async () => Schema.decodeUnknownSync(GuiProfileSnapshot)((await request("/api/profile/items")).value);
  async function operation(path: string, body: unknown) {
    const started = await request(path, "POST", body);
    expect(started.status).toBe(202);
    const ticket = Schema.decodeUnknownSync(GuiOperationTicket)(started.value);
    const deadline = Date.now() + 30_000;
    let polled: typeof GuiOperation.Type;
    do {
      polled = Schema.decodeUnknownSync(GuiOperation)((await request(`/api/operations/${ticket.id}`)).value);
      if (Date.now() > deadline) throw new Error("Skill operation did not finish");
    } while (polled.state === "running");
    return polled;
  }
  return { request, snapshot, operation, child };
}
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("profile GUI endpoints", () => {
  it.each(["/api/profile/items", "/api/profile/config"])("saves an authored item above the default request limit through %s", async (endpoint) => {
    const machine = fixture();
    const initialized = machine.invoke(["source", "init"]);
    expect(initialized.status, initialized.stderr).toBe(0);
    writeFileSync(join(machine.folder, "canonfig.jsonc"), '{"version":1,"harnesses":[]}');
    const gui = await server(machine.env);
    const snapshot = await gui.snapshot();
    const content = "a".repeat(1024 * 1024);
    const changes = [{
      path: "AGENTS.md", expectedDigest: null,
      files: [{ path: "AGENTS.md", base64: base64(content), executable: false }],
    }];
    const body = endpoint === "/api/profile/items" ? { changes } : {
      expectedDigest: snapshot.items.find((item) => item.path === "canonfig.jsonc")!.digest,
      edits: [], changes,
    };
    const saved = await gui.request(endpoint, "PUT", body);
    expect(saved.status, JSON.stringify(saved.value)).toBe(200);
    expect(saved.value).toEqual({ saved: true });
    expect(readFileSync(join(machine.folder, "AGENTS.md"), "utf8")).toBe(content);
  }, 60_000);

  it("authors files and JSONC with digest conflicts, validates, scans and publishes real revisions", async () => {
    const machine = fixture();
    const initialized = machine.invoke(["source", "init"]); expect(initialized.status, initialized.stderr).toBe(0);
    writeFileSync(join(machine.folder, "canonfig.jsonc"), '{\n// Keep the author comment\n"version":1,"profile":{"id":"workstation","name":"Workstation"},"harnesses":[]\n}\n');
    const gui = await server(machine.env);
    let snapshot = await gui.snapshot();
    const configDigest = () => snapshot.items.find((item) => item.path === "canonfig.jsonc")?.digest ?? null;
    const put = (path: string, text: string, expectedDigest: string | null = null) => gui.request("/api/profile/items", "PUT", { changes: [{ path, expectedDigest, files: [{ path, base64: base64(text), executable: false }] }] });
    expect((await put("AGENTS.md", "# Instructions\nKeep changes focused.\n")).status).toBe(200);
    const stale = await put("AGENTS.md", "overwrite"); expect(stale.value).toMatchObject({ category: "conflict-or-drift", exitCode: 4 });
    expect(readFileSync(join(machine.folder, "AGENTS.md"), "utf8")).toContain("Keep changes focused");
    expect((await put("../outside", "escape")).value).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
    expect((await gui.request("/api/profile/items", "PUT", { changes: [], unexpected: true })).value).toMatchObject({ exitCode: 2 });
    for (const endpoint of ["/api/profile/scan", "/api/profile/validate"]) {
      expect((await gui.request(endpoint, "POST", { unexpected: true })).value).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
    }
    for (const [path, text] of [["rules/review.md", "---\ndescription: Review\n---\nReview changes.\n"], ["agents/reviewer.md", "---\ndescription: Reviewer\n---\nReview safely.\n"], ["commands/review.md", "---\ndescription: Review command\n---\nReview.\n"]]) expect((await put(path!, text!)).status).toBe(200);
    snapshot = await gui.snapshot();
    const config = await gui.request("/api/profile/config", "PUT", { expectedDigest: configDigest(), edits: [{ path: ["harnesses"], value: ["codex"] }, { path: ["surfaces"], value: { codex: ["instructions", "skills"] } }, { path: ["groups"], value: { work: ["rules/review"] } }, { path: ["profile", "name"], value: "Changed" }, { path: ["scheduleDefault"], value: "weekly:Mon,Thu@09:00" }, { path: ["local"], value: { allow: ["instructions", "skills"], appendLocal: ["instructions"] } }, { path: ["mcp"], value: { docs: { transport: "streamable-http", url: "https://example.invalid/mcp" } } }, { path: ["settings"], value: { codex: { model_reasoning_effort: "high" } } }, { path: ["credentials"], value: { docs: { reference: "DOCS_TOKEN" } } }, { path: ["resources"], value: { notes: { kind: "file", target: "~/notes.txt", source: "files/notes.txt" } } }], changes: [{ path: "files/notes.txt", expectedDigest: null, files: [{ path: "files/notes.txt", base64: base64("Notes\n"), executable: false }] }] });
    expect(config.status, formatResult(config.value)).toBe(200);
    expect(readFileSync(join(machine.folder, "canonfig.jsonc"), "utf8")).toContain("// Keep the author comment");
    expect((await gui.request("/api/profile/config", "PUT", { expectedDigest: configDigest(), edits: [{ path: ["profile", "name"], value: "stale" }], changes: [] })).value).toMatchObject({ exitCode: 4 });
    snapshot = await gui.snapshot();
    const invalid = await gui.request("/api/profile/config", "PUT", { expectedDigest: configDigest(), edits: [{ path: ["resources", "notes", "target"], value: "~/.codex/auth.json" }], changes: [] });
    expect(invalid.value).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
    snapshot = await gui.snapshot();
    const moreCategories = await gui.request("/api/profile/config", "PUT", {
      expectedDigest: configDigest(),
      edits: [
        { path: ["tools", "uv"], value: { executable: "uv", recipes: [{ platform: "linux", method: "uv", package: "uv", version: "0.4.0" }] } },
        { path: ["hooks"], value: [{ id: "format", event: "after_tool", run: ["hooks/format.sh"], timeoutMs: 5000 }] },
        { path: ["resources", "directory"], value: { kind: "directory", target: "~/notes", source: "files/notes" } },
        { path: ["resources", "config"], value: { kind: "config", target: "~/example.json", format: "json", keys: { enabled: true } } },
      ],
      changes: [
        { path: "hooks/format.sh", expectedDigest: null, files: [{ path: "hooks/format.sh", base64: base64("#!/bin/sh\nexit 0\n"), executable: true }] },
        { path: "files/notes/readme.txt", expectedDigest: null, files: [{ path: "files/notes/readme.txt", base64: base64("Directory resource\n"), executable: false }] },
      ],
    });
    expect(moreCategories.status, JSON.stringify(moreCategories.value)).toBe(200);
    expect((await gui.request("/api/profile/scan", "POST", {})).status).toBe(200);
    const validation = await gui.request("/api/profile/validate", "POST", {}); expect(validation.value).toMatchObject({ valid: true });
    const started = await gui.request("/api/publications", "POST", { reviewer: "GUI test" }); expect(started.status).toBe(202);
    const ticket = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(started.value);
    let operation = Schema.decodeUnknownSync(GuiOperation)((await gui.request(`/api/operations/${ticket.id}`)).value);
    for (let attempt = 0; operation.state === "running" && attempt < 100; attempt++) operation = Schema.decodeUnknownSync(GuiOperation)((await gui.request(`/api/operations/${ticket.id}`)).value);
    expect(operation.state, formatResult(operation)).toBe("succeeded"); expect(operation.journal).not.toBeNull();
    const revisions = Schema.decodeUnknownSync(GuiRevisions)((await gui.request("/api/revisions")).value); expect(revisions.revisions).toHaveLength(1);
    expect((await gui.request("/api/revisions/inspect", "POST", { revision: revisions.revisions[0]!.id })).status).toBe(200);
    expect((await gui.request("/api/revisions/inspect", "POST", { revision: "missing" })).value).toHaveProperty("exitCode");
    snapshot = await gui.snapshot();
    const command = snapshot.items.find((item) => item.path === "commands/review.md")!;
    expect((await gui.request("/api/profile/items", "PUT", { changes: [{ path: command.path, expectedDigest: command.digest, files: [] }] })).status).toBe(200);
  }, 120_000);

  it("tracks, checks and updates skills through a real local Git upstream and refuses local edits", async () => {
    const machine = fixture(); expect(machine.invoke(["source", "init"]).status).toBe(0);
    writeFileSync(join(machine.folder, "canonfig.jsonc"), '{"version":1,"harnesses":[]}');
    const upstream = join(machine.home, "upstream"); mkdirSync(upstream);
    const git = (args: string[]) => { const result = spawnSync("git", args, { cwd: upstream, encoding: "utf8" }); expect(result.status, result.stderr).toBe(0); return result.stdout.trim(); };
    git(["init", "-b", "main"]);
    const original = "---\nname: review\ndescription: Review changes\n---\nReview.\n";
    writeFileSync(join(upstream, "SKILL.md"), original); git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"]);
    mkdirSync(join(machine.folder, "skills", "review"), { recursive: true }); writeFileSync(join(machine.folder, "skills", "review", "SKILL.md"), original);
    const gui = await server(machine.env);
    expect((await gui.operation("/api/skills/track", { name: "review", source: upstream, ref: "main", subdir: "." })).state).toBe("succeeded");
    expect(Schema.decodeUnknownSync(GuiSkills)((await gui.request("/api/skills")).value).skills).toHaveLength(1);
    writeFileSync(join(upstream, "SKILL.md"), `${original}Check tests.\n`); git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "update"]);
    expect((await gui.operation("/api/skills/check", { name: "review" })).result).toMatchObject([{ status: "update-available", changed: ["SKILL.md"] }]);
    expect((await gui.operation("/api/skills/update", { name: "review" })).state).toBe("succeeded");
    expect(readFileSync(join(machine.folder, "skills", "review", "SKILL.md"), "utf8")).toContain("Check tests");
    writeFileSync(join(machine.folder, "skills", "review", "SKILL.md"), `${original}Local edits.\n`);
    expect((await gui.operation("/api/skills/update", { name: "review" })).failure).toMatchObject({ category: "conflict-or-drift", exitCode: 4 });
    expect((await gui.operation("/api/skills/check", { name: "review" })).failure).toMatchObject({ category: "conflict-or-drift", exitCode: 4, message: "Local edits detected in review. Reconcile the local files before updating." });
    expect((await gui.operation("/api/skills/check", { name: "missing" })).failure).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  }, 120_000);

  it.runIf(process.platform !== "win32").each(["track", "update"] as const)(
    "owns %s Git work after request disconnect and waits for cleanup on shutdown", async (action) => {
      const machine = fixture();
      expect(machine.invoke(["source", "init"]).status).toBe(0);
      writeFileSync(join(machine.folder, "canonfig.jsonc"), '{"version":1,"harnesses":[]}');
      const upstream = join(machine.home, "upstream"); mkdirSync(upstream);
      const git = (args: string[]) => {
        const result = spawnSync("git", args, { cwd: upstream, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
      };
      git(["init", "-b", "main"]);
      const original = "---\nname: review\ndescription: Review changes\n---\nReview.\n";
      writeFileSync(join(upstream, "SKILL.md"), original);
      git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"]);
      mkdirSync(join(machine.folder, "skills/review"), { recursive: true });
      writeFileSync(join(machine.folder, "skills/review/SKILL.md"), original);
      const bin = join(machine.home, "bin"); mkdirSync(bin);
      const gui = await server({ ...machine.env, PATH: `${bin}:${machine.env.PATH}` });
      const tracking = { name: "review", source: upstream, ref: "main", subdir: "." };
      if (action === "update") {
        expect((await gui.operation("/api/skills/track", tracking)).state).toBe("succeeded");
        writeFileSync(join(upstream, "SKILL.md"), `${original}Updated.\n`);
        git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "update"]);
      }
      const connected = Promise.withResolvers<{ socket: Socket; directory: string }>();
      const gate = createServer((socket) => {
        socket.once("data", (bytes) => connected.resolve({ socket, directory: bytes.toString() }));
      });
      gate.listen(0, "127.0.0.1"); await once(gate, "listening");
      const address = gate.address();
      if (address === null || Schema.is(Schema.String)(address)) throw new Error("No gate address");
      const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      // This fixture delays, then runs the real Git binary. It does not replace
      // Git output or filesystem work with a mock.
      writeFileSync(join(bin, "git"), `#!${process.execPath}
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
function execute() {
  const child = spawn(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
}
if (args.includes("fetch")) {
  const socket = require("node:net").createConnection(${address.port}, "127.0.0.1", () => socket.write(process.cwd()));
  socket.on("end", execute);
  socket.resume();
} else execute();
`, { mode: 0o755 });
      let held: { socket: Socket; directory: string } | undefined;
      // A real subprocess watchdog releases the fixture even if a regression
      // prevents the HTTP response. TestClock cannot control that subprocess.
      const safetyRelease = setTimeout(() => { void connected.promise.then(({ socket }) => socket.end()); }, 10_000);
      try {
        const started = await gui.request(`/api/skills/${action}`, "POST", action === "track" ? tracking : { name: "review" });
        expect(started.status).toBe(202);
        const ticket = Schema.decodeUnknownSync(GuiOperationTicket)(started.value);
        held = await connected.promise;
        expect(existsSync(held.directory)).toBe(true);
        const polled = await gui.request(`/api/operations/${ticket.id}`);
        expect(polled.value).toMatchObject({ state: "running", journal: null });
        // The initiating response has closed; no request owns this Git process.
        expect((await gui.request("/api/self-update/disable", "POST", {})).status).toBe(409);
        const exited = once(gui.child, "exit");
        gui.child.kill("SIGTERM");
        // Wait until the server has stopped accepting HTTP, rather than guessing
        // when its shutdown finalizer starts.
        await expect.poll(async () => {
          try { await gui.request("/api/session"); return false; } catch { return true; }
        }).toBe(true);
        expect(gui.child.exitCode).toBeNull();
        expect(gui.child.signalCode).toBeNull();
        held.socket.end();
        const [code, signal] = await exited;
        expect(signal).toBeNull(); expect(code).toBe(143);
        expect(existsSync(held.directory)).toBe(false);
        if (action === "track") expect(readFileSync(join(machine.folder, "skills-sources.json"), "utf8")).toContain("review");
        else expect(readFileSync(join(machine.folder, "skills/review/SKILL.md"), "utf8")).toContain("Updated.");
      } finally {
        clearTimeout(safetyRelease);
        held?.socket.end();
        gate.close();
      }
    }, 60_000,
  );

  it("refuses every profile operation without the Source role", async () => {
    const machine = fixture(); const gui = await server(machine.env);
    for (const path of ["/api/profile/items", "/api/revisions", "/api/skills"]) expect((await gui.request(path)).value).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
    for (const [path, method, body] of [
      ["/api/profile/items", "PUT", { changes: [] }], ["/api/profile/config", "PUT", { expectedDigest: null, edits: [], changes: [] }], ["/api/profile/scan", "POST", {}], ["/api/profile/validate", "POST", {}], ["/api/publications", "POST", { reviewer: "reviewer" }], ["/api/revisions/inspect", "POST", { revision: "missing" }], ["/api/skills/track", "POST", { name: "review", source: "/missing", ref: "main", subdir: "." }], ["/api/skills/check", "POST", { name: "review" }], ["/api/skills/update", "POST", { name: "review" }],
    ] as const) expect((await gui.request(path, method, body)).value).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  }, 60_000);
});
function formatResult(value: unknown) { return JSON.stringify(value); }
