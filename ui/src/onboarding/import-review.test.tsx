/// <reference types="node" />
import assert from "node:assert/strict";
import { after, it } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import type { ImportOffer, OnboardingData } from "./onboarding";

GlobalRegistrator.register({ url: "http://localhost/setup", settings: { device: { prefersReducedMotion: "reduce" } } });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
// Register the DOM before loading Radix and React DOM, which select their browser behavior at module load.
const { ImportReview } = await import("./import-review");
after(async () => { await GlobalRegistrator.unregister(); });

const offers: ImportOffer[] = Array.from({ length: 320 }, (_, index) => ({
  id: `codex/skills/skill-${index}`, source: "codex", harnesses: ["codex"], category: "skills",
  name: `skill-${index}`, path: `~/.agents/skills/skill-${index}`, target: `skills/skill-${index}`, secrets: [], notes: [],
}));
const instructions: ImportOffer[] = ["codex", "claude-code"].map((source) => ({
  ...offers[0]!, id: `${source}/instructions/AGENTS.md`, source: source === "codex" ? "codex" : "claude-code",
  harnesses: source === "codex" ? ["codex"] : ["claude-code"],
  category: "instructions", name: "AGENTS.md", target: "AGENTS.md", path: source === "codex" ? "~/.codex/AGENTS.md" : "~/.claude/CLAUDE.md",
}));
const credential: ImportOffer = { ...offers[0]!, id: "codex/mcp/github", category: "mcp", name: "github", target: "canonfig.jsonc#mcp.github", path: "~/.codex/config.toml", secrets: ["env.GITHUB_TOKEN -> fromEnv GITHUB_TOKEN"] };
const held: ImportOffer = { ...offers[0]!, id: "codex/skills/held", name: "held", target: "skills/held", path: "~/.agents/skills/held" };
const identical: ImportOffer = { ...offers[0]!, id: "opencode/skills/skill-0", source: "opencode", harnesses: ["opencode"], path: "~/.config/opencode/skills/skill-0" };
const data: OnboardingData = {
  hostname: "test", endpoint: "", profileName: "test", harnesses: [], followerInstalled: [], present: [],
  offers: [identical, ...offers, ...instructions, credential, held],
  skipped: Array.from({ length: 13 }, (_, index) => ({ source: "codex", path: `~/.agents/skills/unfinished-${index}`, reason: "has no SKILL.md" })),
  collisions: [
    { kind: "candidates", target: "AGENTS.md", candidates: instructions.map(({ id, source, path }) => ({ id, source, path })) },
    { kind: "folder", target: held.target, candidates: [{ id: held.id, source: held.source, path: held.path }] },
  ],
};
const listed = ["codex", "claude-code", "opencode"] as const;
async function fixture(initialSelected: string[] = []) {
  let selection: readonly string[] = initialSelected;
  function TestReview() {
    const [selected, setSelected] = useState<string[]>(initialSelected);
    const [choices, setChoices] = useState<ReadonlyMap<string, string | null>>(() => new Map());
    const [allow, setAllow] = useState(false);
    return <ImportReview data={data} listed={listed} selected={selected} onSelect={(ids) => {
      selection = ids;
      setSelected(ids);
    }} choices={choices} onChoose={(target, id) => {
      setChoices((previous) => new Map(previous).set(target, id));
      setSelected((previous) => {
        const ids = [...previous.filter((selectedId) => !data.offers.some((offer) => offer.target === target && offer.id === selectedId)), ...(id === null ? [] : [id])];
        selection = ids;
        return ids;
      });
    }} allowCredentials={allow} onAllowCredentials={setAllow} />;
  }
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<TestReview />));
  return { container, get selection() { return selection; }, async close() { await act(async () => root.unmount()); container.remove(); } };
}
function button(container: Element, label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label || node.getAttribute("aria-label") === label);
  assert.ok(found, `Missing control: ${label}`);
  return found;
}
async function search(container: Element, value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]'); assert.ok(input);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set; assert.ok(setter);
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

async function choose(container: Element, label: string) {
  const trigger = button(container, "Choose version for AGENTS.md");
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.textContent === label);
  assert.ok(option, `Missing source ${label}`);
  await act(async () => option.click());
}

