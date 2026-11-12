/// <reference types="node" />
import assert from "node:assert/strict";
import { after, it } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Schema } from "effect";
import { GuiAgentHarness } from "../../../../src/gui/contract/administration";
import type { WorkspaceBackend } from "../../gui-client";
import { useLiveAdministration } from "./administration";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
after(async () => { await GlobalRegistrator.unregister(); });

const session = { role: "follower" as const, machineName: "Test", folderPath: "/fixture/.canonfig", version: "7.1.0" };

function PolicyEditor({ backend }: { backend: WorkspaceBackend }) {
  const { agent } = useLiveAdministration(backend, session, ["/api/agent/policy", "/api/agent/harness"], () => assert.fail("Must not update"));
  if (!agent.data || agent.loading || agent.harnessLoading) return <p>Loading</p>;
  const saved = agent.data;
  const harness = saved.harness;
  assert.ok(harness?.kind === "custom");
  return <>
    <output>{JSON.stringify(harness.args)}</output>
    <button onClick={() => { void agent.save({ ...saved, harness: { ...harness, maximumInputBytes: 8192 } }); }}>Save bounds</button>
    <button onClick={() => { void agent.save({ ...saved, harness: { ...harness, args: ["--version"] } }); }}>Replace arguments</button>
    <button onClick={() => { void agent.save({ ...saved, harness: { ...harness, args: [] } }); }}>Clear arguments</button>
    <p>{agent.savedMessage}</p>
  </>;
}

it("keeps undisclosed harness collections absent on save and sends explicit replacements", async () => {
  let harness: typeof GuiAgentHarness.Type = {
    kind: "custom", executable: "/usr/bin/agent", maximumInputBytes: 4096,
    allowedPaths: [], allowedExecutables: [], allowedOrigins: [], allowedCapabilities: [],
    secretBindings: [{ name: "API_TOKEN", secret: "stored-token" }],
  };
  const saved: Array<typeof GuiAgentHarness.Type> = [];
  // An in-memory backend implements the browser contract. API integration tests
  // cover credential sanitization and storage using real disposable machines.
  const backend: WorkspaceBackend = {
    session: async () => session,
    status: async () => ({ machineRole: { role: "follower" }, lifecycle: {}, tunnel: null }),
    operation: async () => assert.fail("No operation ticket expected"),
    request: async (path, schema, _signal, mutation) => {
      if (path === "/api/agent/policy") return Schema.decodeUnknownSync(schema)("agent-propose");
      assert.equal(path, "/api/agent/harness");
      if (!mutation) return Schema.decodeUnknownSync(schema)({ configured: true, value: harness });
      harness = Schema.decodeUnknownSync(GuiAgentHarness)(mutation.body);
      saved.push(harness);
      return Schema.decodeUnknownSync(schema)(harness);
    },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  async function click(label: string) {
    const button = [...container.querySelectorAll("button")].find((element) => element.textContent === label);
    assert.ok(button);
    await act(async () => { button.click(); });
    assert.ok(container.textContent?.includes("Policy and harness saved."));
  }
  try {
    await act(async () => { root.render(<PolicyEditor backend={backend} />); });
    assert.equal(container.querySelector("output")?.textContent, "[]");
    await click("Save bounds");
    assert.equal(saved[0]?.maximumInputBytes, 8192);
    assert.equal(saved[0]?.arguments, undefined);
    assert.equal(saved[0]?.environment, undefined);
    assert.deepEqual(saved[0]?.secretBindings, [{ name: "API_TOKEN", secret: "stored-token" }]);
    await click("Replace arguments");
    assert.deepEqual(saved[1]?.arguments, ["--version"]);
    await click("Clear arguments");
    assert.deepEqual(saved[2]?.arguments, []);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
