import { Schema } from "effect";

import { TaggedError } from "../domain/tagged-error.ts";

/**
 * The setup controller's own failure. Every setup stage reports through this
 * one tag so the failure taxonomy stays additive: `category` selects the exit
 * class at the CLI boundary.
 *
 * - `usage`: the operator's setup invocation is incomplete (no plan, no
 *   approval for the current digest). Exit 2.
 * - `prerequisite`: the machine cannot take the requested role yet (missing
 *   key storage, missing native capability). Exit 3.
 * - `state`: the setup journal itself is unreadable or unwritable. Exit 1.
 */
export class SetupError extends TaggedError<SetupError>()("SetupError", {
  operation: Schema.String,
  message: Schema.String,
  recovery: Schema.optional(Schema.String),
  category: Schema.Literals(["usage", "prerequisite", "state"]),
}) {}
