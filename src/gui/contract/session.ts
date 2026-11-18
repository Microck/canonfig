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

const ReceiptStage = Schema.Struct({
  status: Schema.Literals(["verified", "not-verified", "not-reached", "not-selected", "pending"]),
  detail: Schema.String,
});

export const GuiCompletionReceipt = Schema.Struct({
  run: Schema.optionalKey(Schema.String),
  revision: Schema.optionalKey(Schema.String),
  published: ReceiptStage,
  applied: ReceiptStage,
  independentlyVerified: ReceiptStage,
  clientLoaded: ReceiptStage,
  scheduled: ReceiptStage,
  mcpQualifications: Schema.Array(Schema.Json),
  secondRunNoOp: Schema.Boolean,
  build: Schema.optionalKey(Schema.Struct({
    packageVersion: Schema.String, identity: Schema.String, stateFormat: Schema.Number,
  })),
});

export const GuiActiveRecovery = Schema.Struct({
  run: Schema.String, revision: Schema.String, startedAt: Schema.String,
  owner: Schema.optionalKey(Schema.Struct({
    pid: Schema.Number, operation: Schema.String, since: Schema.String,
  })),
  finishedActions: Schema.Number, totalActions: Schema.Number,
  actions: Schema.Array(Schema.Struct({
    action: Schema.String, resource: Schema.String, kind: Schema.String,
    state: Schema.String, attempt: Schema.Number, recordedAt: Schema.String,
  })),
  drift: Schema.Array(Schema.Json),
  next: Schema.String,
});

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
    completionReceipt: Schema.optionalKey(GuiCompletionReceipt),
    activeRecovery: Schema.optionalKey(GuiActiveRecovery),
    enrollmentLifecycle: Schema.optionalKey(Schema.String),
    enrollmentRecovery: Schema.optionalKey(Schema.String),
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
  issueReporting: "/api/issue-reporting",
} as const;
