import type { GuiRequestError } from "../gui-client";
import type { GuiSetupJournal, GuiSetupStatus, GuiInvitationInspection } from "../../../src/gui/contract/enrollment";
import type { GuiHarnessReport } from "../../../src/gui/contract/synchronization";
import type { HarnessId } from "../shared/metadata";
import { TransitionError } from "../lib/state-machine";

interface SetupEvidence { journal: GuiSetupJournal | null; status: GuiSetupStatus | null }
export type SourceSetupState =
  | { kind: "empty" }
  | { kind: "planning"; previous: SetupEvidence }
  | { kind: "planned" | "approving" | "approval-observing" | "approved" | "applying"; evidence: SetupEvidence }
  | { kind: "needs-human-action" | "complete"; evidence: SetupEvidence; status: GuiSetupStatus }
  | { kind: "observing"; evidence: SetupEvidence }
  | { kind: "observation-lost"; evidence: SetupEvidence; committed: "approval" | "apply" | null; error: GuiRequestError }
  | { kind: "failed"; evidence: SetupEvidence; error: GuiRequestError };
export type SourceEvent =
  | { kind: "plan" }
  | { kind: "planned"; journal: GuiSetupJournal }
  | { kind: "approve" | "apply" | "observe" }
  | { kind: "approval-committed"; journal: GuiSetupJournal }
  | { kind: "observed"; status: GuiSetupStatus }
  | { kind: "failed"; error: GuiRequestError; committed?: "approval" | "apply" };
export function setupEvidence(state: SourceSetupState): SetupEvidence {
  return "evidence" in state ? state.evidence : state.kind === "planning" ? state.previous : { journal: null, status: null };
}
export function transitionSource(state: SourceSetupState, event: SourceEvent): SourceSetupState {
  const evidence = setupEvidence(state);
  const busy = ["planning", "approving", "approval-observing", "applying", "observing"].includes(state.kind);
  switch (event.kind) {
    case "plan": if (!busy && state.kind !== "complete") return { kind: "planning", previous: evidence }; break;
    case "planned":
      if (state.kind === "planning") return { kind: event.journal.approvals.some((approval) => approval.digest === event.journal.planDigest) ? "approved" : "planned", evidence: { journal: event.journal, status: null } };
      break;
    case "approve":
      if ((state.kind === "planned" || state.kind === "failed") && (evidence.journal || evidence.status)) return { kind: "approving", evidence };
      break;
    case "approval-committed":
      if (state.kind === "approving") return { kind: "approval-observing", evidence: { journal: event.journal, status: null } };
      break;
    case "apply":
      if (state.kind === "approved" || state.kind === "needs-human-action" || (state.kind === "observation-lost" && state.committed === "approval")) return { kind: "applying", evidence };
      break;
    case "observe": if (!busy) return { kind: "observing", evidence }; break;
    case "observed": {
      if (!["observing", "approval-observing", "applying"].includes(state.kind)) break;
      const next = { journal: evidence.journal?.planDigest === event.status.planDigest ? evidence.journal : null, status: event.status };
      if (event.status.stage === "complete") return { kind: "complete", evidence: next, status: event.status };
      if (event.status.stage === "human-action-required") return { kind: "needs-human-action", evidence: next, status: event.status };
      return { kind: event.status.approved ? "approved" : "planned", evidence: next };
    }
    case "failed":
      if (event.committed || state.kind === "observing") return { kind: "observation-lost", evidence, committed: event.committed ?? null, error: event.error };
      if (busy) return { kind: "failed", evidence, error: event.error };
      break;
  }
  throw new TransitionError("Source setup", state.kind, event.kind);
}

export interface PreferenceDraft { excluded: HarnessId[]; schedule: boolean }
interface Invitation { inspection: GuiInvitationInspection; envelope: string; label: string }
interface Preferences { report: GuiHarnessReport; draft: PreferenceDraft }
export type FollowerEnrollmentState =
  | { kind: "empty" }
  | { kind: "inspecting"; envelope: string; label: string }
  | ({ kind: "inspected" | "joining" } & Invitation)
  | { kind: "inspection-failed"; error: GuiRequestError }
  | ({ kind: "join-failed"; error: GuiRequestError } & Invitation)
  | { kind: "joined-loading" }
  | { kind: "joined-unavailable"; error: GuiRequestError }
  | ({ kind: "joined"; saved: boolean } & Preferences)
  | ({ kind: "saving-preferences"; applied: HarnessId[] } & Preferences)
  | ({ kind: "preferences-failed"; applied: HarnessId[]; error: GuiRequestError } & Preferences);
export type FollowerEvent =
  | { kind: "inspect"; envelope: string; label: string }
  | { kind: "inspected"; inspection: GuiInvitationInspection }
  | { kind: "clear" | "join" | "joined" | "load-preferences" | "save-preferences" | "preferences-saved" }
  | { kind: "report"; report: GuiHarnessReport }
  | { kind: "edit-preferences"; draft: PreferenceDraft }
  | { kind: "preference-applied"; harness: HarnessId; report: GuiHarnessReport }
  | { kind: "failed"; error: GuiRequestError };
export function hasJoined(state: FollowerEnrollmentState) {
  return ["joined-loading", "joined-unavailable", "joined", "saving-preferences", "preferences-failed"].includes(state.kind);
}
export function transitionFollower(state: FollowerEnrollmentState, event: FollowerEvent): FollowerEnrollmentState {
  switch (event.kind) {
    case "inspect":
      if (["empty", "inspected", "inspection-failed", "join-failed"].includes(state.kind)) return { kind: "inspecting", envelope: event.envelope, label: event.label };
      break;
    case "inspected":
      if (state.kind === "inspecting") return { kind: "inspected", inspection: event.inspection, envelope: state.envelope, label: state.label };
      break;
    case "clear": if (["empty", "inspected", "inspection-failed", "join-failed"].includes(state.kind)) return { kind: "empty" }; break;
    case "join": if (state.kind === "inspected" || state.kind === "join-failed") return { ...state, kind: "joining" }; break;
    case "joined": if (state.kind === "joining") return { kind: "joined-loading" }; break;
    case "load-preferences": if (hasJoined(state) && state.kind !== "saving-preferences") return { kind: "joined-loading" }; break;
    case "report":
      if (state.kind === "joined-loading") return { kind: "joined", report: event.report, draft: { excluded: [...event.report.excluded], schedule: false }, saved: false };
      break;
    case "edit-preferences":
      if (state.kind === "joined" || state.kind === "preferences-failed") return { kind: "joined", report: state.report, draft: event.draft, saved: false };
      break;
    case "save-preferences":
      if (state.kind === "joined" || state.kind === "preferences-failed") return { kind: "saving-preferences", report: state.report, draft: state.draft, applied: [] };
      break;
    case "preference-applied":
      if (state.kind === "saving-preferences") return { ...state, report: event.report, applied: [...state.applied, event.harness] };
      break;
    case "preferences-saved":
      if (state.kind === "saving-preferences") return { kind: "joined", report: state.report, draft: state.draft, saved: true };
      break;
    case "failed":
      if (state.kind === "inspecting") return { kind: "inspection-failed", error: event.error };
      if (state.kind === "joining") return { kind: "join-failed", inspection: state.inspection, envelope: state.envelope, label: state.label, error: event.error };
      if (state.kind === "joined-loading") return { kind: "joined-unavailable", error: event.error };
      if (state.kind === "saving-preferences") return { ...state, kind: "preferences-failed", error: event.error };
      break;
  }
  throw new TransitionError("Follower enrollment", state.kind, event.kind);
}
