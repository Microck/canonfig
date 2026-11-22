/// <reference types="node" />
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { after, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { Schema } from "effect";
import { request, type WorkspaceBackend } from "../gui-client";
import { GuiOperation, GuiSession, GuiStatus } from "../../../src/gui/contract";
import { GuiSkillSelection, GuiSkillUpdate, type GuiSkillCheck } from "../../../src/gui/contract/profile";
import { installerMethods } from "../../../src/domain/installer-method";
import { useWorkspace } from "../workspace/store";
import { navigate, useAppRoute } from "../workspace/routes";

GlobalRegistrator.register({ url: "http://localhost/source/overview", settings: { device: { prefersReducedMotion: "reduce" } } });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Workspace controls need the test DOM before their module-level event listeners register.
const { LiveWorkspaceProvider } = await import("../workspace/live-provider");
const { createRoot } = await import("react-dom/client");
const { ProfileView } = await import("../workspace/profile");
const { LocalView, SyncView } = await import("../workspace/follower");
const { RevisionsView, SecretsView } = await import("../workspace/source");
const { FollowerOperationEvidence } = await import("../workspace/follower-evidence");
const { SetupJournal } = await import("../onboarding/enrollment-controller");
const { TooltipProvider } = await import("../components/ui/tooltip");
const { AgentPolicyView, InstallersView, VersionView } = await import("../workspace/settings");
after(async () => { await GlobalRegistrator.unregister(); });

function Probe() {
  const ws = useWorkspace();
  return <div aria-busy={ws.pageLoading}>
    <p data-testid="error">{ws.pageError?.message}</p>
    <p data-testid="followers">{ws.followers.map((follower) => follower.name).join(", ")}</p>
    <p data-testid="profile-name">{ws.profileName}</p>
    <button onClick={ws.reload}>Reload page</button>
    {ws.revisions.map((revision) => <button key={revision.id} onClick={() => ws.profileLive?.inspectRevision(revision.id)}>Inspect {revision.sequence}</button>)}
    <p data-testid="revision">{JSON.stringify(ws.profileLive?.revisionDetail)}</p>
    <button onClick={() => { void ws.profileLive?.validate(); }}>Validate</button>
    <button onClick={() => ws.publish("Alice", () => {})}>Publish</button>
    <button onClick={ws.followerLive?.check}>Check follower</button>
    <button onClick={ws.followerLive?.resumeObservation}>Resume follower</button>
    <button onClick={ws.applyPlan}>Apply follower</button>
    <button onClick={() => ws.restore("snapshot")}>Restore follower</button>
    <p data-testid="command">{JSON.stringify(ws.followerLive?.command)}</p>
    <p data-testid="phase">{ws.phase}</p>
    <p data-testid="can-apply">{String(ws.followerLive?.canApply)}</p>
    <p data-testid="validation">{String(ws.profileLive?.validation?.valid)}</p>
    <button onClick={() => { if (ws.admin.agent.data) void ws.admin.agent.save({ ...ws.admin.agent.data, mode: "agent-propose" }); }}>Save agent</button>
    <button onClick={() => {
      const saved = ws.admin.agent.data;
      if (saved?.harness) void ws.admin.agent.save({ mode: "agent-apply", harness: {
        ...saved.harness, executables: ["env"], executableAuthorizations: [{ executable: "env", behavior: "leaf" }], capabilities: [],
      } });
    }}>Save apply agent</button>
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
    {route.view === "setup" && <SetupJournal backend={backend} session={session} frame={(actions, content) => <>{actions}{content}</>} />}
    {route.view === "profile" && (route.profileTab === "items" || route.profileTab === "harnesses") && <ProfileView />}
    {route.view === "local" && <LocalView />}
    {route.view === "secrets" && <SecretsView />}
    {route.view === "revisions" && <RevisionsView />}
    {route.view === "agent" && <AgentPolicyView />}
    {route.view === "installers" && <InstallersView />}
    {route.view === "version" && <VersionView />}
    {route.view === "sync" ? <SyncView /> : route.role === "follower" && <FollowerOperationEvidence />}
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
const profile = { items: [], config: { profile: { id: "review", name: "Review" }, groups: { work: [] } }, reservedPaths: [], caseSensitive: true, supportedSurfaces: {} };
const follower = { id: "review-follower", name: "Review laptop", groups: ["work", "secrets"], enrolledAt: "2026-11-06T00:00:00Z", revoked: false, pending: false, credentialPresent: true, credentialLifecycle: { _tag: "Active" } };
const sourceResponses = () => ({
  "/api/status": { machineRole: { role: "source" }, lifecycle: {}, tunnel: null },
  "/api/profile/items": profile,
  "/api/revisions": { revisions: [] },
  "/api/skills": { version: 1, skills: [] },
  "/api/secrets": { secrets: [] },
  "/api/machines": { followers: [follower], invitations: [], health: {} },
});

it("refreshes the canary inventory and excludes pending and revoked followers", async () => {
  const responses = {
    ...sourceResponses(),
    "/api/source-service": { report: null, error: null },
    "/api/fleet-update": null,
    "/api/self-update": { platform: "linux", enabled: false, pending: false, settings: null },
    "/api/machines": {
      followers: [
        follower,
        { ...follower, id: "pending-follower", name: "Pending laptop", pending: true },
        { ...follower, id: "revoked-follower", name: "Revoked laptop", revoked: true },
      ],
      invitations: [], health: {},
    },
  };
  const app = await fixture("/source/settings/version", responses);
  const options = () => Array.from(app.container.querySelectorAll("#fleet-canary ~ select option"), (option) => option.textContent).filter(Boolean);
  const initial = Promise.withResolvers<void>();
  const refreshed = Promise.withResolvers<void>();
  const updateInventory = () => {
    const names = options();
    if (names.includes(follower.name)) initial.resolve();
    if (names.includes("New laptop")) refreshed.resolve();
  };
  const inventoryObserver = new MutationObserver(updateInventory);
  inventoryObserver.observe(app.container, { subtree: true, childList: true });
  updateInventory();
  try {
    await initial.promise;
    assert.deepEqual(options(), [follower.name]);
    responses["/api/machines"].followers = [
      { ...follower, revoked: true },
      { ...follower, id: "fresh-follower", name: "New laptop" },
    ];
    await click("Refresh followers");
    await refreshed.promise;
    assert.deepEqual(options(), ["New laptop"]);
    assert.equal(app.requests.filter((entry) => entry === "GET /api/machines").length, 2);
    assert.deepEqual(app.mutations, []);
  } finally { inventoryObserver.disconnect(); await app.close(); }
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
      await act(async () => { pending?.end(JSON.stringify({ followers: [{ ...follower, name: "Renamed laptop" }], invitations: [], health: {} })); });
      await until(() => app.container.textContent?.includes("Renamed laptop") === true, "Refreshed membership was not shown");
    } finally { await app.close(); }
  });
}

