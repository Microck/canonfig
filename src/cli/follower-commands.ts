import { Context, type Effect } from "effect";

import type { AgentPolicy } from "../domain/identity.ts";
import type { FollowerId } from "../domain/brand.ts";
import type { EnrollmentInvitationGrant } from "../enrollment/enrollment.types.ts";
import type { TargetId } from "../projection/model.ts";
import type { ShieldInput } from "./shield.ts";
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
  readonly timeoutMilliseconds?: number | undefined;
  /** Replace a completed enrollment instead of refusing. */
  readonly replace: boolean;
}

export interface SynchronizeInput {
  readonly mode: "plan" | "apply";
  readonly noInput: boolean;
  /** Set by the rendered native job, so fired evidence is not fakeable. */
  readonly scheduled?: boolean | undefined;
  /** Take over harness surfaces without a takeover snapshot. */
  readonly noBackup?: boolean | undefined;
  /** With `--plan`: write private append-local adoption reviews, never output. */
  readonly reviewLocal?: boolean | undefined;
}

export interface RestoreInput {
  /** Snapshot id under `~/.canonfig/.backups/`; the latest when absent. */
  readonly snapshot?: string | undefined;
}

export interface ExportArchiveInput {
  /** Archive path as typed, relative to the working directory; a timestamped name there when absent. */
  readonly output?: string | undefined;
  /** Add the harness files Canonfig manages on this machine. */
  readonly includeHarnesses: boolean;
  /** Replace an existing file at the output path. */
  readonly force: boolean;
}

export interface ImportArchiveInput {
  /** Archive path as typed, relative to the working directory. */
  readonly archive: string;
  /** Verify and plan without writing. */
  readonly dryRun: boolean;
  /** Replace folder entries that already hold something, after a takeover snapshot of them. */
  readonly replace: boolean;
  /** The signing key fingerprint the archive must be signed by; any archive is accepted when absent. */
  readonly expectKey?: string | undefined;
}

export interface HarnessesInput {
  readonly change?: { readonly action: "include" | "exclude"; readonly harness: TargetId } | undefined;
}

export interface OverlaysInput {
  /** `set` or `remove` one `<category>/<name>`; absent lists the overlays. */
  readonly change?: { readonly action: "set" | "remove"; readonly item: string } | undefined;
}

export interface RecoverInput {
  readonly noInput: boolean;
}

export interface DoctorCommandInput {
  readonly noInput: boolean;
  readonly timeoutMilliseconds: number;
}

export type ScheduleInput =
  | {
    readonly schedule: SyncSchedule;
    readonly executable?: string | undefined;
  }
  /** `schedule set --default`: follow the selected profile's scheduleDefault. */
  | { readonly profileDefault: true };

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
  /**
   * Remove this machine's enrollment: revoke its identity on the Source when
   * the Source answers, then delete the local follower credential, the
   * shared secrets received through the enrollment, and the enrollment
   * record.
   */
  readonly unenroll: () => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly abandon: () => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly synchronize: (
    input: SynchronizeInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly shield: (input: ShieldInput) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly recover: (
    input: RecoverInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  /** Write a takeover snapshot back and exclude its harnesses on this machine. */
  readonly restore: (
    input: RestoreInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  /** Write ~/.canonfig/ (and optionally managed harness files) to one verified .tar.gz. */
  readonly exportArchive: (
    input: ExportArchiveInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  /** Verify an export and write its folder entries into ~/.canonfig/ as a journaled run. */
  readonly importArchive: (
    input: ImportArchiveInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  /** Report harness detection and selection; optionally change a local exclusion. */
  readonly harnesses: (
    input: HarnessesInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  /** List this machine's Local Overlays, or set or remove one in `local/local.jsonc`. */
  readonly overlays: (
    input: OverlaysInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly status: (
    follower?: FollowerId,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly setAgentPolicy: (
    policy: AgentPolicy,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly getAgentPolicy: () => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly setAgentHarness: (
    configuration: FollowerAgentHarnessConfiguration,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly getAgentHarness: () => Effect.Effect<CliPayload, CliCommandFailure>;
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
  /** Restart from the recorded tunnel configuration; no invitation needed. */
  readonly restartTunnel: (
    input: { readonly timeoutMilliseconds?: number | undefined },
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly tunnelStatus: () => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly stopTunnel: (
    input: { readonly forget: boolean },
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
}

export class FollowerCommands extends Context.Service<
  FollowerCommands,
  FollowerCommandsService
>()("canonfig/cli/FollowerCommands") {}
