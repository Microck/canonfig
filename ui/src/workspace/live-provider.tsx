import { useCallback, useState, type ReactNode } from "react";
import type { GuiSession, WorkspaceBackend } from "../gui-client";
import { ScreenContext } from "./screen-context";
import { SharedStateProvider, WorkspaceContext } from "./store";
import type { Workspace, ResourceState } from "./workspace-types";
import type { WorkspaceRoute } from "./routes";
import { PAGE_TIPS } from "./page-tips";
import { useLiveOverview } from "./live/overview";
import { useLiveProfile } from "./live/profile";
import { useLiveMachines } from "./live/machines";
import { useLiveFollower } from "./live/follower";
import { useLiveAdministration } from "./live/administration";

/** Each area owns its reads and mutations; only browser navigation and preferences are shared. */
export function LiveWorkspaceProvider({ backend, session, route, children }: {
  backend: WorkspaceBackend;
  session: GuiSession;
  route: WorkspaceRoute;
  children: ReactNode;
}) {
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const overview = useLiveOverview(backend, session, route, revision, reload);
  const profile = useLiveProfile(backend, session, revision, reload);
  const machines = useLiveMachines(backend, session, revision, reload);
  const follower = useLiveFollower(backend, session, overview.status, revision, reload);
  const admin = useLiveAdministration(backend, session);
  const service = admin.service.data;
  const resources: Partial<Record<Workspace["view"], ResourceState>> = {
    overview: overview.overviewState,
    profile: profile.profileState, revisions: profile.profileStates.revisions,
    secrets: session.role === "follower" ? follower.followerState : profile.profileStates.secrets,
    machines: machines.machinesState, sync: follower.followerState, schedule: follower.followerStates.schedule,
    local: follower.followerStates.local, backups: follower.followerStates.backups, tunnel: follower.followerStates.tunnel,
    machine: session.role === "follower" ? follower.followerState : machines.machineStates.enrollment,
  };
  const resource = resources[route.view];
  const workspace: Workspace = {
    ...overview, ...profile, ...machines, ...follower, admin,
    profileTab: route.profileTab, machinesMode: route.machinesMode,
    endpoint: session.role === "source" ? service?.endpoint ?? "" : machines.endpoint,
    sourceMachine: { ...machines.sourceMachine, ...(session.role === "source" && service ? { endpoint: service.endpoint, platform: service.platform, service: service.state } : {}) },
    serviceInstalled: service?.manager.installed ?? false,
    pageLoading: resource?.loading ?? false,
    pageError: resource?.error,
  };
  return <SharedStateProvider>
    <WorkspaceContext value={workspace}>
      <ScreenContext value={{
        pageLoading: workspace.pageLoading, navigate: workspace.navigate,
        openHelp: PAGE_TIPS[workspace.role][workspace.view] ? () => workspace.openTip(workspace.view) : undefined,
        groups: [workspace.profile.groups, () => workspace.notImplemented("Profile groups")],
      }}>
        {children}
      </ScreenContext>
    </WorkspaceContext>
  </SharedStateProvider>;
}
