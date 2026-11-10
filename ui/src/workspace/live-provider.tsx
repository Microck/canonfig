import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { InstalledUpdate } from "./live/self-update";
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
import { LiveResourceCache, LiveResourcesContext, resourceState } from "./live/resource";
import { isRouteForRole } from "./nav";

/** Dependencies are page-specific; status remains shared local machine evidence. */
export function livePageResources(session: GuiSession, route: WorkspaceRoute): readonly string[] {
  if (!isRouteForRole(route, session.role)) return [];
  // The Source service state drives the workspace-wide notice bar, so every Source page reads it.
  const shared = session.role === "source" ? ["/api/status", "/api/source-service"] : ["/api/status"];
  const pages: Partial<Record<Workspace["view"], readonly string[]>> = {
    profile: ["/api/profile/items", "/api/revisions", ...(route.profileTab === "items" ? ["/api/skills"] : []), ...(route.profileTab === "harnesses" ? ["/api/harnesses"] : []), ...(route.profileTab === "groups" ? ["/api/machines"] : [])],
    revisions: ["/api/revisions"],
    machines: session.role === "source" ? ["/api/machines", "/api/profile/items"] : ["/api/enrollment"],
    secrets: session.role === "source" ? ["/api/secrets", "/api/machines"] : ["/api/secrets", "/api/tunnel"],
    sync: ["/api/tunnel"],
    schedule: ["/api/schedule"],
    local: ["/api/local/items", "/api/harnesses", "/api/local/overlays"],
    backups: ["/api/backups", "/api/local/items"],
    tunnel: ["/api/tunnel"],
    machine: ["/api/enrollment", "/api/tunnel", "/api/local/items"],
    agent: ["/api/agent/policy", "/api/agent/harness"],
    installers: ["/api/installers"],
    version: ["/api/self-update"],
    setup: ["/api/setup"],
  };
  return [...shared, ...(pages[route.view] ?? [])];
}

/** Each area owns its reads and mutations; only browser navigation and preferences are shared. */
export function LiveWorkspaceProvider({ backend, session, route, onInstalled, children }: {
  backend: WorkspaceBackend;
  session: GuiSession;
  route: WorkspaceRoute;
  children: ReactNode;
  onInstalled: (result: InstalledUpdate) => void;
}) {
  const [cache] = useState(() => new LiveResourceCache());
  const paths = livePageResources(session, route);
  useEffect(() => () => cache.dispose(), [cache]);
  return <LiveResourcesContext value={{ cache, paths }}>
    <LiveWorkspace backend={backend} session={session} route={route} cache={cache} paths={paths} onInstalled={onInstalled}>{children}</LiveWorkspace>
  </LiveResourcesContext>;
}

function LiveWorkspace({ backend, session, route, cache, paths, onInstalled, children }: {
  backend: WorkspaceBackend; session: GuiSession; route: WorkspaceRoute;
  cache: LiveResourceCache; paths: readonly string[]; children: ReactNode;
  onInstalled: (result: InstalledUpdate) => void;
}) {
  const admin = useLiveAdministration(backend, session, paths, onInstalled);
  const reload = useCallback(() => {
    cache.invalidate(paths);
    if (paths.includes("/api/source-service")) admin.service.reload();
  }, [cache, paths, admin.service.reload]);
  const invalidate = useCallback(() => cache.invalidate(), [cache]);
  const overview = useLiveOverview(backend, session, route, reload);
  const profile = useLiveProfile(backend, session, invalidate, reload);
  const machines = useLiveMachines(backend, session, invalidate);
  const follower = useLiveFollower(backend, session, overview.status, invalidate);
  const service = admin.service.data;
  const resources: Partial<Record<Workspace["view"], ResourceState>> = {
    overview: overview.overviewState,
    profile: resourceState([profile.profileState, follower.followerStates.harnesses, machines.machineStates.inventory]), revisions: profile.profileStates.revisions,
    secrets: session.role === "follower" ? follower.followerState : resourceState([profile.profileStates.secrets, machines.machineStates.inventory]),
    // The service resource is not part of Machines: its state and request failures show once, in ServiceNotice.
    machines: resourceState([machines.machinesState, profile.profileStates.items]),
    sync: follower.followerState, schedule: follower.followerStates.schedule,
    local: follower.followerStates.local,
    backups: resourceState([follower.followerStates.backups, follower.followerStates.local]),
    tunnel: follower.followerStates.tunnel,
    machine: resourceState([follower.followerState, follower.followerStates.local]),
    setup: machines.machineStates.setup,
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