const revisionMetadata = {
  approval: { revision: "fixture", proposalDigest: "proposal", revisionDigest: "digest", reviewer: "Alice", reviewedAt: "2026-11-06T00:00:00Z", recordedAt: "2026-11-06T00:00:00Z" },
  resourceChanges: { previousRevision: null, added: ["instructions"], changed: [], removed: [] },
};
it("revision details use the displayed revision ID when profile histories share a sequence", async () => {
  const older = { ...revisionMetadata, id: "aaa-old-1", profileId: "aaa-old", sequence: 1, digest: "old-fingerprint", publishedAt: "2026-11-01T00:00:00Z" };
  const current = { ...revisionMetadata, id: "zzz-current-1", profileId: "zzz-current", sequence: 1, digest: "current-fingerprint", publishedAt: "2026-11-06T00:00:00Z" };
  const resources = {
    [older.id]: [{ id: "rules/old-profile", digest: "old-resource-digest" }],
    [current.id]: [{ id: "rules/current-profile", digest: "current-resource-digest" }],
  };
  const app = await fixture("/source/revisions", { ...sourceResponses(), "/api/revisions": { revisions: [older, current] } }, (path, _method, body, outgoing) => {
    if (path !== "/api/revisions/inspect") return false;
    assert.ok(body && typeof body === "object" && "revision" in body && typeof body.revision === "string");
    outgoing.end(JSON.stringify({ resources: resources[body.revision] }));
    return true;
  });
  try {
    await until(() => app.container.textContent?.includes(current.digest) === true, "Current revision not listed");
    assert.ok(app.container.textContent?.includes(older.digest), "Every stored profile history must be listed");
    assert.ok(app.container.textContent?.includes("Alice"), "Stored reviewer must be listed");
    assert.ok(app.container.textContent?.includes("1 added, 0 changed, 0 removed"));
    const row = [...app.container.querySelectorAll<HTMLElement>('[data-tour="revisions-list"]')].find((element) => element.textContent?.includes(current.digest));
    assert.ok(row);
    await act(async () => { row.click(); });
    await until(() => app.mutations.some((mutation) => mutation.path === "/api/revisions/inspect"), "Revision inspection did not start");
    assert.deepEqual(app.mutations.filter((mutation) => mutation.path === "/api/revisions/inspect"), [{ path: "/api/revisions/inspect", body: { revision: current.id } }]);
    assert.equal(new URLSearchParams(window.location.search).get("focus"), current.id);
    await until(() => app.container.textContent?.includes("current-resource-digest") === true, "Current revision resources not displayed");
    assert.ok(app.container.textContent?.includes("rules/current-profile"));
    assert.ok(!app.container.textContent?.includes("rules/old-profile"));
    const detail: unknown = JSON.parse(app.container.querySelector('[data-testid="revision"]')?.textContent ?? "null");
    assert.deepEqual(detail, { id: current.id, data: { resources: resources[current.id] }, loading: false, error: null });
    const history = app.container.querySelector<HTMLSelectElement>("#revision-history")!;
    await act(async () => { history.value = older.profileId; history.dispatchEvent(new Event("change", { bubbles: true })); });
    const oldRow = [...app.container.querySelectorAll<HTMLElement>('[data-tour="revisions-list"]')].find((element) => element.textContent?.includes(older.digest));
    assert.ok(oldRow, "Older profile history is accessible");
    await act(async () => { oldRow.click(); });
    await until(() => app.container.textContent?.includes("old-resource-digest") === true, "Same-sequence older revision not inspected");
    assert.equal(new URLSearchParams(window.location.search).get("focus"), older.id);
    const input = app.container.querySelector<HTMLInputElement>("#revision-lookup")!;
    await fill("#revision-lookup", current.id);
    await act(async () => { input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await until(() => app.container.textContent?.includes("current-resource-digest") === true, "Exact ID lookup must work outside the filtered history");
    assert.equal(new URLSearchParams(window.location.search).get("focus"), current.id);
  } finally { await app.close(); }
});

it("shows each revision field once, collapses the remaining record and distinguishes absent IDs from failed reads", async () => {
  const id = "unlisted:revision";
  const record = { id, profileId: "unlisted", sequence: 7, digest: "unlisted-digest", resources: [{ id: "instructions", target: "AGENTS.md", spec: { kind: "file", blob: "blob-id", executable: false } }], groups: [{ name: "work", resources: ["instructions"] }], scheduleDefault: { expression: "daily@09:00" }, canonicalBytes: "exact canonical text", approval: { reviewer: "Bob" } };
  const app = await fixture(`/source/revisions?focus=${encodeURIComponent(id)}`, sourceResponses(), (path, _method, body, outgoing) => {
    if (path !== "/api/revisions/inspect") return false;
    assert.ok(body && typeof body === "object" && "revision" in body);
    if (body.revision === id) outgoing.end(JSON.stringify(record));
    else if (body.revision === "missing") outgoing.end("null");
    else { outgoing.statusCode = 500; outgoing.end(JSON.stringify({ category: "internal", exitCode: 1, message: "Revision store unavailable" })); }
    return true;
  });
  try {
    await until(() => app.container.textContent?.includes("unlisted-digest") === true, "Direct unlisted ID never loaded");
    for (const text of ["Bob", "blob-id", "work", "daily@09:00", "exact canonical text"]) assert.ok(app.container.textContent?.includes(text), `Missing structured field ${text}`);
    const raw = [...app.container.querySelectorAll("details")].find((element) => element.querySelector("summary")?.textContent === "Raw record")!;
    assert.ok(raw, "Remaining record disclosure is missing");
    assert.equal(raw.open, false, "Remaining record must start collapsed");
    const remaining = JSON.parse(raw.querySelector("pre")!.textContent!);
    for (const field of ["id", "profileId", "sequence", "digest", "publishedAt"]) assert.ok(!(field in remaining), `Formatted ${field} must not repeat in the raw record`);
    assert.ok(!("reviewer" in remaining.approval), "Formatted reviewer must not repeat in the raw record");
    await act(async () => { raw.querySelector("summary")!.click(); });
    assert.equal(raw.open, true);
    assert.equal(remaining.canonicalBytes, record.canonicalBytes);
    await act(async () => { navigate("/source/revisions?focus=missing"); });
    await until(() => app.container.textContent?.includes("No revision with this ID.") === true, "Missing revision state not shown");
    assert.equal(new URLSearchParams(window.location.search).get("focus"), "missing");
    assert.ok(!app.container.textContent?.includes("Retry lookup"), "An absent ID is not a failed request");
    assert.ok(!app.container.textContent?.includes("Operation failed"));
    assert.ok(!app.container.textContent?.includes("unlisted-digest"), "Absent lookup must not retain another revision");
    await act(async () => { navigate("/source/revisions?focus=unavailable"); });
    await until(() => app.container.textContent?.includes("Revision store unavailable") === true, "Actual read failure was hidden");
    assert.ok(app.container.textContent?.includes("Retry lookup"), "Actual request failures remain retryable");
  } finally { await app.close(); }
});

it("revision inspection cancels superseded reads and does not share the mutation lock", async () => {
  const pending = new Map<string, ServerResponse>();
  let validation: ServerResponse | undefined;
  const responses = { ...sourceResponses(), "/api/revisions": { revisions: [1, 2, 3].map((sequence) => ({ ...revisionMetadata, id: `revision-${sequence}`, profileId: "review", sequence, digest: `digest-${sequence}`, publishedAt: "2026-11-06T00:00:00Z" })) } };
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
    await act(async () => { validation?.end(JSON.stringify({ valid: true, errors: [], reviewDigest: "reviewed-digest", profile: {} })); });
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

it("saves a harness's Gets choices once when the menu closes", async () => {
  const items = {
    items: [{ path: "canonfig.jsonc", digest: "config-digest", files: [] }],
    config: { ...profile.config, harnesses: ["codex"] },
    reservedPaths: [], caseSensitive: true, supportedSurfaces: { codex: ["instructions", "rules", "skills", "hooks"] },
  };
  const responses: Record<string, unknown> = {
    ...sourceResponses(),
    "/api/profile/items": items,
    "/api/harnesses": {
      folder: "/tmp/review-fixture", configured: true, listed: ["codex"], excluded: [], detected: ["codex"], notInstalled: [], snapshots: 0,
      harnesses: [{ harness: "codex", name: "OpenAI Codex", installed: true, root: "/tmp/review-fixture/.codex", rootExists: false, status: "selected", listed: true, excluded: false }],
    },
  };
  const app = await fixture("/source/profile/harnesses", responses, (path, method, _body, outgoing) => {
    if (path === "/api/profile/config" && method === "PUT") { outgoing.end('{"saved":true}'); return true; }
    return false;
  });
  try {
    const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-label^="What OpenAI Codex gets"]');
    await until(() => trigger() !== null && !app.container.querySelector('[aria-busy="true"]'), "Harness list did not load");
    await act(async () => { trigger()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await until(() => document.querySelectorAll('[role="menuitemcheckbox"]').length > 0, "Gets menu did not open");
    for (const name of ["Rules", "Skills", "Hooks"]) {
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find((candidate) => candidate.textContent === name);
      assert.ok(item, `Missing ${name}`);
      await act(async () => { item.click(); });
    }
    assert.equal(app.mutations.filter((mutation) => mutation.path === "/api/profile/config").length, 0, "Ticking must not write while the menu is open");
    const menu = document.querySelector('[role="menu"]');
    assert.ok(menu);
    await act(async () => { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await until(() => app.mutations.some((mutation) => mutation.path === "/api/profile/config"), "Closing the menu did not save");
    const writes = app.mutations.filter((mutation) => mutation.path === "/api/profile/config");
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]!.body, { expectedDigest: "config-digest", edits: [{ path: ["surfaces"], value: { codex: ["instructions"] } }], changes: [] });
  } finally { await app.close(); }
});

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
    const snapshot = (digest: string, command: string) => ({ items: [{ path: "local.jsonc", digest, files: [] }], config: { [category]: { example: { command } } }, settingsFiles: {}, canonicalConfig: { local: { allow: [category] } } });
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
    } else outgoing.end(JSON.stringify(polls === 1 ? { id: "plan", state: "running", journal: {} } : { id: "plan", state: "succeeded", journal: {}, result: { plan: {}, planDigest: "a".repeat(64) } }));
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
    } else outgoing.end(JSON.stringify({ id: "first-poll", state: "succeeded", journal: null, result: { planDigest: "a".repeat(64) } }));
    return true;
  });
  try {
    await click("Check follower");
    await until(() => app.container.querySelector('[data-testid="command"]')?.textContent?.includes("ObservationLost") === true, "First-poll failure lost the ticket");
    await click("Resume observation");
    await until(() => app.container.querySelector('[data-testid="can-apply"]')?.textContent === "true", "First-poll recovery did not complete the plan");
  } finally { await app.close(); }
});

