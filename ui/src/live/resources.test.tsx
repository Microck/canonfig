/// <reference types="node" />
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { request, type WorkspaceBackend } from "../gui-client";
import { GuiOperation, GuiSession, GuiStatus } from "../../../src/gui/contract";
import { useWorkspace } from "../workspace/store";
import { navigate, useAppRoute } from "../workspace/routes";

function NavigationProbe({ backend, session }: { backend: WorkspaceBackend; session: GuiSession }) {
  const route = useAppRoute();
  if (route.kind !== "workspace") return <p>Page not found</p>;
  return <LiveWorkspaceProvider backend={backend} session={session} route={route} onInstalled={() => assert.fail("Navigation tests must not install updates")}>
    <ResourceProbe />
    {route.view === "setup" && <SetupJournal backend={backend} session={session} frame={(actions, content) => <>{actions}{content}</>} />}
  </LiveWorkspaceProvider>;
}

function ResourceProbe() {
  const workspace = useWorkspace();
  const busy = workspace.pageLoading || workspace.admin.agent.loading || workspace.admin.agent.harnessLoading || workspace.admin.installers.loading;
  return <div aria-busy={busy}>
    {workspace.machineName}
    {workspace.view === "installers" && "Installers"}
    {workspace.view === "agent" && workspace.admin.agent.data && "Agent policy loaded"}
    <button onClick={workspace.reload}>Reload</button>
    {workspace.view === "agent" && workspace.admin.agent.data && <button onClick={() => {
      const saved = workspace.admin.agent.data;
      if (saved) void workspace.admin.agent.save({ ...saved, mode: "agent-propose" });
    }}>Save proposed policy</button>}
    {workspace.admin.agent.savedMessage}
  </div>;
}

GlobalRegistrator.register({ url: "http://localhost/source/overview" });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Workspace controls register DOM listeners at import time, after the test window exists.
const { LiveWorkspaceProvider } = await import("../workspace/live-provider");
const { SetupJournal } = await import("../onboarding/enrollment-controller");
const { default: LiveApp } = await import("../live-app");
after(async () => { await GlobalRegistrator.unregister(); });

