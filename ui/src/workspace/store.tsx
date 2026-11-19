import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { Workspace } from "./workspace-types";
export type * from "./workspace-types";

export const WorkspaceContext = createContext<Workspace | null>(null);

declare const sharedKeyType: unique symbol;
interface SharedKey<T> {
  readonly initial: T;
  readonly [sharedKeyType]?: (value: T) => T;
}

/** Each key owns its default and is identified by the key object itself. */
export const sharedKey = <T,>(initial: T): SharedKey<T> => ({ initial });

const sharedEntryType = Symbol("shared state seed");
type SharedEntry = readonly [object, unknown] & { readonly [sharedEntryType]: true };
type SharedValues = ReadonlyMap<object, unknown>;
export const seedSharedValue = <T,>(key: SharedKey<T>, value: NoInfer<T>): SharedEntry =>
  Object.assign([key, value] as const, { [sharedEntryType]: true as const });

function sharedValue<T>(values: SharedValues, key: SharedKey<T>): T {
  return values.has(key) ? values.get(key) as T : key.initial;
}

interface SharedStore {
  values: SharedValues;
  update: <T>(key: SharedKey<T>, fn: (prev: T) => T) => void;
  read: <T>(key: SharedKey<T>) => T;
}
const SharedContext = createContext<SharedStore | null>(null);

/** Browser-owned drafts and presentation preferences, never a live machine mutation. */
export function SharedStateProvider({ initial, children }: { initial?: () => readonly SharedEntry[]; children: ReactNode }) {
  const [values, setValues] = useState(() => new Map(initial?.()));
  const update = useCallback(<T,>(key: SharedKey<T>, fn: (prev: T) => T) => {
    setValues((prev) => new Map(prev).set(key, fn(sharedValue(prev, key))));
  }, []);
  const latest = useRef(values);
  latest.current = values;
  const read = useCallback(<T,>(key: SharedKey<T>) => sharedValue(latest.current, key), []);
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
 */
export function useSharedState<T>(key: SharedKey<T>): [T, (next: T | ((prev: T) => T)) => void] {
  const ctx = useContext(SharedContext);
  if (!ctx) throw new Error("useSharedState outside WorkspaceProvider");
  const value = sharedValue(ctx.values, key);
  const { update } = ctx;
  const set = useCallback(
    (next: T | ((prev: T) => T)) => update(key, (prev) => (typeof next === "function" ? (next as (p: T) => T)(prev) : next)),
    [key, update],
  );
  return [value, set];
}

/**
 * Reads `key` when called rather than when rendered, like `isStopped`: for a delayed callback that
 * must see a value changed while it waited, such as a tunnel stopped during a secret refresh.
 */
export function useSharedReader<T>(key: SharedKey<T>): () => T {
  const ctx = useContext(SharedContext);
  if (!ctx) throw new Error("useSharedReader outside WorkspaceProvider");
  const { read } = ctx;
  return () => read(key);
}
