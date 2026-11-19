/// <reference types="node" />
import assert from "node:assert/strict";
import { after, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Window as HappyDOMWindow } from "happy-dom";
import { act } from "react";
import type { Workspace } from "./workspace-types";
import type { WorkspaceRoute } from "./routes";

GlobalRegistrator.register({ url: "http://localhost/source/overview", settings: { device: { prefersReducedMotion: "reduce" } } });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
// Load browser modules only after HappyDOM registers the document and Motion's browser environment.
const { WorkspaceContext } = await import("./store");
const { useWorkspaceNavigation } = await import("./navigation-state");
const { ChapterPicker, TourHost, TourOffer } = await import("./guide");
const { tourChapterPages, tourChapters } = await import("./tour-steps");
const { Tour } = await import("../tour/tour");
after(async () => { await GlobalRegistrator.unregister(); });

async function mount(content: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(content));
  return { container, async close() { await act(async () => root.unmount()); container.remove(); } };
}
async function settle(ms: number) { await act(async () => { await delay(ms); }); }
function target(id: string, left: number) {
  const element = document.createElement("div");
  element.dataset.tour = id;
  // HappyDOM has no layout engine. This fixture supplies the target's physical box.
  element.getBoundingClientRect = () => new DOMRect(left, 100, 120, 40);
  document.body.append(element);
  return element;
}
function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(found, `Missing ${label}`);
  return found;
}
const route: WorkspaceRoute = { kind: "workspace", role: "source", view: "overview", focus: null, profileTab: "items", machinesMode: "list" };

const tourFixture: Pick<Workspace, "machineName" | "resources" | "proposed" | "followers" | "invitations" | "milestones"> & {
  capabilities: Pick<Workspace["capabilities"], "simulatedTelemetry">;
} = {
  machineName: "Example Machine",
  capabilities: { simulatedTelemetry: true },
  resources: [],
  proposed: [],
  followers: [],
  invitations: [],
  milestones: new Set(),
};

it("derives both quick tour previews without visiting their sidebar destinations", () => {
  for (const [role, pages] of [["source", ["profile", "machines"]], ["follower", ["sync", "local"]]] as const) {
    const workspace = { ...tourFixture, role } as Workspace;
    const [quick] = tourChapters(workspace, () => workspace);
    assert.deepEqual(tourChapterPages(quick), [...pages, "overview"]);
    assert.deepEqual(quick.steps.flatMap((step) => step.sidebar ?? []), pages);
    assert.deepEqual(quick.steps.flatMap((step) => step.route ?? []), [{ view: "overview" }]);
  }
});

it("shows the same two Quick tour stops in the narrow picker count and preview", async () => {
  const { innerWidth, happyDOM } = window as unknown as HappyDOMWindow;
  happyDOM.setInnerWidth(420);
  try {
    function Fixture() {
      const navigation = useWorkspaceNavigation(route, () => {});
      const workspace = { ...tourFixture, ...navigation } as Workspace;
      return <WorkspaceContext value={workspace}><ChapterPicker onChoose={() => {}} /></WorkspaceContext>;
    }
    const app = await mount(<Fixture />);
    try {
      assert.match(app.container.querySelector('[data-chapter="quick"]')?.textContent ?? "", /2 steps/u);
      assert.equal(app.container.querySelectorAll('[aria-label="Preview: Quick tour"] ol:not([aria-hidden]) li').length, 2);
    } finally {
      await app.close();
    }
  } finally {
    happyDOM.setInnerWidth(innerWidth);
  }
});

it("enters the same chapter destination that the picker previews", async () => {
  for (const [role, chapterId, page, href] of [
    ["source", "profile", "profile", "/source/profile"],
    ["follower", "schedule", "schedule", "/follower/schedule"],
  ] as const) {
    const destinations: string[] = [];
    function Fixture() {
      const navigation = useWorkspaceNavigation({ ...route, role }, (destination) => destinations.push(destination));
      const workspace = { ...tourFixture, ...navigation, tour: chapterId } as Workspace;
      const chapter = tourChapters(workspace, () => workspace).find((candidate) => candidate.id === chapterId);
      assert.ok(chapter);
      assert.deepEqual(tourChapterPages(chapter), [page]);
      return <WorkspaceContext value={workspace}><TourHost /></WorkspaceContext>;
    }
    const app = await mount(<Fixture />);
    try {
      assert.deepEqual(destinations, [href]);
    } finally {
      await app.close();
    }
  }
});

function OfferFixture() {
  const navigation = useWorkspaceNavigation(route, () => {});
  // Only navigation and dialog availability are consumed by the guidance hosts.
  const workspace = { ...navigation, publishOpen: false, inviteOpen: false, changeGroups: null } as Workspace;
  return <WorkspaceContext value={workspace}><TourOffer /></WorkspaceContext>;
}

it("a new tour step hides immediately instead of showing text beside the previous target", async () => {
  const first = target("first", 50);
  const app = await mount(<Tour steps={[{ target: ["first"], title: "First", body: "First body" }, { target: ["missing"], title: "Second", body: "Second body" }]} onClose={() => {}} />);
  try {
    await settle(50);
    const card = app.container.querySelector('[role="dialog"]');
    assert.ok(card && !card.classList.contains("invisible"), "First step never became visible");
    await act(async () => button(app.container, "Next").click());
    assert.ok(card.classList.contains("invisible"), "Second text is visible using the first target's geometry");
  } finally { await app.close(); first.remove(); }
});

it("a backward search past a missing first target closes without retaining the previous spotlight", async () => {
  const first = target("first", 50);
  const second = target("second", 300);
  const closed: boolean[] = [];
  const app = await mount(<Tour steps={[{ target: ["first"], title: "First", body: "First body" }, { target: ["second"], title: "Second", body: "Second body" }]} onClose={(finished) => closed.push(finished)} />);
  try {
    await settle(50);
    await act(async () => button(app.container, "Next").click());
    await settle(50);
    first.remove();
    await act(async () => button(app.container, "Back").click());
    await settle(900);
    assert.deepEqual(closed, [false], "Missing first target must stop the backward search");
    assert.ok(app.container.querySelector('[role="dialog"]')?.classList.contains("invisible"));
  } finally { await app.close(); first.remove(); second.remove(); }
});

for (const name of ["Change groups", "Edit secret", "Enable self-update"]) {
  it(`the tour offer waits while the ${name} dialog is open`, async () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", name);
    dialog.dataset.state = "open";
    document.body.append(dialog);
    const app = await mount(<OfferFixture />);
    try {
      await settle(950);
      assert.equal(document.querySelector('[aria-label="Tour offer"]'), null, "Guidance appeared over another dialog");
      dialog.remove();
      await settle(50);
      assert.ok(document.querySelector('[aria-label="Tour offer"]'), "Deferred offer never resumed");
    } finally { await app.close(); dialog.remove(); }
  });
}
