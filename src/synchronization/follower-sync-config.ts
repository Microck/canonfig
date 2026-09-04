import { Schema } from "effect";

import {
  CertificateFingerprint,
  CredentialReference,
  ProfileId,
  ResourceId,
  Timestamp,
} from "../domain/brand.ts";
import { AgentPolicy, FollowerIdentity } from "../domain/identity.ts";
import { ScheduleDefaultSchema } from "../domain/profile.ts";
import { ExecutableAuthorizationSchema } from "../domain/synchronization.ts";

export const SupportedAgentHarness = Schema.Literals([
  "codex",
  "claude",
  "gemini",
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
  environment: Schema.optional(Schema.Array(Schema.Struct({
    name: Schema.NonEmptyString,
    value: Schema.String,
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

export const LocalOverlayEntrySchema = Schema.Struct({
  resource: ResourceId,
  /** Optional for schemaVersion 1 configurations written before targets were recorded. */
  target: Schema.optional(Schema.NonEmptyString),
  keys: Schema.Array(Schema.NonEmptyString),
});

export type LocalOverlayEntry = typeof LocalOverlayEntrySchema.Type;

export const FollowerSynchronizationConfiguration = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  follower: FollowerIdentity,
  selectedProfile: ProfileId,
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
  /** Set only between source preparation and source finalization. */
  enrollmentPending: Schema.optional(Schema.Literal(true)),
  /** Last authorized profile-level default schedule, for durable status/recovery. */
  scheduleDefault: Schema.optional(ScheduleDefaultSchema),
  agentHarness: Schema.optional(FollowerAgentHarnessConfiguration),
  localOverlay: Schema.optional(Schema.Array(LocalOverlayEntrySchema)),
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
  Schema.TaggedError<FollowerSynchronizationConfigurationError>()(
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
