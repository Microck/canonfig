/// <reference types="node" />
import assert from "node:assert/strict";
import { after, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Setup } from "@/onboarding/onboarding";
import type { Workspace } from "./workspace-types";
GlobalRegistrator.register({ url: "http://localhost/follower/sync" });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Navigation preference modules need the isolated browser before loading.
const { SimulatedWorkspaceProvider } = await import("./simulated-store");
const { SharedStateProvider, seedSharedValue, sharedKey, useSharedReader, useSharedState, useWorkspace } = await import("./store");
const { createRoot } = await import("react-dom/client");
after(async () => { await GlobalRegistrator.unregister(); });
let ws: Workspace;
function Probe() { ws = useWorkspace(); return null; }
async function fixture(role: "source" | "follower", setup: Setup | null = null) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<SimulatedWorkspaceProvider route={{ kind: "workspace", role, view: role === "source" ? "profile" : "sync", focus: null, profileTab: "items", machinesMode: "map" }} navigate={() => {}} setup={setup}><Probe /></SimulatedWorkspaceProvider>));
  return async () => { await act(async () => root.unmount()); container.remove(); };
}
async function wait(ms: number) { await act(async () => { await delay(ms); }); }

it("uses the seeded shared value for the first edit and keeps the draft across pages", async () => {
  const draftKey = sharedKey("default");
  const seed = [seedSharedValue(draftKey, "seed")];
  const container = document.createElement("div");
  const root = createRoot(container);
  function EditPage() {
    const [draft, setDraft] = useSharedState(draftKey);
    return <button onClick={() => setDraft((current) => `${current} draft`)}>{draft}</button>;
  }
  function ReadPage() {
    const readDraft = useSharedReader(draftKey);
    return <p>{readDraft()}</p>;
  }
  try {
    await act(async () => root.render(<SharedStateProvider initial={() => seed}><EditPage /></SharedStateProvider>));
    const edit = container.querySelector("button");
    assert.ok(edit);
    assert.equal(edit.textContent, "seed");
    await act(async () => edit.click());
    await act(async () => root.render(<SharedStateProvider initial={() => seed}><ReadPage /></SharedStateProvider>));
    assert.equal(container.textContent, "seed draft");
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps Source and Follower onboarding choices ahead of demo defaults", async () => {
  const closeSource = await fixture("source", {
    role: "source", profileName: "My Profile", harnesses: [], imported: [], service: "manual", port: 17342, scan: false,
  });
  try {
    assert.equal(ws.serviceInstalled, false);
    assert.deepEqual(ws.skillSources, []);
  } finally {
    await closeSource();
  }
  const closeFollower = await fixture("follower", { role: "follower", name: "My Follower", tunnel: false, schedule: false, excluded: [] });
  try {
    assert.equal(ws.tunnelUp, false);
    assert.equal(ws.followerSchedule, null);
  } finally {
    await closeFollower();
  }
});

it("held plan entries never become pending, running or done", async () => {
  const close = await fixture("follower");
  try {
    await act(async () => { ws.recover(); });
    await act(async () => { ws.applyPlan(); });
    assert.equal(ws.plan.find((item) => item.action === "skip-drift")?.status, undefined);
    await wait(3700);
    assert.equal(ws.phase, "done");
    assert.equal(ws.plan.find((item) => item.action === "skip-drift")?.status, undefined);
    assert.equal(ws.plan.find((item) => item.action === "skip-drift")?.appliedRevision, 7, "Held evidence must retain its own older revision");
    assert.ok(ws.plan.filter((item) => item.action !== "skip-drift").every((item) => item.status === "done"));
  } finally { await close(); }
});

it("store commands reject apply before recovery and after unenrollment", async () => {
  const close = await fixture("follower");
  try {
    assert.throws(() => ws.applyPlan(), { name: "Error", _tag: "TransitionError" });
    await act(async () => { ws.unenroll(); });
    assert.throws(() => ws.applyPlan(), { name: "Error", _tag: "TransitionError" });
  } finally { await close(); }
});

it("publication clears only the frozen edits, not edits saved while it runs", async () => {
  const close = await fixture("source");
  try {
    const resource = ws.resources.find((item) => item.change); assert.ok(resource);
    await act(async () => { ws.publish("test", () => {}); });
    await act(async () => {
      ws.setResources((items) => items.map((item) => item.id === resource.id ? { ...item, summary: "Newer unpublished edit", change: "modified" } : item));
      ws.markProfileEdit({ area: "defaults", id: "defaults", change: "modified" });
    });
    await wait(1750);
    assert.ok(ws.pending.some((item) => item.id === resource.id), "Newer item was marked published");
    assert.ok(ws.pending.some((item) => item.area === "defaults"), "Newer defaults were marked published");
  } finally { await close(); }
});

it("older delivery completions cannot settle a newer revision delivery", async () => {
  const close = await fixture("source");
  try {
    const reachable = ws.followers.filter((item) => item.state !== "offline"); assert.ok(reachable.length > 1);
    await act(async () => { ws.publish("first", () => {}); });
    await wait(1700);
    await act(async () => {
      ws.markProfileEdit({ area: "defaults", id: "defaults", change: "modified" });
      ws.publish("second", () => {});
    });
    await wait(2500);
    assert.ok(ws.syncing.includes(reachable[1].id), "Old delivery removed newer delivery's progress");
    assert.notEqual(ws.followers.find((item) => item.id === reachable[1].id)?.revision, ws.latest, "New revision must still be delivering");
  } finally { await close(); }
});
