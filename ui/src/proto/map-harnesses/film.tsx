import { memo } from "react";
import { useStore } from "@xyflow/react";
import { CompactInventory, ExpandedInventory, Frame, MachineHeader, type MapNodeProps } from "./parts";

// Subscribe to the disclosure boundary, not the continuously changing zoom value.
export const FilmNode = memo(function FilmNode({ data, selected }: MapNodeProps) {
  const legible = useStore(state => state.transform[2] >= 0.62) && data.expanded;
  return <Frame machine={data.machine} selected={selected}>
    <MachineHeader machine={data.machine} expanded={legible} />
    {legible ? <ExpandedInventory machine={data.machine} /> : <CompactInventory machine={data.machine} />}
  </Frame>;
});
