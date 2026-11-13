import { memo } from "react";
import { CompactInventory, ExpandedInventory, Frame, MachineHeader, type MapNodeProps } from "./parts";

export const FocusNode = memo(function FocusNode({ data, selected }: MapNodeProps) {
  return <Frame machine={data.machine} selected={selected}>
    <MachineHeader machine={data.machine} expanded={data.expanded} />
    {data.expanded ? <ExpandedInventory machine={data.machine} /> : <CompactInventory machine={data.machine} />}
  </Frame>;
});
