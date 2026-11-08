/// <reference types="node" />
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { after, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { Schema } from "effect";
import { request, type WorkspaceBackend } from "../gui-client";
import { GuiOperation, GuiSession, GuiSetupPlanInput, GuiStatus } from "../../../src/gui/contract";
import type { EnrollmentController } from "./enrollment-controller";

GlobalRegistrator.register({ url: "http://localhost/setup", settings: { device: { prefersReducedMotion: "reduce" } } });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Motion must detect the registered DOM, not the Node-only module-loading environment.
const { MotionConfig } = await import("motion/react");
const { createRoot } = await import("react-dom/client");
const { EnrollmentOnboarding, useEnrollmentController } = await import("./enrollment-controller");
const { TooltipProvider } = await import("../components/ui/tooltip");
after(async () => { await GlobalRegistrator.unregister(); });
const session = GuiSession.make({ role: "unconfigured", machineName: "Isolated test", folderPath: "/tmp/onboarding-test", version: "7.1.0" });
const journal = { schema: "canonfig.setup/v3", scope: "full", discoveryPaths: [], discoveryInputs: [], role: "source", planDigest: "digest", intent: "Test", inventory: { schema: "canonfig.setup-inventory/v1", platform: "linux", home: "/tmp/onboarding-test", account: "test", osRelease: "test", nodeRuntime: "24", credentialStorage: { kind: "local-file" }, transport: { policy: "loopback", initialized: false }, tools: [], discoveryFiles: 0, discoveryEvidence: 0, discoveryDigest: "" }, items: [], records: [], approvals: [], decisions: [], exclusions: [], evidence: [], catalog: [], stages: [], createdAt: "", updatedAt: "" };
const inspection = { endpoint: "https://127.0.0.1:17342", sourceFingerprint: "source", tlsFingerprint: "tls", expiresAt: "2099-01-01T00:00:00Z", groups: [] };
let current: EnrollmentController;
function Probe({ backend }: { backend: WorkspaceBackend }) {
  current = useEnrollmentController(backend, session);
  return <div>{current.joined ? "Joined" : "Not joined"}</div>;
}
async function fixture(handler: (path: string, method: string, out: ServerResponse, body: string) => void, wizard = false) {
  const server = createServer((req, out) => {
    out.setHeader("Content-Type", "application/json");
    out.setHeader("Access-Control-Allow-Origin", "http://localhost");
    out.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    out.setHeader("Access-Control-Allow-Headers", "content-type, x-canonfig-request, cache-control");
    if (req.method === "OPTIONS") { out.end(); return; }
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => handler(req.url ?? "/", req.method ?? "GET", out, body));
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
/** The import tree starts collapsed; a search opens every branch that holds a match. */
async function reveal(container: Element, query: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]'); assert.ok(input);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set; assert.ok(setter);
  await act(async () => { setter.call(input, query); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
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

it("Source discovery shows actionable earlier-journal guidance", async () => {
  const message = "The setup journal at ~/.canonfig/setup.json was written by an earlier Canonfig. Inspect any setup side effects first, then move it aside and start setup again. Do not remove state.sqlite.";
  const app = await fixture((_path, _method, out) => {
    out.statusCode = 400;
    respond(out, { category: "human-action-required", exitCode: 3, message });
  }, true);
  try {
    const source = [...app.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Make this the Source"));
    assert.ok(source);
    await act(async () => source.click());
    await until(() => !!app.container.textContent?.includes(message));
    assert.ok(app.container.textContent?.includes("Do not remove state.sqlite."));
  } finally { await app.close(); }
});

for (const literal of [false, true]) it(`harness changes keep canonical ids and the item choice (primary literal: ${literal})`, async () => {
  const category = literal ? "mcp" : "skills";
  const first = { id: `codex/${category}/shared`, source: "codex", harnesses: ["codex"], category, name: "shared", path: literal ? "~/.codex/config.toml" : "~/.agents/skills/shared", target: literal ? "canonfig.jsonc#mcp.shared" : "skills/shared", secrets: literal ? ["env.TOKEN -> fromEnv TOKEN"] : [], notes: [] };
  const second = { ...first, id: `opencode/${category}/shared`, source: "opencode", harnesses: ["opencode"], path: literal ? "~/.config/opencode/opencode.json" : "~/.config/opencode/skills/shared", secrets: [] };
  let submitted: readonly string[] | null = null;
  const app = await fixture((path, _method, out, body) => {
    if (path !== "/api/setup/plan") {
      respond(out, { stage: "role", approved: false, approvals: [], stages: [], items: [], catalog: [], discoveryPaths: [] });
      return;
    }
    const input = Schema.decodeUnknownSync(GuiSetupPlanInput)(JSON.parse(body));
    const harnesses = input.harnesses ?? ["codex", "opencode"];
    if (input.imports.kind !== "offer") submitted = input.imports.kind === "some" ? input.imports.requested : [];
    respond(out, { ...journal, items: [{
      id: "canonfig-folder", kind: "folder-scaffold", scope: "machine", optional: false, dependsOn: [],
      detail: { harnesses, detected: ["codex", "opencode"] },
    }], imports: {
      request: input.imports.kind, offered: [first, second].filter((offer) => harnesses.includes(offer.source)),
      present: [], skipped: [], collisions: [],
    } });
  }, true);
  const press = async (label: string) => {
    const button = [...app.container.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
    assert.ok(button, `Missing ${label}`);
    await act(async () => button.click());
  };
  const codex = () => {
    const label = [...app.container.querySelectorAll('ul[aria-label="Installed AI coding tools"] label')].find((node) => node.textContent?.includes("Codex"));
    const checkbox = label?.querySelector<HTMLButtonElement>('[role="checkbox"]');
    assert.ok(checkbox);
    return checkbox;
  };
  const shared = () => {
    const checkbox = app.container.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label^="shared from"]');
    assert.ok(checkbox);
    return checkbox;
  };
  const review = async () => {
    await until(() => !!app.container.querySelector('[aria-label="Review imports"]'));
    await reveal(app.container, "shared");
  };
  try {
    const source = [...app.container.querySelectorAll("button")].find((node) => node.textContent?.includes("Make this the Source"));
    assert.ok(source); await act(async () => source.click());
    await until(() => !!app.container.querySelector("form"));
    await press("Continue"); await press("Continue");
    await review();
    // A literal credential needs no separate consent: the row names the variable and checking it agrees.
    if (literal) assert.ok(app.container.textContent?.includes("Needs $TOKEN"));
    await act(async () => shared().click());
    await press("Back"); await act(async () => codex().click()); await press("Continue");
    await review();
    await act(async () => shared().click());
    await press("Back"); await act(async () => codex().click()); await press("Continue");
    await review();
    assert.equal(shared().getAttribute("aria-checked"), "true");
    await press("Continue");
    await until(() => submitted !== null);
    assert.deepEqual(submitted, [first.id]);
  } finally { await app.close(); }
});

for (const retainedCollision of [false, true]) it(`a replacement collision choice survives removing and re-adding the earlier harness (collision retained: ${retainedCollision})`, async () => {
  const first = { id: "claude-code/instructions/AGENTS.md", source: "claude-code", harnesses: ["claude-code"], category: "instructions", name: "AGENTS.md", target: "AGENTS.md", path: "~/.claude/CLAUDE.md", secrets: [], notes: [] };
  const second = { ...first, id: "codex/instructions/AGENTS.md", source: "codex", harnesses: ["codex"], path: "~/.codex/AGENTS.md" };
  let submitted: readonly string[] | null = null;
  const app = await fixture((path, _method, out, body) => {
    if (path !== "/api/setup/plan") {
      respond(out, { stage: "role", approved: false, approvals: [], stages: [], items: [], catalog: [], discoveryPaths: [] });
      return;
    }
    const input = Schema.decodeUnknownSync(GuiSetupPlanInput)(JSON.parse(body));
    const harnesses = input.harnesses ?? ["claude-code", "codex"];
    if (input.imports.kind !== "offer") submitted = input.imports.kind === "some" ? input.imports.requested : [];
    const offered = [first, second].filter((offer) => harnesses.includes(offer.source));
    respond(out, { ...journal, items: [{
      id: "canonfig-folder", kind: "folder-scaffold", scope: "machine", optional: false, dependsOn: [],
      detail: { harnesses, detected: ["claude-code", "codex"] },
    }], imports: {
      request: input.imports.kind, offered, present: [], skipped: [],
      collisions: offered.length > 1 || retainedCollision ? [{ kind: "candidates", target: "AGENTS.md", candidates: offered.map(({ id, source, path }) => ({ id, source, path })) }] : [],
    } });
  }, true);
  const press = async (label: string) => {
    const button = [...app.container.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
    assert.ok(button, `Missing ${label}`);
    await act(async () => button.click());
  };
  const choose = async (tool: string) => {
    await until(() => !!app.container.querySelector('[aria-label="Review imports"]'));
    await reveal(app.container, "AGENTS.md");
    const checkbox = app.container.querySelector<HTMLButtonElement>(`[role="checkbox"][aria-label="AGENTS.md from ${tool}"]`); assert.ok(checkbox, `Missing AGENTS.md from ${tool}`);
    await act(async () => checkbox.click());
  };
  const toggleClaude = async () => {
    const label = [...app.container.querySelectorAll('ul[aria-label="Installed AI coding tools"] label')].find((node) => node.textContent?.includes("Claude Code"));
    const checkbox = label?.querySelector<HTMLButtonElement>('[role="checkbox"]'); assert.ok(checkbox);
    await act(async () => checkbox.click());
  };
  try {
    const source = [...app.container.querySelectorAll("button")].find((node) => node.textContent?.includes("Make this the Source"));
    assert.ok(source); await act(async () => source.click());
    await until(() => !!app.container.querySelector("form"));
    await press("Continue"); await press("Continue");
    await choose("Claude Code");
    // Without Claude Code the target may stop being a collision; either way the person picks Codex's copy.
    await press("Back"); await toggleClaude(); await press("Continue");
    await choose("OpenAI Codex");
    await press("Back"); await toggleClaude(); await press("Continue");
    await until(() => !!app.container.querySelector('[aria-label="Review imports"]'));
    await press("Continue");
    await until(() => submitted !== null);
    assert.deepEqual(submitted, [second.id]);
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