it("different-content collisions submit only the chosen source and treat Skip import as a decision", async () => {
  const app = await fixture();
  try {
    assert.deepEqual(app.selection, []);
    assert.ok(button(app.container, "Needs a choice (1)"));
    await choose(app.container, "OpenAI Codex");
    assert.deepEqual(app.selection, [instructions[0]!.id]);
    assert.ok(button(app.container, "Needs a choice (0)"));
    await choose(app.container, "Claude Code");
    assert.deepEqual(app.selection, [instructions[1]!.id]);
    await choose(app.container, "Skip import");
    assert.deepEqual(app.selection, []);
    await act(async () => button(app.container, "Needs a choice (0)").click());
    assert.equal(app.container.querySelector('[aria-label="Choose version for AGENTS.md"]'), null);
    await act(async () => button(app.container, "Needs a choice (0)").click());
    await choose(app.container, "OpenAI Codex");
    assert.deepEqual(app.selection, [instructions[0]!.id], "A later source replaces the skip");
  } finally { await app.close(); }
});

it("bulk selection keeps collisions, existing folder content and literal secrets out", async () => {
  const app = await fixture();
  try {
    assert.equal(app.selection.length, 0);
    await act(async () => button(app.container, "Select available").click());
    assert.equal(app.selection.length, 320);
    assert.ok(app.selection.every((id) => id.startsWith("codex/skills/skill-")));
    assert.ok(app.container.textContent?.includes("320 selected"));
    await act(async () => button(app.container, "Clear selection").click());
    assert.equal(app.selection.length, 0);
  } finally { await app.close(); }
});

it("identical targets have one row, all sources and a deterministic import id", async () => {
  const app = await fixture();
  try {
    const rows = app.container.querySelectorAll<HTMLButtonElement>('[role="checkbox"][aria-label^="skill-0 from"]');
    assert.equal(rows.length, 1);
    const row = rows[0]!.closest("li"); assert.ok(row);
    assert.ok(row.textContent?.includes("Codex, OpenCode"));
    assert.ok(row.querySelector('[title*="~/.config/opencode/skills/skill-0"]'));
    await act(async () => rows[0]!.click());
    assert.deepEqual(app.selection, ["codex/skills/skill-0"]);
  } finally { await app.close(); }
});

it("group selection exposes a mixed state and can select or clear the whole category", async () => {
  const app = await fixture();
  try {
    const row = app.container.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label^="skill-0 from"]'); assert.ok(row);
    await act(async () => row.click());
    const group = button(app.container, "Select Skills");
    assert.equal(group.getAttribute("aria-checked"), "mixed");
    await act(async () => group.click());
    assert.equal(app.selection.length, 320);
    await act(async () => group.click());
    assert.equal(app.selection.length, 0);
  } finally { await app.close(); }
});

it("search matches names and home-relative paths without losing selections", async () => {
  const app = await fixture();
  try {
    await search(app.container, "~/.agents/skills/skill-319");
    assert.equal(app.container.querySelectorAll("li").length, 1);
    await act(async () => button(app.container, "Select available").click());
    assert.deepEqual(app.selection, ["codex/skills/skill-319"]);
    await search(app.container, "no-such-item");
    assert.ok(app.container.textContent?.includes("No items match. Clear the search"));
    await search(app.container, "");
    assert.equal(app.selection.length, 1);
  } finally { await app.close(); }
});

it("a retained choice cannot count content now blocked by the Canonical Folder", async () => {
  const app = await fixture([held.id]);
  try {
    assert.ok(app.container.textContent?.includes("0 selected"));
    assert.ok(app.container.textContent?.includes("Already in ~/.canonfig/; kept unchanged"));
  } finally { await app.close(); }
});

it("skips start collapsed and disclose one counted reason before listing paths", async () => {
  const app = await fixture();
  try {
    assert.equal(app.container.textContent?.includes("unfinished-0"), false);
    await act(async () => button(app.container, "Review items that can't be imported (13)").click());
    assert.ok(app.container.textContent?.includes("Has no SKILL.md (13)"));
    assert.equal(app.container.textContent?.includes("unfinished-0"), false);
    await act(async () => button(app.container, "Has no SKILL.md (13)").click());
    assert.ok(app.container.textContent?.includes("~/.agents/skills/unfinished-0"));
  } finally { await app.close(); }
});
