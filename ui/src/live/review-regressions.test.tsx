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
import { navigate, useAppRoute } from "../workspace/routes";

GlobalRegistrator.register({ url: "http://localhost/source/overview", settings: { device: { prefersReducedMotion: "reduce" } } });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Workspace controls need the test DOM before their module-level event listeners register.
const { LiveWorkspaceProvider } = await import("../workspace/live-provider");
const { createRoot } = await import("react-dom/client");
const { ProfileView } = await import("../workspace/profile");
const { LocalView } = await import("../workspace/follower");
const { SetupJournal } = await import("../onboarding/enrollment-controller");
const { TooltipProvider } = await import("../components/ui/tooltip");
after(async () => { await GlobalRegistrator.unregister(); });

function Probe() {
  const ws = useWorkspace();
  return <div aria-busy={ws.pageLoading}>
    <p data-testid="error">{ws.pageError?.message}</p>
    <p data-testid="followers">{ws.followers.map((follower) => follower.name).join(", ")}</p>
    <p data-testid="profile-name">{ws.profileName}</p>
    <button onClick={ws.reload}>Reload page</button>
    {ws.revisions.map((revision) => <button key={revision.sequence} onClick={() => ws.profileLive?.inspectRevision(revision.sequence)}>Inspect {revision.sequence}</button>)}
    <p data-testid="revision">{JSON.stringify(ws.profileLive?.revisionDetail)}</p>
    <button onClick={() => { void ws.profileLive?.validate(); }}>Validate</button>
  </div>;
}
function Fixture({ backend, session }: { backend: WorkspaceBackend; session: GuiSession }) {
  const route = useAppRoute();
  assert.equal(route.kind, "workspace");
  if (route.kind !== "workspace") return null;
  return <TooltipProvider><LiveWorkspaceProvider backend={backend} session={session} route={route} onInstalled={() => assert.fail("Unexpected installation")}>
    <Probe />
    {route.view === "setup" && <SetupJournal backend={backend} session={session} />}
    {route.view === "profile" && route.profileTab === "items" && <ProfileView />}
    {route.view === "local" && <LocalView />}
  </LiveWorkspaceProvider></TooltipProvider>;
}

