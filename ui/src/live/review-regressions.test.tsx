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
const { SecretsView } = await import("../workspace/source");
const { FollowerOperationEvidence } = await import("../workspace/follower-evidence");
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
    <button onClick={ws.followerLive?.check}>Check follower</button>
    <button onClick={ws.followerLive?.resumeObservation}>Resume follower</button>
    <button onClick={ws.applyPlan}>Apply follower</button>
    <button onClick={() => ws.restore("snapshot")}>Restore follower</button>
    <p data-testid="command">{JSON.stringify(ws.followerLive?.command)}</p>
    <p data-testid="phase">{ws.phase}</p>
    <p data-testid="can-apply">{String(ws.followerLive?.canApply)}</p>
    <p data-testid="validation">{String(ws.profileLive?.validation?.valid)}</p>
    <button onClick={() => { if (ws.admin.agent.data) void ws.admin.agent.save({ ...ws.admin.agent.data, mode: "agent-propose" }); }}>Save agent</button>
    <p data-testid="policy-save">{JSON.stringify(ws.admin.agent.saveState)}</p>
    <p data-testid="policy">{ws.admin.agent.data?.mode}</p>
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
    {route.view === "secrets" && <SecretsView />}
    {route.role === "follower" && <FollowerOperationEvidence />}
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
  const session = GuiSession.make({ role: path.startsWith("/follower") ? "follower" : "source", machineName: "Review fixture", folderPath: "/tmp/review-fixture", version: "7.1.0" });
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
const follower = { id: "review-follower", name: "Review laptop", groups: ["work", "secrets"], enrolledAt: "2026-11-06T00:00:00Z", revoked: false, pending: false, credentialPresent: true, credentialLifecycle: { _tag: "Active" } };
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

it("retains an uncertain follower ticket, blocks another command and resumes its observation", async () => {
  let polls = 0;
  const responses = { ...sourceResponses(), "/api/sync/plan": { id: "plan" } };
  const app = await fixture("/follower/overview", responses, (path, _method, _body, outgoing) => {
    if (path !== "/api/operations/plan") return false;
    polls++;
    if (polls === 2) {
      outgoing.statusCode = 503;
      outgoing.end(JSON.stringify({ category: "internal", exitCode: 1, message: "Observation disconnected" }));
    } else outgoing.end(JSON.stringify(polls === 1 ? { id: "plan", state: "running", journal: {} } : { id: "plan", state: "succeeded", journal: {}, result: { plan: {} } }));
    return true;
  });
  try {
    await click("Check follower");
    await until(() => polls === 2, "The running operation was not polled");
    await until(() => app.container.querySelector('[data-testid="command"]')?.textContent?.includes("ObservationLost") === true, "Lost observation was not represented");
    await click("Check follower");
    assert.equal(app.mutations.filter(({ path }) => path === "/api/sync/plan").length, 1);
    await click("Resume follower");
    await until(() => app.container.querySelector('[data-testid="can-apply"]')?.textContent === "true", "Resumed plan did not enable Apply");
    assert.equal(polls, 3);
  } finally { await app.close(); }
});

it("offers ticket recovery even when the first operation observation fails", async () => {
  let polls = 0;
  const app = await fixture("/follower/overview", { ...sourceResponses(), "/api/sync/plan": { id: "first-poll" } }, (path, _method, _body, outgoing) => {
    if (path !== "/api/operations/first-poll") return false;
    if (++polls === 1) {
      outgoing.statusCode = 503;
      outgoing.end(JSON.stringify({ category: "internal", exitCode: 1, message: "First observation disconnected" }));
    } else outgoing.end(JSON.stringify({ id: "first-poll", state: "succeeded", journal: null, result: {} }));
    return true;
  });
  try {
    await click("Check follower");
    await until(() => app.container.querySelector('[data-testid="command"]')?.textContent?.includes("ObservationLost") === true, "First-poll failure lost the ticket");
    await click("Resume observation");
    await until(() => app.container.querySelector('[data-testid="can-apply"]')?.textContent === "true", "First-poll recovery did not complete the plan");
  } finally { await app.close(); }
});

it("only a successful plan enables Apply and successful Apply reaches done", async () => {
  const responses = {
    ...sourceResponses(), "/api/sync/plan": { id: "plan" }, "/api/backups/restore": { id: "restore" }, "/api/sync/apply": { id: "apply" },
    ...Object.fromEntries(["plan", "restore", "apply"].map((id) => [`/api/operations/${id}`, { id, state: "succeeded", journal: {}, result: {} }])),
  };
  const app = await fixture("/follower/overview", responses);
  try {
    await click("Apply follower");
    assert.equal(app.mutations.filter(({ path }) => path === "/api/sync/apply").length, 0, "Apply without a successful plan must be refused by the transition owner");
    await click("Restore follower");
    await until(() => app.container.querySelector('[data-testid="command"]')?.textContent?.includes('"kind":"Completed","command":"restore"') === true, "Restore did not complete");
    assert.equal(app.container.querySelector('[data-testid="can-apply"]')?.textContent, "false");
    await click("Check follower");
    await until(() => app.container.querySelector('[data-testid="can-apply"]')?.textContent === "true", "Plan did not enable Apply");
    await click("Apply follower");
    await until(() => app.container.querySelector('[data-testid="phase"]')?.textContent === "done", "Successful apply did not reach done");
  } finally { await app.close(); }
});

