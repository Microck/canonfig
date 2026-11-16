import { Schema } from "effect";
import { GuiShield } from "../../../../src/gui/contract/shield";
import type { GuiSession, WorkspaceBackend } from "../../gui-client";
import type { ShieldSlice } from "../workspace-types";
import { resourceState, useLiveActions, useLiveResource } from "./resource";

/** /api/shield for the page; every change is one POST, after which the session reloads the page's reads. */
export function useLiveShield(backend: WorkspaceBackend, session: GuiSession, reload: () => void): ShieldSlice {
  const shield = useLiveResource(backend, "/api/shield", GuiShield, session.role !== "unconfigured");
  const actions = useLiveActions(backend, reload);
  return {
    data: shield.data, state: resourceState([shield]), action: actions.state,
    run: (request) => actions.run((signal) => backend.request("/api/shield", Schema.Json, signal, { method: "POST", body: request })),
  };
}
