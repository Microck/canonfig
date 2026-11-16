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
import { useAppRoute } from "./routes";

GlobalRegistrator.register({ url: "http://localhost/follower/schedule", settings: { device: { prefersReducedMotion: "reduce" } } });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// These controls register browser listeners at module load, so the DOM must exist first.
const { LiveWorkspaceProvider } = await import("./live-provider");
const { createRoot } = await import("react-dom/client");
const { ScheduleView } = await import("./follower");
const { scheduleError } = await import("./schedule");
const { useWorkspace } = await import("./store");
const { ErrorNotice } = await import("../live/session");
const { TooltipProvider } = await import("../components/ui/tooltip");
after(async () => { await GlobalRegistrator.unregister(); });

function Screen() {
  const ws = useWorkspace();
  return <>{ws.followerStates.schedule.error && <ErrorNotice error={ws.followerStates.schedule.error} />}<ScheduleView /></>;
}
function Fixture({ backend }: { backend: WorkspaceBackend }) {
  const route = useAppRoute();
  assert.equal(route.kind, "workspace");
  if (route.kind !== "workspace") return null;
  return <TooltipProvider><LiveWorkspaceProvider backend={backend} session={GuiSession.make({ role: "follower", machineName: "Schedule fixture", folderPath: "/tmp/schedule-fixture", version: "7.3.0" })} route={route} onInstalled={() => assert.fail("Unexpected installation")}>
    <Screen />
  </LiveWorkspaceProvider></TooltipProvider>;
}

