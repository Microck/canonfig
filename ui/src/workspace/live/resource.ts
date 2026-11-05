import { useEffect, useRef, useState } from "react";
import type { Schema } from "effect";
import { GuiRequestError, type WorkspaceBackend } from "../../gui-client";
import type { ResourceState } from "../workspace-types";
import { GuiOperationTicket } from "../../../../src/gui/contract/operations";

export interface LiveResource<T> extends ResourceState { data: T | null }

/** Reads are cancelled on unmount or role changes. Failed refreshes retain their last successful value. */
export function useLiveResource<T>(backend: WorkspaceBackend, path: string, schema: Schema.Codec<T, unknown>, enabled: boolean, revision: number): LiveResource<T> {
  const [resource, setResource] = useState<LiveResource<T>>({ data: null, loading: enabled, error: null });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setResource((previous) => ({ ...previous, loading: true, error: null }));
    void backend.request(path, schema, controller.signal).then(
      (data) => { if (!controller.signal.aborted) setResource({ data, loading: false, error: null }); },
      (cause: unknown) => { if (!controller.signal.aborted) setResource((previous) => ({ ...previous, loading: false, error: requestError(cause) })); },
    );
    return () => controller.abort();
  }, [backend, path, schema, enabled, revision]);
  return resource;
}

export function requestError(cause: unknown): GuiRequestError {
  return cause instanceof GuiRequestError ? cause : new GuiRequestError({
    category: "internal", exitCode: 1,
    message: cause instanceof Error ? cause.message : "Canonfig could not complete this operation.",
  });
}

/** Unported mutations must never run a demo timer or acknowledge an unwritten change. */
export function notImplemented(member: string): never {
  throw new GuiRequestError({ category: "human-action-required", exitCode: 3,
    message: `${member} is not connected to this screen yet. Use the matching Canonfig CLI command.`,
  });
}

export function resourceState(resources: readonly ResourceState[]): ResourceState {
  return { loading: resources.some((resource) => resource.loading), error: resources.find((resource) => resource.error !== null)?.error ?? null };
}

export function useLiveActions(backend: WorkspaceBackend, reload: () => void) {
  const [state, setState] = useState<ResourceState>({ loading: false, error: null });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function run(action: (signal: AbortSignal) => Promise<unknown>) {
    if (controller.current !== null) return;
    const active = new AbortController();
    controller.current = active;
    setState({ loading: true, error: null });
    try {
      await action(active.signal);
      if (!active.signal.aborted) { setState({ loading: false, error: null }); reload(); }
    } catch (cause) {
      if (!active.signal.aborted) setState({ loading: false, error: requestError(cause) });
    } finally {
      controller.current = null;
    }
  }
  async function operation(path: string, body: unknown, signal: AbortSignal) {
    const ticket = await backend.request(path, GuiOperationTicket, signal, { method: "POST", body });
    let operation = await backend.operation(ticket.id, signal);
    while (operation.state === "running") {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
      signal.throwIfAborted();
      operation = await backend.operation(operation.id, signal);
    }
    if (operation.state === "failed") throw operation.failure ? new GuiRequestError(operation.failure) : new Error("The operation failed without a diagnostic.");
    return operation;
  }
  return { state, run, operation };
}