it("labels the running sync command without suggesting a plan applies changes", async () => {
  const planReply = Promise.withResolvers<ServerResponse>();
  const applyReply = Promise.withResolvers<ServerResponse>();
  const app = await fixture("/follower/sync", {
    ...sourceResponses(), "/api/tunnel": { lifecycle: "not-configured" },
    "/api/sync/plan": { id: "plan" }, "/api/sync/apply": { id: "apply" },
  }, (path, _method, _body, outgoing) => {
    if (path === "/api/operations/plan") planReply.resolve(outgoing);
    else if (path === "/api/operations/apply") applyReply.resolve(outgoing);
    else return false;
    return true;
  });
  const check = () => app.container.querySelector<HTMLButtonElement>('[data-tour="sync-check"]');
  const apply = () => app.container.querySelector<HTMLButtonElement>('[data-tour="sync-apply"]');
  try {
    assert.equal(check()?.disabled, false);
    await act(async () => {
      check()?.click();
      await planReply.promise;
    });
    const planned = await planReply.promise;
    assert.equal(check()?.textContent?.trim(), "Checking…");
    assert.equal(apply()?.textContent?.trim(), "Apply changes");
    assert.equal(apply()?.disabled, true);
    await act(async () => { planned.end(JSON.stringify({ id: "plan", state: "succeeded", journal: null, result: { planDigest: "a".repeat(64) } })); });
    await until(() => apply()?.disabled === false, "Plan did not enable Apply");

    await act(async () => {
      apply()?.click();
      await applyReply.promise;
    });
    const applied = await applyReply.promise;
    assert.equal(check()?.textContent?.trim(), "Check for updates");
    assert.equal(apply()?.textContent?.trim(), "Applying…");
    await act(async () => { applied.end(JSON.stringify({ id: "apply", state: "succeeded", journal: null, result: {} })); });
    await until(() => apply() === null, "Finished apply still showed its button");
  } finally { await app.close(); }
});

