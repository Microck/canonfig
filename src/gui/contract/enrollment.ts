import { Schema } from "effect";
import { FollowerId, GroupName } from "../../domain/brand.ts";
import {
  SetupApproval, SetupDiscoveryInput, SetupJournal, SetupMode,
  SetupProvenance, SetupRequestScope, SetupRole, SetupStageRecord,
} from "../../setup/setup.types.ts";
import { EnrollmentCredentialLifecycle } from "../../state/state-repository.types.ts";

export const GuiSetupJournal = SetupJournal;
export type GuiSetupJournal = typeof GuiSetupJournal.Type;
export const GuiSetupStatus = Schema.Struct({
  role: Schema.optionalKey(SetupRole),
  scope: Schema.optionalKey(SetupRequestScope),
  mode: Schema.optionalKey(SetupMode),
  intent: Schema.optionalKey(Schema.String),
  discoveryPaths: Schema.Array(Schema.String),
  discoveryInputs: Schema.optionalKey(Schema.Array(SetupDiscoveryInput)),
  planDigest: Schema.optionalKey(Schema.String),
  stage: Schema.String,
  approved: Schema.Boolean,
  approvals: Schema.Array(SetupApproval),
  stages: Schema.Array(SetupStageRecord),
  items: Schema.Array(Schema.Struct({
    id: Schema.String, status: Schema.String, evidence: Schema.optionalKey(Schema.String),
  })),
  catalog: Schema.Array(SetupProvenance),
});
export type GuiSetupStatus = typeof GuiSetupStatus.Type;
export const GuiSetupPlanInput = Schema.Struct({
  role: SetupRole,
  scope: SetupRequestScope,
  mode: SetupMode,
  files: Schema.Array(Schema.String),
  intent: Schema.optionalKey(Schema.String),
  harnesses: Schema.optionalKey(Schema.Array(Schema.String)),
  imports: Schema.Union([
    Schema.Struct({ kind: Schema.Literals(["offer", "none", "all"]) }),
    Schema.Struct({ kind: Schema.Literal("some"), requested: Schema.Array(Schema.String) }),
  ]),
});
export const GuiSetupApproveInput = Schema.Struct({
  approver: Schema.NonEmptyString, planDigest: Schema.NonEmptyString,
});
export const GuiSetupApplyInput = Schema.Struct({ planDigest: Schema.NonEmptyString });

export const GuiEnrollmentFollower = Schema.Struct({
  id: FollowerId, name: Schema.String, groups: Schema.Array(GroupName),
  enrolledAt: Schema.String, revoked: Schema.Boolean,
  pending: Schema.Boolean, credentialPresent: Schema.Boolean,
  credentialLifecycle: EnrollmentCredentialLifecycle,
});
export type GuiEnrollmentFollower = typeof GuiEnrollmentFollower.Type;
export const GuiStoredInvitation = Schema.Struct({
  endpoint: Schema.String, groups: Schema.Array(GroupName),
  expiresAt: Schema.String, consumed: Schema.Boolean,
});
export const GuiMachines = Schema.Struct({
  followers: Schema.Array(GuiEnrollmentFollower),
  invitations: Schema.Array(GuiStoredInvitation),
});
export type GuiMachines = typeof GuiMachines.Type;
export const GuiEnrollment = Schema.Struct({
  follower: Schema.Struct({
    id: FollowerId, name: Schema.String, groups: Schema.Array(GroupName),
    enrolledAt: Schema.String, revoked: Schema.Boolean,
  }),
  source: Schema.Struct({
    endpoint: Schema.String, signingFingerprint: Schema.String, tlsFingerprint: Schema.String,
  }),
  pending: Schema.Boolean,
});
export type GuiEnrollment = typeof GuiEnrollment.Type;
export const GuiInviteInput = Schema.Struct({
  endpoint: Schema.NonEmptyString,
  expiresInMilliseconds: Schema.Int.check(Schema.isGreaterThan(0)),
  groups: Schema.Array(GroupName),
});
export const GuiInvitationDownload = Schema.Struct({
  filename: Schema.String, envelope: Schema.String,
  endpoint: Schema.String, expiresAt: Schema.String, groups: Schema.Array(GroupName),
});
export type GuiInvitationDownload = typeof GuiInvitationDownload.Type;
export const GuiInvitationInput = Schema.Struct({ envelope: Schema.String });
export const GuiInvitationInspection = Schema.Struct({
  endpoint: Schema.String, sourceFingerprint: Schema.String, tlsFingerprint: Schema.String,
  groups: Schema.Array(GroupName), expiresAt: Schema.String,
});
export type GuiInvitationInspection = typeof GuiInvitationInspection.Type;
export const GuiEnrollInput = Schema.Struct({
  envelope: Schema.String, followerName: Schema.NonEmptyString, replace: Schema.Boolean,
});
export const GuiRevokeInput = Schema.Struct({ follower: FollowerId });
export const GuiEnrollmentTunnelInput = Schema.Struct({
  envelope: Schema.String,
  sshHost: Schema.NonEmptyString, sshUser: Schema.NonEmptyString,
  sshPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  sshHostKeyPath: Schema.NonEmptyString,
  localPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  trustConfirmed: Schema.Literal(true),
});
