import { useMemo } from "react";
import { useWorkspace } from "@/workspace/store";
import type { FollowerState, Harness, HarnessReport, ItemCategory } from "@/shared/metadata";
import { MachineMap as MapView, type MachineMapProps } from "./map-view";

/** Folder categories the Source card lists as chips: what the harnesses receive, in folder order. */
const CHIP_CATEGORIES: readonly ItemCategory[] = ["skills", "mcp", "rules", "hooks", "commands", "agents"];

/**
 * Follower states that hold for every harness at once: a whole run converged, failed or never ran, or the machine
 * lost the Source. Drift and Human Action Required name one item, so they say nothing about a given harness.
 */
const MACHINE_WIDE: Record<FollowerState, boolean> = { converged: true, failed: true, "never-synced": true, offline: true, drift: false, "human-action": false };

/** This machine's managed harnesses (listed, installed, not excluded), with the machine's state when it holds for each. */
const managed = (rows: readonly Harness[], state: FollowerState | undefined): HarnessReport[] =>
  rows.filter((h) => h.listed && h.installed && !h.excluded).map((h) => ({ id: h.id, state: state && MACHINE_WIDE[state] ? state : undefined }));

/**
 * Both modes supply machine records through the workspace provider. This machine's harnesses come from
 * `canonfig harnesses` (ws.harnesses); other followers' harnesses come from their own reports, when they send them.
 */
export function MachineMap(props: Omit<MachineMapProps, "source" | "followers"> & { followers?: MachineMapProps["followers"] }) {
  const ws = useWorkspace();
  const rows = props.followers ?? ws.followers;
  const selfId = props.selfId ?? ws.selfFollower?.id;
  const source = useMemo(() => {
    if (props.role !== "source") return ws.sourceMachine;
    const present = new Set(ws.resources.map((r) => r.category));
    // The Source has no follower state of its own, so its harness cards say they are managed and nothing more.
    return { ...ws.sourceMachine, harnesses: managed(ws.harnesses, undefined), categories: CHIP_CATEGORIES.filter((c) => present.has(c)) };
  }, [props.role, ws.sourceMachine, ws.harnesses, ws.resources]);
  const followers = useMemo(
    () => (props.role === "follower" ? rows.map((f) => (f.id === selfId ? { ...f, harnesses: managed(ws.harnesses, f.state) } : f)) : rows),
    [props.role, rows, selfId, ws.harnesses],
  );
  return <MapView source={source} {...props} followers={followers} latestRevision={props.latestRevision ?? ws.latest} selfId={selfId} />;
}
