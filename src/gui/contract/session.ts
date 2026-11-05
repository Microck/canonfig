import { Schema } from "effect";

/** The CLI and its bundled browser use this module directly, without generated copies. */
export const GuiRole = Schema.Literals(["source", "follower", "unconfigured"]);

export const GuiSession = Schema.Struct({
  role: GuiRole,
  machineName: Schema.String,
  version: Schema.String,
  folderPath: Schema.String,
});
export type GuiSession = typeof GuiSession.Type;

const LifecycleStep = Schema.StructWithRest(
  Schema.Struct({ reached: Schema.Boolean, detail: Schema.String }),
  [Schema.Record(Schema.String, Schema.Json)],
);

/** Preserve the complete status payload, including role-specific run and recovery evidence. */
export const GuiStatus = Schema.StructWithRest(
  Schema.Struct({
    machineRole: Schema.Struct({
      role: GuiRole,
      follower: Schema.optionalKey(Schema.String),
      sourceFingerprint: Schema.optionalKey(Schema.String),
      tlsFingerprint: Schema.optionalKey(Schema.String),
    }),
    lifecycle: Schema.Record(Schema.String, LifecycleStep),
    tunnel: Schema.Json,
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export type GuiStatus = typeof GuiStatus.Type;

/** These are the CLI failure categories and exit codes, not HTTP status codes. */
export const GuiError = Schema.Struct({
  category: Schema.Literals([
    "usage-or-configuration", "human-action-required", "conflict-or-drift",
    "authentication-or-revocation", "transport", "verification-or-apply-failure", "internal",
  ]),
  exitCode: Schema.Literals([1, 2, 3, 4, 5, 6, 7]),
  message: Schema.String,
});
export type GuiError = typeof GuiError.Type;

export const guiEndpoints = {
  session: "/api/session",
  status: "/api/status",
} as const;
