import { useState } from "react";
import { Schema } from "effect";
import { GuiBackupList, GuiBackupOwners, GuiBackupStatus, GuiBackupWarnings, type GuiBackupRequest } from "../../../../src/gui/contract/backup";
import type { WorkspaceBackend } from "../../gui-client";
import type { BackupSlice } from "../workspace-types";
import { resourceState, useLiveActions, useLiveResource } from "./resource";

/** /api/backup/status plus one operation channel; each policy's latest list and owners results are kept for the copies list. */
export function useLiveBackups(backend: WorkspaceBackend, reload: () => void): BackupSlice {
  const status = useLiveResource(backend, "/api/backup/status", GuiBackupStatus, true);
  const actions = useLiveActions(backend, reload);
  const [listings, setListings] = useState<BackupSlice["listings"]>({});
  const [owners, setOwners] = useState<BackupSlice["owners"]>({});
  const run = async (input: GuiBackupRequest) => {
    let warnings: ReadonlyArray<string> = [];
    const done = await actions.run(async signal => {
      const operation = await actions.operation("/api/backup", input, signal);
      signal.throwIfAborted();
      if (input.action === "list") setListings(previous => ({ ...previous, [input.name]: Schema.decodeUnknownSync(GuiBackupList)(operation.result) }));
      if (input.action === "owners") setOwners(previous => ({ ...previous, [input.name]: Schema.decodeUnknownSync(GuiBackupOwners)(operation.result).owners }));
      // Save, resume and check run the destination preflight; what it could not settle comes back as warnings.
      if (input.action === "configure" || input.action === "enable" || input.action === "check") warnings = Schema.decodeUnknownSync(GuiBackupWarnings)(operation.result).warnings;
      // A run, retention change or new destination makes that policy's listed copies stale.
      if (input.action === "run" || input.action === "prune" || input.action === "configure") setListings(({ [input.name]: _stale, ...rest }) => rest);
    }, { reload: input.action !== "list" && input.action !== "owners" && input.action !== "check" });
    // A failed run or restore test is recorded too, so the page shows it rather than the last success.
    if (!done && (input.action === "run" || input.action === "drill")) reload();
    return done ? { warnings } : null;
  };
  return { status: status.data, state: resourceState([status]), action: actions.state, listings, owners, run };
}
