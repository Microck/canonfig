/// <reference types="node" />
/// <reference lib="es2024.promise" />
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { after, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { FollowerLive } from "../workspace/follower-types";
import type { LocalCategory, LocalItem } from "../shared/metadata";

GlobalRegistrator.register({ url: "http://localhost/follower/local-settings", settings: { device: { prefersReducedMotion: "reduce" } } });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// These modules register browser listeners, so the test DOM must exist before module evaluation.
const { createRoot } = await import("react-dom/client");
const { LocalAuthoringEditor } = await import("../workspace/follower-authoring");
const { TooltipProvider } = await import("../components/ui/tooltip");
const { navigate } = await import("../workspace/routes");
after(async () => { await GlobalRegistrator.unregister(); });

function unexpected(): never { throw new Error("Unexpected fixture action"); }
async function fixture(category: LocalCategory = "skills", existing = false) {
  const writes: unknown[] = [];
  const pending: ServerResponse[] = [];
  const server = createServer((incoming, outgoing) => {
    outgoing.setHeader("Content-Type", "application/json");
    outgoing.setHeader("Access-Control-Allow-Origin", "http://localhost");
    outgoing.setHeader("Access-Control-Allow-Headers", "content-type");
    if (incoming.method === "OPTIONS") { outgoing.end(); return; }
    let body = "";
    incoming.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    incoming.on("end", () => { writes.push(JSON.parse(body)); pending.push(outgoing); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const save = async (body: unknown) => (await fetch(origin, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } })).ok;
  const item: LocalItem | null = existing ? category === "mcp" || category === "settings" ? { id: `${category}/example`, path: `${category}/example`, category, summary: "" } : { id: "skills/example", path: "skills/example", category: "skills", summary: "" } : null;
  const live: FollowerLive = {
    action: { loading: false, error: null }, operation: null, operationName: "", allowed: [category, ...["instructions", "skills", "mcp", "settings"].filter((entry): entry is LocalCategory => entry !== category)],
    command: { kind: "Idle" }, canApply: false, resumeObservation: unexpected,
    local: { items: [{ path: "local.jsonc", digest: "config-digest", files: [] }, ...(existing ? [{ path: "skills/example", digest: "item-digest", files: [
      { path: "skills/example/SKILL.md", base64: "b3JpZ2luYWw=", executable: false, digest: "text-digest" },
      { path: "skills/example/asset.bin", base64: "/wCA", executable: true, digest: "binary-digest" },
    ] }] : [])], config: {}, canonicalConfig: {} },
    schedule: null, tunnel: null, enrollment: null, secrets: [], archive: null,
    saveItems: save, savePreferences: save, check: unexpected, createReview: unexpected, saveSchedule: unexpected,
    refreshSecrets: unexpected, toggleTunnel: unexpected, exportArchive: unexpected,
  };
  let closed = 0;
  window.history.replaceState(null, "", "/follower/local-settings");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<TooltipProvider><LocalAuthoringEditor live={live} item={item} onClose={() => { closed++; }} /></TooltipProvider>); });
  return {
    container, writes, pending, get closed() { return closed; },
    async refresh(local: NonNullable<FollowerLive["local"]>) {
      live.local = local;
      await act(async () => { root.render(<TooltipProvider><LocalAuthoringEditor live={live} item={item} onClose={() => { closed++; }} /></TooltipProvider>); });
    },
    async close() {
      await act(async () => { root.unmount(); });
      container.remove();
      await act(async () => {
        for (const response of pending) if (!response.writableEnded) response.end("{}");
        await delay(10);
      });
      server.closeAllConnections();
      const stopped = once(server, "close"); server.close(); await stopped;
    },
  };
}
function button(label: string) {
  const found = [...document.querySelectorAll("button")].find((entry) => entry.textContent === label);
  assert.ok(found, `Missing ${label}`);
  return found;
}
async function click(label: string) { await act(async () => { button(label).click(); }); }
async function input(id: string, value: string) {
  const element = document.getElementById(id);
  assert.ok(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement);
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  await act(async () => { element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
}
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await act(async () => { await delay(10); });
  }
  assert.fail("Editor fixture did not settle");
}
async function upload(id: string, contents: { promise: Promise<ArrayBuffer> }) {
  const element = document.getElementById(id);
  assert.ok(element instanceof HTMLInputElement);
  class DeferredFile extends File { override arrayBuffer() { return contents.promise; } }
  const file = new DeferredFile(["uploaded"], "replacement.bin");
  Object.defineProperty(element, "files", { configurable: true, value: [file] });
  await act(async () => { element.dispatchEvent(new Event("change", { bubbles: true })); });
}

