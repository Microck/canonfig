import { Schema } from "effect";

const fields = {
  endpoint: Schema.NonEmptyString,
  protocolRevision: Schema.optional(Schema.NonEmptyString),
  authentication: Schema.optional(Schema.Literals(["none", "bearer-env"])),
  allowRemote: Schema.optional(Schema.Boolean),
  onUnavailable: Schema.optional(Schema.Literals(["block", "warn"])),
};
export const GuardChecker = Schema.Union([
  Schema.Struct({ ...fields, kind: Schema.Literal("openai-compatible"), model: Schema.NonEmptyString }),
  Schema.Struct({ ...fields, kind: Schema.Literal("http") }),
]);
export const GuardPolicy = Schema.Struct({ version: Schema.Literal(1), checker: Schema.optional(GuardChecker) });
export const GuardFinding = Schema.Struct({
  checker: Schema.Literals(["static", "openai-compatible", "http"]),
  severity: Schema.Literals(["warn", "block"]),
  code: Schema.String, item: Schema.String, digest: Schema.String,
  path: Schema.optional(Schema.String), line: Schema.optional(Schema.Number),
});
export const GuardReport = Schema.Struct({
  trigger: Schema.String, at: Schema.String, verdict: Schema.Literals(["allow", "warn", "block"]),
  checked: Schema.Number, unsupported: Schema.Number, unavailable: Schema.Number, cacheHits: Schema.Number,
  findings: Schema.Array(GuardFinding), findingCount: Schema.Number, next: Schema.optional(Schema.String),
  recordUnavailable: Schema.optionalKey(Schema.Literal(true)),
});
export const GuiGuardWrite = Schema.Struct({ policy: GuardPolicy, digest: Schema.String, consent: Schema.Boolean });
export const GuiGuardStatus = Schema.Struct({
  mode: Schema.Literals(["static", "operator"]),
  policy: Schema.optionalKey(GuardPolicy), digest: Schema.optionalKey(Schema.String),
  bearerAvailable: Schema.optionalKey(Schema.Boolean), latest: Schema.NullOr(GuardReport),
});
export const guardEndpoints = { status: "/api/guard", scan: "/api/guard/scan" } as const;
