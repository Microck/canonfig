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

GlobalRegistrator.register({ url: "http://localhost/source/sync", settings: { device: { prefersReducedMotion: "reduce" } } });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// These controls register browser listeners at module load, so the DOM must exist first.
const { LiveWorkspaceProvider } = await import("./live-provider");
const { createRoot } = await import("react-dom/client");
const { SyncView } = await import("./follower");
const { TooltipProvider } = await import("../components/ui/tooltip");
after(async () => { await GlobalRegistrator.unregister(); });

function Fixture({ backend, role }: { backend: WorkspaceBackend; role: "source" | "follower" }) {
  const route = useAppRoute();
  assert.equal(route.kind, "workspace");
  if (route.kind !== "workspace") return null;
  return <TooltipProvider><LiveWorkspaceProvider backend={backend} session={GuiSession.make({ role, machineName: "Watch fixture", folderPath: "/tmp/watch-fixture", version: "7.8.2" })} route={route} onInstalled={() => assert.fail("Unexpected installation")}>
    <SyncView />
  </LiveWorkspaceProvider></TooltipProvider>;
}

type WatchState = "not-installed" | "running" | "not-running";

/** A real HTTP fixture that answers the Sync page's reads and the watcher's routes. */
async function syncPage(initial: WatchState, role: "source" | "follower" = "source", statusFails = false) {
  window.history.replaceState(null, "", `/${role}/sync`);
  let state: WatchState = initial;
  const writes: string[] = [];
  const watch = () => ({
    state, platform: "linux", mechanism: "systemd-user-service", serviceName: "canonfig-watch.service",
    definitionPath: "/home/fixture/.config/systemd/user/canonfig-watch.service",
    manager: { installed: state !== "not-installed", matches: true, enabled: state !== "not-installed", active: state === "running", state: state === "running" ? "active/running" : "failed/failed" },
    supportedModes: "is managed only while fixture has a login session", logs: "journalctl --user -u canonfig-watch.service", detail: "",
    ...(state === "running" ? { lastPass: { at: new Date().toISOString(), outcome: "failed", message: "follower drift conflicts with the selected revision", category: "conflict-or-drift" } } : {}),
  });
  const server = createServer(async (incoming, outgoing) => {
    outgoing.setHeader("Content-Type", "application/json");
    outgoing.setHeader("Access-Control-Allow-Origin", "http://localhost");
    outgoing.setHeader("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS");
    outgoing.setHeader("Access-Control-Allow-Headers", "content-type, x-canonfig-request, cache-control");
    if (incoming.method === "OPTIONS") { outgoing.end(); return; }
    if (incoming.url === "/api/status") { outgoing.end(JSON.stringify({ machineRole: { role }, lifecycle: {}, tunnel: null })); return; }
    if (incoming.url === "/api/tunnel") { outgoing.end(JSON.stringify({ lifecycle: "not-configured" })); return; }
    if (incoming.url === "/api/local/synchronization") { outgoing.end(JSON.stringify({ activeRecovery: null })); return; }
    if (incoming.url !== "/api/watch") {
      outgoing.statusCode = 404; outgoing.end(JSON.stringify({ category: "internal", exitCode: 1, message: `Unexpected request ${incoming.url}` })); return;
    }
    if (incoming.method === "GET" && statusFails) {
      outgoing.statusCode = 400;
      outgoing.end(JSON.stringify({ category: "human-action-required", exitCode: 3, message: "the systemd user manager is not reachable" })); return;
    }
    if (incoming.method === "GET") { outgoing.end(JSON.stringify(watch())); return; }
    for await (const _chunk of incoming);
    writes.push(incoming.method ?? "");
    state = incoming.method === "PUT" ? "running" : "not-installed";
    outgoing.end(JSON.stringify({ change: incoming.method === "PUT" ? "installed" : "removed" }));
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
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<Fixture backend={backend} role={role} />); });
  const until = async (check: () => boolean) => {
    for (let attempt = 0; attempt < 150 && !check(); attempt++) await act(async () => { await delay(10); });
    assert.ok(check(), document.body.textContent ?? "");
  };
  const toggle = () => {
    const found = document.querySelector('[role="switch"][aria-label="Apply changes automatically"]');
    assert.ok(found instanceof HTMLButtonElement, "No watch switch");
    return found;
  };
  const text = () => document.body.textContent ?? "";
  return {
    writes, until, toggle, text,
    async close() {
      await act(async () => { root.unmount(); }); container.remove();
      server.closeAllConnections(); const stopped = once(server, "close"); server.close(); await stopped;
    },
  };
}

it("turns automatic apply on and off and reports the watcher's last pass", async () => {
  const page = await syncPage("not-installed");
  try {
    await page.until(() => document.querySelector('[role="switch"][aria-label="Apply changes automatically"]') !== null);
    assert.equal(page.toggle().getAttribute("aria-checked"), "false");
    assert.ok(!page.text().includes("Watching the Canonfig folder"));

    await act(async () => { page.toggle().click(); });
    await page.until(() => page.text().includes("Watching the Canonfig folder"));
    assert.deepEqual(page.writes, ["PUT"]);
    assert.equal(page.toggle().getAttribute("aria-checked"), "true");
    // A failed pass says what went wrong instead of claiming the folder applied.
    assert.ok(page.text().includes("wasn't applied: follower drift conflicts with the selected revision"), page.text());

    await act(async () => { page.toggle().click(); });
    await page.until(() => page.toggle().getAttribute("aria-checked") === "false");
    assert.deepEqual(page.writes, ["PUT", "DELETE"]);
  } finally { await page.close(); }
});

it("offers to start a watcher the service manager stopped", async () => {
  const page = await syncPage("not-running");
  try {
    await page.until(() => page.text().includes("Not running"));
    assert.ok(page.text().includes("journalctl --user -u canonfig-watch.service"));
    const start = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Start watching");
    assert.ok(start, "No Start watching button");
    await act(async () => { start.click(); });
    await page.until(() => page.text().includes("Watching the Canonfig folder"));
    assert.deepEqual(page.writes, ["PUT"]);
  } finally { await page.close(); }
});

it("says why the watcher's status couldn't be read instead of hiding the setting", async () => {
  const page = await syncPage("running", "source", true);
  try {
    await page.until(() => page.text().includes("Canonfig couldn't check the watcher: the systemd user manager is not reachable"));
    assert.equal(document.querySelector('[role="switch"]'), null);
  } finally { await page.close(); }
});

it("lets a follower remove a watcher it kept from before it joined", async () => {
  const page = await syncPage("not-running", "follower");
  try {
    await page.until(() => page.text().includes("A watcher from before this machine joined is still installed"));
    assert.equal(document.querySelector('[role="switch"]'), null);
    const remove = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Remove watcher");
    assert.ok(remove, "No Remove watcher button");
    await act(async () => { remove.click(); });
    await page.until(() => !page.text().includes("A watcher from before this machine joined"));
    assert.deepEqual(page.writes, ["DELETE"]);
  } finally { await page.close(); }
});