it("freezes a submitted local draft and blocks Discard, close, Escape and navigation until it settles", async () => {
  const app = await fixture("skills", true);
  try {
    await input("local-content-0", "submitted text");
    await click("Save");
    await until(() => app.writes.length === 1);
    // HappyDOM does not inherit :disabled from a fieldset, but browsers disable its controls.
    for (const control of app.container.querySelectorAll("input, textarea, select")) assert.ok(control.matches(":disabled") || control.closest("fieldset[disabled]"), `${control.id} remains editable during submission`);
    assert.ok(button("Discard").disabled);
    await click("Discard");
    await act(async () => {
      app.container.querySelector<HTMLButtonElement>('[aria-label="Close details"]')!.click();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      navigate("/follower/overview");
    });
    assert.equal(app.closed, 0);
    assert.equal(window.location.pathname, "/follower/local-settings");
    await act(async () => { app.pending[0]!.end("{}"); });
    await until(() => app.closed === 1);
    assert.deepEqual(app.writes[0], { changes: [{ path: "skills/example", expectedDigest: "item-digest", files: [
      { path: "skills/example/SKILL.md", base64: "c3VibWl0dGVkIHRleHQ=", executable: false },
      { path: "skills/example/asset.bin", base64: "/wCA", executable: true },
    ] }] });
  } finally { await app.close(); }
});

it("a removed file's delayed upload cannot overwrite the file that takes its list position", async () => {
  const app = await fixture();
  const read = Promise.withResolvers<ArrayBuffer>();
  try {
    await click("Add file");
    await input("local-content-1", "keep this file");
    await upload("local-upload-0", read);
    await click("Remove file");
    await act(async () => { read.resolve(new TextEncoder().encode("stale upload").buffer); });
    assert.equal((document.getElementById("local-content-0") as HTMLTextAreaElement).value, "keep this file");
  } finally { await app.close(); }
});

it("a mode change cancels uploads from the previous local file tree", async () => {
  const app = await fixture();
  const read = Promise.withResolvers<ArrayBuffer>();
  try {
    await upload("local-upload-0", read);
    assert.ok(button("Save").disabled, "An unfinished read must not save the old bytes");
    await input("local-kind", "instructions");
    await input("local-content-0", "new instructions");
    await act(async () => { read.resolve(new TextEncoder().encode("old skill").buffer); });
    assert.equal((document.getElementById("local-content-0") as HTMLTextAreaElement).value, "new instructions");
  } finally { await app.close(); }
});

it("only the latest replacement read owns a local file", async () => {
  const app = await fixture();
  const older = Promise.withResolvers<ArrayBuffer>();
  const newer = Promise.withResolvers<ArrayBuffer>();
  try {
    await upload("local-upload-0", older);
    await upload("local-upload-0", newer);
    await act(async () => { newer.resolve(new TextEncoder().encode("latest bytes").buffer); });
    await act(async () => { older.resolve(new TextEncoder().encode("old bytes").buffer); });
    assert.equal((document.getElementById("local-content-0") as HTMLTextAreaElement).value, "latest bytes");
    assert.equal(button("Save").disabled, false);
  } finally { await app.close(); }
});

