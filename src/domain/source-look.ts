import { Schema } from "effect";

// Kept apart from enrollment/source-look.ts (which reads and writes the file) because the browser GUI
// contract imports this schema, and that module's node:* imports would break the browser bundle.

/** A preset key from the browser map (`desktop`, `orange`, `custom`); the browser falls back on one it does not know. */
const PresetKey = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/u));

/**
 * How the Source's card looks on the machine map, as customized on the Source.
 * Followers fetch it so their maps show the Source the same way. An uploaded
 * icon stays on the Source; a Follower draws the preset it falls back to.
 */
export const SourceLook = Schema.Struct({
  name: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  purpose: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
  icon: Schema.optional(PresetKey),
  accent: Schema.optional(PresetKey),
  customAccent: Schema.optional(Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/u))),
});
export type SourceLook = typeof SourceLook.Type;
