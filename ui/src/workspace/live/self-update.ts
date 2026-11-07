import { useCallback, useEffect, useRef } from "react";
import { Schema } from "effect";
import { GuiOperationTicket } from "../../../../src/gui/contract/operations";
import { GuiSelfUpdateCheck, GuiSelfUpdateProgress, GuiSelfUpdateStatus } from "../../../../src/gui/contract/administration";
import { GuiRequestError, type WorkspaceBackend } from "../../gui-client";
import { TransitionError, useStateMachine } from "../../lib/state-machine";

type Status = typeof GuiSelfUpdateStatus.Type;
type Check = typeof GuiSelfUpdateCheck.Type;
type Progress = typeof GuiSelfUpdateProgress.Type;
export interface InstalledUpdate { version: string; detail: string }
export type UpdateLifecycle =
  | { kind: "unloaded" }
  | { kind: "loading"; status: Status | null }
  | { kind: "ready"; status: Status; checked: Check | null }
  | { kind: "changing"; status: Status; action: "check" | "enable" | "disable" | "apply" }
  | { kind: "applying"; status: Status; ticket: string; progress: Progress | null }
  | { kind: "observation-lost"; status: Status; ticket: string; lastProgress: Progress | null; error: GuiRequestError }
  | { kind: "failed"; status: Status | null; error: GuiRequestError }
  | { kind: "installed"; status: Status; checked: Check };
export type UpdateEvent =
  | { kind: "load" }
  | { kind: "status"; status: Status }
  | { kind: "start"; action: "check" | "enable" | "disable" | "apply" }
  | { kind: "ticket"; ticket: string }
  | { kind: "progress"; progress: Progress }
  | { kind: "checked"; checked: Check }
  | { kind: "resume" }
  | { kind: "failed"; error: GuiRequestError; terminal?: boolean };
export function transitionUpdate(state: UpdateLifecycle, event: UpdateEvent): UpdateLifecycle {
  const status = "status" in state ? state.status : null;
  switch (event.kind) {
    case "load":
      if (["unloaded", "ready", "failed"].includes(state.kind)) return { kind: "loading", status };
      break;
    case "status":
      if (state.kind === "loading" || state.kind === "changing") return { kind: "ready", status: event.status, checked: null };
      break;
    case "start":
      if (status && (state.kind === "ready" || state.kind === "failed")) {
        if ((event.action === "check" || event.action === "apply" || event.action === "disable") && !status.enabled) break;
        if (event.action === "apply" && (state.kind !== "ready" || state.checked?.status !== "available")) break;
        return { kind: "changing", status, action: event.action };
      }
      break;
    case "ticket":
      if (state.kind === "changing" && state.action === "apply") return { kind: "applying", status: state.status, ticket: event.ticket, progress: null };
      break;
    case "progress": if (state.kind === "applying") return { ...state, progress: event.progress }; break;
    case "checked":
      if (status && (state.kind === "applying" || (state.kind === "changing" && state.action === "check"))) return { kind: event.checked.status === "updated" ? "installed" : "ready", status, checked: event.checked };
      break;
    case "resume":
      if (state.kind === "observation-lost") return { kind: "applying", status: state.status, ticket: state.ticket, progress: state.lastProgress };
      break;
    case "failed":
      if (state.kind === "applying" && !event.terminal) return { kind: "observation-lost", status: state.status, ticket: state.ticket, lastProgress: state.progress, error: event.error };
      if (state.kind === "loading" || state.kind === "changing" || state.kind === "applying") return { kind: "failed", status, error: event.error };
      break;
  }
  throw new TransitionError("Self-update", state.kind, event.kind);
}
export function useLiveSelfUpdate(backend: WorkspaceBackend, enabled: boolean, onInstalled: (result: InstalledUpdate) => void) {
  const flow = useStateMachine<UpdateLifecycle, UpdateEvent>({ kind: "unloaded" }, transitionUpdate);
  const { send: sendFlow, current: flowCurrent } = flow;
  const active = useRef<AbortController | null>(null);
  const run = useCallback(async (work: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController(); active.current = controller;
    try { await work(controller.signal); }
    catch (cause) {
      if (!controller.signal.aborted) sendFlow({ kind: "failed", error: cause instanceof GuiRequestError ? cause : new GuiRequestError({ category: "internal", exitCode: 1, message: cause instanceof Error ? cause.message : "The update failed." }) });
    } finally { active.current = null; }
  }, [sendFlow]);
  const reload = useCallback(() => {
    sendFlow({ kind: "load" });
    void run(async (signal) => { sendFlow({ kind: "status", status: await backend.request("/api/self-update", GuiSelfUpdateStatus, signal) }); });
  }, [backend, sendFlow, run]);
  useEffect(() => { if (enabled && flowCurrent.current.kind === "unloaded") reload(); }, [enabled, reload, flowCurrent]);
  useEffect(() => () => active.current?.abort(), []);
  const observe = async (ticket: string, signal: AbortSignal) => {
    while (true) {
      const operation = await backend.operation(ticket, signal);
      signal.throwIfAborted();
      if (operation.journal !== null) sendFlow({ kind: "progress", progress: Schema.decodeUnknownSync(GuiSelfUpdateProgress)(operation.journal) });
      if (operation.state === "failed") {
        sendFlow({ kind: "failed", terminal: true, error: new GuiRequestError(operation.failure ?? { category: "internal", exitCode: 1, message: "The update failed without a diagnostic." }) });
        return;
      }
      if (operation.state === "succeeded") {
        const checked = Schema.decodeUnknownSync(GuiSelfUpdateCheck)(operation.result);
        sendFlow({ kind: "checked", checked });
        if (checked.status === "updated") onInstalled({ version: checked.candidate, detail: checked.detail });
        return;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
      signal.throwIfAborted();
    }
  };
  const change = (action: "check" | "enable" | "disable" | "apply", body: object = {}) => {
    sendFlow({ kind: "start", action });
    void run(async (signal) => {
      const path = `/api/self-update/${action}`;
      if (action === "apply") {
        const ticket = await backend.request(path, GuiOperationTicket, signal, { method: "POST", body });
        sendFlow({ kind: "ticket", ticket: ticket.id });
        await observe(ticket.id, signal);
      } else if (action === "check") sendFlow({ kind: "checked", checked: await backend.request(path, GuiSelfUpdateCheck, signal, { method: "POST", body }) });
      else sendFlow({ kind: "status", status: await backend.request(path, GuiSelfUpdateStatus, signal, { method: "POST", body }) });
    });
  };
  const state = flow.state;
  return { lifecycle: state, data: "status" in state ? state.status : null, checked: "checked" in state ? state.checked : null,
    loading: state.kind === "loading" || (enabled && state.kind === "unloaded"), busy: ["loading", "changing", "applying"].includes(state.kind),
    error: "error" in state ? state.error : null, checking: state.kind === "changing" && state.action === "check",
    progress: state.kind === "applying" ? state.progress : null, reload,
    check: () => change("check"), enable: (npmCli: string, confirmIdle: boolean) => change("enable", { npmCli, confirmIdle }), disable: () => change("disable"), apply: () => change("apply"),
    resume: () => { const next = sendFlow({ kind: "resume" }); if (next.kind === "applying") void run((signal) => observe(next.ticket, signal)); },
  };
}
