import { Effect } from "effect";
import type { GuiRoute } from "../routing.ts";

/** Register only implemented CLI/domain operations, never demo actions. */
export const administrationRoutes = Effect.succeed<ReadonlyArray<GuiRoute>>([]);
