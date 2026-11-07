import type { Schema } from "effect";
import type { GuiLocalItems, GuiLocalWrite, GuiLocalConfigRequest, GuiSecretSummary } from "../../../src/gui/contract/synchronization";
import type { GuiEnrollment } from "../../../src/gui/contract/enrollment";
import type { GuiOperation } from "../../../src/gui/contract/operations";
import type { Schedule } from "./schedule";
import type { ResourceState } from "./workspace-types";
import type { LocalCategory } from "../shared/metadata";
import type { GuiRequestError } from "../gui-client";

export type FollowerCommand = "plan" | "apply" | "review" | "restore" | "recover" | "abandon";
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
  schedule: Record<string, Schema.Json> | null;
  tunnel: Record<string, Schema.Json> | null;
  enrollment: GuiEnrollment | null;
  secrets: readonly GuiSecretSummary[];
  check: () => void;
  createReview: () => void;
  saveSchedule: (schedule: Schedule) => Promise<boolean>;
  saveItems: (input: typeof GuiLocalWrite.Type) => Promise<boolean>;
  savePreferences: (input: typeof GuiLocalConfigRequest.Type) => Promise<boolean>;
  refreshSecrets: () => void;
  toggleTunnel: () => void;
  exportArchive: () => void;
  archive: { sha256: string; manifestSha256: string; signer: string } | null;
}
