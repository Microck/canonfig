import { memo } from "react";
import { CompactInventory, Frame, MachineHeader, type MapNodeProps } from "./parts";

export const RailNode = memo(function RailNode({ data, selected }: MapNodeProps) {
  return <Frame machine={data.machine} selected={selected}>
    <MachineHeader machine={data.machine} />
    <CompactInventory machine={data.machine} />
  </Frame>;
});
