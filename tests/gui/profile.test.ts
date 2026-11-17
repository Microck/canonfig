import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { GuiProfileFile, GuiProfileSnapshot, GuiRevisions, GuiSkills, GuiSkillChecks, type GuiSkillCheck } from "../../src/gui/contract/profile.ts";
import { GuiLocalChange } from "../../src/gui/contract/synchronization.ts";
import { GuiOperation, GuiOperationTicket } from "../../src/gui/contract/operations.ts";

const entry = resolve("src/runtime/main.ts");
const homes: string[] = [];
const children: ChildProcess[] = [];
const base64 = (value: string) => Buffer.from(value).toString("base64");
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "canonfig-profile-")); homes.push(home);
  const folder = join(home, ".canonfig");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".state"), CANONFIG_LOCAL_CREDENTIAL_ROOT: join(home, "credentials"), CANONFIG_LOG: "off" };
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
  const preview = async (names: readonly string[]) => Schema.decodeUnknownSync(GuiSkillChecks)((await operation("/api/skills/check", { names })).result);
  const updateInput = (checks: readonly GuiSkillCheck[]) => ({ expected: checks.map(({ name, path, previousCommit, nextCommit, previousDigest, nextDigest }) => ({ name, path, previousCommit, nextCommit, previousDigest, nextDigest })) });
  const update = (checks: readonly GuiSkillCheck[]) => operation("/api/skills/update", updateInput(checks));
  return { request, snapshot, operation, preview, update, updateInput, child };
}
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("authoring base64 contracts", () => {
  it.each([4, 64])("accepts a %i MiB file through canonical and local schemas", (size) => {
    const encoded = Buffer.alloc(size * 1024 * 1024, 0xff).toString("base64");
    const file = { path: "skills/large/asset.bin", base64: encoded, executable: false };
    expect(Schema.is(GuiProfileFile)(file)).toBe(true);
    expect(Schema.is(GuiLocalChange)({ path: "skills/large", expectedDigest: null, files: [file] })).toBe(true);
  });
  it.each(["", "Zg==", "Zm8=", "Zm9v", "/+8="])("accepts valid base64 %j", (base64) => {
    const file = { path: "AGENTS.md", base64, executable: false };
    expect(Schema.is(GuiProfileFile)(file)).toBe(true);
    expect(Schema.is(GuiLocalChange)({ path: file.path, expectedDigest: null, files: [file] })).toBe(true);
  });
  it.each(["A", "AAA", "A===", "====", "=AAA", "AA=A", "AA==AAAA", "AA-_", "AA A", "AAAA\n"])("refuses malformed base64 %j", (base64) => {
    const file = { path: "AGENTS.md", base64, executable: false };
    expect(Schema.is(GuiProfileFile)(file)).toBe(false);
    expect(Schema.is(GuiLocalChange)({ path: file.path, expectedDigest: null, files: [file] })).toBe(false);
  });
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

  it("accepts only the reviewed scan with explicit all-tools consent and leaves it unpublished", async () => {
    const machine = fixture();
    // Keep executable resolution independent of installed tools on the test host.
    machine.env.PATH = machine.home;
    expect(machine.invoke(["source", "init"]).status).toBe(0);
    const configPath = join(machine.folder, "canonfig.jsonc");
    const original = '// Keep this comment\n{"version":1,"harnesses":[]}';
    writeFileSync(configPath, original);
    writeFileSync(join(machine.folder, "AGENTS.md"), "```sh\nuv tool install ruff==0.6.9\n```\n");
    const gui = await server(machine.env);
    const scan = async () => Schema.decodeUnknownSync(Schema.Struct({ reviewDigest: Schema.String, written: Schema.Array(Schema.String) }))((await gui.request("/api/profile/scan", "POST", {})).value);
    const reviewed = await scan();
    expect(reviewed.written).toEqual([]);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    for (const body of [{}, { reviewDigest: reviewed.reviewDigest, confirmAll: false }, { reviewDigest: reviewed.reviewDigest, confirmAll: true, tools: ["ruff"] }]) {
      expect((await gui.request("/api/profile/scan/accept", "POST", body)).value).toMatchObject({ exitCode: 2 });
    }
    writeFileSync(join(machine.folder, "AGENTS.md"), "```sh\nuv tool install ruff==0.6.9\nuv tool install black==24.8.0\n```\n");
    const stale = await gui.request("/api/profile/scan/accept", "POST", { reviewDigest: reviewed.reviewDigest, confirmAll: true });
    expect(stale.value).toMatchObject({ exitCode: 2, message: expect.stringContaining("Scan again") });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    const current = await scan();
    const accepted = await gui.request("/api/profile/scan/accept", "POST", { reviewDigest: current.reviewDigest, confirmAll: true });
    expect(accepted.status, JSON.stringify(accepted.value)).toBe(200);
    expect(accepted.value).toMatchObject({ written: ["black", "ruff"] });
    expect(readFileSync(configPath, "utf8")).toContain("// Keep this comment");
    expect((await gui.snapshot()).config.tools).toHaveProperty("ruff");
    expect((await gui.request("/api/revisions")).value).toEqual({ revisions: [] });
    const afterWrite = readFileSync(configPath, "utf8");
    const repeated = await scan();
    expect((await gui.request("/api/profile/scan/accept", "POST", { reviewDigest: repeated.reviewDigest, confirmAll: true })).value).toMatchObject({ written: [], declared: ["black", "ruff"] });
    expect(readFileSync(configPath, "utf8")).toBe(afterWrite);
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
    const first = revisions.revisions[0]!;
    expect(first.approval).toMatchObject({ reviewer: "GUI test", revision: first.id, revisionDigest: first.digest });
    expect(first.resourceChanges.previousRevision).toBeNull();
    expect(first.resourceChanges.added).toContain("instructions");
    const inspected = await gui.request("/api/revisions/inspect", "POST", { revision: first.id });
    expect(inspected.status).toBe(200);
    expect(inspected.value).toMatchObject({ id: first.id, profileId: first.profileId, canonicalBytes: expect.any(String), signature: expect.any(String), resources: expect.any(Array), groups: expect.any(Array), approval: first.approval });
    const instructions = (await gui.snapshot()).items.find((item) => item.path === "AGENTS.md")!;
    expect((await put("AGENTS.md", "# Instructions\nReview exact revision IDs.\n", instructions.digest)).status).toBe(200);
    expect((await gui.operation("/api/publications", { reviewer: "Second reviewer" })).state).toBe("succeeded");
    const history = Schema.decodeUnknownSync(GuiRevisions)((await gui.request("/api/revisions")).value).revisions;
    expect(history).toHaveLength(2);
    const second = history.find((revision) => revision.id !== first.id)!;
    expect(second.approval?.reviewer).toBe("Second reviewer");
    expect(second.resourceChanges).toEqual({ previousRevision: first.id, added: [], changed: ["instructions"], removed: [] });
    expect((await gui.request("/api/revisions/inspect", "POST", { revision: first.id })).value).toMatchObject({ id: first.id, approval: { reviewer: "GUI test" } });
    const absent = await gui.request("/api/revisions/inspect", "POST", { revision: "missing" });
    expect(absent.status).toBe(200);
    expect(absent.value).toBeNull();
    expect((await gui.request("/api/revisions/inspect", "POST", { revision: "" })).value).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
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
    const reviewed = await gui.preview(["review"]);
    expect(reviewed).toMatchObject([{ status: "update-available", changed: ["SKILL.md"] }]);
    expect((await gui.update(reviewed)).state).toBe("succeeded");
    expect(readFileSync(join(machine.folder, "skills", "review", "SKILL.md"), "utf8")).toContain("Check tests");
    writeFileSync(join(machine.folder, "skills", "review", "SKILL.md"), `${original}Local edits.\n`);
    expect((await gui.update(await gui.preview(["review"]))).failure).toMatchObject({ category: "conflict-or-drift", exitCode: 4 });
    expect((await gui.operation("/api/skills/check", { names: ["review"] })).result).toMatchObject([{ name: "review", status: "local-edits" }]);
    expect((await gui.operation("/api/skills/check", { names: ["missing"] })).failure).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  }, 120_000);

  it("previews all or selected skills and refuses the whole batch when one skill has local edits", async () => {
    const machine = fixture();
    expect(machine.invoke(["source", "init"]).status).toBe(0);
    writeFileSync(join(machine.folder, "canonfig.jsonc"), '{"version":1,"harnesses":[]}');
    const upstream = join(machine.home, "upstream"); mkdirSync(upstream);
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: upstream, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    };
    git(["init", "-b", "main"]);
    const names = ["review", "testing", "pinned"];
    for (const name of names) {
      const text = `---\nname: ${name}\ndescription: ${name} skill\n---\nOriginal.\n`;
      mkdirSync(join(upstream, name));
      writeFileSync(join(upstream, name, "SKILL.md"), text);
      mkdirSync(join(machine.folder, "skills", name), { recursive: true });
      writeFileSync(join(machine.folder, "skills", name, "SKILL.md"), text);
    }
    git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"]);
    const gui = await server(machine.env);
    for (const name of names) expect((await gui.operation("/api/skills/track", { name, source: upstream, ref: "main", subdir: name })).state).toBe("succeeded");
    const baseline = readFileSync(join(machine.folder, "skills-sources.json"), "utf8");
    for (const name of ["review", "testing"]) writeFileSync(join(upstream, name, "reference.txt"), "New reference\n");
    git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "upstream updates"]);
    const all = await gui.operation("/api/skills/check", { names: [] });
    expect(all.result).toMatchObject([
      { name: "review", status: "update-available", added: ["reference.txt"] },
      { name: "testing", status: "update-available", added: ["reference.txt"] },
      { name: "pinned", status: "unchanged" },
    ]);
    expect(readFileSync(join(machine.folder, "skills-sources.json"), "utf8")).toBe(baseline);
    expect(existsSync(join(machine.folder, "skills/review/reference.txt"))).toBe(false);
    writeFileSync(join(machine.folder, "skills/testing/local.txt"), "Keep my local file\n");
    const reviewed = await gui.preview(["review", "testing"]);
    expect(reviewed).toMatchObject([
      { name: "review", status: "update-available" }, { name: "testing", status: "local-edits" },
    ]);
    const refused = await gui.update(reviewed);
    expect(refused.failure).toMatchObject({ category: "conflict-or-drift", exitCode: 4 });
    expect(readFileSync(join(machine.folder, "skills-sources.json"), "utf8")).toBe(baseline);
    expect(existsSync(join(machine.folder, "skills/review/reference.txt"))).toBe(false);
    expect(readFileSync(join(machine.folder, "skills/testing/local.txt"), "utf8")).toBe("Keep my local file\n");
    rmSync(join(machine.folder, "skills/testing/local.txt"));
    expect((await gui.update(reviewed)).state).toBe("succeeded");
    for (const name of ["review", "testing"]) expect(readFileSync(join(machine.folder, "skills", name, "reference.txt"), "utf8")).toBe("New reference\n");
    expect((await gui.operation("/api/skills/check", { names: [] })).result).toMatchObject(names.map((name) => ({ name, status: "unchanged" })));
    expect(Schema.decodeUnknownSync(GuiRevisions)((await gui.request("/api/revisions")).value).revisions).toHaveLength(0);
    for (const body of [{}, { name: "review" }, { names: [] }, { expected: [] }, { names: [""] }, { names: ["review"], force: true }]) {
      expect((await gui.request("/api/skills/update", "POST", body)).value).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
    }
  }, 120_000);

  it("rejects a stale reviewed commit before replacing any skill and never adds later registrations to apply", async () => {
    const machine = fixture();
    expect(machine.invoke(["source", "init"]).status).toBe(0);
    writeFileSync(join(machine.folder, "canonfig.jsonc"), '{"version":1,"harnesses":[]}');
    const upstream = join(machine.home, "upstream"); mkdirSync(upstream);
    const git = (args: string[]) => {
      const command = spawnSync("git", args, { cwd: upstream, encoding: "utf8" });
      expect(command.status, command.stderr).toBe(0);
    };
    const commit = () => { git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture update"]); };
    git(["init", "-b", "main"]);
    for (const name of ["review", "testing", "later"]) {
      const text = `---\nname: ${name}\ndescription: ${name} skill\n---\nOriginal.\n`;
      mkdirSync(join(upstream, name)); writeFileSync(join(upstream, name, "SKILL.md"), text);
      mkdirSync(join(machine.folder, "skills", name), { recursive: true });
      writeFileSync(join(machine.folder, "skills", name, "SKILL.md"), text);
    }
    commit();
    const gui = await server(machine.env);
    for (const name of ["review", "testing"]) expect((await gui.operation("/api/skills/track", { name, source: upstream, ref: "main", subdir: name })).state).toBe("succeeded");
    for (const name of ["review", "testing"]) writeFileSync(join(upstream, name, "reference.txt"), "Reviewed reference\n");
    commit();
    const reviewed = await gui.preview([]);
    expect(reviewed.map(({ name }) => name)).toEqual(["review", "testing"]);
    expect((await gui.operation("/api/skills/track", { name: "later", source: upstream, ref: "main", subdir: "later" })).state).toBe("succeeded");
    const config = readFileSync(join(machine.folder, "skills-sources.json"), "utf8");
    writeFileSync(join(upstream, "testing", "reference.txt"), "Unreviewed reference\n");
    writeFileSync(join(upstream, "later", "reference.txt"), "Not selected\n"); commit();
    expect((await gui.update(reviewed)).failure).toMatchObject({
      category: "conflict-or-drift", exitCode: 4,
      message: "The preview is out of date. Check for updates again.",
    });
    for (const name of ["review", "testing", "later"]) expect(existsSync(join(machine.folder, "skills", name, "reference.txt"))).toBe(false);
    expect(readFileSync(join(machine.folder, "skills-sources.json"), "utf8")).toBe(config);
    expect(existsSync(join(machine.folder, "skills-sources.json.pending"))).toBe(false);
    const fresh = await gui.preview(["review", "testing"]);
    const changedBaseline = fresh.map((check, index) => index === 0 ? { ...check, previousDigest: "0".repeat(64) } : check);
    expect((await gui.update(changedBaseline)).failure).toMatchObject({ category: "conflict-or-drift", exitCode: 4 });
    expect((await gui.update(fresh)).state).toBe("succeeded");
    expect(readFileSync(join(machine.folder, "skills/review/reference.txt"), "utf8")).toBe("Reviewed reference\n");
    expect(readFileSync(join(machine.folder, "skills/testing/reference.txt"), "utf8")).toBe("Unreviewed reference\n");
    expect(existsSync(join(machine.folder, "skills/later/reference.txt"))).toBe(false);
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
      const reviewed = action === "update" ? await gui.preview(["review"]) : [];
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
        const started = await gui.request(`/api/skills/${action}`, "POST", action === "track" ? tracking : gui.updateInput(reviewed));
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
    expect((await gui.request("/api/profile/scan/accept", "POST", { reviewDigest: "reviewed", confirmAll: true })).value).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
    for (const [path, method, body] of [
      ["/api/profile/items", "PUT", { changes: [] }], ["/api/profile/config", "PUT", { expectedDigest: null, edits: [], changes: [] }], ["/api/profile/scan", "POST", {}], ["/api/profile/validate", "POST", {}], ["/api/publications", "POST", { reviewer: "reviewer" }], ["/api/revisions/inspect", "POST", { revision: "missing" }], ["/api/skills/track", "POST", { name: "review", source: "/missing", ref: "main", subdir: "." }], ["/api/skills/check", "POST", { names: [] }], ["/api/skills/update", "POST", { expected: [{ name: "review", path: "skills/review", previousCommit: "a", nextCommit: "b", previousDigest: "c", nextDigest: "d" }] }],
    ] as const) expect((await gui.request(path, method, body)).value).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  }, 60_000);
});
function formatResult(value: unknown) { return JSON.stringify(value); }
