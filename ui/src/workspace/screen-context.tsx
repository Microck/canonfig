import { createContext, useContext } from "react";
import type { Navigate } from "./routes";

export interface ScreenGroup { name: string; description?: string }
/** Presentation state for shared components. All operational data belongs to the injected area backend. */
export interface ScreenContextValue {
  readonly pageLoading: boolean;
  readonly navigate: Navigate;
  readonly openHelp?: () => void;
  readonly publication?: { readonly sequence: number; readonly open: () => void };
  readonly groups?: [ScreenGroup[], (next: ScreenGroup[] | ((previous: ScreenGroup[]) => ScreenGroup[])) => void];
}
export const ScreenContext = createContext<ScreenContextValue | null>(null);
export function useScreenContext() {
  const context = useContext(ScreenContext);
  if (context === null) throw new Error("Shared workspace components require ScreenContext.");
  return context;
}
