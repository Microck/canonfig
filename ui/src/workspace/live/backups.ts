import { useState } from "react";
import { Schema } from "effect";
import { GuiBackupList, GuiBackupStatus, type GuiBackupRequest } from "../../../../src/gui/contract/backup";
import type { WorkspaceBackend } from "../../gui-client";
import type { BackupSlice } from "../workspace-types";
import { resourceState, useLiveActions, useLiveResource } from "./resource";

/** /api/backup/status plus one operation channel; this machine's list result is kept per policy for the copies list. */
export function useLiveBackups(backend: WorkspaceBackend, reload: () => void): BackupSlice {
  const status = useLiveResource(backend, "/api/backup/status", GuiBackupStatus, true);
  const actions = useLiveActions(backend, reload);
  const [listings, setListings] = useState<BackupSlice["listings"]>({});
  const run = (input: GuiBackupRequest) => actions.run(async signal => {
    const operation = await actions.operation("/api/backup", input, signal);
    signal.throwIfAborted();
    if (input.action === "list" && input.owner === undefined) setListings(previous => ({ ...previous, [input.name]: Schema.decodeUnknownSync(GuiBackupList)(operation.result) }));
    // A run or retention change makes that policy's listed copies stale.
    if (input.action === "run" || input.action === "prune") setListings(({ [input.name]: _stale, ...rest }) => rest);
  }, { reload: input.action !== "list" && input.action !== "owners" });
  return { status: status.data, state: resourceState([status]), action: actions.state, listings, run };
}
