import type { ReactNode } from "react";
import type { GuiSession, GuiStatus, WorkspaceBackend } from "../gui-client";

export interface LiveScreenProps {
  readonly session: GuiSession;
  readonly status: GuiStatus;
  readonly backend: WorkspaceBackend;
}
export interface LiveScreen {
  readonly title: string;
  /** Return undefined for roles that must not see this screen. */
  readonly path: (role: GuiSession["role"]) => string | undefined;
  readonly render: (props: LiveScreenProps) => ReactNode;
}
