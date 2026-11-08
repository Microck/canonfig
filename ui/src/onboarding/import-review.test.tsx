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
  name: `skill-${index}`, path: `~/.codex/skills/skill-${index}`, target: `skills/skill-${index}`, secrets: [], notes: [],
}));
const instructions: ImportOffer[] = ["codex", "claude-code"].map((source) => ({
  ...offers[0]!, id: `${source}/instructions/AGENTS.md`, source: source === "codex" ? "codex" : "claude-code",
  harnesses: source === "codex" ? ["codex"] : ["claude-code"],
  category: "instructions", name: "AGENTS.md", target: "AGENTS.md", path: source === "codex" ? "~/.codex/AGENTS.md" : "~/.claude/CLAUDE.md",
}));
const credential: ImportOffer = { ...offers[0]!, id: "codex/mcp/github", category: "mcp", name: "github", target: "canonfig.jsonc#mcp.github", path: "~/.codex/config.toml", secrets: ["env.GITHUB_TOKEN -> fromEnv GITHUB_TOKEN"] };
const held: ImportOffer = { ...offers[0]!, id: "codex/skills/held", name: "held", target: "skills/held", path: "~/.codex/skills/held" };
const identical: ImportOffer = { ...offers[0]!, id: "opencode/skills/skill-0", source: "opencode", harnesses: ["opencode"], path: "~/.config/opencode/skills/skill-0" };
// Cursor is not listed: a choice of its copy is retained but not imported.
const unlisted: ImportOffer = { ...instructions[0]!, id: "cursor/instructions/AGENTS.md", source: "cursor", harnesses: ["cursor"], path: "~/.cursor/AGENTS.md" };
const noted: ImportOffer = { ...offers[0]!, id: "claude-code/agents/reviewer", source: "claude-code", harnesses: ["claude-code"], category: "agents", name: "reviewer", target: "agents/reviewer.md", path: "~/.claude/agents/reviewer.md", notes: ["Canonfig does not copy the metadata field tools"] };
const data: OnboardingData = {
  hostname: "test", endpoint: "", profileName: "test", harnesses: [], followerInstalled: [], present: [],
  offers: [identical, ...offers, ...instructions, credential, held, unlisted, noted],
  skipped: [
    ...Array.from({ length: 13 }, (_, index) => ({ source: "codex" as const, path: `~/.codex/skills/unfinished-${index}`, reason: "has no SKILL.md" })),
    { source: "codex", path: "~/.codex/skills/linked", reason: "contains a symbolic link" },
  ],
  collisions: [
    { kind: "candidates", target: "AGENTS.md", candidates: instructions.map(({ id, source, path }) => ({ id, source, path })) },
    { kind: "folder", target: held.target, candidates: [{ id: held.id, source: held.source, path: held.path }] },
  ],
};
const listed = ["codex", "claude-code", "opencode"] as const;

async function fixture(initial: ReadonlyMap<string, string> = new Map()) {
  let choices = initial;
  function TestReview() {
    const [value, setValue] = useState(initial);
    return <ImportReview data={data} listed={listed} choices={value} onChoices={(next) => { choices = next; setValue(next); }} />;
  }
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<TestReview />));
  return { container, get choices() { return choices; }, async close() { await act(async () => root.unmount()); container.remove(); } };
}
function control(container: Element, label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.getAttribute("aria-label") === label || node.textContent === label);
  assert.ok(found, `Missing control: ${label}`);
  return found;
}
const click = async (container: Element, label: string) => { const node = control(container, label); await act(async () => node.click()); };
const checked = (container: Element, label: string) => control(container, label).getAttribute("aria-checked");
async function search(container: Element, value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]'); assert.ok(input);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set; assert.ok(setter);
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

it("tools start collapsed and open into categories and items", async () => {
  const app = await fixture();
  try {
    assert.equal(app.container.textContent?.includes("skill-1"), false);
    await click(app.container, "Expand OpenAI Codex");
    await click(app.container, "Expand Skills from OpenAI Codex");
    assert.ok(app.container.textContent?.includes("skill-1"));
  } finally { await app.close(); }
});

it("checking a differing item under one tool picks that tool's version and marks the others", async () => {
  const app = await fixture();
  try {
    await click(app.container, "Expand OpenAI Codex"); await click(app.container, "Expand Instructions from OpenAI Codex");
    await click(app.container, "Expand Claude Code"); await click(app.container, "Expand Instructions from Claude Code");
    await click(app.container, "AGENTS.md from OpenAI Codex");
    assert.deepEqual([...app.choices], [["AGENTS.md", instructions[0]!.id]]);
    assert.equal(checked(app.container, "AGENTS.md from Claude Code"), "false");
    assert.ok(app.container.textContent?.includes("Using OpenAI Codex's"));
    await click(app.container, "AGENTS.md from Claude Code");
    assert.deepEqual([...app.choices], [["AGENTS.md", instructions[1]!.id]]);
    assert.equal(checked(app.container, "AGENTS.md from OpenAI Codex"), "false");
    await click(app.container, "AGENTS.md from Claude Code");
    assert.equal(app.choices.size, 0);
  } finally { await app.close(); }
});

