// Workspace screens share a sidebar, detail panels, and command palette.
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { List, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { DEMO } from "@/shared/metadata";
import { DemoSwitcher } from "@/shared/demo-switcher";
import { Logo } from "@/shared/shared";
import { StarPrompt, TipHost, TourHost, TourOffer, TourPicker } from "./guide";
import { focusPageHeading, followLink, type AppRoute } from "./routes";
import { Palette, Sidebar } from "./frame";
import { navItem } from "./nav";
import { ChangeGroupsDialog, InviteDialog, MachinesView } from "./machines";
import { ProfileView } from "./profile";
import { PublishDialog, RevisionsView, SecretsView, SourceOverview } from "./source";
import { AgentPolicyView, DoctorView, InstallersView, ServiceView, SetupView, VersionView } from "./settings";
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
import { useWorkspace, type View } from "./store";
import { ErrorNotice } from "../live/session";
import { cn } from "@/lib/utils";
import type { GuiSourceServiceStatus } from "../../../src/gui/contract/administration";

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
  version: VersionView,
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
  installers: InstallersView,
  setup: SetupView,
  machine: MachineView,
  version: VersionView,
};

export function Frame() {
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
    // The notice bar spans the whole window above the sidebar and content, so a machine condition shows once
    // instead of as an error on every page.
    <div className="flex h-svh flex-col bg-canvas text-foreground">
      <a
        href="#workspace-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-panel focus:px-4 focus:py-3 focus:text-sm focus:font-medium focus:text-foreground focus:outline-2 focus:outline-offset-2 focus:outline-ring"
      >
        Skip to content
      </a>
      {ws.role === "source" && <ServiceNotice />}
      {/* Below md (768px) the 244px sidebar would leave ~140px for content, so it moves into a left Sheet behind a
          menu button in a slim top bar. From md up the layout is unchanged. */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <MobileNav />
        <Sidebar className="hidden md:flex" />
        <main id="workspace-content" tabIndex={-1} data-tour="main" className="mx-2 mb-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-panel focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:my-2 md:ml-0">
          {ws.pageError && <div className="px-4 pt-4 sm:px-8"><ErrorNotice error={ws.pageError} /></div>}
          <Suspense fallback={null}>
            <Screen key={ws.view} />
          </Suspense>
        </main>
      </div>
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

type ServiceReport = typeof GuiSourceServiceStatus.Type;

/** One line per reported Source service state; running shows nothing. */
function serviceNoticeCopy(report: ServiceReport): { message: string; action: "install" | "open"; actionLabel: string } | null {
  const cut = "Other machines can't get new revisions.";
  switch (report.state) {
    case "running": return null;
    case "drifted": return { message: report.serving ? "The Source service is out of date for this version of Canonfig." : `${cut} The Source service is out of date.`, action: "install", actionLabel: "Reinstall" };
    case "not-installed": return report.serving
      ? { message: "This Source runs outside the service manager and stops when that process ends.", action: "open", actionLabel: "Open service" }
      : { message: `${cut} The Source service isn't installed.`, action: "install", actionLabel: "Install" };
    case "not-running": return { message: `${cut} The Source service isn't running.`, action: "open", actionLabel: "Open service" };
    case "not-serving": return { message: `${cut} The Source service isn't answering.`, action: "open", actionLabel: "Open service" };
  }
}

/** Reinstalling keeps the address and port the service already uses. */
function currentAddress(endpoint: string): { hostname: "127.0.0.1" | "::1"; port: number } | null {
  if (!URL.canParse(endpoint)) return null;
  const url = new URL(endpoint);
  const port = Number(url.port);
  return port >= 1 && port <= 65535 ? { hostname: url.hostname === "[::1]" ? "::1" : "127.0.0.1", port } : null;
}

function ServiceNotice() {
  const ws = useWorkspace();
  const service = ws.admin.service;
  // Dismissing hides only a condition that still serves revisions, and only until the state changes.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const report = service.data;
  if (service.action === "install") {
    return <div role="status" className="flex min-h-9 shrink-0 items-center justify-center border-b border-border bg-raised px-10 text-sm text-muted-foreground">Installing the Source service…</div>;
  }
  if (!report) return null;
  const copy = serviceNoticeCopy(report);
  if (!copy || (report.serving && dismissed === report.state)) return null;
  const address = currentAddress(report.endpoint);
  const urgent = !report.serving;
  const showAction = copy.action === "install" ? address !== null : ws.view !== "service";
  return (
    <div
      role={urgent ? "alert" : "status"}
      className={cn(
        "relative flex min-h-9 shrink-0 items-center justify-center gap-3 border-b px-10 py-1 text-sm",
        urgent ? "border-bad/40 bg-bad/15" : "border-warn/40 bg-warn/10",
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", urgent ? "bg-bad" : "bg-warn")} />
      <span className="min-w-0 text-pretty">{copy.message}</span>
      {showAction && (
        <Button
          size="xs"
          variant="outline"
          disabled={service.busy}
          onClick={() => copy.action === "install" && address ? service.install(address.hostname, address.port) : ws.go("service")}
        >
          {copy.actionLabel}
        </Button>
      )}
      {!urgent && (
        <Button size="icon-xs" variant="ghost" aria-label="Dismiss service notice" className="absolute right-2" onClick={() => setDismissed(report.state)}>
          <X />
        </Button>
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

export function NotFound({ href = "/source/overview" }: { href?: string }) {
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
          <a href={href} onClick={followLink}>
            Open Overview
          </a>
        )}
      </Button>
    </main>
  );
}


/** The page's name for the tab and history entry: its sidebar label, so two open tabs or Back's menu tell pages apart. */
export function pageTitle(route: AppRoute): string {
  if (route.kind === "setup") return "Setup";
  if (route.kind === "workspace") {
    const item = navItem(route.role, route.view);
    if (item) return item.label;
  }
  return "Page not found";
}

