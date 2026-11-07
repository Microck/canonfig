import { Schema } from "effect";
import { TaggedError } from "../domain/tagged-error.ts";

import {
  CertificateFingerprint,
  CredentialReference,
  ProfileId,
  Timestamp,
} from "../domain/brand.ts";
import { AgentPolicy, FollowerIdentity, SourceIdentity } from "../domain/identity.ts";
import { ScheduleDefaultSchema } from "../domain/profile.ts";
import { SyncScheduleSchema } from "../schedule/schedule-manager.types.ts";
import { ExecutableAuthorizationSchema } from "../domain/synchronization.ts";

export const SupportedAgentHarness = Schema.Literals([
  "codex",
  "claude",
  "custom",
]);

export const AgentHarnessCapability = Schema.Literals([
  "elevation",
  "login",
  "restart",
  "reboot",
]);

export const FollowerAgentHarnessConfiguration = Schema.Struct({
  kind: SupportedAgentHarness,
  executable: Schema.NonEmptyString,
  /** codex/claude only: passed as `--model`. Absent means the agent's own default. */
  model: Schema.optional(Schema.NonEmptyString),
  /** custom only: the complete argument list, run without a shell (ADR 0002). */
  arguments: Schema.optional(Schema.Array(Schema.String)),
  environment: Schema.optional(Schema.Array(Schema.Struct({
    name: Schema.NonEmptyString,
    value: Schema.String,
  }))),
  /** Values stay in native storage; only these symbolic names are persisted. */
  secretBindings: Schema.optional(Schema.Array(Schema.Struct({
    name: Schema.NonEmptyString,
    secret: Schema.NonEmptyString,
  }))),
  maximumInputBytes: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(1024 * 1024),
  ),
  allowedPaths: Schema.Array(Schema.NonEmptyString),
  allowedExecutables: Schema.Array(Schema.NonEmptyString),
  executableAuthorizations: Schema.optional(
    Schema.Array(ExecutableAuthorizationSchema),
  ),
  allowedOrigins: Schema.Array(Schema.NonEmptyString),
  allowedCapabilities: Schema.Array(AgentHarnessCapability),
});

export type FollowerAgentHarnessConfiguration =
  typeof FollowerAgentHarnessConfiguration.Type;

