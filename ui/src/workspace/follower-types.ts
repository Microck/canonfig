import type { Schema } from "effect";
import type { GuiLocalItems, GuiLocalWrite, GuiLocalConfigRequest, GuiSecretSummary, GuiScheduleStatus, GuiWatchStatus } from "../../../src/gui/contract/synchronization";
import type { GuiEnrollment, GuiEnrollmentTunnelInput, GuiInvitationInspection } from "../../../src/gui/contract/enrollment";
import type { GuiOperation } from "../../../src/gui/contract/operations";
import type { Schedule } from "./schedule";
import type { ResourceState } from "./workspace-types";
import type { LocalCategory } from "../shared/metadata";
import type { GuiRequestError } from "../gui-client";

export type FollowerCommand = "plan" | "apply" | "review" | "restore" | "recover" | "abandon" | "tunnel-configure" | "tunnel-start";
export type FollowerCommandState =
  | { kind: "Idle" }
  | { kind: "Submitting"; command: FollowerCommand; name: string }
  | { kind: "Observing"; command: FollowerCommand; name: string; ticket: string; operation: Extract<GuiOperation, { state: "running" }> | null }
  | { kind: "ObservationLost"; command: FollowerCommand; name: string; ticket: string; operation: Extract<GuiOperation, { state: "running" }> | null; error: GuiRequestError }
  | { kind: "Completed"; command: FollowerCommand; name: string; operation: Extract<GuiOperation, { state: "succeeded" }> }
  | { kind: "Failed"; command: FollowerCommand; name: string; operation: Extract<GuiOperation, { state: "failed" }> }
  | { kind: "SubmissionFailed"; command: FollowerCommand; name: string; error: GuiRequestError };

export interface FollowerLive {
  action: ResourceState;
  operation: GuiOperation | null;
  operationName: string;
  command: FollowerCommandState;
  canApply: boolean;
  resumeObservation: () => void;
  local: GuiLocalItems | null;
  allowed: LocalCategory[];
  schedule: GuiScheduleStatus | null;
  tunnel: Record<string, Schema.Json> | null;
  enrollment: GuiEnrollment | null;
  secrets: readonly GuiSecretSummary[];
  check: () => void;
  createReview: () => void;
  saveSchedule: (schedule: Schedule) => Promise<boolean>;
  removeSchedule: () => Promise<boolean>;
  /** The folder watcher: a Source's setting, or one a Follower kept from before it enrolled. Null before it loads. */
  watch: GuiWatchStatus | null;
  /** Why the watcher's status couldn't be read; shown in place of the control. */
  watchError: GuiRequestError | null;
  /** Install (true) or remove (false) the native service that applies folder changes automatically. */
  setWatch: (enabled: boolean) => Promise<boolean>;
  saveItems: (input: typeof GuiLocalWrite.Type) => Promise<boolean>;
  savePreferences: (input: typeof GuiLocalConfigRequest.Type) => Promise<boolean>;
  refreshSecrets: () => void;
  setSecret: (name: string, value: string) => Promise<boolean>;
  removeSecret: (name: string) => Promise<boolean>;
  inspectTunnelInvitation: (envelope: string) => Promise<GuiInvitationInspection | null>;
  configureTunnel: (input: typeof GuiEnrollmentTunnelInput.Type) => void;
  startTunnel: (timeoutMilliseconds?: number) => void;
  stopTunnel: (forget: boolean) => Promise<boolean>;
  exportArchive: (includeHarnesses?: boolean) => void;
  archive: { sha256: string; manifestSha256: string; signer: string } | null;
}
