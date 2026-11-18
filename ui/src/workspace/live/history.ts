import { Schema } from "effect";

import { HistoryDiff, HistoryOperationResult, HistoryStatus, type HistoryRequest } from "../../../../src/gui/contract/history";
import type { WorkspaceBackend } from "../../gui-client";
import { resourceState, useLiveActions, useLiveResource } from "./resource";

export function useLiveHistory(backend: WorkspaceBackend, reload: () => void) {
  const status = useLiveResource(backend, "/api/history/status", HistoryStatus, true);
  const actions = useLiveActions(backend, reload);
  const run = async (request: HistoryRequest): Promise<typeof HistoryOperationResult.Type | { readonly diff: typeof HistoryDiff.Type } | null> => {
    let result: typeof HistoryOperationResult.Type | { readonly diff: typeof HistoryDiff.Type } | null = null;
    const refresh = request.action !== "check" && request.action !== "diff";
    const done = await actions.run(async signal => {
      const completed = await actions.operation("/api/history", request, signal);
      signal.throwIfAborted();
      result = request.action === "diff" ? { diff: Schema.decodeUnknownSync(HistoryDiff)(completed.result) }
        : Schema.decodeUnknownSync(HistoryOperationResult)(completed.result);
    }, { reload: refresh });
    if (!done && refresh) reload();
    return done ? result : null;
  };
  return { status: status.data, state: resourceState([status]), action: actions.state, run };
}
