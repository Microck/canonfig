import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer as createPortListener } from "node:net";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { createGuiSelfUpdateFixture, candidate, previous, type GuiSelfUpdateFixture } from "../gui/self-update-fixture.ts";
import { GuiOperation, GuiOperationTicket } from "../../src/gui/contract/operations.ts";
import { GuiSelfUpdateCheck, GuiSelfUpdateProgress, GuiSelfUpdateStatus } from "../../src/gui/contract/administration.ts";
import { GuiError } from "../../src/gui/contract/session.ts";
import { updateDirectory } from "../../src/runtime/self-update/coordination.ts";

const machines: GuiSelfUpdateFixture[] = [];
const children = new Set<ChildProcess>();
interface GuiServer {
  readonly child: ChildProcess;
  readonly origin: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly api: (path: string, body?: Schema.Json) => Promise<{ status: number; body: unknown }>;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

async function fixture() {
  const machine = await createGuiSelfUpdateFixture({ holdDownload: true });
  machines.push(machine);
  return machine;
}

async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  children.delete(child);
}

afterEach(async () => {
  for (const machine of machines) machine.allowDownload();
  for (const child of children) await stop(child);
  for (const machine of machines.splice(0)) await machine.cleanup();
});

async function start(machine: GuiSelfUpdateFixture): Promise<GuiServer> {
  const child = spawn(process.execPath, [machine.entry, "ui", "--no-open"], {
    env: machine.env, stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const ready = Promise.withResolvers<string>();
  const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    const launch = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/u);
    if (launch) ready.resolve(launch[0]);
  });
  child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  child.once("error", ready.reject);
  child.once("exit", (code, signal) => {
    exited.resolve({ code, signal });
    ready.reject(new Error(`GUI exited ${code}: ${errors}`));
  });
  // The child is a separate Node process, so the deadline guards a missing
  // readiness event rather than advancing application time.
  const deadline = setTimeout(() => ready.reject(new Error(`GUI did not start: ${errors}`)), 30_000);
  try {
    const launch = await ready.promise;
    const origin = new URL(launch).origin;
    const exchange = await fetch(launch, { redirect: "manual" });
    expect(exchange.status).toBe(303);
    const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Missing GUI session cookie");
    const headers = { Cookie: cookie, Origin: origin,
      "Content-Type": "application/json", "x-canonfig-request": "browser" };
    const api = async (path: string, body?: Schema.Json) => {
      const response = await fetch(`${origin}${path}`, {
        method: body === undefined ? "GET" : "POST", headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const responseBody: unknown = await response.json();
      return { status: response.status, body: responseBody };
    };
    return { child, origin, headers, api, exited: exited.promise };
  } finally { clearTimeout(deadline); }
}

async function operation(server: GuiServer, id: string) {
  let completed: GuiOperation | undefined;
  await expect.poll(async () => {
    const response = await server.api(`/api/operations/${id}`);
    expect(response.status).toBe(200);
    completed = Schema.decodeUnknownSync(GuiOperation)(response.body);
    return completed.state;
  }, { timeout: 60_000, interval: 25 }).not.toBe("running");
  if (completed === undefined) throw new Error("Missing completed operation");
  return completed;
}

async function apply(server: GuiServer) {
  const response = await server.api("/api/self-update/apply", {});
  expect(response.status).toBe(202);
  return Schema.decodeUnknownSync(GuiOperationTicket)(response.body).id;
}

const enable = async (server: GuiServer, npmCli: string) => {
  const response = await server.api("/api/self-update/enable", { npmCli, confirmIdle: true });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(Schema.decodeUnknownSync(GuiSelfUpdateStatus)(response.body)).toMatchObject({ enabled: true, pending: false });
};

describe("GUI self-update with a disposable npm installation", () => {
  it("enables, checks and activates a local patch before cleanly exiting and freeing its port", async () => {
    const machine = await fixture();
    const server = await start(machine);
    const cliFailure = machine.invoke(["self-update", "apply", "--apply", "--json"]);
    expect(cliFailure.status).toBe(3);
    const failed = await operation(server, await apply(server));
    expect(failed.state).toBe("failed");
    const diagnostic = Schema.decodeUnknownSync(Schema.Struct({ message: Schema.String }))(JSON.parse(cliFailure.stderr));
    expect(failed.failure).toEqual({ category: "human-action-required", exitCode: 3, message: diagnostic.message });
    expect((await server.api("/api/session")).status).toBe(200);
    const missingConfirmation = await server.api("/api/self-update/enable", { npmCli: machine.npmCli, confirmIdle: false });
    expect(Schema.decodeUnknownSync(GuiError)(missingConfirmation.body)).toMatchObject({ category: "human-action-required", exitCode: 3,
      message: "Stop all existing Canonfig processes and schedules, then explicitly use --confirm-idle when enabling coordination for the first time." });
    // Keep the JSON body incomplete while another connection attempts work.
    // Neither a rejected request nor its finalizer may release this reservation.
    const enabled = Promise.withResolvers<{ status: number | undefined; body: unknown }>();
    const slow = request(`${server.origin}/api/self-update/enable`, {
      method: "POST", headers: server.headers,
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.once("error", enabled.reject);
      response.once("end", () => {
        try { enabled.resolve({ status: response.statusCode, body: JSON.parse(text) }); }
        catch (error) { enabled.reject(error); }
      });
    });
    slow.once("error", enabled.reject);
    slow.flushHeaders();
    try {
      const sent = Promise.withResolvers<void>();
      slow.write(`{"npmCli":${JSON.stringify(machine.npmCli)},"confirmIdle":`, (error) => error ? sent.reject(error) : sent.resolve());
      await sent.promise;
      await expect.poll(async () => (await server.api("/api/self-update")).status, { timeout: 5_000 }).toBe(409);
      expect((await server.api("/api/self-update")).status).toBe(409);
      slow.end("true}");
      const response = await enabled.promise;
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(Schema.decodeUnknownSync(GuiSelfUpdateStatus)(response.body)).toMatchObject({ enabled: true });
      expect((await server.api("/api/self-update")).status).toBe(200);
    } finally {
      slow.destroy();
      await enabled.promise.catch(() => undefined);
    }
    expect(machine.readers()).toHaveLength(1);
    const checked = await server.api("/api/self-update/check", {});
    expect(checked.status).toBe(200);
    expect(Schema.decodeUnknownSync(GuiSelfUpdateCheck)(checked.body)).toMatchObject({ current: previous, candidate, status: "available" });
    expect(machine.version()).toBe(previous);
    const id = await apply(server);
    await machine.downloadStarted;
    const running = Schema.decodeUnknownSync(GuiOperation)((await server.api(`/api/operations/${id}`)).body);
    expect(running.state).toBe("running");
    expect(Schema.decodeUnknownSync(GuiSelfUpdateProgress)(running.journal)).toEqual({ phase: "staging", candidate });
    expect(JSON.parse(readFileSync(join(updateDirectory(machine.root), "progress.json"), "utf8"))).toEqual(running.journal);
    expect(machine.readers()).toHaveLength(0);
    machine.allowDownload();
    const completed = await operation(server, id);
    expect(completed.state).toBe("succeeded");
    expect(Schema.decodeUnknownSync(GuiSelfUpdateProgress)(completed.journal)).toEqual({ phase: "complete", candidate });
    expect(JSON.parse(readFileSync(join(updateDirectory(machine.root), "progress.json"), "utf8"))).toEqual(completed.journal);
    expect(Schema.decodeUnknownSync(GuiSelfUpdateCheck)(completed.result)).toMatchObject({ current: previous, candidate, status: "updated" });
    expect(await server.exited).toEqual({ code: 0, signal: null });
    expect(machine.version()).toBe(candidate);
    expect(machine.invoke(["--version"]).stdout.trim()).toBe(candidate);
    expect(machine.readers()).toHaveLength(0);
    expect(existsSync(join(updateDirectory(machine.root), "pending.json"))).toBe(false);
    expect(existsSync(join(updateDirectory(machine.root), "last-transaction.json"))).toBe(true);
    expect(machine.registryRequests()).toBeGreaterThan(0);
    const port = createPortListener();
    port.listen(Number(new URL(server.origin).port), "127.0.0.1");
    await once(port, "listening");
    const closed = once(port, "close"); port.close(); await closed;
  }, 120_000);

  it("defers for a second command lease and preserves the CLI disable refusal", async () => {
    const machine = await fixture();
    const server = await start(machine);
    await enable(server, machine.npmCli);
    const second = await start(machine);
    const otherLease = machine.readers().find((name) => name.startsWith(`${second.child.pid}-`));
    expect(otherLease).toBeDefined();
    expect(machine.readers()).toHaveLength(2);
    const completed = await operation(server, await apply(server));
    expect(completed.state).toBe("succeeded");
    expect(Schema.decodeUnknownSync(GuiSelfUpdateCheck)(completed.result)).toMatchObject({ status: "deferred", current: previous, candidate,
      detail: "Canonfig commands are active (or left a stale lease). Retry after they finish; do not remove live leases." });
    expect(machine.readers()).toContain(otherLease);
    expect(machine.readers()).toHaveLength(2);
    expect(machine.version()).toBe(previous);
    const cli = machine.invoke(["self-update", "disable", "--apply", "--json"]);
    expect(cli.status).toBe(3);
    const cliFailure = Schema.decodeUnknownSync(Schema.Struct({ message: Schema.String }))(JSON.parse(cli.stderr));
    const refused = await server.api("/api/self-update/disable", {});
    expect(refused.status).toBe(400);
    expect(Schema.decodeUnknownSync(GuiError)(refused.body)).toEqual({ category: "human-action-required", exitCode: 3, message: cliFailure.message });
    expect(machine.readers()).toContain(otherLease);
    expect((await server.api("/api/self-update")).status).toBe(200);
    await stop(second.child);
    expect(machine.readers()).toHaveLength(1);
    const disabled = await server.api("/api/self-update/disable", {});
    expect(disabled.status).toBe(200);
    expect(Schema.decodeUnknownSync(GuiSelfUpdateStatus)(disabled.body)).toMatchObject({ enabled: false, settings: null });
    expect(machine.readers()).toHaveLength(0);
    expect((await server.api("/api/session")).status).toBe(200);
    await enable(server, machine.npmCli);
    expect(machine.readers()).toHaveLength(1);
  }, 120_000);
});