it("only a successful plan enables Apply and successful Apply reaches done", async () => {
  const responses = {
    ...sourceResponses(), "/api/sync/plan": { id: "plan" }, "/api/backups/restore": { id: "restore" }, "/api/sync/apply": { id: "apply" },
    ...Object.fromEntries(["plan", "restore", "apply"].map((id) => [`/api/operations/${id}`, { id, state: "succeeded", journal: {}, result: id === "plan" ? { planDigest: "a".repeat(64) } : {} }])),
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
    assert.deepEqual(app.mutations.find(({ path }) => path === "/api/sync/apply")?.body, { planDigest: "a".repeat(64) });
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
    outgoing.end(JSON.stringify(scans === 1 ? { category: "internal", exitCode: 1, message: "Discovery failed" } : { tools: [], declared: [], reviewDigest: "reviewed" }));
    return true;
  });
  try {
    await until(() => !app.container.querySelector('[aria-busy="true"]'), "Profile did not load");
    await click("Discover tools");
    await until(() => document.body.textContent?.includes("Discovery failed") === true, "Discovery failure was not shown");
    assert.equal(document.body.textContent?.includes("Finding tools…"), false);
    await click("Retry discovery");
    await until(() => scans === 2 && document.body.textContent?.includes("No new accepted tools.") === true, "Retry did not settle");
    assert.equal([...document.querySelectorAll("button")].find((button) => button.textContent === "Add 0 accepted tools")?.disabled, true);
  } finally { await app.close(); }
});
it("the counted discovery action confirms accepted tools and retains a failed acceptance for retry", async () => {
  let attempts = 0;
  const app = await fixture("/source/profile", {
    ...sourceResponses(),
    "/api/profile/scan": { reviewDigest: "reviewed", declared: [], tools: [{ id: "ruff", executable: "ruff", reviewStatus: "accepted", evidence: [{ invocation: ["uv", "tool", "install", "ruff==0.6.9"], sourcePath: "/tmp/AGENTS.md" }] }] },
  }, (path, _method, _body, outgoing) => {
    if (path !== "/api/profile/scan/accept") return false;
    outgoing.statusCode = ++attempts === 1 ? 400 : 200;
    outgoing.end(JSON.stringify(attempts === 1 ? { category: "usage-or-configuration", exitCode: 2, message: "Write refused" } : { written: ["ruff"] }));
    return true;
  });
  try {
    await until(() => !app.container.querySelector('[aria-busy="true"]'), "Profile did not load");
    await click("Discover tools");
    await until(() => document.body.textContent?.includes("Add 1 accepted tool") === true, "Findings did not load");
    const add = [...document.querySelectorAll("button")].find((button) => button.textContent === "Add 1 accepted tool")!;
    assert.equal(add.disabled, false);
    assert.equal(document.querySelector('[role="dialog"] [role="checkbox"]'), null, "The counted action is the consent");
    assert.equal(app.mutations.some(({ path }) => path === "/api/profile/scan/accept"), false, "Scanning must not accept tools");
    await click("Add 1 accepted tool");
    await until(() => document.body.textContent?.includes("Write refused") === true, "Acceptance failure was not shown");
    assert.ok(document.querySelector('[role="dialog"]'));
    await click("Add 1 accepted tool");
    await until(() => !document.querySelector('[role="dialog"]'), "Successful acceptance did not close");
    assert.deepEqual(app.mutations.filter(({ path }) => path === "/api/profile/scan/accept").map(({ body }) => body), [
      { reviewDigest: "reviewed", confirmAll: true }, { reviewDigest: "reviewed", confirmAll: true },
    ]);
    assert.equal(app.mutations.some(({ path }) => path === "/api/publications"), false);
  } finally { await app.close(); }
});

