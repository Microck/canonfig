import { TransitionError } from "../../lib/state-machine";
import type { DeviceIcon } from "./model";

type IconChoice = { status: "preset"; icon: DeviceIcon } | { status: "custom"; dataUrl: string };
export type IconSelection = { generation: number } & (
  | IconChoice
  | { status: "choosing"; previous: IconChoice }
  | { status: "reading"; previous: IconChoice }
  | { status: "failed"; previous: IconChoice; error: string }
);
export type IconSelections = Readonly<Record<string, IconSelection>>;
export type IconReadRequest = { machineId: string; generation: number };
export type IconSelectionEvent =
  | { type: "preset"; machineId: string; icon: DeviceIcon }
  | { type: "custom"; machineId: string; previous: IconChoice; dataUrl: string }
  | { type: "read"; machineId: string; previous: IconChoice }
  | { type: "reset"; machineId: string; icon: DeviceIcon }
  | ({ type: "loaded"; dataUrl: string } & IconReadRequest)
  | ({ type: "failed"; error: string } & IconReadRequest);

/** One transient lifecycle per machine; browser preferences keep their existing icon/customIcon shape. */
export function transitionIconSelection(states: IconSelections, event: IconSelectionEvent): IconSelections {
  const current = states[event.machineId];
  if ((event.type === "loaded" || event.type === "failed") && (current?.status !== "reading" || current.generation !== event.generation)) {
    throw new TransitionError("Icon selection", current?.status ?? "absent", event.type);
  }
  const generation = (current?.generation ?? 0) + 1;
  let next: IconSelection;
  switch (event.type) {
    case "preset":
    case "reset":
      next = { status: "preset", icon: event.icon, generation };
      break;
    case "custom":
      next = event.dataUrl
        ? { status: "custom", dataUrl: event.dataUrl, generation }
        : { status: "choosing", previous: event.previous, generation };
      break;
    case "read":
      next = { status: "reading", previous: event.previous, generation };
      break;
    case "loaded":
      next = { status: "custom", dataUrl: event.dataUrl, generation: event.generation };
      break;
    case "failed":
      if (current?.status !== "reading") throw new TransitionError("Icon selection", current?.status ?? "absent", event.type);
      next = { status: "failed", previous: current.previous, error: event.error, generation: event.generation };
      break;
  }
  return { ...states, [event.machineId]: next };
}

/** A superseded read is refused by the owner, then deliberately discarded at this async boundary. */
export async function settleIconRead(
  request: IconReadRequest,
  read: Promise<string>,
  send: (event: IconSelectionEvent) => IconSelections,
): Promise<string | null> {
  let event: IconSelectionEvent;
  try {
    event = { type: "loaded", ...request, dataUrl: await read };
  } catch (error) {
    event = { type: "failed", ...request, error: (error as Error).message };
  }
  try {
    send(event);
  } catch (error) {
    if (error instanceof TransitionError) return null;
    throw error;
  }
  return event.type === "loaded" ? event.dataUrl : null;
}
