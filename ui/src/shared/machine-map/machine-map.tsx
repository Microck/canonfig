import { useWorkspace } from "@/workspace/store";
import { MachineMap as MapView, type MachineMapProps } from "./map-view";

/** Both modes supply machine records through the workspace provider. */
export function MachineMap(props: Omit<MachineMapProps, "source" | "followers"> & { followers?: MachineMapProps["followers"] }) {
  const ws = useWorkspace();
  const rows = props.followers ?? ws.followers;
  return <MapView source={ws.sourceMachine} {...props} followers={rows} latestRevision={props.latestRevision ?? ws.latest} selfId={props.selfId ?? ws.selfFollower?.id} />;
}