it("counts and labels additions from each reviewed scan instead of cached Profile entries", async () => {
  let scans = 0;
  const app = await fixture("/source/profile", {
    ...sourceResponses(),
    "/api/profile/items": { ...profile, config: { ...profile.config, tools: { ruff: { executable: "ruff", recipes: [] } } } },
    "/api/profile/scan/accept": { written: ["black", "ruff"] },
  }, (path, _method, _body, outgoing) => {
    if (path !== "/api/profile/scan") return false;
    outgoing.end(JSON.stringify({
      reviewDigest: `reviewed-${++scans}`,
      declared: scans === 1 ? ["ruff"] : [],
      tools: ["black", "ruff"].map((id) => ({ id, executable: id, reviewStatus: "accepted", evidence: [{ invocation: [id], sourcePath: "/tmp/AGENTS.md" }] })),
    }));
    return true;
  });
  try {
    await until(() => !app.container.querySelector('[aria-busy="true"]'), "Profile did not load");
    assert.ok(document.body.textContent?.includes("tools.ruff"), "Cached Profile must contain ruff");
    await click("Discover tools");
    await until(() => document.body.textContent?.includes("Add 1 accepted tool") === true, "Initial declaration was not respected");
    assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes("In the folder"));
    await click("Scan again");
    await until(() => document.body.textContent?.includes("Add 2 accepted tools") === true, "Rescan did not include the removed declaration");
    assert.equal(document.querySelector('[role="dialog"]')?.textContent?.includes("In the folder"), false);
    assert.equal(app.requests.filter((request) => request === "GET /api/profile/items").length, 1, "Rescan should not depend on a refreshed Profile cache");
    await click("Add 2 accepted tools");
    await until(() => !document.querySelector('[role="dialog"]'), "Acceptance did not finish");
    assert.deepEqual(app.mutations.find(({ path }) => path === "/api/profile/scan/accept")?.body, { reviewDigest: "reviewed-2", confirmAll: true });
  } finally { await app.close(); }
});


