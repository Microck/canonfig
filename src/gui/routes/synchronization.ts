import { Effect } from "effect";
import type { GuiRoute } from "../routing.ts";

/** Register only implemented CLI/domain operations, never demo actions. */
export const synchronizationRoutes = Effect.succeed<ReadonlyArray<GuiRoute>>([]);
