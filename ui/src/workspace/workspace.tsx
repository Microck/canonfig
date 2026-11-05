// Workspace screens share a sidebar, detail panels, and command palette.
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { List, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { DEMO } from "@/shared/data";
import { DemoSwitcher } from "@/shared/demo-switcher";
import { Logo } from "@/shared/shared";
import { StarPrompt, TipHost, TourHost, TourOffer, TourPicker } from "./guide";
import { focusPageHeading, followLink, navigate, workspaceHref, type AppRoute } from "./routes";
import { Palette, Sidebar } from "./frame";
import { navItem } from "./nav";
import { ChangeGroupsDialog, InviteDialog, MachinesView } from "./machines";
import type { Setup } from "@/onboarding/onboarding";

// Setup only runs once per machine, so its screens and dither shader load on demand.
const Onboarding = lazy(() => import("@/onboarding/onboarding").then((m) => ({ default: m.Onboarding })));
import { ProfileView } from "./profile";
import { PublishDialog, RevisionsView, SecretsView, SourceOverview } from "./source";
import { AgentPolicyView, DoctorView, InstallersView, ServiceView, SetupView } from "./settings";
import { BackupsView } from "./harnesses";
// A session is one role, so the Follower screens load only when a Follower workspace opens. All of them share
// one chunk: after the first Follower page suspends once, page changes inside the role never suspend.
const follower = () => import("./follower");
const FollowerOverview = lazy(() => follower().then((m) => ({ default: m.FollowerOverview })));
const FollowerSecretsView = lazy(() => follower().then((m) => ({ default: m.FollowerSecretsView })));
const MachineView = lazy(() => follower().then((m) => ({ default: m.MachineView })));
const LocalView = lazy(() => follower().then((m) => ({ default: m.LocalView })));
const ScheduleView = lazy(() => follower().then((m) => ({ default: m.ScheduleView })));
const SyncView = lazy(() => follower().then((m) => ({ default: m.SyncView })));
const TunnelView = lazy(() => follower().then((m) => ({ default: m.TunnelView })));
const UnenrollDialog = lazy(() => follower().then((m) => ({ default: m.UnenrollDialog })));
import { WorkspaceProvider, useWorkspace, type View } from "./store";

const SOURCE_SCREENS: Partial<Record<View, React.ComponentType>> = {
  overview: SourceOverview,
  profile: ProfileView,
  machines: MachinesView,
  revisions: RevisionsView,
  backups: BackupsView,
  secrets: SecretsView,
  service: ServiceView,
  agent: AgentPolicyView,
  installers: InstallersView,
  setup: SetupView,
  doctor: DoctorView,
};

const FOLLOWER_SCREENS: Partial<Record<View, React.ComponentType>> = {
  overview: FollowerOverview,
  machines: MachinesView,
  sync: SyncView,
  schedule: ScheduleView,
  local: LocalView,
  backups: BackupsView,
  secrets: FollowerSecretsView,
  tunnel: TunnelView,
  agent: AgentPolicyView,
  doctor: DoctorView,
  machine: MachineView,
};

function Frame() {
  const ws = useWorkspace();
  const screens = ws.role === "source" ? SOURCE_SCREENS : FOLLOWER_SCREENS;
  const Screen = screens[ws.view];
  // Move focus to the new page's h1 on every page change after the first render, so a fresh load still gives the
  // first Tab to "Skip to content". An open overlay (nav sheet) still traps focus here, so its own close handler
  // moves focus instead. The tour card (aria-modal, no Radix data-state) switches pages from its own steps and
  // keeps focus on its buttons, so it counts as an open overlay too.
  const shownView = useRef(ws.view);
  useEffect(() => {
    if (shownView.current === ws.view) return;
    shownView.current = ws.view;
    // Wait until the outgoing page's effects have cleaned up before choosing the new focus target.
    const frame = requestAnimationFrame(() => {
      if (!document.querySelector('[role="dialog"][data-state="open"], [role="dialog"][aria-modal="true"]')) focusPageHeading();
    });
    return () => cancelAnimationFrame(frame);
  }, [ws.view]);
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
        <Suspense fallback={null}>
          <Screen key={ws.view} />
        </Suspense>
      </main>
      <Palette />
      {/* Keyed by tour, so moving to the next chapter starts a fresh tour at its first stop. */}
      {ws.tour && <TourHost key={ws.tour} />}
      <TourPicker />
      <TourOffer />
      <TipHost />
      <StarPrompt />
      {ws.role === "source" ? (
        <>
          <PublishDialog />
          <InviteDialog />
          <ChangeGroupsDialog />
        </>
      ) : (
        <Suspense fallback={null}>
          <UnenrollDialog />
        </Suspense>
      )}
    </div>
  );
}

/**
 * Mobile-only top bar whose menu opens the same Sidebar in a Sheet. Navigating closes the Sheet. In the demo,
 * its right end holds the compact Demo button, so the demo panel stays one tap away on every page.
 */