export const FollowerConfigurationFields = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  follower: FollowerIdentity,
  /** The one profile its Source publishes, recorded at enrollment. */
  profile: ProfileId,
  source: Schema.Struct({
    endpoint: Schema.NonEmptyString,
    tlsFingerprint: CertificateFingerprint,
    signingFingerprint: CertificateFingerprint,
  }),
  credentialReference: CredentialReference,
  cacheDirectory: Schema.NonEmptyString,
  stateLocation: Schema.NonEmptyString,
  agentPolicy: AgentPolicy,
  /**
   * How this follower keeps its credential, recorded at enrollment.
   *
   * The policy was selected only by `CANONFIG_LOCAL_CREDENTIAL_ROOT` in the
   * environment, which a native scheduled job does not carry, so a follower
   * enrolled under the local-file policy had no credential during a scheduled
   * run. Recording it here makes the enrolled configuration the authority
   * rather than whatever environment happens to be present.
   */
  credentialPolicy: Schema.optional(Schema.Union([
    Schema.Struct({ kind: Schema.Literal("secure-store") }),
    Schema.Struct({
      kind: Schema.Literal("local-file"),
      path: Schema.NonEmptyString,
    }),
  ])),
  /** Last authorized profile-level default schedule, inherited when no override is set. */
  scheduleDefault: Schema.optional(ScheduleDefaultSchema),
  /**
   * This follower's own decision about the native synchronization job.
   *
   * The follower owns `canonfig-sync`. `inherit` follows the profile's
   * `scheduleDefault`, `disabled` means this machine runs no scheduled
   * synchronization, and `schedule` pins a calendar this machine chose.
   *
   * A Machine Profile used to fight over the same job: every plan appended a
   * `schedule-default` action, so `canonfig schedule set` lasted exactly one
   * run and a profile declaring both a schedule resource and a different
   * default made the follower alternate calendars while reporting Converged.
   */
  scheduleOverride: Schema.optional(Schema.Union([
    Schema.Struct({ kind: Schema.Literal("inherit") }),
    Schema.Struct({ kind: Schema.Literal("disabled") }),
    Schema.Struct({
      kind: Schema.Literal("schedule"),
      schedule: SyncScheduleSchema,
      executable: Schema.optional(Schema.NonEmptyString),
    }),
  ])),
  agentHarness: Schema.optional(FollowerAgentHarnessConfiguration),
  /**
   * Bounds on requests to the Source Machine. `timeoutMilliseconds` is an HTTP
   * timeout and belongs to the transport, not to work run on this machine; see
   * `localExecution` for that.
   */
  scheduledInvocation: Schema.Struct({
    mode: Schema.Literal("apply"),
    noInput: Schema.Literal(true),
    timeoutMilliseconds: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1_000),
      Schema.isLessThanOrEqualTo(300_000),
    ),
    maximumMetadataBytes: Schema.Int.check(Schema.isGreaterThan(0)),
    maximumBlobBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  /**
   * Bounds on work Canonfig runs on this machine: package manager installers
   * and `command` verifications. These routinely take minutes, so they cannot
   * share the transport's timeout.
   */
  localExecution: Schema.optional(Schema.Struct({
    processTimeoutMilliseconds: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1_000),
      Schema.isLessThanOrEqualTo(60 * 60 * 1_000),
    ),
  })),
  updatedAt: Timestamp,
});

const PreviousFollowerEnrollment = Schema.Struct({
  ...FollowerConfigurationFields.fields,
  sourceIdentity: SourceIdentity,
});

/** Previous enrollment remains owned until its remote and local retirement finish. */
export const FollowerEnrollmentLifecycle = Schema.Union([
  Schema.TaggedStruct("Active", {}),
  Schema.TaggedStruct("Finalizing", {
    previous: Schema.optional(PreviousFollowerEnrollment),
  }),
  Schema.TaggedStruct("RetiringPrevious", {
    previous: PreviousFollowerEnrollment,
    cleanup: Schema.Union([
      Schema.TaggedStruct("RevokeRemote", {}),
      Schema.TaggedStruct("RemoveLocal", {}),
    ]),
  }),
  Schema.TaggedStruct("RollbackPending", { previous: PreviousFollowerEnrollment }),
  Schema.TaggedStruct("Unenrolling", {
    previous: Schema.optional(PreviousFollowerEnrollment),
  }),
]);

export const FollowerSynchronizationConfiguration = Schema.Struct({
  ...FollowerConfigurationFields.fields,
  lifecycle: FollowerEnrollmentLifecycle,
});

export type FollowerSynchronizationConfiguration =
  typeof FollowerSynchronizationConfiguration.Type;

/**
 * The default bound on a local process. It matches the executor's own default,
 * which was previously overridden by the transport timeout on every run.
 */
export const defaultLocalExecution = {
  processTimeoutMilliseconds: 10 * 60 * 1_000,
} as const;

export const defaultScheduledInvocation = {
  mode: "apply",
  noInput: true,
  timeoutMilliseconds: 10_000,
  maximumMetadataBytes: 1024 * 1024,
  maximumBlobBytes: 8 * 1024 * 1024,
} as const;

export class FollowerSynchronizationConfigurationError extends
  TaggedError<FollowerSynchronizationConfigurationError>()(
    "FollowerSynchronizationConfigurationError",
    {
      reason: Schema.Literals([
        "missing",
        "stale",
        "invalid-profile",
        "invalid-reference",
      ]),
      message: Schema.String,
    },
  )
{}
