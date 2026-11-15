import { useWorkspace } from "@/workspace/store";
import { MachineMap as MapView, type MachineMapProps } from "./map-view";

/** Both modes supply machine records through the workspace provider. */
export function MachineMap(props: Omit<MachineMapProps, "source" | "followers"> & { followers?: MachineMapProps["followers"] }) {
  const ws = useWorkspace();
  const rows = props.followers ?? ws.followers;
  // Only a live Source publishes its card's look; a Follower's or the demo's customizing stays in this browser.
  const save = ws.saveSourceLook;
  const onSourceLookSave = props.onSourceLookSave ?? (save ? (look: Parameters<typeof save>[0]) => { void save(look); } : undefined);
  return <MapView source={ws.sourceMachine} {...props} followers={rows} latestRevision={props.latestRevision ?? ws.latest} selfId={props.selfId ?? ws.selfFollower?.id} onSourceLookSave={onSourceLookSave} />;
}