it("a changed folder snapshot invalidates publication review evidence", async () => {
  const responses: Record<string, unknown> = { ...sourceResponses(), "/api/profile/validate": { valid: true, errors: [], reviewDigest: "reviewed-digest", profile: {} } };
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

it("publication names the digest its validation reviewed", async () => {
  const reviewDigest = randomUUID();
  const responses: Record<string, unknown> = { ...sourceResponses(), "/api/profile/validate": { valid: true, errors: [], reviewDigest, profile: {} } };
  const app = await fixture("/source/profile", responses);
  try {
    await until(() => !app.container.querySelector('[aria-busy="true"]'), "Profile did not load");
    await click("Validate");
    await until(() => app.container.querySelector('[data-testid="validation"]')?.textContent === "true", "Validation did not finish");
    await click("Publish");
    await until(() => app.mutations.some(({ path }) => path === "/api/publications"), "Publication did not start");
    assert.deepEqual(app.mutations.find(({ path }) => path === "/api/publications")?.body, { reviewer: "Alice", reviewDigest });
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
    "/api/agent/policy": "agent-apply",
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
    assert.equal(app.container.textContent?.split("Policy saved. Harness has not been saved.").length, 2);
    assert.equal(app.container.querySelector('[data-testid="policy"]')?.textContent, "agent-propose");
  } finally { await app.close(); }
});

it("offers the domain installer methods in Settings", async () => {
  const app = await fixture("/source/settings/installers", {
    ...sourceResponses(),
    "/api/installers": { bindings: [], detected: [] },
  });
  try {
    await until(() => app.container.textContent?.includes("No installers set up") === true, "Installers did not load");
    await click("Add installer");
    const trigger = document.querySelector("#installer-method");
    assert.ok(trigger);
    await act(async () => {
      trigger.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    const choices = [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent);
    assert.deepEqual(choices, installerMethods);
  } finally {
    await app.close();
  }
});

it("reviews and saves complete harness bounds while deterministic-only stays selected", async () => {
  const harness = {
    kind: "codex", executable: "codex", maximumInputBytes: 4096,
    allowedPaths: ["/tmp/agent-work"], allowedExecutables: ["printf"],
    executableAuthorizations: [{ executable: "printf", behavior: "leaf" }],
    allowedOrigins: ["https://api.example.com"], allowedCapabilities: ["restart"],
    secretBindings: [{ name: "API_TOKEN", secret: "api-token" }],
    environment: [{ name: "PLAIN_NAME", value: "not-rendered-environment-value" }],
  };
  const app = await fixture("/follower/settings/agent", {
    "/api/status": { machineRole: { role: "follower" }, lifecycle: {}, tunnel: null },
    "/api/agent/policy": "deterministic-only",
    "/api/agent/harness": { configured: true, value: harness },
  }, (path, method, body, outgoing) => {
    if (method !== "PUT") return false;
    outgoing.end(JSON.stringify(path === "/api/agent/policy" ? "deterministic-only" : body));
    return true;
  });
  try {
    await until(() => !!app.container.querySelector("#ap-origins"), "Harness form did not load");
    assert.equal(app.container.querySelector<HTMLTextAreaElement>("#ap-origins")?.value, "https://api.example.com");
    assert.equal(app.container.querySelector<HTMLTextAreaElement>("#ap-executables")?.value, "printf");
    assert.equal(app.container.querySelector<HTMLTextAreaElement>("#ap-bindings")?.value, "API_TOKEN=api-token");
    assert.ok(app.container.textContent?.includes("PLAIN_NAME"));
    assert.ok(!app.container.textContent?.includes("not-rendered-environment-value"));
    const bindingInput = app.container.querySelector<HTMLTextAreaElement>("#ap-bindings");
    assert.ok(bindingInput);
    const advanced = bindingInput.closest("details");
    assert.ok(advanced);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(bindingInput, "invalid binding");
      bindingInput.dispatchEvent(new window.Event("input", { bubbles: true }));
      advanced.open = false;
    });
    await click("Review settings");
    assert.equal(advanced.open, true);
    assert.equal(document.activeElement, bindingInput);
    assert.equal(bindingInput.getAttribute("aria-invalid"), "true");
    assert.equal(app.mutations.length, 0);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(bindingInput, "API_TOKEN=api-token");
      bindingInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const model = app.container.querySelector<HTMLInputElement>("#ap-model");
    assert.ok(model);
    await fill("#ap-model", "two words");
    await click("Review settings");
    assert.equal(model.getAttribute("aria-invalid"), "true");
    assert.equal(document.activeElement, model);
    assert.equal(app.mutations.length, 0);
    await fill("#ap-model", "test-model");
    await act(async () => {
      for (const id of ["ap-origins", "ap-executables", "ap-bindings"]) {
        const input = app.container.querySelector<HTMLTextAreaElement>(`#${id}`);
        assert.ok(input);
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, ` ${input.value} \n`);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      }
    });
    await click("Review settings");
    assert.equal(app.mutations.length, 0);
    assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes("May restart services or applications"));
    assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes("Deterministic only"));
    assert.ok(!document.querySelector('[role="dialog"]')?.textContent?.includes("deterministic-only"));
    await click("Save settings");
    await until(() => app.mutations.length === 2, "Harness settings did not save");
    assert.equal(app.mutations[0]?.body, "deterministic-only");
    assert.deepEqual(app.mutations[1]?.body, { ...harness, model: "test-model" });
    await until(() => app.container.textContent?.includes("Policy and harness saved.") === true, "Save did not settle");
    assert.equal(app.container.querySelector<HTMLTextAreaElement>("#ap-origins")?.value, "https://api.example.com");
    assert.equal(app.container.querySelector<HTMLTextAreaElement>("#ap-executables")?.value, "printf");
    assert.equal(app.container.querySelector<HTMLTextAreaElement>("#ap-bindings")?.value, "API_TOKEN=api-token");
    const buttons = [...app.container.querySelectorAll("button")];
    assert.equal(buttons.find((button) => button.textContent === "Reload settings")?.disabled, false);
    assert.equal(buttons.find((button) => button.textContent === "Review settings")?.disabled, true);
    assert.equal(buttons.some((button) => button.textContent === "Discard"), false);
  } finally { await app.close(); }
});

