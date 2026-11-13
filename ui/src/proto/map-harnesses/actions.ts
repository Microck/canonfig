import { createContext, use } from "react";
import type { Harness, Machine } from "./fixtures";

type MapActions = { select: (id: string) => void; inspect: (machine: Machine, harness: Harness, trigger: HTMLButtonElement) => void };
export const Actions = createContext<MapActions | null>(null);
export function useActions() {
  const actions = use(Actions);
  if (!actions) throw new Error("Map actions require the prototype provider");
  return actions;
}
