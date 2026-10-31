// TEMPORARY component gallery at /components.html (`?only=<id>` shows one component full width).
// A dev-only entry like /break.html: Vite builds only index.html, so none of this ships.
// Delete ui/components.html and ui/src/gallery/ once the components are refined.
import { createRoot } from "react-dom/client";
import "@/index.css";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Gallery } from "./gallery";

// Same providers and Toaster placement as App.tsx, so tooltips and toasts look as they do in the app.
createRoot(document.getElementById("root")!).render(
  <TooltipProvider delayDuration={250}>
    <div className="dark min-h-svh bg-canvas text-foreground">
      <Gallery />
    </div>
    <Toaster
      theme="dark"
      position="bottom-right"
      offset={{ right: 8, bottom: "calc(8px + var(--toast-lift, 0px))" }}
      mobileOffset={{ bottom: "calc(8px + var(--toast-lift, 0px))" }}
    />
  </TooltipProvider>,
);
