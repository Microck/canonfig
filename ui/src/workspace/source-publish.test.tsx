/// <reference types="node" />
import assert from "node:assert/strict";
import { after, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Workspace } from "./workspace-types";

GlobalRegistrator.register({ url: "http://localhost/source/overview", settings: { device: { prefersReducedMotion: "reduce" } } });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Static imports would register module-level browser listeners before the isolated DOM exists.
const { SimulatedWorkspaceProvider } = await import("./simulated-store");
const { WorkspaceContext, useWorkspace } = await import("./store");
const { createRoot } = await import("react-dom/client");
const { PublishDialog } = await import("./source");
const { TooltipProvider } = await import("../components/ui/tooltip");
after(async () => { await GlobalRegistrator.unregister(); });

let ws: Workspace;
function Controls({ reviewerDefault }: { reviewerDefault: string }) {
  ws = useWorkspace();
  return <WorkspaceContext value={{ ...ws, publicationReviewer: reviewerDefault }}>
    <button onClick={() => ws.setPublishOpen(true)}>Open Publish</button>
    <PublishDialog />
  </WorkspaceContext>;
}
async function fixture(reviewerDefault: string) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const render = async (currentDefault: string) => {
    await act(async () => root.render(<TooltipProvider><SimulatedWorkspaceProvider route={{ kind: "workspace", role: "source", view: "overview", focus: null, profileTab: "items", machinesMode: "map" }} navigate={() => {}}><Controls reviewerDefault={currentDefault} /></SimulatedWorkspaceProvider></TooltipProvider>));
  };
  await render(reviewerDefault);
  return { render, close: async () => { await act(async () => root.unmount()); container.remove(); } };
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
function reviewer() {
  const input = document.getElementById("pub-reviewer");
  assert.ok(input instanceof HTMLInputElement);
  return input;
}
async function fill(value: string) {
  const input = reviewer();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  assert.ok(setter);
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function until(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await delay(25); });
    if (check()) return;
  }
  assert.fail(message);
}

for (const reviewerDefault of ["maria", ""]) {
  for (const closeWith of ["Cancel", "Escape"]) {
    it(`${closeWith} discards the reviewer draft and reopens with default ${JSON.stringify(reviewerDefault)}`, async () => {
      const app = await fixture(reviewerDefault);
      try {
        const revisions = ws.revisions;
        const pending = ws.pending;
        await click("Open Publish");
        assert.equal(reviewer().value, reviewerDefault);
        await fill(closeWith === "Cancel" ? "Abandoned reviewer" : "");
        if (closeWith === "Cancel") await click("Cancel");
        else await act(async () => { reviewer().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
        assert.equal(document.querySelector('[role="dialog"]'), null);
        await click("Open Publish");
        assert.equal(reviewer().value, reviewerDefault);
        assert.equal(ws.publishing, false);
        assert.deepEqual(ws.revisions, revisions);
        assert.deepEqual(ws.pending, pending);
      } finally { await app.close(); }
    });
  }
}

it("a reopened Publish dialog reads the current workspace default", async () => {
  const app = await fixture("maria");
  try {
    await click("Open Publish");
    await fill("Abandoned reviewer");
    await click("Cancel");
    await app.render("Current reviewer");
    await click("Open Publish");
    assert.equal(reviewer().value, "Current reviewer");
  } finally { await app.close(); }
});

it("failed reviewer validation keeps the draft open until it is corrected and submitted", async () => {
  const app = await fixture("maria");
  try {
    const sequence = ws.nextSequence;
    const revisions = ws.revisions;
    const pending = ws.pending;
    await click("Open Publish");
    await fill("   ");
    await until(() => [...document.querySelectorAll("button")].some((candidate) => candidate.textContent === `Publish revision ${sequence}` && !candidate.disabled), "File validation did not finish");
    await click(`Publish revision ${sequence}`);
    assert.equal(ws.publishOpen, true);
    assert.equal(reviewer().value, "   ");
    assert.equal(reviewer().getAttribute("aria-invalid"), "true");
    assert.ok(document.body.textContent?.includes("Enter the name of the person who reviewed these changes."));
    await app.render("Changed workspace default");
    assert.equal(reviewer().value, "   ", "An open draft must not follow workspace default changes");
    await fill("Corrected reviewer");
    assert.equal(ws.publishing, false, "Editing must not publish");
    assert.deepEqual(ws.revisions, revisions);
    assert.deepEqual(ws.pending, pending);
    await click(`Publish revision ${sequence}`);
    await until(() => !ws.publishOpen, "Publication did not complete");
    assert.equal(ws.revisions[0]?.sequence, sequence);
    assert.equal(ws.revisions[0]?.reviewer, "Corrected reviewer");
  } finally { await app.close(); }
});