/** A real HTTP fixture provides schedule evidence, including a host zone unlike the browser's. */
async function schedulePage() {
  let schedule: Record<string, unknown> = { kind: "daily", localTime: "09:00", timezone: "Europe/Paris" };
  let removed = false;
  let failRemove = false;
  let failSave = false;
  let releaseRemoval: (() => void) | null = null;
  const writes: { method: string; body: unknown }[] = [];
  const server = createServer(async (incoming, outgoing) => {
    outgoing.setHeader("Content-Type", "application/json");
    outgoing.setHeader("Access-Control-Allow-Origin", "http://localhost");
    outgoing.setHeader("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS");
    outgoing.setHeader("Access-Control-Allow-Headers", "content-type, x-canonfig-request, cache-control");
    if (incoming.method === "OPTIONS") { outgoing.end(); return; }
    if (incoming.url === "/api/status") {
      outgoing.end(JSON.stringify({ machineRole: { role: "follower" }, lifecycle: {}, tunnel: null })); return;
    }
    if (incoming.url !== "/api/schedule") {
      outgoing.statusCode = 404; outgoing.end(JSON.stringify({ category: "internal", exitCode: 1, message: `Unexpected request ${incoming.url}` })); return;
    }
    if (incoming.method === "GET") {
      outgoing.end(JSON.stringify(removed ? { state: "not-selected", machineTimezone: "Pacific/Honolulu" } : {
        state: "current", platform: "linux", machineTimezone: "Pacific/Honolulu", timezone: schedule.timezone ?? "Pacific/Honolulu", schedule,
      })); return;
    }
    let body = "";
    for await (const chunk of incoming) body += String(chunk);
    writes.push({ method: incoming.method ?? "", body: JSON.parse(body) });
    if (incoming.method === "DELETE") {
      const pending = Promise.withResolvers<void>();
      releaseRemoval = pending.resolve;
      await pending.promise;
    }
    if (incoming.method === "DELETE" && failRemove || incoming.method === "PUT" && failSave) {
      outgoing.statusCode = 400;
      outgoing.end(JSON.stringify({ category: "human-action-required", exitCode: 3, message: "Fixture scheduler refused the change." })); return;
    }
    if (incoming.method === "DELETE") removed = true;
    else { schedule = JSON.parse(body).schedule; removed = false; }
    outgoing.end(JSON.stringify({ change: removed ? "removed" : "updated" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const backend: WorkspaceBackend = {
    request: (url, schema, signal, mutation) => request(`${origin}${url}`, schema, signal, mutation),
    session: (signal) => request(`${origin}/api/session`, GuiSession, signal),
    status: (signal) => request(`${origin}/api/status`, GuiStatus, signal),
    operation: (id, signal) => request(`${origin}/api/operations/${id}`, GuiOperation, signal),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<Fixture backend={backend} />); });
  const until = async (check: () => boolean) => {
    for (let attempt = 0; attempt < 150 && !check(); attempt++) await act(async () => { await delay(10); });
    assert.ok(check(), document.body.textContent ?? "");
  };
  const button = (name: string) => {
    const found = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === name);
    assert.ok(found, `No ${name} button`); return found;
  };
  return {
    writes, until, button,
    failSave: () => { failSave = true; },
    failRemove: (value: boolean) => { failRemove = value; },
    async releaseRemoval() { await until(() => releaseRemoval !== null); await act(async () => { releaseRemoval?.(); releaseRemoval = null; }); },
    async close() {
      releaseRemoval?.();
      await act(async () => { root.unmount(); }); container.remove();
      server.closeAllConnections(); const stopped = once(server, "close"); server.close(); await stopped;
    },
  };
}

async function fillZone(zone: string) {
  const input = document.getElementById("sch-timezone");
  assert.ok(input instanceof HTMLInputElement);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, zone);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("edits the zone, shows saved and machine zones, and retains a refused draft", async () => {
  const page = await schedulePage();
  try {
    await page.until(() => document.body.textContent?.includes("Saved time zone") === true);
    assert.equal((document.getElementById("sch-timezone") as HTMLInputElement).value, "Europe/Paris");
    assert.ok(document.body.textContent?.includes("Pacific/Honolulu"));
    await fillZone("America/New_York");
    await act(async () => { page.button("Save schedule").click(); });
    await page.until(() => page.writes.length === 1 && document.body.textContent?.includes("Saved time zoneAmerica/New_York") === true && !page.button("Save schedule").disabled);
    assert.deepEqual(page.writes[0], { method: "PUT", body: { schedule: { kind: "daily", localTime: "09:00", timezone: "America/New_York" } } });
    await fillZone("+05:30");
    assert.equal(page.button("Save schedule").disabled, true);
    await fillZone("");
    await act(async () => { page.button("Save schedule").click(); });
    await page.until(() => page.writes.length === 2);
    assert.deepEqual(page.writes[1].body, { schedule: { kind: "daily", localTime: "09:00" } });
    await page.until(() => document.body.textContent?.includes("Saved time zonePacific/Honolulu") === true && !page.button("Save schedule").disabled);
    page.failSave();
    await fillZone("Asia/Tokyo");
    await act(async () => { page.button("Save schedule").click(); });
    await page.until(() => document.body.textContent?.includes("Fixture scheduler refused") === true);
    assert.equal((document.getElementById("sch-timezone") as HTMLInputElement).value, "Asia/Tokyo");
  } finally { await page.close(); }
});

it("confirms removal, cancels without a request, blocks duplicates and retries failure", async () => {
  const page = await schedulePage();
  try {
    await page.until(() => document.body.textContent?.includes("Saved time zone") === true);
    await act(async () => { page.button("Remove schedule").click(); });
    assert.ok(document.body.textContent?.includes("even if the Source suggests a schedule"));
    assert.equal(page.writes.length, 0);
    await act(async () => { page.button("Cancel").click(); });
    assert.equal(page.writes.length, 0);
    page.failRemove(true);
    await act(async () => { page.button("Remove schedule").click(); });
    const confirm = Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => button.textContent === "Remove schedule");
    assert.ok(confirm instanceof HTMLButtonElement);
    await act(async () => { confirm.click(); });
    await page.until(() => page.writes.length === 1);
    assert.equal(page.button("Removing…").disabled, true);
    assert.equal(page.button("Save schedule").disabled, true);
    assert.deepEqual(page.writes[0], { method: "DELETE", body: {} });
    await page.releaseRemoval();
    await page.until(() => document.body.textContent?.includes("Fixture scheduler refused") === true);
    assert.equal((document.getElementById("sch-timezone") as HTMLInputElement).value, "Europe/Paris");
    page.failRemove(false);
    await act(async () => { page.button("Remove schedule").click(); });
    const retry = Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => button.textContent === "Remove schedule");
    assert.ok(retry instanceof HTMLButtonElement);
    await act(async () => { retry.click(); });
    await page.releaseRemoval();
    await page.until(() => document.body.textContent?.includes("No schedule is set") === true);
    assert.equal(document.getElementById("sch-timezone"), null);
    assert.equal(page.writes.length, 2);
  } finally { await page.close(); }
});

it("validates IANA names for every explicit cadence but keeps the Source default independent", () => {
  for (const cadence of ["daily", "days", "custom"] as const) {
    const schedule = { cadence, days: ["Mon" as const], time: "09:00", expression: "Mon *-*-* 09:00:00", timezone: "Europe/Paris" };
    assert.equal(scheduleError(schedule), null);
    for (const timezone of ["Mars/Olympus", "+05:30", " Europe/Paris", ""]) assert.match(scheduleError({ ...schedule, timezone }) ?? "", /IANA/);
    assert.equal(scheduleError({ ...schedule, timezone: undefined }), null);
  }
  assert.equal(scheduleError({ cadence: "default", days: [], time: "", timezone: "ignored" }), null);
});