it("a profile save refresh keeps edits made after the submitted draft", async () => {
  const snapshot = (digest: string, body: string) => ({ ...profile, items: [{ path: "AGENTS.md", digest, files: [{ path: "AGENTS.md", base64: Buffer.from(body).toString("base64"), executable: false }] }] });
  let refresh: ServerResponse | undefined;
  let reads = 0;
  const app = await fixture("/source/profile?focus=instructions", { ...sourceResponses(), "/api/profile/items": snapshot("original", "Original") }, (path, method, _body, outgoing) => {
    if (path === "/api/profile/config" && method === "PUT") { outgoing.end('{"saved":true}'); return true; }
    if (path === "/api/profile/items" && ++reads > 1) { refresh = outgoing; return true; }
    return false;
  });
  try {
    await until(() => document.querySelector<HTMLTextAreaElement>("#item-Body")?.value === "Original", "Editor did not load");
    await fill("#item-Body", "Submitted");
    await click("Save to the folder");
    await until(() => refresh !== undefined, "Save did not invalidate the snapshot");
    await fill("#item-Body", "A newer unsaved edit");
    await act(async () => { refresh?.end(JSON.stringify(snapshot("saved", "Submitted"))); });
    await until(() => !app.container.querySelector('[aria-busy="true"]'), "Refresh did not settle");
    assert.equal(document.querySelector<HTMLTextAreaElement>("#item-Body")?.value, "A newer unsaved edit");
    assert.equal([...document.querySelectorAll("button")].find((button) => button.textContent === "Save to the folder")?.disabled, false);
  } finally { await app.close(); }
});

it("discovery failure stops Finding tools and offers a scan-specific retry", async () => {
  let scans = 0;
  const app = await fixture("/source/profile", sourceResponses(), (path, _method, _body, outgoing) => {
    if (path !== "/api/profile/scan") return false;
    scans++;
    outgoing.statusCode = scans === 1 ? 500 : 200;
    outgoing.end(JSON.stringify(scans === 1 ? { category: "internal", exitCode: 1, message: "Discovery failed" } : { tools: [] }));
    return true;
  });
  try {
    await until(() => !app.container.querySelector('[aria-busy="true"]'), "Profile did not load");
    await click("Discover tools");
    await until(() => document.body.textContent?.includes("Discovery failed") === true, "Discovery failure was not shown");
    assert.equal(document.body.textContent?.includes("Finding tools…"), false);
    await click("Retry discovery");
    await until(() => scans === 2 && !document.body.textContent?.includes("Finding tools…"), "Retry did not settle");
  } finally { await app.close(); }
});

it("a changed folder snapshot invalidates publication review evidence", async () => {
  const responses: Record<string, unknown> = { ...sourceResponses(), "/api/profile/validate": { valid: true, errors: [], profile: {} } };
  const app = await fixture("/source/profile", responses);
  try {
    await until(() => !app.container.querySelector('[aria-busy="true"]'), "Profile did not load");
    await click("Validate");
    await until(() => app.container.querySelector('[data-testid="validation"]')?.textContent === "true", "Validation did not finish");
    responses["/api/profile/items"] = { ...profile, config: { ...profile.config, profile: { id: "changed", name: "Changed" } } };
    await click("Reload page");
    await until(() => app.container.querySelector('[data-testid="profile-name"]')?.textContent === "Changed", "Folder did not refresh");
    assert.equal(app.container.querySelector('[data-testid="validation"]')?.textContent, "undefined");
  } finally { await app.close(); }
});

it("a secret submission freezes its draft and cannot close as if it cancelled the write", async () => {
  let saving: ServerResponse | undefined;
  const app = await fixture("/source/secrets", sourceResponses(), (path, method, _body, outgoing) => {
    if (path !== "/api/secrets" || method !== "PUT") return false;
    saving = outgoing; return true;
  });
  try {
    await until(() => !app.container.querySelector('[aria-busy="true"]'), "Secrets did not load");
    await click("Set secret");
    await fill("#sec-name", "test-secret");
    await fill("#sec-value", "submitted-value");
    await click("Save secret");
    await until(() => saving !== undefined, "Secret save did not start");
    assert.equal(document.querySelector<HTMLInputElement>("#sec-value")?.closest("fieldset")?.disabled, true);
    assert.equal([...document.querySelectorAll("button")].find((button) => button.textContent === "Cancel")?.disabled, true);
    await act(async () => { saving?.end(JSON.stringify({ name: "test-secret", origin: "local" })); });
    await until(() => !document.querySelector("#sec-value"), "Saved secret form did not close");
  } finally { await app.close(); }
});

it("a failed harness save retains the committed policy as an explicit partial success", async () => {
  const responses: Record<string, unknown> = {
    "/api/status": { machineRole: { role: "follower" }, lifecycle: {}, tunnel: null },
    "/api/agent/policy": { configured: false, default: "deterministic-only" },
    "/api/agent/harness": { configured: false },
  };
  const app = await fixture("/follower/settings/agent", responses, (path, method, _body, outgoing) => {
    if (method !== "PUT") return false;
    if (path === "/api/agent/policy") { outgoing.end('"agent-propose"'); return true; }
    if (path === "/api/agent/harness") { outgoing.statusCode = 500; outgoing.end(JSON.stringify({ category: "internal", exitCode: 1, message: "Harness write failed" })); return true; }
    return false;
  });
  try {
    await until(() => app.requests.includes("GET /api/agent/policy") && !app.container.querySelector('[aria-busy="true"]'), "Policy did not load");
    await click("Save agent");
    await until(() => app.mutations.some(({ path }) => path === "/api/agent/harness"), "Harness save did not start");
    await until(() => app.container.querySelector('[data-testid="policy-save"]')?.textContent?.includes("HarnessFailed") === true, "Partial commit was not represented");
    assert.equal(app.container.querySelector('[data-testid="policy"]')?.textContent, "agent-propose");
  } finally { await app.close(); }
});
