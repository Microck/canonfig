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

GlobalRegistrator.register({ url: "http://localhost/source/overview", settings: { device: { prefersReducedMotion: "reduce" } } });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Workspace controls register module-level browser listeners, so the DOM must exist before they load.
const { LiveWorkspaceProvider } = await import("./live-provider");
const { createRoot } = await import("react-dom/client");
const { SourceOverview } = await import("./source");
const { TooltipProvider } = await import("../components/ui/tooltip");
after(async () => { await GlobalRegistrator.unregister(); });

function Fixture({ backend }: { backend: WorkspaceBackend }) {
  const route = useAppRoute();
  assert.equal(route.kind, "workspace");
  if (route.kind !== "workspace") return null;
  return <TooltipProvider><LiveWorkspaceProvider backend={backend} session={GuiSession.make({ role: "source", machineName: "Overview fixture", folderPath: "/tmp/overview-fixture", version: "7.1.10" })} route={route} onInstalled={() => assert.fail("Unexpected installation")}>
    <SourceOverview />
  </LiveWorkspaceProvider></TooltipProvider>;
}

const revision = (sequence: number) => ({ id: `rev-${sequence}`, profileId: "fixture", sequence, digest: `digest-${sequence}`, publishedAt: `2026-11-1${sequence}T00:00:00Z` });
const service = (serving: boolean) => ({ report: { state: serving ? "running" : "not-serving", platform: "linux", mechanism: "systemd-user-service", serviceName: "overview-fixture", endpoint: "https://127.0.0.1:17342", manager: { installed: true, matches: true, enabled: true, active: serving, state: serving ? "running" : "not-running" }, serving, supportedModes: "", logs: "", detail: "" }, error: null });

/** Renders the live Source Overview against a real HTTP server that answers with the given Source evidence. */
async function overview(responses: Record<string, unknown>) {
  const server = createServer((incoming, outgoing) => {
    outgoing.setHeader("Content-Type", "application/json");
    outgoing.setHeader("Access-Control-Allow-Origin", "http://localhost");
    outgoing.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
  window.history.replaceState(null, "", "/source/overview");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<Fixture backend={backend} />); });
  return {
    async text(expected: string) {
      for (let attempt = 0; attempt < 100 && !container.textContent?.includes(expected); attempt++) await act(async () => { await delay(10); });
      return container.textContent ?? "";
    },
    async close() {
      await act(async () => { root.unmount(); });
      container.remove();
      server.closeAllConnections();
      const stopped = once(server, "close"); server.close(); await stopped;
    },
  };
}

const status = { machineRole: { role: "source" }, lifecycle: {}, tunnel: null };

it("a live Source that published revisions says so, without claiming machines have them", async () => {
  const page = await overview({ "/api/status": status, "/api/source-service": service(true), "/api/revisions": { revisions: [revision(1), revision(3), revision(2)] } });
  try {
    const text = await page.text("Revision 3 is published");
    assert.ok(text.includes("Revision 3 is published"), text);
    assert.ok(!text.includes("Publish the profile to send it to your other machines"), text);
    // Followers report nothing back to the Source, so no machine count or "up to date" claim may appear.
    assert.ok(!/up to date|machines have revision/i.test(text), text);
    assert.ok(text.includes("can't tell which machines have it"), text);
  } finally { await page.close(); }
});

it("a live Source with no revisions asks for the first publication", async () => {
  const page = await overview({ "/api/status": status, "/api/source-service": service(true), "/api/revisions": { revisions: [] } });
  try {
    assert.ok((await page.text("Nothing published yet")).includes("Nothing published yet"));
  } finally { await page.close(); }
});

it("a Source service that is not serving still outranks publication", async () => {
  const page = await overview({ "/api/status": status, "/api/source-service": service(false), "/api/revisions": { revisions: [revision(1)] } });
  try {
    const text = await page.text("can't reach this Source");
    assert.ok(text.includes("Other machines can't reach this Source"), text);
    assert.ok(!text.includes("Revision 1 is published"), text);
  } finally { await page.close(); }
});
