/// <reference types="node" />
import assert from "node:assert/strict";
import { after, it } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { FollowerLive } from "./follower-types";

GlobalRegistrator.register({ url: "http://localhost/follower/local-settings" });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// The controls import browser listeners through the settings kit, so the DOM must exist before loading them.
const { createRoot } = await import("react-dom/client");
const { LocalPreservationControls } = await import("./local-preservation");
after(async () => { await GlobalRegistrator.unregister(); });

it("edits kept-local policies with the displayed digest and explains preservation without connectivity claims", async () => {
  const writes: unknown[] = [];
  const live: Pick<FollowerLive, "local" | "action" | "savePreferences"> = {
    action: { loading: false, error: null },
    local: { items: [{ path: "local.jsonc", digest: "displayed-digest", files: [] }], config: { excludeSkills: ["deploy"], preserveMcp: true }, canonicalConfig: { local: { appendLocal: ["skills"] } } },
    savePreferences: async (input) => { writes.push(input); return true; },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async () => { await act(async () => { root.render(<LocalPreservationControls live={live} sharedSkills={false} preferences={{ excludeSkills: [], preserveMcp: false }} saveDemo={() => assert.fail("Live controls must not save demo state")} />); }); };
  const click = async (label: string) => {
    const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    assert.ok(button);
    await act(async () => { button.click(); });
  };
  try {
    await render();
    // Preserved is neither disabled nor verified, and the row says so while it is on.
    assert.match(container.textContent ?? "", /Kept as is\. Canonfig doesn't check that the servers start\./);
    await click("Remove kept-local skill deploy");
    assert.deepEqual(writes.shift(), { expectedDigest: "displayed-digest", edits: [{ path: ["excludeSkills"], value: [] }] });
    await click("Keep native MCP on this machine");
    assert.deepEqual(writes.shift(), { expectedDigest: "displayed-digest", edits: [{ path: ["preserveMcp"], value: false }] });
    // The field opens in place from the Add button that carries the same label.
    await click("Skill name to keep local");
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Skill name to keep local"]');
    assert.ok(input);
    const setInput = async (value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      await act(async () => { input.dispatchEvent(new Event("input", { bubbles: true })); });
    };
    await setInput("../bad");
    assert.match(container.textContent ?? "", /Use lowercase letters/);
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    assert.ok(submit?.disabled);
    await setInput("review");
    assert.equal(submit.disabled, false);
    await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    assert.deepEqual(writes.shift(), { expectedDigest: "displayed-digest", edits: [{ path: ["excludeSkills"], value: ["deploy", "review"] }] });
    assert.ok(live.local);
    live.local = { ...live.local, canonicalConfig: { local: { appendLocal: [] } } };
    await render();
    assert.equal(container.querySelector('[aria-label="Skill name to keep local"]'), null);
    assert.equal(container.querySelector<HTMLButtonElement>('[aria-label="Remove kept-local skill deploy"]')?.disabled, true);
    assert.match(container.textContent ?? "", /Source must share skills folders/);
    live.savePreferences = async () => false;
    await click("Keep native MCP on this machine");
    assert.match(container.textContent ?? "", /Preferences were not saved/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
