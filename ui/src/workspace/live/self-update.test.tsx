/// <reference types="node" />
import assert from "node:assert/strict";
import { after, it } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Schema } from "effect";
import { GuiRequestError, type WorkspaceBackend } from "../../gui-client";
import type { AdministrationSlice } from "../administration-types";
import type { Workspace } from "../workspace-types";
import { useLiveAdministration } from "./administration";
GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
after(async () => { await GlobalRegistrator.unregister(); });
const session = { role: "follower" as const, machineName: "test", folderPath: "/tmp/test", version: "7.1.0" };
let version: AdministrationSlice["version"];
function Probe({ backend }: { backend: WorkspaceBackend }) { version = useLiveAdministration(backend, session, ["/api/self-update"], () => assert.fail("Unexpected installation")).version; return null; }
async function fixture() {
  let enabled = true;
  let pollingFailed = false;
  const backend: WorkspaceBackend = {
    session: async () => session,
    status: async () => ({ machineRole: { role: "follower" }, lifecycle: {}, tunnel: null, shield: { enabled: false, hard: false, scope: "local", destination: "/tmp/update-fixture/local", projected: false, excludedPlugins: [], note: "" } }),
    operation: async (id) => {
      if (pollingFailed) throw new GuiRequestError({ category: "internal", exitCode: 1, message: "Lost observation" });
      pollingFailed = true;
      return { id, state: "running", journal: { phase: "staging", candidate: "7.1.1" } };
    },
    request: async (path, schema) => {
      const body = path === "/api/self-update/check" ? { current: "7.1.0", candidate: "7.1.1", status: "available", detail: "Patch available" }
        : path === "/api/self-update/apply" ? { id: "update-ticket" }
          : { platform: "linux", enabled, pending: false, settings: enabled ? { npmCli: "/npm/bin/npm-cli.js" } : null };
      return Schema.decodeUnknownSync(schema)(body);
    },
  };
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Probe backend={backend} />));
  return { disable() { enabled = false; }, async close() { await act(async () => root.unmount()); container.remove(); } };
}
it("status reload invalidates an earlier available check when disabled", async () => {
  const app = await fixture();
  try {
    await act(async () => { version.check(); });
    assert.equal(version.checked?.status, "available");
    app.disable();
    await act(async () => { version.reload(); });
    assert.equal(version.data?.enabled, false);
    assert.equal(version.checked, null, "Disabled settings cannot retain install authorization");
  } finally { await app.close(); }
});
it("poll failure retains a resumable ticket, not a running progress claim", async () => {
  const app = await fixture();
  try {
    await act(async () => { version.check(); });
    await act(async () => { version.apply(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
    assert.equal(version.lifecycle.kind, "observation-lost");
    assert.equal(version.lifecycle.kind === "observation-lost" ? version.lifecycle.ticket : null, "update-ticket");
    assert.equal(version.busy, false);
    assert.equal(version.progress, null);
  } finally { await app.close(); }
});

it("the Version page treats an installed result with a warning as success", async () => {
  const app = await fixture();
  const { WorkspaceContext } = await import("../store");
  const { VersionView } = await import("../settings");
  const { ScreenContext } = await import("../screen-context");
  const { TooltipProvider } = await import("../../components/ui/tooltip");
  const checked = { current: "7.1.0", candidate: "7.1.1", status: "updated" as const, detail: "Receipt unavailable; keep the update record for recovery." };
  assert.ok(version.data);
  const installed = { ...version, checked, latest: checked.candidate, lifecycle: { kind: "installed" as const, status: version.data, checked } };
  const workspace = { role: "source", admin: { version: installed } } as Workspace;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<TooltipProvider><ScreenContext value={{ pageLoading: false, navigate: () => {} }}><WorkspaceContext value={workspace}><VersionView /></WorkspaceContext></ScreenContext></TooltipProvider>));
    assert.ok(container.textContent?.includes("Canonfig 7.1.1 is installed."));
    assert.ok(container.textContent?.includes(checked.detail));
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.ok(![...container.querySelectorAll("button")].some((button) => button.textContent?.includes("Install 7.1.1")));
  } finally { await act(async () => root.unmount()); container.remove(); await app.close(); }
});
