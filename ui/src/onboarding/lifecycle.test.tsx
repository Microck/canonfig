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
import type { EnrollmentController } from "./enrollment-controller";

GlobalRegistrator.register({ url: "http://localhost/setup", settings: { device: { prefersReducedMotion: "reduce" } } });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Motion must detect the registered DOM, not the Node-only module-loading environment.
const { MotionConfig } = await import("motion/react");
const { createRoot } = await import("react-dom/client");
const { EnrollmentOnboarding, useEnrollmentController } = await import("./enrollment-controller");
const { TooltipProvider } = await import("../components/ui/tooltip");
after(async () => { await GlobalRegistrator.unregister(); });
const session = GuiSession.make({ role: "unconfigured", machineName: "Isolated test", folderPath: "/tmp/onboarding-test", version: "7.0.0" });
const journal = { schema: "canonfig.setup/v2", scope: "full", discoveryPaths: [], discoveryInputs: [], role: "source", planDigest: "digest", intent: "Test", inventory: { schema: "canonfig.setup-inventory/v1", platform: "linux", home: "/tmp/onboarding-test", account: "test", osRelease: "test", nodeRuntime: "24", credentialStorage: { kind: "local-file" }, transport: { policy: "loopback", initialized: false }, tools: [], discoveryFiles: 0, discoveryEvidence: 0, discoveryDigest: "" }, items: [], records: [], approvals: [], decisions: [], exclusions: [], evidence: [], catalog: [], stages: [], createdAt: "", updatedAt: "" };
const inspection = { endpoint: "https://127.0.0.1:17342", sourceFingerprint: "source", tlsFingerprint: "tls", expiresAt: "2099-01-01T00:00:00Z", groups: [] };
let current: EnrollmentController;
function Probe({ backend }: { backend: WorkspaceBackend }) {
  current = useEnrollmentController(backend, session);
  return <div>{current.joined ? "Joined" : "Not joined"}</div>;
}
async function fixture(handler: (path: string, method: string, out: ServerResponse) => void, wizard = false) {
  const server = createServer((req, out) => {
    out.setHeader("Content-Type", "application/json");
    out.setHeader("Access-Control-Allow-Origin", "http://localhost");
    out.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    out.setHeader("Access-Control-Allow-Headers", "content-type, x-canonfig-request, cache-control");
    if (req.method === "OPTIONS") { out.end(); return; }
    req.resume(); req.on("end", () => handler(req.url ?? "/", req.method ?? "GET", out));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const backend: WorkspaceBackend = {
    request: (url, schema, signal, mutation) => request(`${base}${url}`, schema, signal, mutation),
    operation: (id, signal) => request(`${base}/api/operations/${id}`, GuiOperation, signal),
    status: (signal) => request(`${base}/api/status`, GuiStatus, signal),
    session: (signal) => request(`${base}/api/session`, GuiSession, signal),
  };
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(wizard ? <MotionConfig skipAnimations><TooltipProvider><EnrollmentOnboarding backend={backend} session={session} /></TooltipProvider></MotionConfig> : <Probe backend={backend} />));
  return { container, async close() { await act(async () => root.unmount()); container.remove(); server.closeAllConnections(); const stopped = once(server, "close"); server.close(); await stopped; } };
}
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await delay(10); });
    if (check()) return;
  }
  assert.fail("Onboarding did not reach the expected state");
}
function respond(out: ServerResponse, body: unknown) { out.end(JSON.stringify(body)); }
function failure(out: ServerResponse) { out.statusCode = 500; respond(out, { category: "internal", exitCode: 1, message: "Observation unavailable" }); }

