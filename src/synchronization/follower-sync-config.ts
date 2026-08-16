import { Schema } from "effect";

import {
  CertificateFingerprint,
  CredentialReference,
  ProfileId,
  Timestamp,
} from "../domain/brand.ts";
import { AgentPolicy, FollowerIdentity } from "../domain/identity.ts";

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
  maximumInputBytes: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(1024 * 1024),
  ),
  allowedPaths: Schema.Array(Schema.NonEmptyString),
  allowedExecutables: Schema.Array(Schema.NonEmptyString),
  allowedOrigins: Schema.Array(Schema.NonEmptyString),
  allowedCapabilities: Schema.Array(AgentHarnessCapability),
});

export type FollowerAgentHarnessConfiguration =
  typeof FollowerAgentHarnessConfiguration.Type;

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
  agentHarness: Schema.optional(FollowerAgentHarnessConfiguration),
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
  updatedAt: Timestamp,
});

export type FollowerSynchronizationConfiguration =
  typeof FollowerSynchronizationConfiguration.Type;

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
