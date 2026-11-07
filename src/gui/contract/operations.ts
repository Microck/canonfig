import { Schema } from "effect";
import { GuiError } from "./session.ts";

export const guiMutationHeader = "x-canonfig-request";
export const guiMutationValue = "browser";
export const GuiOperationTicket = Schema.Struct({ id: Schema.String });
export type GuiOperationTicket = typeof GuiOperationTicket.Type;
/** Journal is supplied by the owning service, never synthesized from elapsed time. */
const operationFields = { id: Schema.String, journal: Schema.NullOr(Schema.Json) };
export const GuiOperation = Schema.Union([
  Schema.Struct({ ...operationFields, state: Schema.Literal("running") }),
  Schema.Struct({ ...operationFields, state: Schema.Literal("succeeded"), result: Schema.Json }),
  Schema.Struct({ ...operationFields, state: Schema.Literal("failed"), failure: GuiError }),
]);
export type GuiOperation = typeof GuiOperation.Type;
export const operationPath = (id: string) => `/api/operations/${encodeURIComponent(id)}`;
