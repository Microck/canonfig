import { Context, type Effect } from "effect";

import type { AgentPolicy } from "../domain/identity.ts";
import type { FollowerId, ProfileId, ResourceId } from "../domain/brand.ts";
import type { EnrollmentInvitationGrant } from "../enrollment/enrollment.types.ts";
import type { SyncSchedule } from "../schedule/schedule-manager.types.ts";
import type {
  CliCommandFailure,
  CliPayload,
} from "./source-commands.ts";
import type { FollowerAgentHarnessConfiguration } from
  "../synchronization/follower-sync-config.ts";

export interface FollowerEnrollInput {
  readonly invitation: EnrollmentInvitationGrant;
  readonly followerName: string;
  readonly selectedProfile?: ProfileId | undefined;
  /** Replace a completed enrollment instead of refusing. */
  readonly replace: boolean;
}

export interface SynchronizeInput {
  readonly mode: "plan" | "apply";
  readonly noInput: boolean;
  /** Set by the rendered native job, so fired evidence is not fakeable. */
  readonly scheduled?: boolean | undefined;
}

export interface RecoverInput {
  readonly noInput: boolean;
}

export interface DoctorCommandInput {
  readonly noInput: boolean;
  readonly timeoutMilliseconds: number;
}

export interface ScheduleInput {
  readonly schedule: SyncSchedule;
  readonly executable?: string | undefined;
}

export interface LocalOverlayInput {
  readonly resource: ResourceId;
  readonly target: string;
  readonly keys: ReadonlyArray<string>;
}

export interface TunnelStartCommandInput {
  readonly invitationPath: string;
  readonly sshHost: string;
  readonly sshPort: number;
  readonly sshUser: string;
  readonly sshHostKeyPath: string;
  readonly localHost: "127.0.0.1" | "::1";
  readonly localPort: number;
  readonly sshExecutable?: string | undefined;
  readonly sshArguments: ReadonlyArray<string>;
  readonly timeoutMilliseconds: number;
}

export interface FollowerCommandsService {
  readonly enroll: (
    input: FollowerEnrollInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly abandon: () => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly synchronize: (
    input: SynchronizeInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly recover: (
    input: RecoverInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly status: (
    follower?: FollowerId,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly setLocalOverlay: (
    input: LocalOverlayInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly listLocalOverlays: () => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly removeLocalOverlay: (
    resource: ResourceId,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly setAgentPolicy: (
    policy: AgentPolicy,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly getAgentPolicy: () => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly setAgentHarness: (
    configuration: FollowerAgentHarnessConfiguration,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly getAgentHarness: () => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly selectProfile: (
    profile: ProfileId,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly setSchedule: (
    input: ScheduleInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly scheduleStatus: () => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly removeSchedule: () => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly doctor: (
    input: DoctorCommandInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly startTunnel: (
    input: TunnelStartCommandInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly tunnelStatus: () => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly stopTunnel: () => Effect.Effect<CliPayload, CliCommandFailure>;
}

export class FollowerCommands extends Context.Service<
  FollowerCommands,
  FollowerCommandsService
>()("canonfig/cli/FollowerCommands") {}
