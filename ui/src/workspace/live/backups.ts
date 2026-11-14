import { useState } from "react";
import { Schema } from "effect";
import { GuiBackupList, GuiBackupStatus, type GuiBackupRequest } from "../../../../src/gui/contract/backup";
import type { WorkspaceBackend } from "../../gui-client";
import type { BackupSlice } from "../workspace-types";
import { resourceState, useLiveActions, useLiveResource } from "./resource";

/** /api/backup/status plus one operation channel; a list result is kept per policy for the copies list. */
export function useLiveBackups(backend: WorkspaceBackend, reload: () => void): BackupSlice {
  const status = useLiveResource(backend, "/api/backup/status", GuiBackupStatus, true);
  const actions = useLiveActions(backend, reload);
  const [listing, setListing] = useState<BackupSlice["listing"]>(null);
  const [report, setReport] = useState<BackupSlice["report"]>(null);
  const run = (input: GuiBackupRequest) => actions.run(async signal => {
    setReport(null);
    const operation = await actions.operation("/api/backup", input, signal);
    signal.throwIfAborted();
    if (input.action === "list") setListing({ name: input.name, owner: input.owner, value: Schema.decodeUnknownSync(GuiBackupList)(operation.result) });
    else setReport({ action: input.action, ...("name" in input ? { name: input.name } : {}), value: operation.result });
    // A run or retention change makes the listed copies stale.
    if ((input.action === "run" || input.action === "prune") && listing?.name === input.name) setListing(null);
  });
  return { status: status.data, state: resourceState([status]), action: actions.state, listing, report, run };
}
