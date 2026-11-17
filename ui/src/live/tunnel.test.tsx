/// <reference types="node" />
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { GuiOperation, GuiSession, GuiStatus } from "../../../src/gui/contract";
import { request, type WorkspaceBackend } from "../gui-client";

GlobalRegistrator.register({ url: "http://localhost/follower/settings/tunnel", settings: { device: { prefersReducedMotion: "reduce" } } });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// React DOM and workspace listeners must observe the test DOM during module evaluation.
const { createRoot } = await import("react-dom/client");
const { LiveWorkspaceProvider } = await import("../workspace/live-provider");
const { TunnelView } = await import("../workspace/follower");
const { useAppRoute } = await import("../workspace/routes");
after(async () => { await GlobalRegistrator.unregister(); });

const session = { role: "follower", machineName: "Tunnel fixture", folderPath: "/tmp/tunnel-ui-fixture", version: "7.3.0" } as const;
function Screen({ backend }: { backend: WorkspaceBackend }) {
  const route = useAppRoute();
  assert.equal(route.kind, "workspace");
  if (route.kind !== "workspace") return null;
  return <LiveWorkspaceProvider backend={backend} session={session} route={route} onInstalled={() => assert.fail("No updater in tunnel tests")}><TunnelView /></LiveWorkspaceProvider>;
}

