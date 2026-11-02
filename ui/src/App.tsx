// The GUI currently uses simulated machine data and actions in both builds; DEMO adds the demo panel. ?tour=1 replays the tour.
import { Component, type ReactNode } from "react";
import { SkulletProvider } from "skullet/react";
import type { SkulletTheme } from "skullet";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEMO } from "@/shared/data";
import { DemoSwitcher } from "@/shared/demo-switcher";
import { WorkspaceApp } from "@/workspace/workspace";
import { useAppRoute } from "@/workspace/routes";

/**
 * Loading skeletons (workspace Body, kit.tsx) in the app's palette: bars in the muted surface tone, read on
 * the panel like a row's hover fill, and a faint foreground highlight sweeping across them (skullet's default
 * animation, left unset here). Text bars take the small radius; buttons and chips keep their own. Skullet
 * holds the sweep and its fades still under reduced motion.
 *
 * Don't name the animation in this source: Tailwind scans it for class names, and that word would add an
 * unused utility from shadcn's tailwind.css to the stylesheet.
 */
const SKELETON_THEME: SkulletTheme = {
  dark: { base: "var(--muted)", highlight: "color-mix(in oklab, var(--foreground) 7%, transparent)" },
  radius: "var(--radius-sm)",
};

/**
 * Catches a page that throws while rendering, most often a lazily loaded chunk (setup, Follower screens, the
 * machine map) whose file is gone because Canonfig was updated while this tab stayed open. Without it React
 * unmounts the whole app and leaves an empty window. A reload fetches the current files.
 */
class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="flex min-h-svh flex-col items-center justify-center gap-4 bg-canvas px-6 text-center text-foreground">
        <h1 className="text-xl font-semibold">This page couldn't load</h1>
        <p className="max-w-sm text-sm text-pretty text-muted-foreground">
          Part of Canonfig failed to load, often because it was updated while this tab was open. Reload the page to get the current version.
        </p>
        <Button size="lg" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </main>
    );
  }
}

export default function App() {
  const route = useAppRoute();

  return (
    <SkulletProvider mode="dark" theme={SKELETON_THEME}>
      <TooltipProvider delayDuration={250}>
        <div className="dark min-h-svh">
          <PageErrorBoundary>
            <WorkspaceApp route={route} />
          </PageErrorBoundary>
        </div>
        {/* Bottom-right, the usual place for notifications, 8px in like the main panel and the tour offer card. While the tour offer card occupies that corner it
            publishes its height as --toast-lift (guide.tsx), so toasts sit above it and drop back down once it
            is dismissed. Footers and side panels keep primary actions bottom-right too, so a toast can briefly
            cover one; toasts close on their own after 4s. Below 600px Sonner uses its own full-width offsets. */}
        <Toaster
          theme="dark"
          position="bottom-right"
          offset={{ right: 8, bottom: "calc(8px + var(--toast-lift, 0px))" }}
          mobileOffset={{ bottom: "calc(8px + var(--toast-lift, 0px))" }}
        />
        {DEMO && route.kind !== "workspace" && (
          // Below md the compact panel is one button in the reserved slot of the setup header (onboarding/kit.tsx).
          <DemoSwitcher
            role={route.kind === "setup" ? "unconfigured" : null}
            compact
            className="fixed z-40 max-md:top-0.5 max-md:right-16 md:bottom-[12px] md:left-[12px] md:w-[220px]"
          />
        )}
      </TooltipProvider>
    </SkulletProvider>
  );
}
