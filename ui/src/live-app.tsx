import { useEffect, useState } from "react";
import { SkulletProvider } from "skullet/react";
import type { SkulletTheme } from "skullet";
import { ArrowsClockwise, Desktop } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GuiRequestError, httpBackend, type WorkspaceBackend, type GuiSession, type GuiStatus } from "./gui-client";
import { ErrorNotice, overviewPath, sessionScreens } from "./live/session";
import { profileScreens } from "./live/profile";
import { enrollmentScreens } from "./live/enrollment";
import { synchronizationScreens } from "./live/synchronization";
import { administrationScreens } from "./live/administration";
import { ScreenContext } from "./workspace/screen-context";

const screens = [
  ...sessionScreens,
  ...profileScreens,
  ...enrollmentScreens,
  ...synchronizationScreens,
  ...administrationScreens,
];

const SKELETON_THEME: SkulletTheme = {
  dark: { base: "var(--muted)", highlight: "color-mix(in oklab, var(--foreground) 7%, transparent)" },
  radius: "var(--radius-sm)",
};

/** The sidebar and route lookup share the role-filtered live screen registry. */
export function screensForRole(role: GuiSession["role"]) {
  return screens.flatMap((screen) => {
    const href = screen.path(role);
    return href === undefined ? [] : [{ ...screen, href }];
  });
}

type OverviewState =
  | { kind: "loading"; session?: GuiSession }
  | { kind: "ready"; session: GuiSession; status: GuiStatus }
  | { kind: "error"; session?: GuiSession; error: GuiRequestError };


/** This entrypoint has no import path to the simulated workspace, its navigation, or its store. */
export default function LiveApp({ backend = httpBackend }: { backend?: WorkspaceBackend }) {
  const [state, setState] = useState<OverviewState>({ kind: "loading" });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let session: GuiSession | undefined;
    async function load() {
      try {
        session = await backend.session(controller.signal);
        if (controller.signal.aborted) return;
        if (session.role === "unconfigured") window.history.replaceState(null, "", "/setup");
        else if (window.location.pathname === "/") window.history.replaceState(null, "", overviewPath(session.role));
        setState({ kind: "loading", session });
        const status = await backend.status(controller.signal);
        if (controller.signal.aborted) return;
        if (status.machineRole.role !== session.role) {
          throw new GuiRequestError({ category: "conflict-or-drift", exitCode: 4, message: "This machine's role changed while loading. Reload to read its current role and status." });
        }
        setState({ kind: "ready", session, status });
      } catch (cause) {
        if (controller.signal.aborted) return;
        const error = cause instanceof GuiRequestError ? cause : new GuiRequestError({
          category: "internal",
          exitCode: 1,
          message: cause instanceof Error ? cause.message : "Canonfig could not load the Overview. Reload to try again.",
        });
        setState({ kind: "error", session, error });
      }
    }
    void load();
    return () => controller.abort();
  }, [reload, backend]);

  const session = state.session;
  const href = session ? overviewPath(session.role) : "/";
  const available = session === undefined ? [] : screensForRole(session.role);
  const screen = available.find((screen) => screen.href === window.location.pathname);
  const unavailable = session !== undefined && screen === undefined;
  const busy = state.kind === "loading";

  return (
    <SkulletProvider mode="dark" theme={SKELETON_THEME}>
    <TooltipProvider delayDuration={250}>
    <div className="dark min-h-svh bg-canvas text-foreground md:grid md:grid-cols-[244px_minmax(0,1fr)]">
      <aside className="border-b border-border px-4 py-3 md:border-0 md:py-5">
        <div className="flex items-center gap-2 font-semibold"><Desktop className="size-4" /><span>canonfig</span></div>
        {session && <p className="mt-3 truncate font-mono text-sm text-muted-foreground" title={session.machineName}>{session.machineName}</p>}
        <nav aria-label="Workspace" className="mt-3">
          {available.map((entry) => <a key={entry.href} href={entry.href} aria-current={entry === screen ? "page" : undefined} className="flex min-h-10 items-center rounded-lg px-2 text-base hover:bg-raised focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11">{entry.title}</a>)}
        </nav>
      </aside>
      <main className="min-w-0 bg-panel md:m-2 md:ml-0 md:rounded-lg md:border md:border-border">
        <header className="flex min-h-11 items-center justify-between gap-3 border-b border-border px-[18px] py-1">
          <h1 className="text-base font-semibold">{unavailable ? "Page unavailable" : screen?.title ?? "Overview"}</h1>
          <Button variant="outline" size="sm" className="min-h-10 pointer-coarse:min-h-11" disabled={busy} onClick={() => { setState({ kind: "loading" }); setReload((value) => value + 1); }}>
            <ArrowsClockwise />{busy ? "Loading…" : "Reload"}
          </Button>
        </header>
        <div className="max-w-[880px] px-4 py-6 sm:px-8">
          {unavailable ? (
            <section className="grid justify-items-start gap-4">
              <h2 className="text-xl font-semibold">This page is not available for this machine</h2>
              <p className="max-w-prose text-muted-foreground">This page has no live backend for this machine. Use the Canonfig CLI for operations not listed in the sidebar.</p>
              <Button asChild variant="secondary" size="lg" className="min-h-10 pointer-coarse:min-h-11"><a href={href}>{session?.role === "unconfigured" ? "Open setup" : "Open Overview"}</a></Button>
            </section>
          ) : (
            <>
              {busy && <p role="status" className="text-muted-foreground">Loading machine status…</p>}
              {state.kind === "error" && <ErrorNotice error={state.error} title="Overview could not load" />}
              {state.kind === "ready" && <ScreenContext value={{
                pageLoading: false,
                navigate: (href, options) => options?.replace ? window.location.replace(href) : window.location.assign(href),
              }}>{screen?.render({ session: state.session, status: state.status, backend })}</ScreenContext>}
            </>
          )}
        </div>
      </main>
    </div>
    <Toaster
      theme="dark"
      position="bottom-right"
      offset={{ right: 8, bottom: "calc(8px + var(--toast-lift, 0px))" }}
      mobileOffset={{ bottom: "calc(8px + var(--toast-lift, 0px))" }}
    />
    </TooltipProvider>
    </SkulletProvider>
  );
}
