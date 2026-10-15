// Workspace screens share a sidebar, detail panels, and command palette.
import { useState } from "react";
import { TipHost, TourHost, TourOffer } from "./guide";
import { followLink, navigate, workspaceHref, type AppRoute } from "./routes";
import { Palette, Sidebar } from "./frame";
import { ChangeGroupsDialog, InviteDialog, MachinesView } from "./machines";
import { Onboarding, type Setup } from "@/onboarding/onboarding";
import { ProfileView } from "./profile";
import { PublishDialog, RevisionsView, SecretsView, SourceOverview } from "./source";
import { AgentPolicyView, DoctorView, HarnessView, InstallersView, ServiceView, SetupView } from "./settings";
import {
  FollowerOverview,
  FollowerSecretsView,
  MachineView,
  OverlaysView,
  ScheduleView,
  SyncView,
  TunnelView,
  UnenrollDialog,
} from "./follower";
import { WorkspaceProvider, useWorkspace, type View } from "./store";

const SOURCE_SCREENS: Partial<Record<View, () => React.ReactElement>> = {
  overview: SourceOverview,
  profile: ProfileView,
  machines: MachinesView,
  revisions: RevisionsView,
  secrets: SecretsView,
  service: ServiceView,
  agent: AgentPolicyView,
  harness: HarnessView,
  installers: InstallersView,
  setup: SetupView,
  doctor: DoctorView,
};

const FOLLOWER_SCREENS: Partial<Record<View, () => React.ReactElement>> = {
  overview: FollowerOverview,
  machines: MachinesView,
  sync: SyncView,
  schedule: ScheduleView,
  overlays: OverlaysView,
  secrets: FollowerSecretsView,
  tunnel: TunnelView,
  agent: AgentPolicyView,
  harness: HarnessView,
  doctor: DoctorView,
  machine: MachineView,
};

function Frame() {
  const ws = useWorkspace();
  const screens = ws.role === "source" ? SOURCE_SCREENS : FOLLOWER_SCREENS;
  const Screen = screens[ws.view];
  if (!Screen) return <NotFound />;
  return (
    <div className="flex h-svh bg-canvas text-foreground">
      <Sidebar />
      <main data-tour="main" className="my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-panel">
        <Screen key={ws.view} />
      </main>
      <Palette />
      {ws.tourOpen && <TourHost />}
      <TourOffer />
      <TipHost />
      {ws.role === "source" ? (
        <>
          <PublishDialog />
          <InviteDialog />
          <ChangeGroupsDialog />
        </>
      ) : (
        <UnenrollDialog />
      )}
    </div>
  );
}

function NotFound() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 bg-canvas px-6 text-foreground">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">This address is not a page for this machine role.</p>
      <a href="/source/overview" onClick={followLink} className="rounded text-sm underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring/60">
        Go to Source overview
      </a>
    </main>
  );
}

export function WorkspaceApp({ route }: { route: AppRoute }) {
  const role = route.kind === "workspace" ? route.role : route.kind;
  // Setup belongs to this role session. Changing pages keeps demo edits; changing roles starts fresh.
  const [session, setSession] = useState<{ role: typeof role; setup: Setup | null }>({ role, setup: null });
  if (session.role !== role) {
    setSession({ role, setup: null });
    return null;
  }
  if (route.kind === "not-found") return <NotFound />;
  if (route.kind === "setup") return <Onboarding onDone={(setup) => {
    setSession({ role: setup.role, setup });
    navigate(workspaceHref(setup.role, setup.role === "source" && setup.scan ? "profile" : "overview"));
  }} />;
  return (
    <WorkspaceProvider key={route.role} route={route} navigate={navigate} setup={session.setup}>
      <Frame />
    </WorkspaceProvider>
  );
}
