/// <reference types="node" />
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { request, type WorkspaceBackend } from "../gui-client";
import { GuiOperation, GuiSession, GuiStatus } from "../../../src/gui/contract";
import { useAppRoute } from "./routes";

GlobalRegistrator.register({ url: "http://localhost/source/secrets", settings: { device: { prefersReducedMotion: "reduce" } } });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Workspace modules register browser listeners, so load them only after the isolated DOM exists.
const { LiveWorkspaceProvider } = await import("./live-provider");
const { createRoot } = await import("react-dom/client");
const { SecretsView } = await import("./source");
const { TooltipProvider } = await import("../components/ui/tooltip");
after(async () => { await GlobalRegistrator.unregister(); });

function Fixture({ backend, role }: { backend: WorkspaceBackend; role: "source" | "follower" }) {
  const route = useAppRoute();
  assert.equal(route.kind, "workspace");
  if (route.kind !== "workspace") return null;
  return <TooltipProvider><LiveWorkspaceProvider backend={backend} session={GuiSession.make({ role, machineName: "Secret fixture", folderPath: "/tmp/secret-fixture", version: "7.3.0" })} route={route} onInstalled={() => assert.fail("Unexpected installation")}>
    <SecretsView />
  </LiveWorkspaceProvider></TooltipProvider>;
}

async function fixture(role: "source" | "follower") {
  const responses: Record<string, unknown> = {
    "/api/status": { machineRole: { role }, lifecycle: {}, tunnel: null },
    "/api/secrets": { secrets: [{ name: "local-agent-key", origin: "local" }, { name: "shared-api-key", origin: "source" }] },
    "/api/machines": { followers: [], invitations: [] },
    "/api/tunnel": { lifecycle: "not-configured" },
    "/api/source-service": { report: {
      state: "not-serving", platform: "linux", mechanism: "systemd-user-service", serviceName: "secret-fixture", endpoint: "https://127.0.0.1:17342",
      requested: { hostname: "127.0.0.1", port: 17342 },
      tailnet: { installed: false, ready: false, backendState: "not-installed", addresses: [], httpsAvailable: false, userspace: false, detail: "" },
      manager: { installed: false, matches: false, enabled: false, active: false, state: "not-installed" },
      serving: false, supportedModes: "", logs: "", detail: "",
    }, error: null },
  };
  const server = createServer((incoming, outgoing) => {
    outgoing.setHeader("Content-Type", "application/json");
    outgoing.setHeader("Access-Control-Allow-Origin", "http://localhost");
    outgoing.setHeader("Access-Control-Allow-Headers", "content-type, x-canonfig-request, cache-control");
    if (incoming.method === "OPTIONS") { outgoing.end(); return; }
    const path = incoming.url ?? "/";
    outgoing.statusCode = path in responses ? 200 : 404;
    outgoing.end(JSON.stringify(responses[path] ?? { category: "internal", exitCode: 1, message: `Unexpected request ${path}` }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const backend: WorkspaceBackend = {
    request: (url, schema, signal, mutation) => request(`${origin}${url}`, schema, signal, mutation),
    session: (signal) => request(`${origin}/api/session`, GuiSession, signal),
    status: (signal) => request(`${origin}/api/status`, GuiStatus, signal),
    operation: (id, signal) => request(`${origin}/api/operations/${id}`, GuiOperation, signal),
  };
  window.history.replaceState(null, "", `/${role}/secrets`);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<Fixture backend={backend} role={role} />); });
  for (let attempt = 0; attempt < 100 && !container.textContent?.includes("local-agent-key"); attempt++) await act(async () => { await delay(10); });
  return {
    container,
    async close() {
      await act(async () => { root.unmount(); }); container.remove();
      server.closeAllConnections(); const stopped = once(server, "close"); server.close(); await stopped;
    },
  };
}

it("Source Secrets retains origins and omits an empty timestamp column and duplicate recipients", async () => {
  const view = await fixture("source");
  try {
    assert.ok(view.container.textContent?.includes("This machine"));
    assert.ok(view.container.textContent?.includes("Shared by the Source"));
    assert.ok(!view.container.textContent?.includes("Updated"));
    assert.ok(!view.container.textContent?.includes("Not recorded"));
    assert.ok(!view.container.textContent?.includes("Sent to:"));
    assert.ok(view.container.textContent?.includes("Eligible machines"));
    assert.ok(!view.container.textContent?.includes("Today"));
  } finally { await view.close(); }
});

it("Follower Secrets opens a write-only local form and discards its value on cancel", async () => {
  const view = await fixture("follower");
  try {
    const open = Array.from(view.container.querySelectorAll("button")).find((entry) => entry.textContent === "Set local secret");
    assert.ok(open);
    await act(async () => open.click());
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog?.textContent?.includes("Available to local agent bindings."));
    const value = dialog?.querySelector<HTMLInputElement>('#sec-value');
    assert.equal(value?.type, "password");
    assert.equal(value?.autocomplete, "off");
    assert.ok(value);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(value, "private-fixture-value");
      value.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const cancel = Array.from(dialog!.querySelectorAll("button")).find((entry) => entry.textContent === "Cancel");
    assert.ok(cancel);
    await act(async () => cancel.click());
    await act(async () => open.click());
    assert.equal(document.querySelector<HTMLInputElement>('#sec-value')?.value, "");
    assert.ok(!document.body.textContent?.includes("private-fixture-value"));
  } finally { await view.close(); }
});
