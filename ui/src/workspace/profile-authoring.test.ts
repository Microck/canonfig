/// <reference types="node" />
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDocument } from "yaml";
import type { GuiProfileSnapshot } from "../../../src/gui/contract/profile";
import { authoredItems, configEdits, decodeText, encodeText, itemWrite } from "./profile-authoring";

const snapshot = (path: string, text: string, config: GuiProfileSnapshot["config"] = {}): GuiProfileSnapshot => ({ config, supportedSurfaces: {}, items: [{ path: "canonfig.jsonc", digest: "config-digest", files: [{ path: "canonfig.jsonc", base64: encodeText("{}"), executable: false }] }, { path, digest: "item-digest", files: [{ path: path.startsWith("skills/") ? `${path}/SKILL.md` : path, base64: encodeText(text), executable: false }] }] });

describe("shared profile authoring", () => {
  for (const [path, text] of [
    ["AGENTS.md", "# Instructions\nKeep this exact.\n"],
    ["rules/style.md", "---\n# Keep this comment\ndescription: Style\npaths: [\"**/*.ts\"]\nactivation: path\n---\nUse TypeScript.\n"],
    ["agents/reviewer.md", "---\ndescription: Review\nmodel: default\ntools: [read, search]\nwritable: false\n---\nReview changes.\n"],
    ["commands/check.md", "---\ndescription: Check\nargumentHint: '[branch]'\n---\nRun tests.\n"],
    ["skills/review", "---\nname: review\ndescription: Review code\n---\nRead the diff.\n"],
  ] as const) it(`round trips field content and digests for ${path}`, () => {
    const state = snapshot(path, text);
    const entry = authoredItems(state)[0]!;
    assert.equal(entry.exact, undefined);
    const write = itemWrite(state, entry.resource, entry.resource);
    assert.equal(write.expectedDigest, "config-digest");
    assert.equal(write.changes[0]!.expectedDigest, "item-digest");
    const saved = decodeText(write.changes[0]!.files[0]!.base64);
    if (path === "AGENTS.md") assert.equal(saved, text);
    else {
      assert.deepEqual(parseDocument(saved.split("---\n")[1]).toJS(), parseDocument(text.split("---\n")[1]).toJS());
      assert.equal(saved.split("---\n")[2], text.split("---\n")[2]);
      if (text.includes("# Keep this comment")) assert.ok(saved.includes("# Keep this comment"));
    }
  });
  it("keeps unrepresented frontmatter in the exact editor", () => {
    const state = snapshot("rules/custom.md", "---\ndescription: Rule\ncustom: [one, two]\n---\nBody\n");
    const entry = authoredItems(state)[0]!;
    assert.ok(entry.exact);
    assert.deepEqual(itemWrite(state, entry.resource, entry.resource, entry.exact).changes[0]!.files, state.items[1]!.files);
  });
  it("keeps skill trees and binary executable assets intact", () => {
    const state = snapshot("skills/review", "---\nname: review\ndescription: Review\n---\nBody\n");
    const tree = { ...state, items: [state.items[0]!, { ...state.items[1]!, files: [...state.items[1]!.files, { path: "skills/review/assets/data.bin", base64: "/wAB", executable: true }] }] };
    const entry = authoredItems(tree)[0]!;
    assert.equal(entry.exact?.files[1]?.encoding, "base64");
    assert.deepEqual(itemWrite(tree, entry.resource, entry.resource, entry.exact).changes[0]!.files, tree.items[1]!.files);
  });
  const configurations: GuiProfileSnapshot["config"] = {
    mcp: { transport: "stdio", command: "node", args: ["server.js"] },
    credentials: { reference: "token" },
    hooks: { id: "test", event: "session_start", run: ["hooks/test.sh"], matcher: { capabilities: ["read"] }, onFailure: "warn" },
    settings: { nested: { truth: true }, count: 2, text: "value" },
    resources: { kind: "config", target: "~/.custom.json", format: "json", keys: { enabled: true } },
  };
  for (const [category, value] of Object.entries(configurations)) it(`round trips ${category} through fields`, () => {
    const state: GuiProfileSnapshot = { config: { [category]: category === "hooks" ? [value] : { test: value } }, supportedSurfaces: {}, items: [] };
    const entry = authoredItems(state)[0]!;
    assert.equal(entry.exact, undefined);
    assert.deepEqual(itemWrite(state, entry.resource, entry.resource).edits, []);
  });
  it("keeps MCP arguments with spaces and tool recipes in exact editors", () => {
    const state: GuiProfileSnapshot = { config: { mcp: { server: { command: "node", args: ["an argument"] } }, tools: { tool: { executable: "tool", recipes: [{ version: "1.0" }] } } }, supportedSurfaces: {}, items: [] };
    for (const entry of authoredItems(state)) {
      assert.ok(entry.exact);
      assert.deepEqual(itemWrite(state, entry.resource, entry.resource, entry.exact).edits, []);
    }
  });
  it("renames a file and memberships in one digest checked write", () => {
    const state = snapshot("rules/old.md", "Old body\n", { groups: { work: ["rules/old"] } });
    const entry = authoredItems(state)[0]!;
    const write = itemWrite(state, entry.resource, { ...entry.resource, id: "rules/new", path: "rules/new.md" });
    assert.deepEqual(write.changes.map(({ path, expectedDigest, files }) => [path, expectedDigest, files.length]), [["rules/old.md", "item-digest", 0], ["rules/new.md", null, 1]]);
    assert.deepEqual(write.edits, [{ path: ["groups", "work"], value: ["rules/new"] }]);
  });
  it("preserves empty optional fields while changing another config field", () => {
    const state: GuiProfileSnapshot = { config: { mcp: { server: { transport: "stdio", command: "node", args: [] } } }, supportedSurfaces: {}, items: [] };
    const entry = authoredItems(state)[0]!;
    const next = { ...entry.resource, detail: { ...entry.resource.detail, Command: "bun" } };
    assert.deepEqual(itemWrite(state, entry.resource, next).edits, [{ path: ["mcp", "server", "command"], value: "bun" }]);
  });
  it("writes supporting hook files with field edits in one transaction", () => {
    const state: GuiProfileSnapshot = { config: { hooks: [{ id: "test", event: "session_start", run: ["hooks/test.sh"], matcher: { capabilities: [] } }] }, supportedSurfaces: {}, items: [] };
    const entry = authoredItems(state)[0]!;
    const write = itemWrite(state, entry.resource, entry.resource, { files: [{ path: "hooks/test.sh", content: "#!/bin/sh\nexit 0\n", encoding: "text", executable: true }] });
    assert.deepEqual(write.edits, []);
    assert.deepEqual(write.changes, [{ path: "hooks/test.sh", expectedDigest: null, files: [{ path: "hooks/test.sh", base64: encodeText("#!/bin/sh\nexit 0\n"), executable: true }] }]);
  });
  it("writes each file tree member with its own original digest", () => {
    const state = snapshot("files/old.txt", "old\n");
    const entry = authoredItems(state)[0]!;
    const write = itemWrite(state, entry.resource, entry.resource, { files: [{ path: "files/new.txt", content: "new\n", encoding: "text", executable: false }] });
    assert.deepEqual(write.changes.map(({ path, expectedDigest, files }) => [path, expectedDigest, files.length]), [["files/old.txt", "item-digest", 0], ["files/new.txt", null, 1]]);
  });
  it("preserves the byte order mark in exact UTF-8 content", () => {
    assert.equal(encodeText(decodeText("77u/dGV4dA==")), "77u/dGV4dA==");
  });
  it("edits only changed JSONC leaves", () => {
    assert.deepEqual(configEdits(["mcp", "server"], { command: "old", args: ["a"] }, { command: "new", args: ["a"] }), [{ path: ["mcp", "server", "command"], value: "new" }]);
  });
});