type Handler = (path: string, method: string, body: unknown, outgoing: ServerResponse) => boolean;
async function fixture(path: string, responses: Record<string, unknown>, handler?: Handler) {
  const requests: string[] = [];
  const mutations: { path: string; body: unknown }[] = [];
  const server = createServer((incoming, outgoing) => {
    outgoing.setHeader("Content-Type", "application/json");
    outgoing.setHeader("Access-Control-Allow-Origin", "http://localhost");
    outgoing.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    outgoing.setHeader("Access-Control-Allow-Headers", "content-type, x-canonfig-request, cache-control");
    if (incoming.method === "OPTIONS") { outgoing.end(); return; }
    const url = incoming.url ?? "/";
    requests.push(`${incoming.method} ${url}`);
    let body = "";
    incoming.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    incoming.on("end", () => {
      const parsed: unknown = body ? JSON.parse(body) : undefined;
      if (incoming.method !== "GET") mutations.push({ path: url, body: parsed });
      if (handler?.(url, incoming.method ?? "GET", parsed, outgoing)) return;
      outgoing.statusCode = url in responses ? 200 : 404;
      outgoing.end(JSON.stringify(responses[url] ?? { category: "internal", exitCode: 1, message: `Unexpected request ${url}` }));
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
  window.history.replaceState(null, "", path);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const session = GuiSession.make({ role: path.startsWith("/follower") ? "follower" : "source", machineName: "Review fixture", folderPath: "/tmp/review-fixture", version: "6.0.0" });
  await act(async () => { root.render(<Fixture backend={backend} session={session} />); });
  return {
    container, requests, mutations,
    async close() {
      await act(async () => { root.unmount(); });
      container.remove();
      server.closeAllConnections();
      const stopped = once(server, "close"); server.close(); await stopped;
    },
  };
}
async function until(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await delay(10); });
    if (check()) return;
  }
  assert.fail(message);
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  assert.ok(button, `Missing button ${label}`);
  assert.equal(button.disabled, false, `${label} is disabled`);
  await act(async () => { button.click(); });
}
const profile = { items: [], config: { profile: { id: "review", name: "Review" }, groups: { work: [] } }, supportedSurfaces: {} };
const follower = { id: "review-follower", name: "Review laptop", groups: ["work", "secrets"], enrolledAt: "2026-11-06T00:00:00Z", revoked: false, pending: false, credentialPresent: true };
const sourceResponses = () => ({
  "/api/status": { machineRole: { role: "source" }, lifecycle: {}, tunnel: null },
  "/api/profile/items": profile,
  "/api/revisions": { revisions: [] },
  "/api/skills": { version: 1, skills: [] },
  "/api/secrets": { secrets: [] },
  "/api/machines": { followers: [follower], invitations: [] },
});

for (const path of ["/source/secrets", "/source/profile/groups"]) {
  it(`${path} cold entry loads follower membership, reports failures and refreshes it`, async () => {
    let pending: ServerResponse | undefined;
    let fail = false;
    const responses = sourceResponses();
    const app = await fixture(path, responses, (url, _method, _body, outgoing) => {
      if (url !== "/api/machines") return false;
      if (fail) { outgoing.statusCode = 500; outgoing.end(JSON.stringify({ category: "internal", exitCode: 1, message: "Inventory unavailable" })); }
      else pending = outgoing;
      return true;
    });
    try {
      await until(() => app.requests.includes("GET /api/machines"), "Cold entry never requested follower membership");
      assert.ok(app.container.querySelector('[aria-busy="true"]'), "membership participates in page loading");
      await act(async () => { pending?.end(JSON.stringify(responses["/api/machines"])); });
      await until(() => !app.container.querySelector('[aria-busy="true"]'), "Page did not finish loading");
      assert.equal(app.container.querySelector('[data-testid="followers"]')?.textContent, "Review laptop");
      fail = true;
      await click("Reload page");
      await until(() => app.container.textContent?.includes("Inventory unavailable") === true, "Membership error was not shown");
      fail = false;
      await click("Reload page");
      await until(() => app.requests.filter((request) => request === "GET /api/machines").length === 3, "Reload did not refresh membership");
      await act(async () => { pending?.end(JSON.stringify({ followers: [{ ...follower, name: "Renamed laptop" }], invitations: [] })); });
      await until(() => app.container.textContent?.includes("Renamed laptop") === true, "Refreshed membership was not shown");
    } finally { await app.close(); }
  });
}

it("revision inspection cancels superseded reads and does not share the mutation lock", async () => {
  const pending = new Map<string, ServerResponse>();
  let validation: ServerResponse | undefined;
  const responses = { ...sourceResponses(), "/api/revisions": { revisions: [1, 2, 3].map((sequence) => ({ id: `revision-${sequence}`, profileId: "review", sequence, digest: `digest-${sequence}`, publishedAt: "2026-11-06T00:00:00Z" })) } };
  const app = await fixture("/source/revisions", responses, (path, _method, body, outgoing) => {
    if (path === "/api/revisions/inspect") {
      assert.ok(body && typeof body === "object" && "revision" in body && typeof body.revision === "string");
      pending.set(body.revision, outgoing);
      return true;
    }
    if (path === "/api/profile/validate") { validation = outgoing; return true; }
    return false;
  });
  try {
    await until(() => app.container.textContent?.includes("Inspect 3") === true, "Revisions not loaded");
    await click("Inspect 1");
    await until(() => pending.has("revision-1"), "First inspection did not start");
    await click("Inspect 2");
    await until(() => pending.has("revision-2"), "Second inspection was dropped");
    await act(async () => { pending.get("revision-2")?.end(JSON.stringify({ signature: "second revision" })); });
    await until(() => app.container.textContent?.includes("second revision") === true, "Second revision not displayed");
    await act(async () => { pending.get("revision-1")?.end(JSON.stringify({ signature: "stale first revision" })); await delay(20); });
    assert.ok(!app.container.textContent?.includes("stale first revision"));
    await click("Validate");
    await until(() => validation !== undefined, "Validation not started");
    await click("Inspect 3");
    await until(() => pending.has("revision-3"), "Mutation blocked revision inspection");
    await act(async () => { pending.get("revision-3")?.end(JSON.stringify({ signature: "third revision" })); });
    await until(() => app.container.textContent?.includes("third revision") === true, "Third revision not displayed");
    await act(async () => { validation?.end(JSON.stringify({ valid: true, errors: [], profile: {} })); });
  } finally { await app.close(); }
});

for (const state of ["succeeded", "failed"] as const) {
  it(`setup apply invalidates configured workspace evidence when ${state}`, async () => {
    const responses: Record<string, unknown> = {
      ...sourceResponses(),
      "/api/harnesses": { folder: "/tmp/review-fixture", configured: true, listed: [], excluded: [], detected: [], notInstalled: [], snapshots: 0, harnesses: [] },
      "/api/setup": { discoveryPaths: [], stage: "approved", approved: true, approvals: [], stages: [], items: [], catalog: [], planDigest: "setup-plan" },
      "/api/setup/apply": { id: "setup-operation" },
      "/api/operations/setup-operation": { id: "setup-operation", state, journal: null, ...(state === "failed" ? { failure: { category: "internal", exitCode: 1, message: "Import stopped after writing files" } } : {}) },
    };
    const app = await fixture("/source/profile/harnesses", responses, (path) => {
      if (path === "/api/setup/apply") responses["/api/profile/items"] = { ...profile, config: { ...profile.config, profile: { id: "review", name: "After setup" } } };
      return false;
    });
    try {
      await until(() => !app.container.querySelector('[aria-busy="true"]'), "Initial profile did not load");
      await act(async () => { navigate("/source/settings/setup"); });
      await until(() => app.container.textContent?.includes("Apply approved setup") === true && !app.container.querySelector('[aria-busy="true"]'), "Setup did not load");
      await click("Apply approved setup");
      await until(() => app.requests.includes("GET /api/operations/setup-operation") && !app.container.querySelector('[aria-busy="true"]'), "Apply did not finish");
      await act(async () => { navigate("/source/profile/harnesses"); });
      await until(() => !app.container.querySelector('[aria-busy="true"]'), "Profile did not finish refreshing");
      assert.equal(app.container.querySelector('[data-testid="profile-name"]')?.textContent, "After setup");
      assert.equal(app.requests.filter((request) => request === "GET /api/harnesses").length, 2, "Harness evidence must be invalidated");
      assert.equal(app.requests.filter((request) => request === "GET /api/status").length, 2, "Status evidence must be invalidated");
    } finally { await app.close(); }
  });
}

async function fill(selector: string, value: string) {
  const input = document.querySelector(selector);
  assert.ok(input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement, `Missing field ${selector}`);
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  assert.ok(setter);
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

for (const category of ["mcp", "settings"]) {
  it(`local ${category} reload resets its draft and saves against the refreshed local.jsonc digest`, async () => {
    const snapshot = (digest: string, command: string) => ({ items: [{ path: "local.jsonc", digest, files: [] }], config: { [category]: { example: { command } } }, canonicalConfig: { local: { allow: [category] } } });
    const responses: Record<string, unknown> = {
      "/api/status": { machineRole: { role: "follower" }, lifecycle: {}, tunnel: null },
      "/api/harnesses": { folder: "/tmp/review-fixture", configured: true, listed: [], excluded: [], detected: [], notInstalled: [], snapshots: 0, harnesses: [] },
      "/api/local/overlays": { overlays: [] },
      "/api/local/items": snapshot("original-digest", "original"),
      "/api/local/preferences": snapshot("saved-digest", "saved"),
    };
    const app = await fixture(`/follower/local-settings?focus=${category}/example`, responses);
    try {
      await until(() => document.querySelector<HTMLTextAreaElement>("#local-value")?.value.includes("original") === true, "Local item did not load");
      await fill("#local-value", JSON.stringify({ command: "my unsaved edit" }));
      responses["/api/local/items"] = snapshot("refreshed-digest", "new disk value");
      await click("Reload page");
      await until(() => app.requests.filter((request) => request === "GET /api/local/items").length === 2 && !app.container.querySelector('[aria-busy="true"]'), "Local reload did not finish");
      assert.ok(document.querySelector<HTMLTextAreaElement>("#local-value")?.value.includes("new disk value"), "Reload left the stale local draft open");
      await fill("#local-value", JSON.stringify({ command: "saved" }));
      await click("Save");
      await until(() => app.mutations.some((mutation) => mutation.path === "/api/local/preferences"), "Local save not sent");
      assert.deepEqual(app.mutations.at(-1)?.body, { expectedDigest: "refreshed-digest", edits: [{ path: [category, "example"], value: { command: "saved" } }] });
      await until(() => !document.querySelector("#local-value") && !app.container.querySelector('[aria-busy="true"]'), "Local save did not finish");
    } finally { await app.close(); }
  });
}

for (const resolution of ["Discard my edits", "Re-apply my edits"]) {
  it(`profile conflict reload preserves the draft until ${resolution}`, async () => {
    const snapshot = (digest: string, body: string) => ({
      ...profile,
      items: [
        { path: "canonfig.jsonc", digest: "config-digest", files: [] },
        { path: "AGENTS.md", digest, files: [{ path: "AGENTS.md", base64: Buffer.from(body).toString("base64"), executable: false }] },
      ],
    });
    const responses: Record<string, unknown> = { ...sourceResponses(), "/api/profile/items": snapshot("original-digest", "Original instructions") };
    let writes = 0;
    const app = await fixture("/source/profile?focus=instructions", responses, (path, method, _body, outgoing) => {
      if (path !== "/api/profile/config" || method !== "PUT") return false;
      writes += 1;
      if (writes === 1) {
        responses["/api/profile/items"] = snapshot("disk-digest", "Instructions changed on disk");
        outgoing.statusCode = 409;
        outgoing.end(JSON.stringify({ category: "conflict-or-drift", exitCode: 4, message: "AGENTS.md changed on disk. Reload before saving." }));
      } else {
        responses["/api/profile/items"] = snapshot("saved-digest", "My unsaved instructions");
        outgoing.end(JSON.stringify({ saved: true }));
      }
      return true;
    });
    try {
      await until(() => document.querySelector<HTMLTextAreaElement>("#item-Body")?.value === "Original instructions", "Instructions did not load");
      await fill("#item-Body", "My unsaved instructions");
      await click("Save to the folder");
      await until(() => app.container.textContent?.includes("AGENTS.md changed on disk") === true, "Digest conflict not displayed");
      await click("Reload");
      await until(() => app.requests.filter((request) => request === "GET /api/profile/items").length === 2 && !app.container.querySelector('[aria-busy="true"]'), "Profile reload did not finish");
      assert.equal(document.querySelector<HTMLTextAreaElement>("#item-Body")?.value, "My unsaved instructions", "Reload discarded the draft without consent");
      assert.ok(app.container.textContent?.includes("Instructions changed on disk"), "The new disk version must be visible alongside the draft");
      await click(resolution);
      if (resolution === "Discard my edits") {
        assert.equal(document.querySelector<HTMLTextAreaElement>("#item-Body")?.value, "Instructions changed on disk");
        assert.equal(writes, 1, "Discard must not write");
      } else {
        await click("Save to the folder");
        await until(() => writes === 2 && !app.container.querySelector('[aria-busy="true"]'), "Re-applied draft was not saved");
        const body = app.mutations.at(-1)?.body;
        assert.ok(body && typeof body === "object" && "changes" in body);
        assert.deepEqual(body.changes, [{ path: "AGENTS.md", expectedDigest: "disk-digest", files: [{ path: "AGENTS.md", base64: Buffer.from("My unsaved instructions").toString("base64"), executable: false }] }]);
      }
    } finally { await app.close(); }
  });
}
