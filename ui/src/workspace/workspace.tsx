// Workspace screens share a sidebar, detail panels, and command palette.
import { useState } from "react";
import { List, X } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Logo } from "@/shared/shared";
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
    // Below md (768px) the 244px sidebar would leave ~140px for content, so it moves into a left Sheet behind a
    // menu button in a slim top bar. From md up the layout is unchanged.
    <div className="flex h-svh flex-col bg-canvas text-foreground md:flex-row">
      <a
        href="#workspace-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-panel focus:px-4 focus:py-3 focus:text-sm focus:font-medium focus:text-foreground focus:outline-2 focus:outline-offset-2 focus:outline-ring"
      >
        Skip to content
      </a>
      <MobileNav />
      <Sidebar className="hidden md:flex" />
      <main id="workspace-content" tabIndex={-1} data-tour="main" className="mx-2 mb-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-panel focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:my-2 md:ml-0">
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

/** Mobile-only top bar whose menu opens the same Sidebar in a Sheet. Navigating closes the Sheet. */
function MobileNav() {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  // Close on page change during render rather than in an effect, so the new page never paints under an open sheet.
  const [shownView, setShownView] = useState(ws.view);
  if (shownView !== ws.view) {
    setShownView(ws.view);
    setOpen(false);
  }
  return (
    <div className="flex h-[48px] shrink-0 items-center gap-1 px-1 md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="size-10" aria-label="Open navigation">
            <List className="size-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" showCloseButton={false} className="w-[244px] gap-0 border-sidebar-border bg-sidebar p-0">
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-sidebar-border pr-2 pl-5">
            <SheetTitle>Navigation</SheetTitle>
            <SheetClose asChild>
              <Button variant="ghost" size="icon" className="size-11" aria-label="Close navigation">
                <X className="size-4" />
              </Button>
            </SheetClose>
          </div>
          <SheetDescription className="sr-only">Pages and settings for this machine</SheetDescription>
          <Sidebar className="min-h-0 w-full flex-1 [&_[data-tour=machine]]:min-h-11" onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <span className="flex min-w-0 items-center gap-2 text-base">
        <Logo />
        <span className="truncate font-semibold">{ws.machineName}</span>
        <span className="shrink-0 text-sm text-muted-foreground">{ws.role === "source" ? "Source" : "Follower"}</span>
      </span>
    </div>
  );
}

function NotFound() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 bg-canvas px-6 text-center text-foreground">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">This address is not a page for this machine role.</p>
      <Button asChild size="lg">
        <a href="/source/overview" onClick={followLink}>
          Go to Source overview
        </a>
      </Button>
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
