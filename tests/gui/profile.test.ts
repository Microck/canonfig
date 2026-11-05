import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { GuiProfileSnapshot, GuiRevisions, GuiSkills } from "../../src/gui/contract/profile.ts";
import { GuiOperation } from "../../src/gui/contract/operations.ts";

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
  return { request, snapshot };
}
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("profile GUI endpoints", () => {
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
    expect((await gui.request("/api/skills/track", "POST", { name: "review", source: upstream, ref: "main", subdir: "." })).status).toBe(200);
    expect(Schema.decodeUnknownSync(GuiSkills)((await gui.request("/api/skills")).value).skills).toHaveLength(1);
    writeFileSync(join(upstream, "SKILL.md"), `${original}Check tests.\n`); git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "update"]);
    expect((await gui.request("/api/skills/check", "POST", { name: "review" })).value).toMatchObject([{ status: "update-available", changed: ["SKILL.md"] }]);
    expect((await gui.request("/api/skills/update", "POST", { name: "review" })).status).toBe(200);
    expect(readFileSync(join(machine.folder, "skills", "review", "SKILL.md"), "utf8")).toContain("Check tests");
    writeFileSync(join(machine.folder, "skills", "review", "SKILL.md"), `${original}Local edits.\n`);
    expect((await gui.request("/api/skills/update", "POST", { name: "review" })).value).toMatchObject({ category: "conflict-or-drift", exitCode: 4 });
    expect((await gui.request("/api/skills/check", "POST", { name: "missing" })).value).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  }, 120_000);

  it("refuses every profile operation without the Source role", async () => {
    const machine = fixture(); const gui = await server(machine.env);
    for (const path of ["/api/profile/items", "/api/revisions", "/api/skills"]) expect((await gui.request(path)).value).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
    for (const [path, method, body] of [
      ["/api/profile/items", "PUT", { changes: [] }], ["/api/profile/config", "PUT", { expectedDigest: null, edits: [], changes: [] }], ["/api/profile/scan", "POST", {}], ["/api/profile/validate", "POST", {}], ["/api/publications", "POST", { reviewer: "reviewer" }], ["/api/revisions/inspect", "POST", { revision: "missing" }], ["/api/skills/track", "POST", { name: "review", source: "/missing", ref: "main", subdir: "." }], ["/api/skills/check", "POST", { name: "review" }], ["/api/skills/update", "POST", { name: "review" }],
    ] as const) expect((await gui.request(path, method, body)).value).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  }, 60_000);
});
function formatResult(value: unknown) { return JSON.stringify(value); }
