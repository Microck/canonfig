import { useEffect, useState } from "react";
import { SkulletProvider } from "skullet/react";
import type { SkulletTheme } from "skullet";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { httpBackend, type WorkspaceBackend, type GuiSession } from "./gui-client";
import { ErrorNotice, overviewPath } from "./live/session";
import { EnrollmentOnboarding } from "./onboarding/enrollment-controller";
import { LiveWorkspaceProvider } from "./workspace/live-provider";
import { Frame, NotFound, pageTitle } from "./workspace/workspace";
import { isRouteForRole } from "./workspace/nav";
import { navigate, useAppRoute } from "./workspace/routes";
import { ScreenContext } from "./workspace/screen-context";
import { requestError } from "./workspace/live/resource";
import type { GuiRequestError } from "./gui-client";

const SKELETON_THEME: SkulletTheme = {
  dark: { base: "var(--muted)", highlight: "color-mix(in oklab, var(--foreground) 7%, transparent)" },
  radius: "var(--radius-sm)",
};


type SessionState =
  | { kind: "loading" }
  | { kind: "ready"; session: GuiSession }
  | { kind: "error"; error: GuiRequestError };

export default function LiveApp({ backend = httpBackend }: { backend?: WorkspaceBackend }) {
  const route = useAppRoute();
  const [state, setState] = useState<SessionState>({ kind: "loading" });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void backend.session(controller.signal).then((session) => {
      if (controller.signal.aborted) return;
      if (session.role === "unconfigured" || window.location.pathname === "/") navigate(overviewPath(session.role), { replace: true });
      setState({ kind: "ready", session });
    }, (cause: unknown) => {
      if (!controller.signal.aborted) setState({ kind: "error", error: requestError(cause) });
    });
    return () => controller.abort();
  }, [backend, revision]);
  useEffect(() => { document.title = `${pageTitle(route)} | Canonfig`; }, [route]);

  let content;
  if (state.kind === "loading") {
    content = <main className="grid min-h-svh place-content-center bg-canvas text-muted-foreground" role="status">Reading this machine…</main>;
  } else if (state.kind === "error") {
    content = <main className="mx-auto max-w-[880px] space-y-4 p-6"><ErrorNotice error={state.error} title="Workspace could not load" /><Button onClick={() => setRevision((value) => value + 1)}>Reload</Button></main>;
  } else if (state.session.role === "unconfigured") {
    content = <ScreenContext value={{ pageLoading: false, navigate }}><EnrollmentOnboarding backend={backend} session={state.session} /></ScreenContext>;
  } else if (route.kind !== "workspace" || !isRouteForRole(route, state.session.role)) {
    content = <NotFound href={overviewPath(state.session.role)} />;
  } else {
    content = <LiveWorkspaceProvider key={state.session.role} backend={backend} session={state.session} route={route}><Frame /></LiveWorkspaceProvider>;
  }
  return <SkulletProvider mode="dark" theme={SKELETON_THEME}>
    <TooltipProvider delayDuration={250}>
      <div className="dark min-h-svh bg-canvas text-foreground">{content}</div>
      <Toaster theme="dark" position="bottom-right" offset={{ right: 8, bottom: "calc(8px + var(--toast-lift, 0px))" }} mobileOffset={{ bottom: "calc(8px + var(--toast-lift, 0px))" }} />
    </TooltipProvider>
  </SkulletProvider>;
}
