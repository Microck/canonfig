import { Schema } from "effect";
import { ShieldLogEntry } from "../../projection/shield-log.types.ts";

/** `canonfig shield status`, also carried in /api/status for the machine evidence on Overview. */
export const GuiShieldStatus = Schema.Struct({
  enabled: Schema.Boolean,
  hard: Schema.Boolean,
  scope: Schema.Literals(["canonical", "local"]),
  destination: Schema.String,
  projected: Schema.Boolean,
  excludedPlugins: Schema.Array(Schema.String),
  note: Schema.String,
});

/**
 * A Native Plugin this machine loads, with what the review dialog shows before someone approves its code. Plugins
 * this machine excluded are not listed (the folder loader drops them); their ids are in `status.excludedPlugins`.
 */
export const GuiShieldPlugin = Schema.Struct({
  id: Schema.String,
  harnesses: Schema.Array(Schema.String),
  /** Entry files the harness loads, relative to the plugin folder. */
  entries: Schema.Array(Schema.String),
  /** Folder tools the plugin needs, like `tools/gh`. */
  requires: Schema.Array(Schema.String),
  digest: Schema.String,
  reviewed: Schema.Boolean,
});
export type GuiShieldPlugin = typeof GuiShieldPlugin.Type;

export const GuiShield = Schema.Struct({
  status: GuiShieldStatus,
  /** The last 30 days, newest first. */
  log: Schema.Array(ShieldLogEntry),
  plugins: Schema.Array(GuiShieldPlugin),
});
export type GuiShield = typeof GuiShield.Type;

/** What the Shield page can change; each maps to one `canonfig shield` command on this machine. */
export const GuiShieldRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("enable"), hard: Schema.Boolean }),
  Schema.Struct({ action: Schema.Literal("disable") }),
  /** The digest the person saw; the command refuses it if the plugin's files changed since. */
  Schema.Struct({ action: Schema.Literal("review"), id: Schema.String, digest: Schema.String }),
  Schema.Struct({ action: Schema.Literal("exclude"), id: Schema.String }),
]);
export type GuiShieldRequest = typeof GuiShieldRequest.Type;
