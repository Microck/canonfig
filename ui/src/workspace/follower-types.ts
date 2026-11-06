import type { Schema } from "effect";
import type { GuiLocalItems, GuiLocalWrite, GuiLocalConfigRequest, GuiSecretSummary } from "../../../src/gui/contract/synchronization";
import type { GuiEnrollment } from "../../../src/gui/contract/enrollment";
import type { GuiOperation } from "../../../src/gui/contract/operations";
import type { Schedule } from "./schedule";
import type { ResourceState } from "./workspace-types";
import type { LocalCategory } from "../shared/metadata";

export interface FollowerLive {
  action: ResourceState;
  operation: GuiOperation | null;
  operationName: string;
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
