import { useState } from "react";
import { Schema } from "effect";
import { GuiBackupList, GuiBackupStatus, type GuiBackupRequest } from "../../../../src/gui/contract/backup";
import type { WorkspaceBackend } from "../../gui-client";
import { useLiveActions, useLiveResource } from "./resource";

export function useLiveBackups(backend: WorkspaceBackend, reload: () => void) {
  const status = useLiveResource(backend, "/api/backup/status", GuiBackupStatus, true);
  const actions = useLiveActions(backend, reload);
  const [listing, setListing] = useState<{ name: string; value: GuiBackupList } | null>(null);
  const [report, setReport] = useState<{ action: string; name?: string; value: Schema.Json } | null>(null);
  const run = async (input: GuiBackupRequest): Promise<boolean> => {
    let succeeded = false;
    await actions.run(async signal => {
      setReport(null);
      if (input.action === "list") setListing(null);
      const operation = await actions.operation("/api/backup", input, signal);
      signal.throwIfAborted();
      if (input.action === "list") setListing({ name: input.name, value: Schema.decodeUnknownSync(GuiBackupList)(operation.result) });
      else setReport({ action: input.action, ...("name" in input ? { name: input.name } : {}), value: operation.result });
      if (input.action === "run" || input.action === "prune") setListing(null);
      succeeded = true;
    });
    return succeeded;
  };
  return { status, action: actions.state, listing, report, run };
}
