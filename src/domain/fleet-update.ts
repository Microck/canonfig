import { Schema } from "effect";
import { CertificateFingerprint, FollowerId } from "./brand.ts";

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
