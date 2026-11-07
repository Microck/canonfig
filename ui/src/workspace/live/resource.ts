import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Schema } from "effect";
import { GuiRequestError, type WorkspaceBackend } from "../../gui-client";
import type { ResourceState } from "../workspace-types";
import { GuiOperationTicket } from "../../../../src/gui/contract/operations";

export interface LiveResource<T> extends ResourceState { data: T | null }
interface CachedResource extends LiveResource<unknown> { stale: boolean }

/** One cache per live session. Route changes retain reads; explicit invalidation makes them stale. */
export class LiveResourceCache {
  private entries = new Map<string, CachedResource>();
  private listeners = new Set<() => void>();
  private controllers = new Map<string, AbortController>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  get = (path: string): CachedResource => {
    let entry = this.entries.get(path);
    if (!entry) {
      entry = { data: null, loading: false, error: null, stale: true };
      this.entries.set(path, entry);
    }
    return entry;
  };
  private update(path: string, entry: CachedResource) {
    this.entries.set(path, entry);
    for (const listener of this.listeners) listener();
  }
  set(path: string, data: unknown) {
    this.controllers.get(path)?.abort();
    this.controllers.delete(path);
    this.update(path, { data, loading: false, error: null, stale: false });
  }
  load<T>(backend: WorkspaceBackend, path: string, schema: Schema.Codec<T, unknown>) {
    const entry = this.get(path);
    if (!entry.stale || this.controllers.has(path)) return;
    const controller = new AbortController();
    this.controllers.set(path, controller);
    this.update(path, { ...entry, loading: true, error: null, stale: false });
    void backend.request(path, schema, controller.signal).then(
      (data) => { if (!controller.signal.aborted) this.update(path, { data, loading: false, error: null, stale: false }); },
      (cause: unknown) => { if (!controller.signal.aborted) this.update(path, { ...entry, loading: false, error: requestError(cause), stale: false }); },
    ).finally(() => { if (this.controllers.get(path) === controller) this.controllers.delete(path); });
  }
  invalidate = (paths: readonly string[] = [...this.entries.keys()]) => {
    for (const path of paths) {
      this.controllers.get(path)?.abort();
      this.controllers.delete(path);
      this.update(path, { ...this.get(path), loading: false, error: null, stale: true });
    }
  };
  dispose = () => { this.invalidate([...this.controllers.keys()]); };
}

export const LiveResourcesContext = createContext<{ cache: LiveResourceCache; paths: readonly string[] } | null>(null);

export function useLiveResource<T>(backend: WorkspaceBackend, path: string, schema: Schema.Codec<T, unknown>, allowed: boolean): LiveResource<T> {
  const context = useContext(LiveResourcesContext);
  if (!context) throw new Error("Live resources require a session cache.");
  const { cache, paths } = context;
  const enabled = allowed && paths.includes(path);
  const entry = useSyncExternalStore(cache.subscribe, () => cache.get(path));
  useEffect(() => {
    if (enabled && entry.stale) cache.load(backend, path, schema);
  }, [backend, cache, path, schema, enabled, entry.stale]);
  // Each endpoint has one shared contract, decoded before entering this session's cache.
  return { data: entry.data as T | null, loading: enabled && (entry.stale || entry.loading), error: enabled ? entry.error : null };
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
    if (controller.current !== null) {
      setState((state) => ({ ...state, error: new GuiRequestError({ category: "usage-or-configuration", exitCode: 2, message: "Another action is running. Wait for it to finish, then retry." }) }));
      return;
    }
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
    if (operation.state === "failed") throw new GuiRequestError(operation.failure);
    return operation;
  }
  return { state, run, operation };
}
