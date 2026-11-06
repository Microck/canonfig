import { GuiStatus } from "../../../../src/gui/contract/session";
import { GuiRequestError, type GuiSession, type WorkspaceBackend } from "../../gui-client";
import { useWorkspaceNavigation } from "../navigation-state";
import { navigate, type WorkspaceRoute } from "../routes";
import type { OverviewSlice } from "../workspace-types";
import { notImplemented, useLiveResource } from "./resource";

/** Overview has no pending adapters. Status is local evidence, never fleet telemetry. */
export function useLiveOverview(backend: WorkspaceBackend, session: GuiSession, route: WorkspaceRoute, revision: number, reload: () => void): OverviewSlice {
  const navigation = useWorkspaceNavigation(route, navigate);
  const status = useLiveResource(backend, "/api/status", GuiStatus, true, revision);
  const roleChanged = status.data !== null && status.data.machineRole.role !== session.role;
  const error = roleChanged ? new GuiRequestError({ category: "conflict-or-drift", exitCode: 4, message: "This machine's role changed while loading. Reload to read its current role and status." }) : status.error;
  return {
    ...navigation, session, status: roleChanged ? undefined : status.data ?? undefined,
    machineName: session.machineName, folderPath: session.folderPath, version: session.version,
    reload: roleChanged ? () => window.location.reload() : reload,
    sourceActivity: [], overviewState: { loading: status.loading, error },
    pageLoading: status.loading,
    capabilities: {
      invitationCancel: false, selectiveScanWrite: false, serviceRestart: false,
      privateReviewDelete: false, simulatedTelemetry: false, selfUpdateMutations: false,
      profileWrite: true, enrollmentWrite: true, followerWrite: true,
    },
    notImplemented,
    later: () => notImplemented("Simulated operation"),
  };
}