it("identical copies in two tools check together as one import", async () => {
  const app = await fixture();
  try {
    await search(app.container, "skill-0");
    await click(app.container, "skill-0 from OpenCode");
    assert.equal(checked(app.container, "skill-0 from OpenAI Codex"), "true");
    assert.ok(app.container.textContent?.includes("1 selected"));
  } finally { await app.close(); }
});

it("checking a whole tool takes undecided items only, and one click clears what it took", async () => {
  const app = await fixture(new Map([["AGENTS.md", instructions[1]!.id]]));
  try {
    await click(app.container, "Expand OpenAI Codex"); await click(app.container, "Expand Skills from OpenAI Codex");
    await click(app.container, "skill-1 from OpenAI Codex");
    assert.equal(checked(app.container, "Select everything from OpenAI Codex"), "mixed");
    await click(app.container, "Select everything from OpenAI Codex");
    // The 320 skills: never the Claude Code version already chosen, the held folder item or the server needing a variable.
    assert.equal(app.choices.size, 321);
    assert.equal(app.choices.has(credential.target), false);
    assert.equal(app.choices.get("AGENTS.md"), instructions[1]!.id);
    assert.equal(app.choices.has(held.target), false);
    assert.equal(checked(app.container, "Select everything from OpenAI Codex"), "true");
    await click(app.container, "Select everything from OpenAI Codex");
    assert.deepEqual([...app.choices], [["AGENTS.md", instructions[1]!.id]]);
  } finally { await app.close(); }
});

it("a choice retained from an unlisted tool survives checking another tool", async () => {
  const app = await fixture(new Map([["AGENTS.md", unlisted.id]]));
  try {
    await click(app.container, "Select everything from OpenAI Codex");
    assert.equal(app.choices.get("AGENTS.md"), unlisted.id);
    await search(app.container, "AGENTS.md");
    assert.ok(app.container.textContent?.includes("Chosen from Cursor, which isn't listed"));
    // An explicit check under a listed tool is the person replacing it.
    await click(app.container, "AGENTS.md from OpenAI Codex");
    assert.equal(app.choices.get("AGENTS.md"), instructions[0]!.id);
  } finally { await app.close(); }
});

it("conversion notes are visible and describe the item's checkbox", async () => {
  const app = await fixture();
  try {
    await search(app.container, "reviewer");
    const box = control(app.container, "reviewer from Claude Code");
    const description = document.getElementById(box.getAttribute("aria-describedby") ?? "");
    assert.equal(description?.textContent, "Canonfig does not copy the metadata field tools");
  } finally { await app.close(); }
});

it("search opens matching branches by name or path and keeps selections", async () => {
  const app = await fixture();
  try {
    await search(app.container, "~/.codex/skills/skill-319");
    await click(app.container, "skill-319 from OpenAI Codex");
    assert.equal(app.container.querySelectorAll('[aria-label$="from OpenAI Codex"][role="checkbox"]').length, 3, "tool, category and the one match");
    await search(app.container, "no-such-item");
    assert.ok(app.container.textContent?.includes("No matches."));
    await search(app.container, "");
    assert.deepEqual([...app.choices], [["skills/skill-319", "codex/skills/skill-319"]]);
  } finally { await app.close(); }
});

it("content already in the folder cannot be checked, even from a retained choice", async () => {
  const app = await fixture(new Map([[held.target, held.id]]));
  try {
    assert.ok(app.container.textContent?.includes("0 selected"));
    await search(app.container, "held");
    assert.equal(control(app.container, "held from OpenAI Codex").disabled, true);
    assert.ok(app.container.textContent?.includes("Already in ~/.canonfig/"));
  } finally { await app.close(); }
});

it("an MCP server with a password names its variable and checking it is the consent", async () => {
  const app = await fixture();
  try {
    await search(app.container, "github");
    assert.ok(app.container.textContent?.includes("Needs $GITHUB_TOKEN"));
    await click(app.container, "github from OpenAI Codex");
    assert.equal(app.choices.get(credential.target), credential.id);
  } finally { await app.close(); }
});

it("each tool keeps its skipped items closed until asked, grouped by reason", async () => {
  const app = await fixture();
  try {
    await click(app.container, "Expand OpenAI Codex");
    assert.equal(app.container.textContent?.includes("unfinished-0"), false);
    await click(app.container, "14 can't be imported");
    const groups = [...app.container.querySelectorAll("li")].filter((node) => /^(Has no SKILL\.md|Contains a symbolic link)/.test(node.textContent ?? ""));
    const noManifest = groups.find((node) => node.textContent?.startsWith("Has no SKILL.md")); assert.ok(noManifest);
    const linked = groups.find((node) => node.textContent?.startsWith("Contains a symbolic link")); assert.ok(linked);
    assert.ok(noManifest.textContent?.includes("~/.codex/skills/unfinished-0"));
    assert.equal(noManifest.textContent?.includes("~/.codex/skills/linked"), false);
    assert.ok(linked.textContent?.includes("~/.codex/skills/linked"));
  } finally { await app.close(); }
});

it("a search that matches a skipped path shows it", async () => {
  const app = await fixture();
  try {
    await search(app.container, "unfinished-12");
    assert.ok(app.container.textContent?.includes("~/.codex/skills/unfinished-12"));
  } finally { await app.close(); }
});