it("failed config saves retain their JSON draft, unlock editing and preserve the config digest on retry", async () => {
  const app = await fixture("mcp");
  try {
    await input("local-name", "docs");
    await input("local-value", "{\"transport\":\"stdio\",\"command\":\"docs-server\",\"unknown\":{\"keep\":true}}");
    await click("Save");
    await until(() => app.writes.length === 1);
    assert.ok(document.getElementById("local-name")?.closest("fieldset[disabled]"));
    assert.ok(document.getElementById("local-value")?.closest("fieldset[disabled]"));
    await act(async () => { app.pending[0]!.statusCode = 409; app.pending[0]!.end("{}"); });
    await until(() => !!app.container.querySelector('[role="alert"]'));
    assert.equal(app.closed, 0);
    assert.equal(document.getElementById("local-value")?.closest("fieldset[disabled]"), null);
    assert.equal((document.getElementById("local-name") as HTMLInputElement).value, "docs");
    await input("local-name", "docs-retry");
    await click("Save");
    await until(() => app.writes.length === 2);
    assert.deepEqual(app.writes[1], { expectedDigest: "config-digest", edits: [{ path: ["mcp", "docs-retry"], value: { transport: "stdio", command: "docs-server", unknown: { keep: true } } }] });
    await act(async () => { app.pending[1]!.end("{}"); });
    await until(() => app.closed === 1);
  } finally { await app.close(); }
});

it("a binary replacement preserves exact bytes and the file's executable flag", async () => {
  const app = await fixture("skills", true);
  const read = Promise.withResolvers<ArrayBuffer>();
  try {
    await upload("local-upload-1", read);
    await act(async () => { read.resolve(Uint8Array.from([255, 0, 254, 128]).buffer); });
    await click("Save");
    await until(() => app.writes.length === 1);
    assert.deepEqual(app.writes[0], { changes: [{ path: "skills/example", expectedDigest: "item-digest", files: [
      { path: "skills/example/SKILL.md", base64: "b3JpZ2luYWw=", executable: false },
      { path: "skills/example/asset.bin", base64: "/wD+gA==", executable: true },
    ] }] });
    await act(async () => { app.pending[0]!.end("{}"); });
    await until(() => app.closed === 1);
  } finally { await app.close(); }
});

it("confirmed removal freezes the same editor until the digest-checked deletion settles", async () => {
  const app = await fixture("skills", true);
  try {
    await click("Remove…");
    await click("Remove");
    await until(() => app.writes.length === 1);
    assert.deepEqual(app.writes[0], { changes: [{ path: "skills/example", expectedDigest: "item-digest", files: [] }] });
    assert.ok(button("Discard").disabled);
    assert.ok(document.getElementById("local-content-0")?.closest("fieldset[disabled]"));
    await act(async () => { app.pending[0]!.end("{}"); });
    await until(() => app.closed === 1);
  } finally { await app.close(); }
});

it("refreshing local config replaces an editing draft and its save digest", async () => {
  const app = await fixture("mcp", true);
  try {
    await input("local-value", "{\"command\":\"unsaved\"}");
    await app.refresh({ items: [{ path: "local.jsonc", digest: "reloaded-digest", files: [] }], config: { mcp: { example: { command: "disk-value" } } }, canonicalConfig: {} });
    assert.equal((document.getElementById("local-value") as HTMLTextAreaElement).value, '{\n  "command": "disk-value"\n}');
    await input("local-value", "{\"command\":\"new edit\"}");
    await click("Save");
    await until(() => app.writes.length === 1);
    assert.deepEqual(app.writes[0], { expectedDigest: "reloaded-digest", edits: [{ path: ["mcp", "example"], value: { command: "new edit" } }] });
    await act(async () => { app.pending[0]!.end("{}"); });
    await until(() => app.closed === 1);
  } finally { await app.close(); }
});

it("refreshing local config during submission keeps the frozen generation until success closes it", async () => {
  const app = await fixture("mcp", true);
  try {
    await input("local-value", "{\"command\":\"submitted\"}");
    await click("Save");
    await until(() => app.writes.length === 1);
    await app.refresh({ items: [{ path: "local.jsonc", digest: "saved-digest", files: [] }], config: { mcp: { example: { command: "refreshed value" } } }, canonicalConfig: {} });
    assert.equal((document.getElementById("local-value") as HTMLTextAreaElement).value, "{\"command\":\"submitted\"}");
    assert.ok(button("Discard").disabled);
    assert.deepEqual(app.writes[0], { expectedDigest: "config-digest", edits: [{ path: ["mcp", "example"], value: { command: "submitted" } }] });
    await act(async () => { app.pending[0]!.end("{}"); });
    await until(() => app.closed === 1);
  } finally { await app.close(); }
});
