// The machine map alone, full size, with simulated data for screenshots and review.
import { useState } from "react";
import { toast } from "sonner";
import { MachineMap } from "./machine-map";
import type { MapRole } from "./model";

// By default the laptop is mid-run so every edge style shows at once.
const DEMO_SYNCING = ["f_8c21"];

export function MachineMapDemo({
  role,
  publishing = false,
  syncing = DEMO_SYNCING,
  customize = null,
}: {
  role: MapRole;
  publishing?: boolean;
  syncing?: readonly string[];
  /** Machine whose Customize sheet starts open; the demo drives the sheet as a host panel would. */
  customize?: string | null;
}) {
  const [customizeId, setCustomizeId] = useState(customize);
  return (
    <div className="dark flex h-svh flex-col gap-3 bg-canvas p-3 text-foreground">
      <header className="flex items-baseline gap-2 px-1">
        <h1 className="font-medium">Machines</h1>
        <span className="text-sm text-faint">{role === "source" ? "Source view" : "Follower view"}</span>
      </header>
      <MachineMap
        role={role}
        syncing={syncing}
        publishing={publishing}
        customizeId={customizeId}
        onCustomizeChange={setCustomizeId}
        className="flex-1"
        onOpenMachine={(id) => toast(`Open machine ${id}`)}
        onInvite={() => toast("Invite a follower")}
      />
    </div>
  );
}
