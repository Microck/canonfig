/// <reference types="node" />
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { request, type WorkspaceBackend } from "../gui-client";
import { GuiOperation, GuiSession, GuiStatus } from "../../../src/gui/contract";

GlobalRegistrator.register({ url: "http://localhost/setup", settings: { device: { prefersReducedMotion: "reduce" } } });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Radix must observe the registered DOM when its modules load, as in the existing UI HTTP tests.
const { createRoot } = await import("react-dom/client");
const { ArchiveImportButton } = await import("./archive-transfer");
const { TooltipProvider } = await import("../components/ui/tooltip");
after(async () => { await GlobalRegistrator.unregister(); });

type ApplyResponse = "disconnect" | "unreadable" | "invalid-ticket" | "rejected" | "poll-failure";
const result = { sha256: "a".repeat(64), manifestSha256: "b".repeat(64), signer: "unsigned", folderFiles: 1, replaced: [], plan: {} };
async function fixture(applyResponse: ApplyResponse) {
  let submissions = 0;
  let observations = 0;
  const server = createServer((incoming, outgoing) => {
    outgoing.setHeader("Content-Type", "application/json");
    outgoing.setHeader("Access-Control-Allow-Origin", "http://localhost");
    outgoing.setHeader("Access-Control-Allow-Headers", "content-type, x-canonfig-request, cache-control");
    outgoing.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (incoming.method === "OPTIONS") { outgoing.end(); return; }
    incoming.resume();
    incoming.on("end", () => {
      if (incoming.url === "/api/imports/preview") { outgoing.statusCode = 202; outgoing.end(JSON.stringify({ id: "preview" })); }
      else if (incoming.url === "/api/operations/preview") outgoing.end(JSON.stringify({ id: "preview", state: "succeeded", journal: null, result }));
      else if (incoming.url === "/api/imports") {
        submissions++;
        outgoing.statusCode = 202;
        switch (applyResponse) {
          case "disconnect": outgoing.destroy(); break;
          case "unreadable": outgoing.end("not JSON"); break;
          case "invalid-ticket": outgoing.end(JSON.stringify({ wrong: "ticket" })); break;
          case "rejected":
            outgoing.statusCode = 409;
            outgoing.end(JSON.stringify({ category: "conflict-or-drift", exitCode: 4, message: "Import rejected before starting" }));
            break;
          case "poll-failure": outgoing.end(JSON.stringify({ id: "apply" })); break;
        }
      } else if (incoming.url === "/api/operations/apply") {
        observations++;
        if (observations === 1) { outgoing.statusCode = 500; outgoing.end(JSON.stringify({ category: "internal", exitCode: 1, message: "Observation unavailable" })); }
        else outgoing.end(JSON.stringify({ id: "apply", state: "succeeded", journal: null, result: {
          ...result, guard: {
            trigger: "archive.import", at: "2026-11-06T00:00:00Z", verdict: "warn",
            checked: 1, unsupported: 0, unavailable: 0, cacheHits: 0, findingCount: 1,
            findings: [{ severity: "warn", checker: "static", code: "invisible-control", item: "instructions", path: "AGENTS.md", digest: result.sha256 }],
          },
        } }));
      } else { outgoing.statusCode = 404; outgoing.end("{}"); }
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const backend: WorkspaceBackend = {
    request: (path, schema, signal, mutation) => request(base + path, schema, signal, mutation),
    operation: (id, signal) => request(`${base}/api/operations/${id}`, GuiOperation, signal),
    session: (signal) => request(`${base}/api/session`, GuiSession, signal),
    status: (signal) => request(`${base}/api/status`, GuiStatus, signal),
  };
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<TooltipProvider><ArchiveImportButton backend={backend} /></TooltipProvider>));
  return {
    get submissions() { return submissions; },
    get observations() { return observations; },
    async close() {
      await act(async () => root.unmount()); container.remove();
      server.closeAllConnections(); const closed = once(server, "close"); server.close(); await closed;
    },
  };
}
function button(text: string) {
  const found = [...document.querySelectorAll("button")].find((entry) => entry.textContent === text);
  assert.ok(found, `Missing button ${text}`);
  return found;
}
async function click(text: string) { await act(async () => button(text).click()); }
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await act(async () => { await delay(10); });
  }
  assert.fail("Archive flow did not reach the expected state");
}
async function preview() {
  await click("Import archive");
  const input = document.getElementById("archive-file"); assert.ok(input instanceof HTMLInputElement);
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["archive fixture"], "setup.tar.gz", { type: "application/gzip" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  await click("Verify and preview");
  await until(() => !!document.querySelector('[role="status"]')?.textContent?.includes("Ready to import"));
  const consent = [...document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].find((entry) => entry.closest("label")?.textContent === "I have reviewed the plan."); assert.ok(consent);
  await act(async () => consent.click());
}

for (const response of ["disconnect", "unreadable", "invalid-ticket"] as const) {
  it(`keeps import locked when the apply response is ${response}`, async () => {
    const app = await fixture(response);
    try {
      await preview();
      await click("Import verified archive");
      await until(() => !!document.body.textContent?.includes("Operation observation lost"));
      assert.equal(app.submissions, 1);
      assert.ok(button("Cancel").disabled);
      assert.equal([...document.querySelectorAll("button")].some((entry) => entry.textContent === "Verify and preview" || entry.textContent === "Import verified archive"), false);
      assert.ok(document.getElementById("archive-file")?.closest("fieldset[disabled]"));
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      assert.ok(document.querySelector('[role="dialog"]'));
      assert.equal(app.submissions, 1);
    } finally { await app.close(); }
  });
}
it("unlocks editing only when the server rejects the apply request", async () => {
  const app = await fixture("rejected");
  try {
    await preview(); await click("Import verified archive");
    await until(() => !!document.body.textContent?.includes("Archive import failed"));
    assert.equal(app.submissions, 1);
    assert.equal(button("Cancel").disabled, false);
    assert.equal(button("Verify and preview").disabled, false);
  } finally { await app.close(); }
});
it("shows the completed import's Guard warning after resuming the same ticket", async () => {
  const app = await fixture("poll-failure");
  try {
    await preview(); await click("Import verified archive");
    await until(() => !!document.body.textContent?.includes("Operation observation lost"));
    assert.ok(document.body.textContent?.includes("apply"));
    await click("Resume observation");
    await until(() => !!document.querySelector('[role="status"]')?.textContent?.includes("Import complete"));
    assert.match(document.querySelector('[role="dialog"] li')?.textContent ?? "", /instructions \/ AGENTS\.md invisible-control \(static\)/u);
    assert.equal(app.submissions, 1);
    assert.equal(app.observations, 2);
  } finally { await app.close(); }
});
