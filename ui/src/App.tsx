// The GUI currently uses simulated machine data and actions. ?tour=1 replays the tour.
import { IconContext } from "@phosphor-icons/react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DemoSwitcher } from "@/shared/demo-switcher";
import { WorkspaceApp } from "@/workspace/workspace";
import { useAppRoute } from "@/workspace/routes";

const ICONS = { weight: "regular", size: "1em" } as const;

export default function App() {
  const route = useAppRoute();
  const role = route.kind === "workspace" ? route.role : route.kind === "setup" ? "unconfigured" : null;

  return (
    // Phosphor's regular weight everywhere; sizes come from `size-*` classes.
    <IconContext.Provider value={ICONS}>
      <TooltipProvider delayDuration={250}>
        <div className="dark min-h-svh">
          <WorkspaceApp route={route} />
        </div>
        {/* Bottom-left of the main column, past the 244px sidebar (frame.tsx): footers and right-hand panels keep
            their primary actions bottom-right, where a toast sat on top of the next click. Setup and not-found pages
            have no sidebar, but the same offset keeps toasts clear of their bottom-left Demo switcher; below 600px
            Sonner switches to its own full-width mobile offsets. */}
        <Toaster theme="dark" position="bottom-left" offset={{ left: 260, bottom: 16 }} />
        {route.kind !== "workspace" && (
          <div className="fixed bottom-[80px] left-[12px] z-40">
            <DemoSwitcher role={role} />
          </div>
        )}
      </TooltipProvider>
    </IconContext.Provider>
  );
}