for (const failure of ["observation", "configuration"] as const) {
it(`configures without enrollment after ${failure} failure, retries and confirms forgetting`, async () => {
  const mutations: { path: string; body: Record<string, unknown> }[] = [];
  let configured = false;
  let loseObservation = failure === "observation";
  let failConfiguration = failure === "configuration";
  let tunnelReads = 0;
  const enrollment = { follower: { id: `follower-${"a".repeat(32)}`, name: "laptop", groups: [], enrolledAt: "2026-11-16", revoked: false }, source: { endpoint: "https://[::1]:17342", signingFingerprint: "a".repeat(64), tlsFingerprint: "b".repeat(64) }, pending: false };
  const server = createServer((incoming, outgoing) => {
    const path = incoming.url ?? "/";
    outgoing.setHeader("Content-Type", "application/json");
    outgoing.setHeader("Access-Control-Allow-Origin", "http://localhost");
    outgoing.setHeader("Access-Control-Allow-Headers", "content-type, x-canonfig-request, cache-control");
    outgoing.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (incoming.method === "OPTIONS") { outgoing.end(); return; }
    const respond = (value: unknown) => outgoing.end(JSON.stringify(value));
    if (incoming.method === "POST") {
      let contents = "";
      incoming.on("data", (chunk: Buffer) => { contents += chunk.toString(); });
      incoming.on("end", () => {
        const body = JSON.parse(contents) as Record<string, unknown>;
        mutations.push({ path, body });
        if (path === "/api/enrollment/inspect") respond({ endpoint: enrollment.source.endpoint, sourceFingerprint: enrollment.source.signingFingerprint, tlsFingerprint: enrollment.source.tlsFingerprint, groups: [], expiresAt: "2026-11-17" });
        else if (path === "/api/tunnel/stop") { if (body.forget) configured = false; respond({ stopped: true, restartable: !body.forget }); }
        else respond({ id: "tunnel-operation" });
      });
    } else if (path === "/api/status") respond({ machineRole: { role: "follower" }, lifecycle: {}, tunnel: null });
    else if (path === "/api/enrollment") respond(enrollment);
    else if (path === "/api/tunnel") { tunnelReads++; respond({ lifecycle: configured ? "stopped" : "not-configured", detail: "Disposable tunnel fixture" }); }
    else if (path === "/api/operations/tunnel-operation") {
      if (loseObservation) { loseObservation = false; outgoing.statusCode = 503; respond({ category: "transport", exitCode: 6, message: "Observation interrupted" }); }
      else if (failConfiguration) { failConfiguration = false; respond({ id: "tunnel-operation", state: "failed", journal: null, failure: { category: "usage-or-configuration", exitCode: 2, message: "the pinned SSH host key file could not be read" } }); }
      else { configured = true; respond({ id: "tunnel-operation", state: "succeeded", journal: null, result: { lifecycle: "running" } }); }
    } else { outgoing.statusCode = 404; respond({ category: "internal", exitCode: 1, message: `Unexpected ${path}` }); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const backend: WorkspaceBackend = {
    request: (path, schema, signal, mutation) => request(origin + path, schema, signal, mutation),
    session: (signal) => request(origin + "/api/session", GuiSession, signal),
    status: (signal) => request(origin + "/api/status", GuiStatus, signal),
    operation: (id, signal) => request(`${origin}/api/operations/${id}`, GuiOperation, signal),
  };
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const until = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 200; attempt++) { await act(async () => { await delay(10); }); if (predicate()) return; }
    assert.fail(container.textContent ?? "No screen");
  };
  const click = async (label: string, dialog = false) => {
    let button: HTMLButtonElement | undefined;
    await until(() => {
      const scope = dialog ? document.querySelector('[role="dialog"]') : container;
      button = [...(scope?.querySelectorAll("button") ?? [])].find((element) => (element.getAttribute("aria-label") ?? element.textContent?.trim()) === label);
      return !!button && !button.disabled && !button.closest("fieldset")?.disabled;
    });
    assert.ok(button, `Missing enabled button ${label}`);
    const enabledButton = button;
    await act(async () => { enabledButton.click(); });
  };
  const openForget = async () => {
    let trigger: HTMLButtonElement | undefined;
    await until(() => {
      trigger = container.querySelector<HTMLButtonElement>('[aria-label="SSH tunnel: more actions"]') ?? undefined;
      return !!trigger && !trigger.disabled;
    });
    assert.ok(trigger);
    const menuTrigger = trigger;
    await act(async () => { menuTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    let item: HTMLElement | undefined;
    await until(() => {
      item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) => element.textContent?.trim() === "Stop and forget tunnel…");
      return !!item;
    });
    assert.ok(item);
    const menuItem = item;
    await act(async () => { menuItem.click(); });
  };
  const fill = async (id: string, value: string) => {
    const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`); assert.ok(input);
    const prototype = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  try {
    await act(async () => { root.render(<Screen backend={backend} />); });
    await until(() => container.textContent?.includes("Disposable tunnel fixture") === true);
    await click("Configure tunnel");
    await fill("tunnel-invitation", "private-envelope"); await click("Inspect invitation");
    await until(() => container.textContent?.includes("Use another invitation") === true);
    assert.equal(container.querySelector("#tunnel-invitation"), null);
    await fill("tunnel-host", "source.invalid"); await fill("tunnel-user", "operator");
    if (failure === "configuration") {
      await fill("tunnel-host-key", "/missing/source.pub");
      await fill("tunnel-ssh-port", "2222"); await fill("tunnel-local-port", "17343");
    }
    await fill("tunnel-timeout", "45000");
    await act(async () => { container.querySelector<HTMLButtonElement>('[role="checkbox"]')?.click(); });
    await click("Configure and start tunnel");
    await until(() => mutations.some((entry) => entry.path === "/api/enrollment/tunnel"));
    const configuredRequest = mutations.find((entry) => entry.path === "/api/enrollment/tunnel");
    assert.ok(configuredRequest);
    assert.equal(configuredRequest.body.localHost, "::1"); assert.equal(configuredRequest.body.timeoutMilliseconds, 45000);
    assert.equal(mutations.some((entry) => entry.path === "/api/enrollment"), false);
    if (failure === "configuration") {
      await until(() => tunnelReads >= 2 && container.textContent?.includes("Configure tunnel: Failed") === true && !!container.querySelector("#tunnel-host") && !container.querySelector("fieldset")?.disabled);
      assert.equal(container.querySelector<HTMLInputElement>("#tunnel-host")?.value, "source.invalid");
      assert.equal(container.querySelector<HTMLInputElement>("#tunnel-user")?.value, "operator");
      assert.equal(container.querySelector<HTMLInputElement>("#tunnel-host-key")?.value, "/missing/source.pub");
      assert.equal(container.querySelector<HTMLInputElement>("#tunnel-ssh-port")?.value, "2222");
      assert.equal(container.querySelector<HTMLInputElement>("#tunnel-local-port")?.value, "17343");
      assert.equal(container.querySelector<HTMLInputElement>("#tunnel-timeout")?.value, "45000");
      assert.ok(container.textContent?.includes("Use another invitation"));
      assert.ok(container.textContent?.includes(enrollment.source.signingFingerprint));
      await fill("tunnel-host-key", "/tmp/source.pub");
      await act(async () => { container.querySelector<HTMLButtonElement>('[role="checkbox"]')?.click(); });
      await click("Configure and start tunnel");
      await until(() => mutations.filter((entry) => entry.path === "/api/enrollment/tunnel").length === 2);
      assert.deepEqual(mutations.filter((entry) => entry.path === "/api/enrollment/tunnel")[1]?.body, { ...configuredRequest.body, sshHostKeyPath: "/tmp/source.pub" });
    } else {
      await until(() => container.textContent?.includes("Resume observation") === true);
      await click("Resume observation");
    }
    await until(() => container.textContent?.includes("Configure tunnel: Completed") === true);
    await click("Cancel");
    await until(() => !!container.querySelector('[aria-label="SSH tunnel: more actions"]'));
    await click("Change tunnel");
    await until(() => !!container.querySelector("form"));
    const form = container.querySelector("form");
    assert.ok(form);
    assert.equal(form.querySelectorAll('[role="checkbox"]').length, 1);
    const cancel = [...form.querySelectorAll("button")].find((button) => button.textContent === "Cancel");
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    assert.ok(cancel && submit);
    assert.equal(submit.textContent, "Replace and start tunnel");
    assert.ok(cancel.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING);
    const submitted = mutations.filter((entry) => entry.path === "/api/enrollment/tunnel").length;
    await click("Replace and start tunnel");
    assert.equal(mutations.filter((entry) => entry.path === "/api/enrollment/tunnel").length, submitted);
    await click("Cancel");
    await click("Start tunnel");
    await until(() => mutations.some((entry) => entry.path === "/api/tunnel/start"));
    assert.deepEqual(mutations.find((entry) => entry.path === "/api/tunnel/start")?.body, {});
    await until(() => container.textContent?.includes("Start tunnel: Completed") === true);
    await fill("tunnel-timeout", "60000"); await click("Start tunnel");
    await until(() => mutations.filter((entry) => entry.path === "/api/tunnel/start").length === 2);
    assert.equal(mutations.filter((entry) => entry.path === "/api/tunnel/start")[1]?.body.timeoutMilliseconds, 60000);
    await until(() => container.textContent?.includes("Start tunnel: Completed") === true);
    await fill("tunnel-timeout", ""); await click("Start tunnel");
    await until(() => mutations.filter((entry) => entry.path === "/api/tunnel/start").length === 3);
    assert.deepEqual(mutations.filter((entry) => entry.path === "/api/tunnel/start")[2]?.body, {});
    await openForget(); await click("Cancel", true);
    assert.equal(mutations.some((entry) => entry.path === "/api/tunnel/stop"), false);
    await openForget(); await click("Stop and forget tunnel", true);
    await until(() => mutations.some((entry) => entry.path === "/api/tunnel/stop"));
    assert.deepEqual(mutations.find((entry) => entry.path === "/api/tunnel/stop")?.body, { forget: true });
    await until(() => container.textContent?.includes("Not configured") === true);
  } finally {
    await act(async () => { root.unmount(); }); container.remove();
    server.closeAllConnections(); const closed = once(server, "close"); server.close(); await closed;
  }
});
}
