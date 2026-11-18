import { Schema } from "effect";
import { CertificateFingerprint, FollowerId } from "./brand.ts";

/**
 * How a doctor probe detail value marks a failing item, such as one MCP server
 * (`fail · codex · command not found: ...`). The GUI lists those items.
 */
export const failingDetailPrefix = "fail · ";
/** The longest message or detail value a machine health report carries. */
export const machineHealthTextLimit = 512;
/** The longest detail key a machine health report carries. */
export const machineHealthKeyLimit = 200;
/** Where the Source's Machines view gets a doctor report, as doctor reports it. */
export const DoctorSourceReport = Schema.Struct({
  status: Schema.Literals(["sent", "recorded", "failed"]),
  detail: Schema.String,
});
export interface DoctorSourceReport extends Schema.Schema.Type<typeof DoctorSourceReport> {}
export const FleetVersion = Schema.String.check(Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u));
export const FleetIntegrity = Schema.String.check(Schema.isPattern(/^sha512-[A-Za-z0-9+/]{86}==$/u));
export const FleetDirective = Schema.Struct({
  schema: Schema.Literal("canonfig.fleet-directive/v1"),
  rollout: Schema.NonEmptyString,
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  follower: FollowerId,
  source: CertificateFingerprint,
  version: FleetVersion,
  integrity: FleetIntegrity,
  stateFormat: Schema.Int.check(Schema.isGreaterThan(0)),
  attempt: Schema.NonEmptyString,
  expiresAt: Schema.String,
});
export interface FleetDirective extends Schema.Schema.Type<typeof FleetDirective> {}
export const SignedFleetDirective = Schema.Struct({
  directive: FleetDirective, publicKey: Schema.NonEmptyString, signature: Schema.NonEmptyString,
});
export interface SignedFleetDirective extends Schema.Schema.Type<typeof SignedFleetDirective> {}
export const FleetHealth = Schema.Struct({
  run: Schema.NonEmptyString, revision: Schema.NonEmptyString,
  version: FleetVersion, outcome: Schema.Literal("Converged"), recordedAt: Schema.String,
});
export const FleetReport = Schema.Struct({
  rollout: Schema.NonEmptyString, attempt: Schema.NonEmptyString,
  status: Schema.Literals(["deferred", "healthy", "failed"]),
  version: FleetVersion, detail: Schema.String.check(Schema.isMaxLength(1024)),
  health: Schema.NullOr(FleetHealth),
});
export interface FleetReport extends Schema.Schema.Type<typeof FleetReport> {}
export const FleetFollower = Schema.Struct({
  id: FollowerId, name: Schema.String,
  status: Schema.Literals(["queued", "deferred", "updating", "healthy", "failed"]),
  version: Schema.NullOr(FleetVersion), detail: Schema.String,
  attempt: Schema.NullOr(Schema.String), admittedAt: Schema.NullOr(Schema.String),
  health: Schema.NullOr(FleetHealth),
});
export const FleetUpdate = Schema.Struct({
  schema: Schema.Literal("canonfig.fleet-update/v1"),
  id: Schema.NonEmptyString, sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  source: CertificateFingerprint, version: FleetVersion, integrity: FleetIntegrity,
  stateFormat: Schema.Int, startedAt: Schema.String,
  status: Schema.Literals(["running", "halted", "complete", "stopped"]),
  followers: Schema.Array(FleetFollower),
});
export interface FleetUpdate extends Schema.Schema.Type<typeof FleetUpdate> {}
export const FleetPoll = Schema.Struct({ directive: Schema.NullOr(SignedFleetDirective) });
export const FleetStart = Schema.Struct({ canary: FollowerId, apply: Schema.Boolean });
export interface FleetStart extends Schema.Schema.Type<typeof FleetStart> {}

/**
 * One machine's latest doctor report as the Source keeps it. Followers send
 * theirs after `canonfig doctor`; the Source records its own. Text is capped
 * so a report fits the Source's 64 KiB request limit.
 */
export const MachineHealthProbe = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(64)),
  status: Schema.Literals(["pass", "warning", "fail", "skipped"]),
  message: Schema.String.check(Schema.isMaxLength(machineHealthTextLimit)),
  details: Schema.optionalKey(Schema.Record(
    Schema.String.check(Schema.isMaxLength(machineHealthKeyLimit)),
    Schema.Union([Schema.Boolean, Schema.Number, Schema.String.check(Schema.isMaxLength(machineHealthTextLimit))]),
  )),
});
export interface MachineHealthProbe extends Schema.Schema.Type<typeof MachineHealthProbe> {}
export const MachineHealthReport = Schema.Struct({
  recordedAt: Schema.String,
  version: Schema.String.check(Schema.isMaxLength(64)),
  status: Schema.Literals(["healthy", "degraded", "unhealthy"]),
  probes: Schema.Array(MachineHealthProbe).check(Schema.isMaxLength(32)),
});
export interface MachineHealthReport extends Schema.Schema.Type<typeof MachineHealthReport> {}
/** One machine's stored record: its key is a follower id, or `source` for the Source itself. */
export const MachineHealthEntry = Schema.Struct({ key: Schema.String, name: Schema.String, report: MachineHealthReport });
export const MachineHealth = Schema.Struct({
  /** Keyed by follower id, or `source` for the Source itself. */
  machines: Schema.Record(Schema.String, Schema.Struct({ name: Schema.String, report: MachineHealthReport })),
});
export interface MachineHealth extends Schema.Schema.Type<typeof MachineHealth> {}
