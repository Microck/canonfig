import { Schema } from "effect";
import { TaggedError } from "../domain/tagged-error.ts";

export class StateInitializationError extends TaggedError<StateInitializationError>()(
  "StateInitializationError",
  { path: Schema.String, message: Schema.String },
) {}
