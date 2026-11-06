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
  return <LiveWorkspaceProvider backend={backend} session={session} route={route}>
    <ResourceProbe />
    {route.view === "setup" && <SetupJournal backend={backend} session={session} />}
  </LiveWorkspaceProvider>;
}

function ResourceProbe() {
  const workspace = useWorkspace();
  const busy = workspace.pageLoading || workspace.admin.agent.loading || workspace.admin.agent.harnessLoading || workspace.admin.installers.loading;
  return <div aria-busy={busy}>
    {workspace.machineName}
    {workspace.view === "installers" && "Installers"}
    {workspace.view === "agent" && !workspace.admin.agent.configured && "Not configured yet"}
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
after(async () => { await GlobalRegistrator.unregister(); });

for (const role of ["source", "follower"] as const) {
  it(`${role} Overview fetches only session/status and revisits retain page reads`, async () => {
    const requests: string[] = [];
    const mutations: { path: string; body: unknown }[] = [];
    const setup = { discoveryPaths: [], stage: "approved", approved: true, approvals: [], stages: [], items: [], catalog: [], planDigest: "navigation-plan" };
    const responses: Record<string, unknown> = {
      "/api/session": { role, machineName: "Navigation fixture", folderPath: "/tmp/navigation-fixture", version: "6.0.0" },
      "/api/status": { machineRole: { role }, lifecycle: {}, tunnel: null },
      "/api/installers": { bindings: [], suggestions: [] },
      "/api/agent/policy": { configured: false, default: "deterministic-only" },
      "/api/agent/harness": { configured: false },
      "/api/setup": setup,
      "/api/setup/apply": { id: "setup-operation" },
      "/api/operations/setup-operation": { id: "setup-operation", state: "succeeded", journal: null },
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
      await act(async () => { navigate(`/${role}/settings/agent`); });
      await settle("Not configured yet");
      assert.deepEqual(requests.slice(3).sort(), ["/api/agent/harness", "/api/agent/policy"]);
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
      await act(async () => { apply.click(); });
      await settle("Apply approved setup");
      assert.deepEqual(mutations.at(-1), { path: "/api/setup/apply", body: { planDigest: "navigation-plan" } });
      assert.equal(requests.filter((path) => path === "/api/setup").length, 2, "Apply refreshes setup exactly once");
      const afterApply = requests.length;
      await act(async () => { navigate(`/${role}/overview`); });
      await settle("Navigation fixture");
      await act(async () => { navigate(`/${role}/settings/setup`); });
      await settle("Apply approved setup");
      assert.equal(requests.length, afterApply, "Setup keeps its post-mutation status on revisit");
      if (role === "source") {
        await act(async () => { navigate("/source/settings/agent"); });
        await settle("Not configured yet");
        const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Save proposed policy");
        assert.ok(save);
        await act(async () => { save.click(); });
        await settle("Policy saved.");
        assert.deepEqual(mutations.filter(({ path }) => path.startsWith("/api/agent/")), [{ path: "/api/agent/policy", body: "agent-propose" }]);
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
