import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { withRunLock } from "../../src/synchronization/run-lock.ts";
import { GuiOperation } from "../../src/gui/contract/operations.ts";
import { GuiSetupJournal, GuiSetupStatus } from "../../src/gui/contract/enrollment.ts";

const entry = resolve(import.meta.dirname, "../../src/runtime/main.ts");
const homes: string[] = [];
const children = new Set<ChildProcess>();
const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-gui-enrollment-"));
  homes.push(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".state"), CANONFIG_LOCAL_CREDENTIAL_ROOT: join(home, "credentials"), CANONFIG_LOG: "off" };
  return { home, env, invoke: (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", entry, "--json", ...args], { env, encoding: "utf8", timeout: 30_000 }) };
};

async function start(env: NodeJS.ProcessEnv, args = ["ui", "--no-open"]) {
  const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const { promise, resolve: ready, reject } = Promise.withResolvers<string>();
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    const match = output.match(args[0] === "ui" ? /http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/u : /https:\/\/127\.0\.0\.1:\d+/u);
    if (match) ready(match[0]);
  });
  child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  child.once("error", reject);
  child.once("exit", (code) => reject(new Error(`Server exited ${code}: ${errors}`)));
  const deadline = setTimeout(() => reject(new Error(`Server did not start: ${errors}`)), 30_000);
  try { return { child, url: await promise }; } finally { clearTimeout(deadline); }
}
async function gui(env: NodeJS.ProcessEnv) {
  const server = await start(env);
  const origin = new URL(server.url).origin;
  const exchange = await fetch(server.url, { redirect: "manual" });
  const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Session cookie missing");
  return {
    ...server,
    async request(path: string, body?: unknown) {
      const response = await fetch(`${origin}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "x-canonfig-request": "browser" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    },
  };
}
interface GuiTestServer {
  request(path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
}
async function finish(server: GuiTestServer, ticket: { id: string }, pollStatus?: () => Promise<void>) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const [response] = await Promise.all([server.request(`/api/operations/${ticket.id}`), pollStatus?.()]);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const operation = Schema.decodeUnknownSync(GuiOperation)(response.body);
    if (operation.state !== "running") return operation;
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
  throw new Error("Operation did not finish");
}
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped; }
  }
  children.clear();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("real enrollment and setup endpoints", () => {
  it("explains the preserved 7.1.0 setup journal shape in both clients without changing it", async () => {
    const machine = fixture();
    mkdirSync(join(machine.home, ".codex"), { recursive: true });
    writeFileSync(join(machine.home, ".codex", "AGENTS.md"), "Keep these instructions.\n");
    const server = await gui(machine.env);
    const input = { role: "source", scope: "full", mode: "simple", files: [], harnesses: ["codex"], imports: { kind: "offer" } };
    const planned = await server.request("/api/setup/plan", input);
    expect(planned.status).toBe(200);
    const journal = Schema.decodeUnknownSync(GuiSetupJournal)(planned.body);
    if (!journal.imports) throw new Error("Source plan did not contain an import review");
    // The preserved 7.1.0 repro has only request, offered and present, with four fields per offer.
    const legacy = JSON.stringify({ ...journal, schema: "canonfig.setup/v2", imports: {
      request: "offer", present: [], offered: journal.imports.offered.map(({ id, target, secrets, notes }) => ({ id, target, secrets, notes })),
    } });
    const path = join(machine.home, ".canonfig", "setup.json");
    writeFileSync(path, legacy);
    for (const [endpoint, body] of [["/api/setup", undefined], ["/api/setup/plan", input]] as const) {
      const response = await server.request(endpoint, body);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ category: "human-action-required", exitCode: 3 });
      expect(response.body.message).toContain(`The setup journal at ${path} was written by an earlier Canonfig`);
      expect(response.body.message).toContain("move it aside and start setup again");
      expect(readFileSync(path, "utf8")).toBe(legacy);
    }
    const cli = machine.invoke(["setup", "status"]);
    expect(cli.status).toBe(3);
    expect(cli.stderr).toContain("was written by an earlier Canonfig");
    expect(cli.stderr).toContain("move it aside and start setup again");
    expect(readFileSync(path, "utf8")).toBe(legacy);
  }, 60_000);

  it("carries structured skips and collisions with home-relative source paths", async () => {
    const machine = fixture();
    for (const harness of [".codex", ".claude"]) mkdirSync(join(machine.home, harness), { recursive: true });
    writeFileSync(join(machine.home, ".codex", "AGENTS.md"), "Codex instructions.\n");
    writeFileSync(join(machine.home, ".claude", "CLAUDE.md"), "Claude instructions.\n");
    mkdirSync(join(machine.home, ".claude", "skills", "unfinished"), { recursive: true });
    for (const root of [".canonfig", ".claude"]) {
      mkdirSync(join(machine.home, root, "skills", "held"), { recursive: true });
      writeFileSync(join(machine.home, root, "skills", "held", "SKILL.md"), `---\nname: held\ndescription: ${root} copy\n---\n${root}\n`);
    }
    const server = await gui(machine.env);
    const plan = await server.request("/api/setup/plan", {
      role: "source", scope: "full", mode: "simple", files: [],
      harnesses: ["codex", "claude-code"], imports: { kind: "offer" },
    });
    expect(plan.status).toBe(200);
    expect(plan.body.imports.offered).toContainEqual(expect.objectContaining({
      id: "codex/instructions/AGENTS.md", source: "codex", category: "instructions",
      name: "AGENTS.md", path: "~/.codex/AGENTS.md",
    }));
    expect(plan.body.imports.skipped).toContainEqual({
      source: "claude-code", path: "~/.claude/skills/unfinished", reason: "Missing SKILL.md. Add a SKILL.md file with a name and description to import this skill.",
    });
    expect(plan.body.imports.collisions).toContainEqual({
      kind: "candidates", target: "AGENTS.md", candidates: [
        { id: "claude-code/instructions/AGENTS.md", source: "claude-code", path: "~/.claude/CLAUDE.md" },
        { id: "codex/instructions/AGENTS.md", source: "codex", path: "~/.codex/AGENTS.md" },
      ],
    });
    expect(plan.body.imports.collisions).toContainEqual({
      kind: "folder", target: "skills/held", candidates: [
        { id: "claude-code/skills/held", source: "claude-code", path: "~/.claude/skills/held" },
      ],
    });
    expect(JSON.stringify(plan.body.imports)).not.toContain(machine.home);
    expect(JSON.stringify(plan.body)).not.toContain("import skipped:");
    expect(JSON.stringify(plan.body)).not.toContain("--import");
  }, 60_000);

  it("refuses CLI setup writers while another process owns the setup journal lock", async () => {
    const machine = fixture();
    const planned = machine.invoke(["setup", "plan", "--role", "follower", "--scope", "cli-only"]);
    expect(planned.status, planned.stdout + planned.stderr).toBe(0);
    const journalPath = join(machine.home, ".canonfig", "setup.json");
    const original = readFileSync(journalPath, "utf8");
    await Effect.runPromise(withRunLock(journalPath, "test setup journal owner", Effect.sync(() => {
      for (const args of [
        ["setup", "approve", "--approver", "reviewer"],
        ["setup", "apply"],
        ["setup", "plan", "--role", "follower", "--scope", "cli-only", "--intent", "different"],
      ]) {
        const result = machine.invoke(args);
        expect(result.status, result.stdout + result.stderr).toBe(4);
        expect(readFileSync(journalPath, "utf8")).toBe(original);
      }
    })));
  }, 60_000);

  it("rejects role-invalid and malformed requests with CLI categories and exit codes", async () => {
    const machine = fixture();
    const server = await gui(machine.env);
    for (const [path, input] of [["/api/machines", undefined], ["/api/enrollment", undefined], ["/api/invitations", { endpoint: "https://127.0.0.1:7341", groups: [], expiresInMilliseconds: 1000 }], ["/api/machines/revoke", { follower: "missing" }]] as const) {
      const response = await server.request(path, input);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
    }
    for (const envelope of ["not-an-invitation", "e30=\n", "e30\nCANONFIG_INVITATION_EOF\n"]) {
      const response = await server.request("/api/enrollment/inspect", { envelope });
      expect(response.body).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
      expect(response.body.message).not.toContain(envelope);
    }
    const unknown = await server.request("/api/setup/approve", { approver: "reviewer", planDigest: "stale", extra: true });
    expect(unknown.body).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  }, 60_000);

  it("lists real import offers, requires approval, detects stale review and applies the real setup journal", async () => {
    const machine = fixture();
    mkdirSync(join(machine.home, ".codex"), { recursive: true });
    writeFileSync(join(machine.home, ".codex", "AGENTS.md"), "Keep this real instruction.\n");
    const server = await gui(machine.env);
    expect((await server.request("/api/setup")).body).toMatchObject({ stage: "role", approved: false });
    const input = { role: "source", scope: "full", mode: "simple", files: [], harnesses: ["codex"], imports: { kind: "offer" } };
    const plan = await server.request("/api/setup/plan", input);
    expect(plan.status).toBe(200);
    expect(plan.body.imports.offered.length).toBeGreaterThan(0);
    const refused = await server.request("/api/setup/apply", { planDigest: plan.body.planDigest });
    expect(refused.status, JSON.stringify(refused.body)).toBe(202);
    const refusal = await finish(server, refused.body);
    expect(refusal).toMatchObject({ state: "failed", failure: { category: "human-action-required", exitCode: 3 } });
    const selected = plan.body.imports.offered.map((offer: { id: string }) => offer.id);
    const revised = await server.request("/api/setup/plan", { ...input, imports: { kind: "some", requested: selected } });
    expect(revised.body.planDigest).not.toBe(plan.body.planDigest);
    expect((await server.request("/api/setup/approve", { approver: "reviewer", planDigest: plan.body.planDigest })).body).toMatchObject({ category: "conflict-or-drift", exitCode: 4 });
    const staleApply = await server.request("/api/setup/apply", { planDigest: plan.body.planDigest });
    expect(staleApply.status).toBe(202);
    expect(await finish(server, staleApply.body)).toMatchObject({
      state: "failed", failure: { category: "conflict-or-drift", exitCode: 4 },
    });
    expect((await server.request("/api/setup/approve", { approver: "reviewer", planDigest: revised.body.planDigest })).body.approvals).toEqual(expect.arrayContaining([expect.objectContaining({ approver: "reviewer", digest: revised.body.planDigest })]));
    const apply = await server.request("/api/setup/apply", { planDigest: revised.body.planDigest });
    expect(apply.status).toBe(202);
    let statusPolls = 0;
    const completed = await finish(server, apply.body, async () => {
      const response = await server.request("/api/setup");
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(Schema.decodeUnknownSync(GuiSetupStatus)(response.body).planDigest).toBe(revised.body.planDigest);
      statusPolls++;
    });
    expect(statusPolls).toBeGreaterThan(0);
    expect(completed.state, JSON.stringify(completed)).toBe("succeeded");
    expect(completed.journal).toMatchObject({ planDigest: revised.body.planDigest });
    expect(readFileSync(join(machine.home, ".canonfig", "AGENTS.md"), "utf8")).toBe("Keep this real instruction.\n");
    expect((await server.request("/api/session")).body.role).toBe("source");
    expect((await server.request("/api/setup/plan", { ...input, role: "follower" })).body).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  }, 120_000);

  it("downloads a real invitation, enrolls a follower, protects sibling inventory and revokes access", async () => {
    const source = fixture();
    const initialized = source.invoke(["source", "init"]);
    expect(initialized.status, initialized.stderr).toBe(0);
    writeFileSync(join(source.home, ".canonfig", "canonfig.jsonc"), JSON.stringify({ version: 1, profile: { id: "test", name: "Test" }, harnesses: [], groups: {} }));
    const published = source.invoke(["source", "publish", "--reviewer", "test"]);
    expect(published.status, published.stdout + published.stderr).toBe(0);
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const address = listener.address();
    if (address === null || typeof address === "string") throw new Error("No TCP port");
    const port = address.port;
    listener.close();
    await once(listener, "close");
    const serving = await start(source.env, ["source", "serve", "--port", String(port)]);
    const sourceGui = await gui(source.env);
    const invitation = await sourceGui.request("/api/invitations", { endpoint: serving.url, groups: [], expiresInMilliseconds: 3_600_000 });
    expect(invitation.status, JSON.stringify(invitation.body)).toBe(200);
    expect(invitation.body.envelope).toContain("\n");
    const inventory = await sourceGui.request("/api/machines");
    expect(inventory.body.invitations).toEqual([expect.objectContaining({ endpoint: serving.url, consumed: false })]);
    expect(JSON.stringify(inventory.body)).not.toMatch(/codeDigest|nonce|credentialReference/);
    const target = fixture();
    const targetGui = await gui(target.env);
    const inspection = await targetGui.request("/api/enrollment/inspect", { envelope: invitation.body.envelope });
    expect(inspection.status).toBe(200);
    expect(inspection.body).toMatchObject({ endpoint: serving.url, groups: [] });
    expect(JSON.stringify(inspection.body)).not.toMatch(/"code"|"nonce"/);
    const tunnelRefusal = await targetGui.request("/api/enrollment/tunnel", {
      envelope: invitation.body.envelope, sshHost: "127.0.0.1", sshUser: "test",
      sshPort: 22, sshHostKeyPath: join(target.home, "missing-host-key"),
      localPort: 17342, trustConfirmed: false,
    });
    expect(tunnelRefusal.body).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
    const joinTicket = await targetGui.request("/api/enrollment", { envelope: invitation.body.envelope, followerName: "Real follower", replace: false });
    expect(joinTicket.status).toBe(202);
    const enrolled = await finish(targetGui, joinTicket.body);
    expect(enrolled.state, JSON.stringify(enrolled)).toBe("succeeded");
    const own = await targetGui.request("/api/enrollment");
    expect(own.body.follower.name).toBe("Real follower");
    expect((await targetGui.request("/api/machines")).body).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
    expect((await sourceGui.request("/api/enrollment/inspect", { envelope: invitation.body.envelope })).body).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
    const listed = await sourceGui.request("/api/machines");
    expect(listed.body.followers).toEqual([expect.objectContaining({ name: "Real follower", revoked: false, pending: false, credentialPresent: true })]);
    const revoked = await sourceGui.request("/api/machines/revoke", { follower: own.body.follower.id });
    expect(revoked.body).toMatchObject({ revoked: true });
    expect((await sourceGui.request("/api/machines")).body.followers[0].revoked).toBe(true);
    const replacement = await sourceGui.request("/api/invitations", { endpoint: serving.url, groups: [], expiresInMilliseconds: 3_600_000 });
    const replacementRequest = { envelope: replacement.body.envelope, followerName: "Replacement follower", replace: false };
    const noConsent = await targetGui.request("/api/enrollment", replacementRequest);
    expect(await finish(targetGui, noConsent.body)).toMatchObject({ state: "failed", failure: { category: "conflict-or-drift", exitCode: 4 } });
    const replacing = await targetGui.request("/api/enrollment", { ...replacementRequest, replace: true });
    const replaced = await finish(targetGui, replacing.body);
    expect(replaced.state, JSON.stringify(replaced)).toBe("succeeded");
    expect((await targetGui.request("/api/enrollment")).body.follower.name).toBe("Replacement follower");
  }, 120_000);
});