for (const initialPolicy of ["deterministic-only", "agent-propose"]) {
  for (const failure of ["harness", "policy", null]) {
    it(`saves bounds before enabling agent-apply from ${initialPolicy} when ${failure ?? "nothing"} fails`, async () => {
      const harness = { kind: "codex", executable: "codex", maximumInputBytes: 4096,
        allowedPaths: [], allowedExecutables: ["printf"], allowedOrigins: [], allowedCapabilities: ["reboot"] };
      const app = await fixture("/follower/settings/agent", {
        "/api/status": { machineRole: { role: "follower" }, lifecycle: {}, tunnel: null },
        "/api/agent/policy": initialPolicy,
        "/api/agent/harness": { configured: true, value: harness },
      }, (path, method, body, outgoing) => {
        if (method !== "PUT") return false;
        if (path === `/api/agent/${failure}`) {
          outgoing.statusCode = 500;
          outgoing.end(JSON.stringify({ category: "internal", exitCode: 1, message: "Save refused" }));
        } else outgoing.end(JSON.stringify(path === "/api/agent/policy" ? "agent-apply" : body));
        return true;
      });
      try {
        await until(() => !!app.container.querySelector("#ap-origins"), "Harness did not load");
        assert.ok(!app.container.textContent?.includes("Environment names"));
        assert.ok(!app.container.textContent?.includes("Allowed capabilities:"));
        await click("Save apply agent");
        const terminal = failure === "harness" ? "HarnessFirstFailed" : failure === "policy" ? "PolicyLastFailed" : "Saved";
        await until(() => {
          const state = app.container.querySelector('[data-testid="policy-save"]')?.textContent;
          return !!state && JSON.parse(state).kind === terminal;
        }, "Save did not settle");
        assert.deepEqual(app.mutations.map(({ path }) => path), failure === "harness"
          ? ["/api/agent/harness"] : ["/api/agent/harness", "/api/agent/policy"]);
        assert.equal(app.container.querySelector('[data-testid="policy"]')?.textContent, failure ? initialPolicy : "agent-apply");
        assert.deepEqual(app.mutations[0]?.body, { ...harness, allowedExecutables: ["env"],
          executableAuthorizations: [{ executable: "env", behavior: "leaf" }], secretBindings: [], allowedCapabilities: [] });
        assert.ok(!app.container.textContent?.includes("Policy saved. Harness has not been saved."));
        if (failure === "policy") assert.equal(app.container.textContent?.split("Harness saved. Policy has not been saved.").length, 2);
      } finally { await app.close(); }
    });
  }
}

const trackedSkills = ["review", "testing", "conflict"].map((name) => ({
  name, path: `skills/${name}`, source: "/tmp/upstream", ref: "main", subdir: name,
  commit: "a".repeat(40), digest: "b".repeat(64),
}));
const trackedProfile = {
  ...profile,
  items: trackedSkills.map(({ name, path }) => ({
    path, digest: "e".repeat(64),
    files: [{ path: `${path}/SKILL.md`, base64: Buffer.from(`---\nname: ${name}\ndescription: Review ${name}.\n---\nSkill instructions.\n`).toString("base64"), executable: false }],
  })),
};
const skillCheck = (name: string, status: "update-available" | "local-edits" = "update-available") => ({
  name, path: `skills/${name}`, previousCommit: "a".repeat(40), nextCommit: "c".repeat(40),
  previousDigest: "b".repeat(64), nextDigest: "d".repeat(64),
  status, added: ["reference.txt"], changed: ["SKILL.md"], removed: [],
});

