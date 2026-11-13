/// <reference types="node" />
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { after, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { request, type WorkspaceBackend } from "../gui-client";
import { GuiOperation, GuiSession, GuiStatus } from "../../../src/gui/contract";
import { useWorkspace } from "../workspace/store";
import { useAppRoute } from "../workspace/routes";

GlobalRegistrator.register({ url: "http://localhost/source/machines/list", settings: { device: { prefersReducedMotion: "reduce" } } });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Controls register module-level browser listeners, so the real DOM must exist before loading them.
const { LiveWorkspaceProvider } = await import("../workspace/live-provider");
const { createRoot } = await import("react-dom/client");
const { MachinesView, InviteDialog, ChangeGroupsDialog } = await import("../workspace/machines");
const { TooltipProvider } = await import("../components/ui/tooltip");
after(async () => { await GlobalRegistrator.unregister(); });

function Fixture({ backend }: { backend: WorkspaceBackend }) {
  const route = useAppRoute();
  assert.equal(route.kind, "workspace");
  if (route.kind !== "workspace") return null;
  return <TooltipProvider><LiveWorkspaceProvider backend={backend} session={GuiSession.make({ role: "source", machineName: "Dialog fixture", folderPath: "/tmp/dialog-fixture", version: "7.1.0" })} route={route} onInstalled={() => assert.fail("Unexpected installation")}>
    <Controls /><MachinesView /><InviteDialog /><ChangeGroupsDialog />
  </LiveWorkspaceProvider></TooltipProvider>;
}
function Controls() {
  const ws = useWorkspace();
  return <><output data-testid="followers">{ws.followers.map((entry) => entry.id).join(",")}</output><button onClick={ws.reload}>Reload page</button><button onClick={() => ws.setChangeGroups({ followerId: "dialog-follower" })}>Open groups</button></>;
}
const follower = { id: "dialog-follower", name: "Original laptop", groups: ["work"], enrolledAt: "2026-11-06T00:00:00Z", revoked: false, pending: false, credentialPresent: true, credentialLifecycle: { _tag: "Active" } };
type Handler = (path: string, body: unknown, outgoing: ServerResponse) => boolean;
async function fixture(handler: Handler) {
  const responses: Record<string, unknown> = {
    "/api/status": { machineRole: { role: "source" }, lifecycle: {}, tunnel: null },
    "/api/profile/items": { items: [], config: { profile: { id: "dialog", name: "Dialog" }, groups: { work: [] } }, supportedSurfaces: {} },
    "/api/source-service": { report: { state: "not-installed", platform: "linux", mechanism: "systemd-user-service", serviceName: "dialog-fixture", endpoint: "", manager: { installed: false, matches: false, enabled: false, active: false, state: "not-installed" }, serving: false, supportedModes: "", logs: "", detail: "" }, error: null },
    "/api/revisions": { revisions: [] },
    "/api/machines": { followers: [follower], invitations: [] },
  };
  const requests: string[] = [];
  const server = createServer((incoming, outgoing) => {
    outgoing.setHeader("Content-Type", "application/json");
    outgoing.setHeader("Access-Control-Allow-Origin", "http://localhost");
    outgoing.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    outgoing.setHeader("Access-Control-Allow-Headers", "content-type, x-canonfig-request, cache-control");
    if (incoming.method === "OPTIONS") { outgoing.end(); return; }
    const path = incoming.url ?? "/";
    requests.push(`${incoming.method} ${path}`);
    let body = "";
    incoming.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    incoming.on("end", () => {
      if (handler(path, body ? JSON.parse(body) : undefined, outgoing)) return;
      outgoing.statusCode = path in responses ? 200 : 404;
      outgoing.end(JSON.stringify(responses[path] ?? { category: "internal", exitCode: 1, message: `Unexpected request ${path}` }));
    });
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
  window.history.replaceState(null, "", "/source/machines/list?focus=dialog-follower");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<Fixture backend={backend} />); });
  await until(() => container.textContent?.includes("Revoke…") === true, "Follower details did not load");
  return { responses, requests, async close() {
    await act(async () => { root.unmount(); });
    container.remove();
    server.closeAllConnections();
    const stopped = once(server, "close"); server.close(); await stopped;
  } };
}
async function until(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await delay(10); });
    if (check()) return;
  }
  assert.fail(message);
}
function button(label: string) {
  const found = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  assert.ok(found, `Missing button ${label}`);
  return found;
}
async function click(label: string) {
  const target = button(label);
  assert.equal(target.disabled, false, `${label} is disabled`);
  await act(async () => { target.click(); });
}
async function fill(selector: string, value: string) {
  const input = document.querySelector(selector);
  assert.ok(input instanceof HTMLInputElement, `Missing field ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  assert.ok(setter);
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
function fail(outgoing: ServerResponse) {
  outgoing.statusCode = 500;
  outgoing.end(JSON.stringify({ category: "internal", exitCode: 1, message: "Operation unavailable" }));
}

it("group invitation retains its submitted follower after failure, retry and inventory removal", async () => {
  let attempts = 0;
  const submitted: unknown[] = [];
  const app = await fixture((path, body, outgoing) => {
    if (path !== "/api/invitations") return false;
    submitted.push(body);
    if (++attempts === 1) fail(outgoing);
    else outgoing.end(JSON.stringify({ filename: "new-groups.json", envelope: "private invitation", endpoint: "https://source.example", groups: ["work", "canonfig:secrets"], expiresAt: "2026-11-06T01:00:00Z" }));
    return true;
  });
  try {
    await click("Open groups");
    await fill("#cg-endpoint", "https://source.example");
    await act(async () => { document.getElementById("cg-canonfig:secrets")!.click(); });
    await click("Create invitation");
    await until(() => document.body.textContent?.includes("Operation unavailable") === true, "Creation error missing");
    assert.equal(document.querySelector<HTMLInputElement>("#cg-endpoint")?.value, "https://source.example");
    assert.equal(document.getElementById("cg-canonfig:secrets")?.getAttribute("data-state"), "checked");
    await click("Create invitation");
    await until(() => document.body.textContent?.includes("Re-join Original laptop with its new groups") === true, "Created invitation missing");
    app.responses["/api/machines"] = { followers: [], invitations: [] };
    await click("Reload page");
    await until(() => document.querySelector('[data-testid="followers"]')?.textContent === "", "Inventory not refreshed");
    assert.ok(document.body.textContent?.includes("Re-join Original laptop with its new groups"), "Created invitation reverted to editing when follower disappeared");
    assert.ok(document.body.textContent?.includes("--name 'Original laptop' --replace"));
    assert.ok(button("Download invitation"));
    assert.deepEqual(submitted, Array.from({ length: 2 }, () => ({ endpoint: "https://source.example", groups: ["work", "canonfig:secrets"], expiresInMilliseconds: 3_600_000 })));
  } finally { await app.close(); }
});

it("revocation cannot be cancelled or dismissed while its server request runs", async () => {
  let pending: ServerResponse | undefined;
  const app = await fixture((path, body, outgoing) => {
    if (path !== "/api/machines/revoke") return false;
    assert.deepEqual(body, { follower: "dialog-follower" });
    pending = outgoing;
    return true;
  });
  try {
    await click("Revoke…");
    await click("Revoke Original laptop");
    await until(() => pending !== undefined, "Revocation did not start");
    assert.equal(button("Cancel").disabled, true, "Cancel misleadingly remains available during revocation");
    await act(async () => { document.querySelector('[role="dialog"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.ok(document.querySelector('[role="dialog"]'), "Escape dismissed a non-cancellable revocation");
    await act(async () => { pending!.end("{}"); });
    await until(() => !document.querySelector('[role="dialog"]'), "Successful revocation did not close");
    assert.equal(app.requests.filter((entry) => entry === "POST /api/machines/revoke").length, 1);
  } finally { await app.close(); }
});

it("reopening failed revocation clears the prior attempt error", async () => {
  const app = await fixture((path, _body, outgoing) => {
    if (path !== "/api/machines/revoke") return false;
    fail(outgoing);
    return true;
  });
  try {
    await click("Revoke…");
    await click("Revoke Original laptop");
    await until(() => document.body.textContent?.includes("Operation unavailable") === true, "Revocation error missing");
    await click("Cancel");
    await click("Revoke…");
    assert.ok(!document.querySelector('[role="dialog"]')?.textContent?.includes("Operation unavailable"), "Reopened confirmation retained the previous error");
  } finally { await app.close(); }
});

it("ordinary invitation captures its submitted values and starts a fresh invitation", async () => {
  let pending: ServerResponse | undefined;
  const app = await fixture((path, body, outgoing) => {
    if (path !== "/api/invitations") return false;
    assert.deepEqual(body, { endpoint: "https://source.example", groups: [], expiresInMilliseconds: 3_600_000 });
    pending = outgoing;
    return true;
  });
  try {
    await click("Add machine");
    await fill("#inv-ep", "https://source.example");
    await click("Create invitation");
    await until(() => pending !== undefined, "Invitation did not start");
    assert.equal(document.querySelector<HTMLInputElement>("#inv-ep")?.disabled, true);
    assert.equal(button("Cancel").disabled, true);
    await act(async () => { pending!.end(JSON.stringify({ filename: "captured.json", envelope: "private invitation", endpoint: "https://source.example", groups: [], expiresAt: "2026-11-06T01:00:00Z" })); });
    await until(() => document.body.textContent?.includes("Invitation ready") === true, "Invitation result missing");
    assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes("captured.json"));
    assert.ok(button("Download invitation"));
    await click("Invite another");
    assert.equal(document.querySelector<HTMLInputElement>("#inv-ep")?.value, "https://source.example");
    assert.ok(button("Create invitation"));
    await click("Cancel");
    await click("Add machine");
    assert.ok(!document.querySelector('[role="dialog"]')?.textContent?.includes("captured.json"));
  } finally { await app.close(); }
});

it("invitation address starts as the Source service's address once it has loaded", async () => {
  // The invitation dialog is mounted before the service report arrives, as on a real page load.
  const app = await fixture((path, _body, outgoing) => {
    if (path !== "/api/source-service") return false;
    outgoing.end(JSON.stringify({ report: { state: "running", platform: "linux", mechanism: "systemd-user-service", serviceName: "dialog-fixture", endpoint: "https://127.0.0.1:17342", manager: { installed: true, matches: true, enabled: true, active: true, state: "running" }, serving: true, supportedModes: "", logs: "", detail: "" }, error: null }));
    return true;
  });
  try {
    await click("Add machine");
    assert.equal(document.querySelector<HTMLInputElement>("#inv-ep")?.value, "https://127.0.0.1:17342");
    await fill("#inv-ep", "https://source.example");
    await click("Cancel");
    await click("Add machine");
    // What was typed last time is kept.
    assert.equal(document.querySelector<HTMLInputElement>("#inv-ep")?.value, "https://source.example");
  } finally { await app.close(); }
});
