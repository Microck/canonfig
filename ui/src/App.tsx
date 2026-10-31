// The GUI currently uses simulated machine data and actions. ?tour=1 replays the tour.
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DemoSwitcher } from "@/shared/demo-switcher";
import { WorkspaceApp } from "@/workspace/workspace";
import { useAppRoute } from "@/workspace/routes";

export default function App() {
  const route = useAppRoute();
  const role = route.kind === "workspace" ? route.role : route.kind === "setup" ? "unconfigured" : null;

  return (
    <TooltipProvider delayDuration={250}>
      <div className="dark min-h-svh">
        <WorkspaceApp route={route} />
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
      {route.kind !== "workspace" && (
        // Below md the compact switcher is one button in the reserved slot of the setup header (kit.tsx).
        <aside aria-label="Demo" className="fixed z-40 max-md:top-0.5 max-md:right-16 md:bottom-[80px] md:left-[12px]">
          <DemoSwitcher role={role} compact />
        </aside>
      )}
    </TooltipProvider>
  );
}