it("reviews all tracked skills, invalidates preview on selection changes and applies one selected-set operation", async () => {
  let checks: readonly GuiSkillCheck[] = [];
  let applying = false;
  let refuse = true;
  const app = await fixture("/source/profile", { ...sourceResponses(), "/api/profile/items": trackedProfile, "/api/skills": { version: 1, skills: trackedSkills } }, (path, method, body, outgoing) => {
    if (method === "POST" && (path === "/api/skills/check" || path === "/api/skills/update")) {
      applying = path.endsWith("/update");
      const names = applying
        ? Schema.decodeUnknownSync(GuiSkillUpdate)(body).expected.map(({ name }) => name)
        : Schema.decodeUnknownSync(GuiSkillSelection)(body).names;
      checks = (names.length ? names : trackedSkills.map(({ name }) => name)).map((name) => skillCheck(name, name === "conflict" ? "local-edits" : "update-available"));
      outgoing.end(JSON.stringify({ id: "skills-ticket" })); return true;
    }
    if (path !== "/api/operations/skills-ticket") return false;
    outgoing.end(JSON.stringify(applying && refuse
      ? { id: "skills-ticket", state: "failed", journal: null, failure: { category: "conflict-or-drift", exitCode: 4, message: "Local edits detected. No skill was updated." } }
      : { id: "skills-ticket", state: "succeeded", journal: null, result: checks }));
    return true;
  });
  const toggle = async (name: string) => {
    const label = [...document.querySelectorAll("label")].find((entry) => entry.textContent?.startsWith(name));
    const checkbox = label?.querySelector<HTMLButtonElement>('[role="checkbox"]');
    assert.ok(checkbox, `Missing selection for ${name}`);
    await act(async () => { checkbox.click(); });
  };
  try {
    await until(() => !app.container.querySelector('[aria-busy="true"]'), "Profile did not load");
    const entry = [...document.querySelectorAll("button")].find((button) => button.textContent === "Skill updates");
    assert.ok(entry);
    assert.ok(entry.closest('[class~="group/band"]'));
    assert.equal(entry.closest("header"), null);
    await click("Skill updates");
    assert.equal(document.querySelector('[aria-label="Update preview"]'), null);
    assert.deepEqual([...document.querySelectorAll('[data-slot="dialog-footer"] button')].map((button) => button.textContent), ["Cancel", "Check"]);
    assert.equal(document.body.textContent?.includes("Select all"), false);
    assert.equal(document.body.textContent?.includes("Clear selection"), false);
    await click("Check");
    await until(() => document.body.textContent?.includes("Deselect skills with local edits or reconcile them, then check again.") === true, "Batch preview did not show conflicts");
    assert.deepEqual(app.mutations.at(-1), { path: "/api/skills/check", body: { names: [] } });
    assert.equal([...document.querySelectorAll("button")].find((entry) => entry.textContent === "Apply 2 updates")?.disabled, true);
    assert.ok(document.querySelector('[aria-label="Update preview"]')?.textContent?.includes("reference.txt"));
    assert.deepEqual([...document.querySelectorAll('[data-slot="dialog-footer"] button')].map((button) => button.textContent), ["Cancel", "Apply 2 updates"]);
    await toggle("conflict");
    assert.equal(document.querySelector('[aria-label="Update preview"]'), null);
    await click("Check");
    await until(() => document.querySelector('[aria-label="Update preview"]') !== null, "Selected preview did not load");
    assert.deepEqual(app.mutations.at(-1), { path: "/api/skills/check", body: { names: ["review", "testing"] } });
    await click("Apply 2 updates");
    await until(() => document.body.textContent?.includes("No skill was updated.") === true, "Apply conflict did not render");
    assert.equal(document.querySelector('[aria-label="Update result"]'), null);
    assert.equal(document.querySelectorAll('[role="alert"]').length, 1);
    assert.ok(document.querySelector('[role="alert"]')?.closest('[role="dialog"]'));
    assert.equal([...document.querySelectorAll("button")].some((button) => button.textContent === "Reload"), false);
    refuse = false;
    await click("Check");
    await until(() => document.querySelector('[aria-label="Update preview"]') !== null, "Retry preview did not load");
    await click("Apply 2 updates");
    await until(() => document.querySelector('[aria-label="Update result"]') !== null, "Batch result did not render");
    assert.deepEqual([...document.querySelectorAll('[data-slot="dialog-footer"] button')].map((button) => button.textContent), ["Close", "Check"]);
    const result = document.querySelector('[aria-label="Update result"]');
    assert.equal([...result!.querySelectorAll("span")].filter((entry) => entry.textContent === "Updated").length, 2);
    assert.ok(result?.textContent?.includes("ccccccc"));
    assert.deepEqual(app.mutations.filter(({ path }) => path === "/api/skills/update").map(({ body }) => body), [
      { expected: ["review", "testing"].map((name) => ({ name, path: `skills/${name}`, previousCommit: "a".repeat(40), nextCommit: "c".repeat(40), previousDigest: "b".repeat(64), nextDigest: "d".repeat(64) })) },
      { expected: ["review", "testing"].map((name) => ({ name, path: `skills/${name}`, previousCommit: "a".repeat(40), nextCommit: "c".repeat(40), previousDigest: "b".repeat(64), nextDigest: "d".repeat(64) })) },
    ]);
    assert.equal(app.mutations.some(({ path }) => path === "/api/publications"), false);
  } finally { await app.close(); }
});

it("resumes a lost batch poll without resubmitting and applies its explicit reviewed set", async () => {
  let lost = true;
  const app = await fixture("/source/profile", { ...sourceResponses(), "/api/profile/items": trackedProfile, "/api/skills": { version: 1, skills: trackedSkills } }, (path, method, _body, outgoing) => {
    if (path === "/api/skills/update" && method === "POST") { outgoing.end('{"id":"applied-skills"}'); return true; }
    if (path === "/api/operations/applied-skills") {
      outgoing.end(JSON.stringify({ id: "applied-skills", state: "succeeded", journal: null, result: trackedSkills.map(({ name }) => skillCheck(name)) })); return true;
    }
    if (path === "/api/skills/check" && method === "POST") { outgoing.end('{"id":"lost-skills"}'); return true; }
    if (path !== "/api/operations/lost-skills") return false;
    if (lost) {
      outgoing.statusCode = 503;
      outgoing.end(JSON.stringify({ category: "transport", exitCode: 6, message: "Operation observation interrupted." }));
    } else outgoing.end(JSON.stringify({ id: "lost-skills", state: "succeeded", journal: null, result: trackedSkills.map(({ name }) => skillCheck(name)) }));
    return true;
  });
  try {
    await until(() => !app.container.querySelector('[aria-busy="true"]'), "Profile did not load");
    await click("Skill updates"); await click("Check");
    await until(() => document.body.textContent?.includes("Resume status check") === true, "Lost observation did not offer resume");
    assert.deepEqual([...document.querySelectorAll('[data-slot="dialog-footer"] button')].map((button) => button.textContent), ["Cancel", "Resume status check"]);
    assert.equal(document.querySelectorAll('[role="alert"]').length, 1);
    lost = false;
    await click("Resume status check");
    await until(() => document.querySelector('[aria-label="Update preview"]') !== null, "Original batch observation did not resume");
    assert.equal(app.mutations.filter(({ path }) => path === "/api/skills/check").length, 1);
    assert.equal(app.requests.filter((entry) => entry === "GET /api/operations/lost-skills").length, 2);
    await click("Apply 3 updates");
    await until(() => document.querySelector('[aria-label="Update result"]') !== null, "Reviewed all-skills set did not apply");
    const submitted = app.mutations.find(({ path }) => path === "/api/skills/update");
    assert.ok(submitted);
    const { expected } = Schema.decodeUnknownSync(GuiSkillUpdate)(submitted.body);
    assert.deepEqual(expected.map(({ name }) => name), trackedSkills.map(({ name }) => name));
  } finally { await app.close(); }
});
