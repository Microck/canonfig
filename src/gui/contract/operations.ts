import { Schema } from "effect";
import { GuiError } from "./session.ts";

export const guiMutationHeader = "x-canonfig-request";
export const guiMutationValue = "browser";
export const GuiOperationTicket = Schema.Struct({ id: Schema.String });
export type GuiOperationTicket = typeof GuiOperationTicket.Type;
/** Journal is supplied by the owning service, never synthesized from elapsed time. */
export const GuiOperation = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["running", "succeeded", "failed"]),
  journal: Schema.NullOr(Schema.Json),
  result: Schema.optionalKey(Schema.Json),
  failure: Schema.optionalKey(GuiError),
});
export type GuiOperation = typeof GuiOperation.Type;
export const operationPath = (id: string) => `/api/operations/${encodeURIComponent(id)}`;