function MobileNav() {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const openedOn = useRef(ws.view);
  const openToursOnClose = useRef(false);
  // Close on page change during render rather than in an effect, so the new page never paints under an open sheet.
  const [shownView, setShownView] = useState(ws.view);
  if (shownView !== ws.view) {
    setShownView(ws.view);
    setOpen(false);
  }
  return (
    <div className="flex h-[48px] shrink-0 items-center gap-1 px-1 md:hidden">
      <Sheet open={open} onOpenChange={(next) => {
        if (next) openedOn.current = ws.view;
        setOpen(next);
      }}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="size-10" aria-label="Open navigation">
            <List className="size-5" />
          </Button>
        </SheetTrigger>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="w-[244px] gap-0 border-sidebar-border bg-sidebar p-0"
          // Radix returns focus to the menu button on close; after a page change the new heading should get it.
          onCloseAutoFocus={(event) => {
            // Open the tour picker only after the sheet's focus trap has been removed, so no
            // spotlight ever sits under the open sheet.
            if (openToursOnClose.current) {
              event.preventDefault();
              openToursOnClose.current = false;
              // Let Radix finish focus-scope teardown; the heading is then where focus returns after the tour.
              requestAnimationFrame(() => {
                focusPageHeading();
                ws.setTourPickerOpen(true);
              });
              return;
            }
            if (openedOn.current === ws.view) return;
            event.preventDefault();
            focusPageHeading();
          }}
        >
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-sidebar-border pr-2 pl-5">
            <SheetTitle>Navigation</SheetTitle>
            <SheetClose asChild>
              <Button variant="ghost" size="icon" className="size-11" aria-label="Close navigation">
                <X className="size-4" />
              </Button>
            </SheetClose>
          </div>
          <SheetDescription className="sr-only">Pages and settings for this machine</SheetDescription>
          <Sidebar
            className="min-h-0 w-full flex-1 [&_[data-tour=machine]]:min-h-11"
            onNavigate={() => setOpen(false)}
            onOpenTours={() => {
              openToursOnClose.current = true;
              setOpen(false);
            }}
          />
        </SheetContent>
      </Sheet>
      <span className="flex min-w-0 items-center gap-2 text-base">
        <Logo />
        <span className="truncate font-semibold">{ws.machineName}</span>
        <span className="shrink-0 text-sm text-muted-foreground">{ws.role === "source" ? "Source" : "Follower"}</span>
      </span>
      {DEMO && <DemoSwitcher role={ws.role} compact className="ml-auto shrink-0 pr-1" />}
    </div>
  );
}

/** Top-level docs sections, which lived at the domain root before the docs moved under /docs/ (website/content/docs). */
const RETIRED_DOCS_ROOT = /^\/(tutorials|how-to|explanation|reference)(\/|$)/;

function NotFound() {
  // GitHub Pages answers every unknown path on the demo's domain with this app's 404.html, mistyped or retired
  // docs links under /docs/ included, so the demo sends those back to the docs (a plain link: they are another site).
  const { pathname, search, hash } = window.location;
  const docs = DEMO && pathname.startsWith("/docs/");
  // Links from before the move (e.g. /reference/cli) go to the same page under /docs/. Never matches a /docs/ path, so it can't loop.
  if (DEMO && RETIRED_DOCS_ROOT.test(pathname)) {
    window.location.replace(`/docs${pathname.endsWith("/") ? pathname : `${pathname}/`}${search}${hash}`);
    return null;
  }
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 bg-canvas px-6 text-center text-foreground">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">{docs ? "There is no docs page at this address." : "This address is not a page for this machine role."}</p>
      <Button asChild size="lg">
        {docs ? (
          <a href="/docs/">Go to the docs</a>
        ) : (
          <a href="/source/overview" onClick={followLink}>
            Go to Source overview
          </a>
        )}
      </Button>
    </main>
  );
}

/**
 * index.html's title ("Canonfig", or the demo build's longer one), kept on <html> the first time this module runs.
 * Fast Refresh re-runs the module in dev after pages have renamed the tab, so re-reading document.title would
 * stack page names ("Overview | Overview | Canonfig").
 */
const SITE_TITLE = (document.documentElement.dataset.siteTitle ??= document.title);

/** The page's name for the tab and history entry: its sidebar label, so two open tabs or Back's menu tell pages apart. */
function pageTitle(route: AppRoute): string {
  if (route.kind === "setup") return "Setup";
  if (route.kind === "workspace") {
    const item = navItem(route.role, route.view);
    if (item) return item.label;
  }
  return "Page not found";
}

export function WorkspaceApp({ route }: { route: AppRoute }) {
  const role = route.kind === "workspace" ? route.role : route.kind;
  // Setup belongs to this role session. Changing pages keeps demo edits; changing roles starts fresh.
  const [session, setSession] = useState<{ role: typeof role; setup: Setup | null }>({ role, setup: null });
  const title = `${pageTitle(route)} | ${SITE_TITLE}`;
  useEffect(() => {
    document.title = title;
  }, [title]);
  if (session.role !== role) {
    setSession({ role, setup: null });
    return null;
  }
  if (route.kind === "not-found") return <NotFound />;
  if (route.kind === "setup") return <Suspense fallback={null}><Onboarding onDone={(setup) => {
    setSession({ role: setup.role, setup });
    navigate(workspaceHref(setup.role, setup.role === "source" && setup.scan ? "profile" : "overview"));
  }} /></Suspense>;
  return (
    <WorkspaceProvider key={route.role} route={route} navigate={navigate} setup={session.setup}>
      <Frame />
    </WorkspaceProvider>
  );
}
