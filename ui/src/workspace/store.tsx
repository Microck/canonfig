import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { Workspace } from "./workspace-types";
export type * from "./workspace-types";

export const WorkspaceContext = createContext<Workspace | null>(null);

interface SharedStore {
  values: Readonly<Record<string, unknown>>;
  update: (key: string, fn: (prev: unknown) => unknown, initial: unknown) => void;
  read: (key: string, initial: unknown) => unknown;
}
const SharedContext = createContext<SharedStore | null>(null);

/** Browser-owned drafts and presentation preferences, never a live machine mutation. */
export function SharedStateProvider({ initial = {}, children }: { initial?: Readonly<Record<string, unknown>>; children: ReactNode }) {
  const [values, setValues] = useState(initial);
  const update = useCallback((key: string, fn: (prev: unknown) => unknown, fallback: unknown) => {
    setValues((prev) => ({ ...prev, [key]: fn(key in prev ? prev[key] : fallback) }));
  }, []);
  const latest = useRef(values);
  latest.current = values;
  const read = useCallback((key: string, fallback: unknown) => key in latest.current ? latest.current[key] : fallback, []);
  const shared = useMemo(() => ({ values, update, read }), [values, update, read]);
  return <SharedContext value={shared}>{children}</SharedContext>;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace outside WorkspaceProvider");
  return ctx;
}

/**
 * Browser-owned state that must outlive its page, including unfinished drafts and
 * simulated machine state in the demo. Live machine state belongs to the live slices.
 * Values last for the workspace session; a reload reads the backend again.
 * Every reader of a key must pass the same `initial`; the first write wins over it.
 */
export function useSharedState<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const ctx = useContext(SharedContext);
  if (!ctx) throw new Error("useSharedState outside WorkspaceProvider");
  const value = (key in ctx.values ? ctx.values[key] : initial) as T;
  const { update } = ctx;
  const set = useCallback(
    (next: T | ((prev: T) => T)) => update(key, (prev) => (typeof next === "function" ? (next as (p: T) => T)(prev as T) : next), initial),
    // `initial` is only the fallback for the first write; callers pass a stable literal per key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, update],
  );
  return [value, set];
}

/**
 * Reads `key` when called rather than when rendered, like `isStopped`: for a delayed callback that
 * must see a value changed while it waited, such as a tunnel stopped during a secret refresh.
 * Pass the same `initial` as the key's `useSharedState` readers.
 */
export function useSharedReader<T>(key: string, initial: T): () => T {
  const ctx = useContext(SharedContext);
  if (!ctx) throw new Error("useSharedReader outside WorkspaceProvider");
  const { read } = ctx;
  return () => read(key, initial) as T;
}
