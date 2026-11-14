import { Schema } from "effect";

/**
 * One line of `<folder>/.shield/log.jsonl` (shield-log.ts). Kept free of Node imports because the GUI contract,
 * which the browser bundle loads, decodes these entries too.
 *
 * Entries hold paths, item names and installer kinds only, never file contents or installer arguments (an
 * `mcp add` line can carry a token).
 */
export const ShieldLogEntry = Schema.Union([
  /** The generated hook guard refused a harness write. */
  Schema.Struct({
    at: Schema.String, kind: Schema.Literal("blocked"),
    harness: Schema.optional(Schema.String),
    /** The write the guard refused, home-relative as `~/...` when inside HOME. */
    path: Schema.optional(Schema.String),
    /** The installer phrase the guard refused, like `claude mcp add`, without its arguments. */
    installer: Schema.optional(Schema.String),
  }),
  /** `canonfig shield install` ran an installer in a private home and admitted what it produced. */
  Schema.Struct({
    at: Schema.String, kind: Schema.Literal("installed"),
    installer: Schema.Literals(["skills", "mcp", "plugin"]),
    /** Folder items the installer produced, like `skills/web-design-guidelines`. */
    items: Schema.Array(Schema.String),
  }),
  /** Sync found an item a harness installed on its own and moved it into the folder. */
  Schema.Struct({
    at: Schema.String, kind: Schema.Literal("ingested"),
    /** Where sync found the item, home-relative when inside HOME. */
    path: Schema.String,
    item: Schema.String,
  }),
]);
export type ShieldLogEntry = typeof ShieldLogEntry.Type;

/** Shield keeps a month of entries; older ones are dropped the next time Canonfig itself appends. */
export const shieldLogDays = 30;
