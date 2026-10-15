// Isolated map demo entry (/map-demo.html?role=source|follower&publishing=1&syncing=<ids, empty for none>&customize=<id>).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import "@/index.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MachineMapDemo } from "./demo";

const params = new URLSearchParams(location.search);
const role = params.get("role") === "follower" ? "follower" : "source";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={250}>
      <MachineMapDemo
        role={role}
        publishing={params.get("publishing") === "1"}
        syncing={params.get("syncing")?.split(",").filter(Boolean)}
        customize={params.get("customize")}
      />
    </TooltipProvider>
    <Toaster theme="dark" position="bottom-right" />
  </StrictMode>,
);
