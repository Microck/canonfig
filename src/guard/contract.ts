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
export const guardRules = {
  "instruction-credential-concealment": "block",
  "instruction-risk-mention": "warn",
  "unverified-download-execute": "block",
  "download-execute": "warn",
  "invisible-control": "warn",
  "encoded-looking-text": "warn",
  "credential-file-reference": "warn",
  "tool-call-steering": "warn",
  "unscanned-file": "warn",
} as const;
const GuardRuleSeverity = Schema.Literals(["block", "warn", "off"]);
const GuardRuleOverrides = Schema.Record(Schema.String, GuardRuleSeverity).check(
  Schema.makeFilter((rules) => Object.keys(rules).every((code) => Object.hasOwn(guardRules, code)) || "Unknown built-in Guard rule"),
);
export const guardItemLabelLimit = 180;
export const guardApprovalDigestLength = 64;
export const guardApprovalNoteLimit = 256;
export const guardApprovalLimit = 100;
const ApprovalItem = Schema.NonEmptyString.check(Schema.isMaxLength(guardItemLabelLimit));
const ApprovalIdentity = {
  item: ApprovalItem,
  digest: Schema.String.check(Schema.isPattern(new RegExp(`^[a-f0-9]{${guardApprovalDigestLength}}$`, "u"))),
};
export const GuardApproval = Schema.Struct({
  ...ApprovalIdentity,
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(guardApprovalNoteLimit))),
});
export const GuardApprovalChange = Schema.Union([
  Schema.Struct({ action: Schema.Literal("approve"), approval: GuardApproval }),
  Schema.Struct({ action: Schema.Literal("revoke"), item: ApprovalItem }),
]);
export const GuardPolicy = Schema.Struct({
  version: Schema.Literal(1), checker: Schema.optional(GuardChecker),
  rules: Schema.optional(GuardRuleOverrides),
  approvals: Schema.optional(Schema.Array(GuardApproval).check(
    Schema.isMaxLength(guardApprovalLimit),
    Schema.makeFilter((approvals) =>
      new Set(approvals.map(({ item }) => item)).size === approvals.length || "Only one approval per Guard item is allowed"),
  )),
});
export const GuardFinding = Schema.Struct({
  checker: Schema.Literals(["static", "openai-compatible", "http"]),
  severity: GuardRuleSeverity,
  code: Schema.String, item: Schema.String, digest: Schema.String,
  path: Schema.optional(Schema.String), line: Schema.optional(Schema.Number),
  overriddenBy: Schema.optional(Schema.Literals(["rule", "approval"])),
});
export const guardReportItemLimit = 100;
export const guardReportFindingLimit = 20;
export const followerPublicationWarning = "Followers evaluate these items under their own Guard policy and may hold this revision.";

export const GuardReport = Schema.Struct({
  trigger: Schema.String, at: Schema.String, verdict: Schema.Literals(["allow", "warn", "block"]),
  checked: Schema.Number, unsupported: Schema.Number, unavailable: Schema.Number, cacheHits: Schema.Number,
  findings: Schema.Array(GuardFinding).check(Schema.isMaxLength(guardReportFindingLimit)),
  findingCount: Schema.Number, next: Schema.optional(Schema.String),
  blockedItems: Schema.optional(Schema.Array(Schema.Struct(ApprovalIdentity)).check(Schema.isMaxLength(guardReportItemLimit))),
  publicationPolicyWarnings: Schema.optional(Schema.Array(ApprovalItem).check(Schema.isMaxLength(guardReportItemLimit))),
  approvalObservations: Schema.optional(Schema.Array(Schema.Struct(ApprovalIdentity)).check(Schema.isMaxLength(guardApprovalLimit))),
  recordUnavailable: Schema.optionalKey(Schema.Literal(true)),
});
export const GuiGuardWrite = Schema.Struct({ policy: GuardPolicy, digest: Schema.String, consent: Schema.Boolean });
export const GuiGuardApproval = Schema.Struct({ change: GuardApprovalChange, digest: Schema.String });
export const GuiGuardStatus = Schema.Struct({
  mode: Schema.Literals(["static", "operator"]),
  policy: Schema.optionalKey(GuardPolicy), digest: Schema.optionalKey(Schema.String),
  bearerAvailable: Schema.optionalKey(Schema.Boolean), latest: Schema.NullOr(GuardReport),
  approvals: Schema.Array(Schema.Struct({
    ...GuardApproval.fields, status: Schema.Literals(["current", "stale", "unseen"]),
  })),
});
export const guardEndpoints = { status: "/api/guard", scan: "/api/guard/scan", approval: "/api/guard/approval" } as const;
export const promptGuardLocalEndpoint = "http://127.0.0.1:8787/v1/guard";
