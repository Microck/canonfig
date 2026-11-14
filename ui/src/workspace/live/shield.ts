import { Schema } from "effect";
import { GuiShield, type GuiShieldRequest } from "../../../../src/gui/contract/shield";
import type { GuiSession, WorkspaceBackend } from "../../gui-client";
import type { ShieldSlice } from "../workspace-types";
import { resourceState, useLiveActions, useLiveResource } from "./resource";

/** /api/shield for the page; every change is one POST, after which the session reloads the page's reads. */
export function useLiveShield(backend: WorkspaceBackend, session: GuiSession, reload: () => void): ShieldSlice {
  const shield = useLiveResource(backend, "/api/shield", GuiShield, session.role !== "unconfigured");
  const actions = useLiveActions(backend, reload);
  const run = async (request: GuiShieldRequest) => {
    let succeeded = false;
    await actions.run(async (signal) => {
      await backend.request("/api/shield", Schema.Json, signal, { method: "POST", body: request });
      succeeded = true;
    });
    return succeeded;
  };
  return { data: shield.data, state: resourceState([shield]), action: actions.state, run };
}
