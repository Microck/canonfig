import { Schema } from "effect";
import type { AgentPolicy } from "../../domain/identity.ts";
import type { FollowerAgentHarnessConfiguration } from "../../synchronization/follower-sync-config.ts";
import { GuiError } from "./session.ts";

export const GuiAgentPolicy = Schema.Literals(["deterministic-only", "agent-propose", "agent-apply"]) satisfies Schema.Codec<AgentPolicy>;
/** Browser-safe wire fields. Domain configuration modules also define Node-only errors. */
export const GuiAgentHarness = Schema.Struct({
  kind: Schema.Literals(["codex", "claude", "custom"]),
  executable: Schema.NonEmptyString,
  model: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isPattern(/^[^\s-][^\s]*$/u))),
  /** Omitted in responses when credential-bearing; omitted writes preserve the stored collection. */
  arguments: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Omitted in responses when credential-bearing; an explicit array replaces the stored collection. */
  environment: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.NonEmptyString, value: Schema.String }))),
  secretBindings: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.NonEmptyString, secret: Schema.NonEmptyString }))),
  maximumInputBytes: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1024 * 1024)),
  allowedPaths: Schema.Array(Schema.NonEmptyString),
  allowedExecutables: Schema.Array(Schema.NonEmptyString),
  executableAuthorizations: Schema.optionalKey(Schema.Array(Schema.Struct({
    executable: Schema.NonEmptyString, behavior: Schema.Literals(["leaf", "script-interpreter"]),
  }))),
  allowedOrigins: Schema.Array(Schema.NonEmptyString),
  allowedCapabilities: Schema.Array(Schema.Literals(["elevation", "login", "restart", "reboot"])),
}) satisfies Schema.Codec<FollowerAgentHarnessConfiguration>;

export const GuiAgentHarnessRead = Schema.Union([
  Schema.Struct({ configured: Schema.Literal(false) }),
  Schema.Struct({ configured: Schema.Literal(true), value: GuiAgentHarness }),
]);
export type GuiAgentHarnessRead = typeof GuiAgentHarnessRead.Type;
export const GuiSourceServiceInput = Schema.Struct({
  hostname: Schema.Literals(["127.0.0.1", "::1"]),
  port: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(65535)),
});
export const GuiSourceServiceStatus = Schema.Struct({
  state: Schema.Literals(["not-installed", "running", "not-running", "not-serving", "drifted"]),
  platform: Schema.Literals(["linux", "macos", "windows"]),
  mechanism: Schema.Literals(["systemd-user-service", "launchd-user-agent", "task-scheduler-logon"]),
  serviceName: Schema.String,
  definitionPath: Schema.optionalKey(Schema.String),
  endpoint: Schema.String,
  manager: Schema.Struct({
    installed: Schema.Boolean, matches: Schema.Boolean, enabled: Schema.Boolean, active: Schema.Boolean,
    state: Schema.String, pid: Schema.optionalKey(Schema.Number),
  }),
  serving: Schema.Boolean,
  supportedModes: Schema.String,
  linger: Schema.optionalKey(Schema.Boolean),
  logs: Schema.String,
  detail: Schema.String,
});
export const GuiSourceServiceReport = Schema.Struct({ report: GuiSourceServiceStatus, error: Schema.NullOr(GuiError) });
export const GuiSourceServiceChange = Schema.Struct({
  change: Schema.Literals(["installed", "updated", "unchanged"]), status: GuiSourceServiceStatus,
});
export const GuiSourceServiceRemoval = Schema.Struct({
  change: Schema.Literals(["removed", "unchanged"]), serviceName: Schema.String,
});
export const GuiInstallerMethod = Schema.Literals(["apt", "brew", "bun", "cargo", "npm", "pnpm", "uv", "winget"]);
export const GuiInstallerBinding = Schema.Struct({
  schema: Schema.Literal("canonfig.installer/v1"),
  method: GuiInstallerMethod,
  platform: Schema.Literals(["linux", "macos", "windows"]),
  executable: Schema.String,
  arguments: Schema.Array(Schema.String),
});
/** A PATH executable that would make a valid binding; the GUI offers it as a one-click choice. */
export const GuiDetectedInstaller = Schema.Struct({
  method: GuiInstallerMethod, executable: Schema.String, arguments: Schema.Array(Schema.String),
});
export const GuiInstallers = Schema.Struct({
  bindings: Schema.Array(GuiInstallerBinding),
  detected: Schema.Array(GuiDetectedInstaller),
});
export const GuiInstallerSetInput = GuiDetectedInstaller;
export const GuiInstallerSet = Schema.Struct({ binding: GuiInstallerBinding });
export const GuiInstallerRemoval = Schema.Struct({ removed: Schema.Boolean });
export const GuiInstallerCheck = Schema.Struct({
  binding: GuiInstallerBinding,
  verified: Schema.Literal(true),
  scope: Schema.Literal("current-process"),
});

export const GuiDoctorReport = Schema.Struct({
  schema: Schema.Literal("canonfig.doctor/v1"),
  status: Schema.Literals(["healthy", "degraded", "unhealthy"]),
  noInput: Schema.Boolean,
  timeoutMilliseconds: Schema.Number,
  probes: Schema.Array(Schema.Struct({
    name: Schema.String,
    status: Schema.Literals(["pass", "warning", "fail", "skipped"]),
    message: Schema.String,
    category: Schema.optionalKey(GuiError.fields.category),
    details: Schema.optionalKey(Schema.Record(Schema.String, Schema.Union([Schema.Boolean, Schema.Number, Schema.String]))),
  })),
});
export const GuiSelfUpdateStatus = Schema.Struct({
  platform: Schema.String,
  enabled: Schema.Boolean,
  pending: Schema.Boolean,
  settings: Schema.NullOr(Schema.Json),
});
/** Manual checks offer only the installed major's newest stable release.
 * Detail also reports newer majors and pairing/state warnings for line changes.
 */
export const GuiSelfUpdateCheck = Schema.Struct({
  current: Schema.String,
  candidate: Schema.String,
  status: Schema.Literals(["current", "available", "deferred", "updated"]),
  detail: Schema.String,
});
export const GuiSelfUpdateEnable = Schema.Struct({
  npmCli: Schema.NonEmptyString,
  confirmIdle: Schema.Boolean,
});
export const GuiSelfUpdateProgress = Schema.Struct({
  phase: Schema.Literals(["checking", "staging", "verifying", "activating", "complete"]),
  candidate: Schema.NullOr(Schema.String),
});