it("Source discovery cannot replace a newer Follower choice", async () => {
  let pending: ServerResponse | undefined;
  const app = await fixture((_path, _method, out) => { pending = out; }, true);
  try {
    const source = [...app.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Make this the Source"));
    const follower = [...app.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Copy the setup from another machine"));
    assert.ok(source && follower);
    await act(async () => source.click()); await until(() => !!pending);
    // Inspection either locks the choice or admits the newer role and invalidates the old request.
    if (!follower.disabled && !follower.closest("[inert]")) await act(async () => follower.click());
    const choseFollower = app.container.textContent?.includes("Add the invitation file");
    await act(async () => respond(pending!, journal));
    await until(() => !app.container.textContent?.includes("Inspecting this machine"));
    if (choseFollower) assert.ok(app.container.textContent?.includes("Add the invitation file"), "Older Source discovery replaced Follower");
    else assert.ok(follower.disabled || follower.closest("[inert]"), "Source inspection must own the choice until it settles");
  } finally { await app.close(); }
});

it("join success followed by report failure retains explicit joined recovery state", async () => {
  const app = await fixture((path, _method, out) => {
    if (path === "/api/enrollment/inspect") respond(out, inspection);
    else if (path === "/api/enrollment") respond(out, { id: "join" });
    else if (path === "/api/operations/join") respond(out, { id: "join", state: "succeeded", journal: null, result: {} });
    else failure(out);
  });
  try {
    await act(async () => { await current.inspectInvitation("envelope", () => {}); });
    await act(async () => { await current.join({ name: "laptop", replace: false, tunnel: false, sshHost: "", sshUser: "", sshPort: 22, hostKey: "", localPort: 17342 }); });
    assert.equal(current.joined, true);
    assert.equal(current.followerState.kind, "joined-unavailable");
    assert.equal(current.envelope, "");
    assert.equal(current.harnessReport, null);
  } finally { await app.close(); }
});

it("a concurrent inspection is refused before it can clear the active envelope", async () => {
  let pending: ServerResponse | undefined;
  const app = await fixture((_path, _method, out) => { pending = out; });
  try {
    let inspectionPromise: Promise<void> | undefined;
    await act(async () => { inspectionPromise = current.inspectInvitation("first-envelope", () => {}, "first"); });
    await until(() => !!pending);
    assert.throws(() => current.inspectInvitation("second-envelope", () => {}), { _tag: "TransitionError" });
    assert.equal(current.followerState.kind, "inspecting");
    assert.ok(inspectionPromise);
    await act(async () => { respond(pending!, inspection); await inspectionPromise; });
    assert.equal(current.envelope, "first-envelope");
    assert.equal(current.invitationLabel, "first");
  } finally { await app.close(); }
});

it("a status reload certifies completed setup after a lost apply observation", async () => {
  let failStatus = true;
  const app = await fixture((path, _method, out) => {
    if (path === "/api/setup/plan") respond(out, journal);
    else if (path === "/api/setup/approve") respond(out, { ...journal, approvals: [{ digest: "digest", approver: "test", approvedAt: "" }] });
    else if (path === "/api/setup/apply") respond(out, { id: "setup" });
    else if (path === "/api/operations/setup") respond(out, { id: "setup", state: "succeeded", journal: null, result: {} });
    else if (failStatus) failure(out);
    else respond(out, { planDigest: "digest", stage: "complete", approved: true, items: [], approvals: [], discoveryPaths: [], stages: [], catalog: [] });
  });
  try {
    await act(async () => { await current.planSetup([], [], () => {}); });
    await act(async () => { current.setApprover("test"); });
    await act(async () => { await current.approveSetup(); });
    await act(async () => { await current.applySetup(); });
    assert.equal(current.applied, false);
    failStatus = false;
    await act(async () => { current.reloadStatus(); });
    await until(() => !current.state.loading);
    assert.equal(current.applied, true, "Reloaded journal must certify completion without another apply");
  } finally { await app.close(); }
});

it("approval remains committed when its follow-up status read fails", async () => {
  let approvals = 0;
  const app = await fixture((path, _method, out) => {
    if (path === "/api/setup/plan") respond(out, journal);
    else if (path === "/api/setup/approve") {
      approvals++;
      respond(out, { ...journal, approvals: [{ digest: "digest", approver: "test", approvedAt: "" }] });
    } else failure(out);
  });
  try {
    await act(async () => { await current.planSetup([], [], () => {}); });
    await act(async () => { current.setApprover("test"); });
    await act(async () => { await current.approveSetup(); });
    assert.equal(current.sourceState.kind, "observation-lost");
    assert.equal(current.approved, true);
    assert.throws(() => current.approveSetup(), { _tag: "TransitionError" });
    assert.equal(approvals, 1, "A lost status read must not repeat approval");
  } finally { await app.close(); }
});

it("setup stopping for human action is not reported as complete", async () => {
  let stage = "approved";
  const app = await fixture((path, _method, out) => {
    if (path === "/api/setup/plan") respond(out, journal);
    else if (path === "/api/setup/approve") respond(out, { ...journal, approvals: [{ digest: "digest", approver: "test", approvedAt: "" }] });
    else if (path === "/api/setup/apply") { stage = "human-action-required"; respond(out, { id: "setup" }); }
    else if (path === "/api/operations/setup") respond(out, { id: "setup", state: "succeeded", journal: null, result: {} });
    else respond(out, { planDigest: "digest", stage, approved: true, items: [], approvals: [], discoveryPaths: [], stages: [], catalog: [] });
  });
  try {
    await act(async () => { await current.planSetup([], [], () => {}); });
    await act(async () => { current.setApprover("test"); });
    await act(async () => { await current.approveSetup(); });
    await act(async () => { await current.applySetup(); });
    assert.equal(current.sourceState.kind, "needs-human-action");
    assert.equal(current.applied, false);
  } finally { await app.close(); }
});

it("preference retry preserves its draft and rechecks partial server progress", async () => {
  let writes = 0;
  let excluded: string[] = [];
  const report = () => ({ folder: "/tmp/onboarding-test", configured: true, listed: [], excluded, detected: [], notInstalled: [], snapshots: 0, harnesses: [] });
  const app = await fixture((path, method, out) => {
    if (path === "/api/enrollment/inspect") respond(out, inspection);
    else if (path === "/api/enrollment") respond(out, { id: "join" });
    else if (path === "/api/operations/join") respond(out, { id: "join", state: "succeeded", journal: null, result: {} });
    else if (path === "/api/harnesses" && method === "GET") respond(out, report());
    else if (++writes === 2) failure(out);
    else { excluded = writes === 1 ? ["amp"] : ["amp", "antigravity"]; respond(out, report()); }
  });
  try {
    await act(async () => { await current.inspectInvitation("envelope", () => {}); });
    await act(async () => { await current.join({ name: "laptop", replace: false, tunnel: false, sshHost: "", sshUser: "", sshPort: 22, hostKey: "", localPort: 17342 }); });
    await act(async () => { await current.savePreferences(["amp", "antigravity"], false); });
    assert.equal(current.followerState.kind, "preferences-failed");
    assert.deepEqual(current.preferenceDraft?.excluded, ["amp", "antigravity"]);
    assert.equal(current.followerState.kind === "preferences-failed" ? current.followerState.applied.length : 0, 1);
    await act(async () => { await current.savePreferences(["amp", "antigravity"], false); });
    assert.equal(writes, 3, "Retry should skip the already committed harness");
    assert.equal(current.preferencesSaved, true);
  } finally { await app.close(); }
});
