import { followers, followerSelf, machine, revisions } from "@/shared/data";
import { MachineMap as MapView, type MachineMapProps } from "./map-view";

/** The demo injects fixtures; production imports map-view directly. */
export function MachineMap(props: Omit<MachineMapProps, "source" | "followers"> & { followers?: MachineMapProps["followers"] }) {
  const rows = props.followers ?? followers;
  return <MapView source={machine} {...props} followers={rows} latestRevision={props.latestRevision ?? revisions[0].sequence} selfId={props.selfId ?? rows.find((row) => row.name === followerSelf.name)?.id} />;
}
