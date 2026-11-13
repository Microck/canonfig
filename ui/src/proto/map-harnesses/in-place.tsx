import { useMemo, type ReactNode } from "react";
import { useWorkspace } from "@/workspace/store";
import { Explorer } from "./explorer";
import { makeMachines, type Machine } from "./fixtures";

// Only shell identity comes from the demo provider. Harness observations remain explicitly synthetic.
export function InPlace({ children }: { children?: ReactNode }) {
  const ws = useWorkspace();
  const demoMachines = useMemo(() => {
    const examples = makeMachines("film");
    const followers = ws.role === "follower" ? (ws.selfFollower ? [ws.selfFollower] : []) : ws.followers;
    return [
      { ...examples[0], name: ws.sourceMachine.hostname },
      ...followers.map((follower, index): Machine => ({
        ...examples[1 + index % (examples.length - 1)],
        id: follower.id,
        name: follower.name,
        platform: follower.platform === "macos" ? "macOS" : follower.platform === "windows" ? "Windows" : "Linux",
      })),
    ];
  }, [ws.role, ws.selfFollower, ws.followers, ws.sourceMachine.hostname]);
  // A DEV build connected to a live provider must still fail closed.
  if (!ws.capabilities.simulatedTelemetry) return children;
  return <Explorer baseline={children ?? null} demoMachines={demoMachines} />;
}
