import { lazy, Suspense, useEffect, useState } from "react";
import { navigate, workspaceHref, type AppRoute } from "./routes";
import type { Setup } from "@/onboarding/onboarding";
import { SimulatedWorkspaceProvider } from "./simulated-store";
import { Frame, NotFound, pageTitle } from "./workspace";
const Onboarding = lazy(() => import("@/onboarding/onboarding").then((module) => ({ default: module.Onboarding })));
const SITE_TITLE = (document.documentElement.dataset.siteTitle ??= document.title);

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
    <SimulatedWorkspaceProvider key={route.role} route={route} navigate={navigate} setup={session.setup}>
      <Frame />
    </SimulatedWorkspaceProvider>
  );
}