for (const role of ["source", "follower"] as const) {
  it(`${role} Overview fetches only session/status and revisits retain page reads`, async () => {
    const requests: string[] = [];
    const mutations: { path: string; body: unknown }[] = [];
    const setup = { discoveryPaths: [], stage: "approved", approved: true, approvals: [], stages: [], items: [], catalog: [], planDigest: "navigation-plan" };
    const responses: Record<string, unknown> = {
      "/api/session": { role, machineName: "Navigation fixture", folderPath: "/tmp/navigation-fixture", version: "7.1.0" },
      "/api/status": { machineRole: { role }, lifecycle: {}, tunnel: null, shield: { enabled: false, hard: false, scope: role === "follower" ? "local" : "canonical", destination: "/tmp/navigation-fixture", projected: false, excludedPlugins: [], note: "" } },
      "/api/installers": { bindings: [], detected: [] },
      "/api/agent/policy": "deterministic-only",
      "/api/agent/harness": { configured: false },
      "/api/setup": setup,
      "/api/setup/apply": { id: "setup-operation" },
      "/api/operations/setup-operation": { id: "setup-operation", state: "succeeded", journal: null, result: {} },
    };
    const server = createServer((incoming, outgoing) => {
      const path = incoming.url ?? "/";
      if (incoming.method === "GET") requests.push(path);
      outgoing.writeHead(path in responses ? 200 : 404, {
        "Content-Type": "application/json", "Access-Control-Allow-Origin": "http://localhost",
        "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, x-canonfig-request, cache-control",
      });
      if (incoming.method === "PUT" || incoming.method === "POST") {
        let body = "";
        incoming.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        incoming.on("end", () => {
          const parsed: unknown = JSON.parse(body);
          mutations.push({ path, body: parsed });
          if (path === "/api/agent/policy") {
            responses[path] = parsed;
            outgoing.end(JSON.stringify(parsed));
          } else if (path === "/api/agent/harness") {
            responses[path] = { configured: true, value: parsed };
            outgoing.end(JSON.stringify(parsed));
          } else {
            if (path === "/api/setup/apply") setup.stage = "complete";
            outgoing.end(JSON.stringify(responses[path]));
          }
        });
      } else outgoing.end(JSON.stringify(responses[path] ?? { message: `Unexpected read ${path}` }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const backend: WorkspaceBackend = {
      request: (path, schema, signal, mutation) => request(`${origin}${path}`, schema, signal, mutation),
      session: (signal) => request(`${origin}/api/session`, GuiSession, signal),
      status: (signal) => request(`${origin}/api/status`, GuiStatus, signal),
      operation: (id, signal) => request(`${origin}/api/operations/${id}`, GuiOperation, signal),
    };
    window.history.replaceState(null, "", `/${role}/overview`);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    async function settle(expected: string) {
      for (let attempt = 0; attempt < 100; attempt++) {
        await act(async () => { await delay(10); });
        if (container.textContent?.includes(expected) && !container.querySelector('[aria-busy="true"]')) return;
      }
      assert.fail(`Page did not settle: ${container.textContent}`);
    }
    try {
      const session = await backend.session(new AbortController().signal);
      await act(async () => { root.render(<NavigationProbe backend={backend} session={session} />); });
      await settle("Navigation fixture");
      assert.deepEqual(requests, ["/api/session", "/api/status"]);
      await act(async () => { navigate(`/${role}/settings/installers`); });
      await settle("Installers");
      assert.deepEqual(requests, ["/api/session", "/api/status", "/api/installers"]);
      // Only a Follower has an Agent policy page; on a Source the route does not exist and reads nothing.
      await act(async () => { navigate(`/${role}/settings/agent`); });
      if (role === "follower") {
        await settle("Agent policy loaded");
        assert.deepEqual(requests.slice(3).sort(), ["/api/agent/harness", "/api/agent/policy"]);
      } else {
        await act(async () => { await delay(25); });
        assert.deepEqual(requests.slice(3), []);
      }
      const count = requests.length;
      await act(async () => { navigate(`/${role}/settings/installers`); });
      await settle("Installers");
      await act(async () => { navigate(`/${role}/overview`); });
      await settle("Navigation fixture");
      assert.equal(requests.length, count);
      const reload = [...container.querySelectorAll("button")].find((button) => button.textContent === "Reload");
      assert.ok(reload);
      await act(async () => { reload.click(); });
      await settle("Navigation fixture");
      assert.deepEqual(requests.slice(count), ["/api/status"]);
      await act(async () => { navigate(`/${role}/settings/installers`); });
      await settle("Installers");
      assert.equal(requests.length, count + 1, "Overview Reload must not invalidate another page");
      await act(async () => { navigate(`/${role === "source" ? "follower" : "source"}/settings/agent`); });
      await act(async () => { await delay(25); });
      assert.equal(requests.length, count + 1, "wrong-role routes must not read resources");
      await act(async () => { navigate(`/${role}/settings/setup`); });
      await settle("Apply approved setup");
      assert.equal(requests.filter((path) => path === "/api/setup").length, 1);
      const apply = [...container.querySelectorAll("button")].find((button) => button.textContent === "Apply approved setup");
      assert.ok(apply);
      const statusReadsBeforeApply = requests.filter((path) => path === "/api/status").length;
      await act(async () => { apply.click(); });
      await settle("Done");
      assert.deepEqual(mutations.at(-1), { path: "/api/setup/apply", body: { planDigest: "navigation-plan" } });
      assert.equal(requests.filter((path) => path === "/api/setup").length, 2, "Apply refreshes setup exactly once");
      const afterApply = requests.filter((path) => path !== "/api/status").length;
      await act(async () => { navigate(`/${role}/overview`); });
      await settle("Navigation fixture");
      await act(async () => { navigate(`/${role}/settings/setup`); });
      await settle("Done");
      assert.equal(requests.filter((path) => path !== "/api/status").length, afterApply, "Setup keeps its post-mutation status on revisit");
      assert.equal(requests.filter((path) => path === "/api/status").length, statusReadsBeforeApply + 1, "Apply refreshes machine status before Overview reuses it");
      if (role === "follower") {
        await act(async () => { navigate("/follower/settings/agent"); });
        await settle("Agent policy loaded");
        const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Save proposed policy");
        assert.ok(save);
        await act(async () => { save.click(); });
        await settle("Policy and harness saved.");
        const agentWrites = mutations.filter(({ path }) => path.startsWith("/api/agent/"));
        assert.deepEqual(agentWrites.map(({ path }) => path), ["/api/agent/policy", "/api/agent/harness"]);
        assert.equal(agentWrites[0]!.body, "agent-propose");
      }
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      server.closeAllConnections();
      const stopped = once(server, "close");
      server.close();
      await stopped;
    }
  });
}

it("self-update offers a same-major minor, preserves major notices and pairing warnings, and stops requests after installation", async () => {
  const requests: string[] = [];
  let operationReads = 0;
  const detail = "Source and Followers only pair on the same major.minor, so update every machine. 8.0.0: a new major is available; it installs automatically if auto updates are on, or with npm install --global @microck/canonfig@8.0.0.";
  const responses: Record<string, unknown> = {
    "/api/session": { role: "source", machineName: "Update fixture", folderPath: "/tmp/update-fixture", version: "7.1.0" },
    "/api/status": { machineRole: { role: "source" }, lifecycle: {}, tunnel: null, shield: { enabled: false, hard: false, scope: "canonical", destination: "/tmp/update-fixture", projected: false, excludedPlugins: [], note: "" } },
    "/api/self-update": { enabled: true, pending: false, platform: "linux", settings: { npmCli: "/tmp/update-fixture/npm/bin/npm-cli.js" } },
    "/api/self-update/check": { current: "7.1.0", candidate: "7.1.0", status: "available", detail },
    "/api/self-update/apply": { id: "update-operation" },
  };
  // This disposable HTTP fixture exercises the real browser transport and schemas,
  // but never invokes an installer or shuts down an operator's GUI.
  const server = createServer((incoming, outgoing) => {
    const path = incoming.url ?? "/";
    outgoing.setHeader("Content-Type", "application/json");
    outgoing.setHeader("Access-Control-Allow-Origin", "http://localhost");
    outgoing.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    outgoing.setHeader("Access-Control-Allow-Headers", "content-type, x-canonfig-request, cache-control");
    if (incoming.method === "OPTIONS") { outgoing.end(); return; }
    requests.push(`${incoming.method} ${path}`);
    if (path === "/api/operations/update-operation") {
      operationReads += 1;
      outgoing.end(JSON.stringify(operationReads === 1
        ? { id: "update-operation", state: "running", journal: { phase: "staging", candidate: "7.1.0" } }
        : { id: "update-operation", state: "succeeded", journal: { phase: "complete", candidate: "7.1.0" }, result: { current: "7.1.0", candidate: "7.1.0", status: "updated", detail: `Installed 7.1.0. Receipt unavailable; keep the update record for recovery. ${detail}` } }));
      return;
    }
    outgoing.statusCode = path in responses ? path === "/api/self-update/apply" ? 202 : 200 : 404;
    incoming.resume();
    outgoing.end(JSON.stringify(responses[path] ?? { message: `Unexpected request ${path}` }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const backend: WorkspaceBackend = {
    request: (path, schema, signal, mutation) => request(`${origin}${path}`, schema, signal, mutation),
    session: (signal) => request(`${origin}/api/session`, GuiSession, signal),
    status: (signal) => request(`${origin}/api/status`, GuiStatus, signal),
    operation: (id, signal) => request(`${origin}/api/operations/${id}`, GuiOperation, signal),
  };
  window.history.replaceState(null, "", "/source/settings/version");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  async function settle(text: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
      await act(async () => { await delay(10); });
      if (container.textContent?.includes(text)) return;
    }
    assert.fail(`Missing ${text}: ${container.textContent}`);
  }
  async function click(label: string) {
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
    assert.ok(button, `Missing button ${label}`);
    assert.equal(button.disabled, false);
    await act(async () => { button.click(); });
  }
  try {
    await act(async () => { root.render(<LiveApp backend={backend} />); });
    await settle("/tmp/update-fixture/npm/bin/npm-cli.js");
    await click("Check for updates");
    await settle(detail);
    await click("Install 7.1.0…");
    assert.ok(document.body.textContent?.includes("After installation, this GUI stops."));
    await click("Install update");
    await settle("staging 7.1.0");
    await settle("Canonfig 7.1.0 is installed. Start canonfig ui again.");
    assert.ok(container.textContent?.includes(detail), "Pairing warnings and major notices must survive activation");
    assert.ok(container.textContent?.includes("Receipt unavailable; keep the update record for recovery."), "Committed-update warnings must survive the terminal screen");
    assert.equal(container.querySelector('[role="status"] .font-mono')?.textContent, "canonfig ui");
    assert.ok(!container.querySelector('[role="status"]')?.textContent?.includes("`"));
    assert.equal(operationReads, 2);
    assert.equal(container.querySelector('[title="canonfig ui"]')?.textContent, "canonfig ui");
    assert.ok(container.querySelector('button[aria-label="Copy"]'));
    const completedRequests = [...requests];
    await act(async () => { navigate("/not-a-workspace"); });
    await act(async () => { navigate("/source/settings/version"); });
    await act(async () => { await delay(550); });
    assert.deepEqual(requests, completedRequests, "completion must unmount resource reads and stop operation polling");
    assert.ok(container.textContent?.includes("Canonfig 7.1.0 is installed."));
    assert.equal(container.querySelectorAll("button").length, 1, "only the copy command control remains");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    server.closeAllConnections();
    const stopped = once(server, "close");
    server.close();
    await stopped;
  }
});
