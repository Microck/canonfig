import type { Resource, Revision } from "../shared/metadata";
import { TransitionError } from "../lib/state-machine";
import type { PendingChange, PlanItem, ProfileEdit, Run } from "./workspace-types";

interface FollowerEvidence { appliedRevision: number; humanAction: boolean; runs: Run[] }
export type SimulatedRun =
  | { kind: "recovery-required"; run: Run; plan: PlanItem[] }
  | { kind: "planned"; plan: PlanItem[] }
  | { kind: "applying"; id: number; plan: PlanItem[]; progress: number; target: number }
  | { kind: "applied"; plan: PlanItem[]; revision: number; held: number };
export type SimulatedFollowerState =
  | { kind: "enrolled"; run: SimulatedRun; evidence: FollowerEvidence }
  | { kind: "unenrolled"; plan: PlanItem[]; lastEvidence: FollowerEvidence };
export type SimulatedFollowerEvent =
  | { kind: "apply"; target: number }
  | { kind: "advance"; id: number; progress: number }
  | { kind: "recover" | "abandon" | "unenroll" | "acknowledge" }
  | { kind: "restore"; snapshot: string };
export function transitionSimulatedFollower(state: SimulatedFollowerState, event: SimulatedFollowerEvent): SimulatedFollowerState {
  if (state.kind !== "enrolled") throw new TransitionError("Demo follower", state.kind, event.kind);
  const { run, evidence } = state;
  switch (event.kind) {
    case "apply":
      if (run.kind !== "planned" && run.kind !== "applied") break;
      return { ...state, run: { kind: "applying", id: (evidence.runs[0]?.n ?? 0) + 1, plan: run.plan, progress: 0, target: event.target } };
    case "advance": {
      if (run.kind !== "applying" || run.id !== event.id || event.progress < run.progress || event.progress > 100) break;
      if (event.progress < 100) return { ...state, run: { ...run, progress: event.progress } };
      const held = run.plan.filter((item) => item.action === "skip-drift").length;
      const humanAction = evidence.humanAction || run.plan.some((item) => item.resource === "tools/gh" && item.action === "install");
      return { kind: "enrolled", run: { kind: "applied", revision: run.target, held, plan: run.plan }, evidence: {
        appliedRevision: run.target, humanAction,
        runs: [{ n: run.id, what: `Applied revision ${run.target}${held ? `, ${held} ${held === 1 ? "item" : "items"} held` : ""}`, when: "Just now", tone: "ok" }, ...evidence.runs],
      } };
    }
    case "recover":
    case "abandon":
      if (run.kind !== "recovery-required") break;
      return { ...state, run: { kind: "planned", plan: run.plan }, evidence: { ...evidence, runs: evidence.runs.map((item) => item.n === run.run.n ? {
        ...item, what: event.kind === "recover" ? "Recovered: all 5 steps done" : "Abandoned, 3 of 5 done", when: "Just now", tone: event.kind === "recover" ? "ok" : "muted",
      } : item) } };
    case "unenroll": {
      const actionable = run.plan.filter((item) => item.action !== "skip-drift").length;
      const lastEvidence = run.kind === "applying" ? { ...evidence, runs: [{ n: run.id, what: `Stopped, ${Math.floor(run.progress / 100 * actionable)} of ${actionable} done`, when: "Just now", tone: "muted" as const }, ...evidence.runs] } : evidence;
      return { kind: "unenrolled", plan: run.plan, lastEvidence };
    }
    case "acknowledge":
      if (!evidence.humanAction) break;
      return { ...state, evidence: { ...evidence, humanAction: false } };
    case "restore":
      if (run.kind === "applying" || run.kind === "recovery-required") break;
      return { ...state, evidence: { ...evidence, runs: [{ n: (evidence.runs[0]?.n ?? 0) + 1, what: `Restored snapshot ${event.snapshot}`, when: "Just now", tone: "ok" }, ...evidence.runs] } };
  }
  throw new TransitionError("Demo follower", run.kind, event.kind);
}

/** Held resources never enter the apply cursor or acquire execution status. */
export function simulatedPlan(state: SimulatedFollowerState): PlanItem[] {
  if (state.kind === "unenrolled") return state.plan;
  const { run } = state;
  if (run.kind !== "applying" && run.kind !== "applied") return run.plan;
  const count = run.plan.filter((item) => item.action !== "skip-drift").length;
  const completed = run.kind === "applied" ? count : Math.floor(run.progress / 100 * count);
  let cursor = 0;
  return run.plan.map((item) => item.action === "skip-drift" ? item : { ...item, status: cursor++ < completed ? "done" : cursor - 1 === completed ? "running" : "pending" });
}

export type Delivery = { kind: "delivering"; sequence: number; requestId: number } | { kind: "delivered"; sequence: number };
interface SourceDraft { resources: Resource[]; edits: ProfileEdit[]; revisions: Revision[]; deliveries: Record<string, Delivery> }
export type SimulatedPublication =
  | ({ kind: "idle" } & SourceDraft)
  | ({ kind: "publishing"; generation: number; sequence: number; reviewer: string; frozen: PendingChange[] } & SourceDraft);
export type PublicationEvent =
  | { kind: "resources"; update: Resource[] | ((items: Resource[]) => Resource[]) }
  | { kind: "edit" | "withdraw-edit"; edit: ProfileEdit }
  | { kind: "publish"; reviewer: string; generation: number }
  | { kind: "published"; generation: number; revision: Revision; followers: string[] }
  | { kind: "delivered"; follower: string; sequence: number; requestId: number };
export function pendingChanges(state: SourceDraft): PendingChange[] {
  return [...state.resources.flatMap((resource) => resource.change ? [{ area: "item" as const, id: resource.id, change: resource.change, resource }] : []), ...state.edits];
}
export function transitionPublication(state: SimulatedPublication, event: PublicationEvent): SimulatedPublication {
  switch (event.kind) {
    case "resources": return { ...state, resources: typeof event.update === "function" ? event.update(state.resources) : event.update };
    case "edit": return { ...state, edits: [...state.edits.filter((edit) => edit.area !== event.edit.area || edit.id !== event.edit.id), event.edit] };
    case "withdraw-edit": return { ...state, edits: state.edits.filter((edit) => edit.area !== event.edit.area || edit.id !== event.edit.id) };
    case "publish":
      if (state.kind !== "idle") break;
      return { ...state, kind: "publishing", generation: event.generation, sequence: (state.revisions[0]?.sequence ?? 0) + 1, reviewer: event.reviewer, frozen: pendingChanges(state) };
    case "published": {
      if (state.kind !== "publishing" || state.generation !== event.generation || state.sequence !== event.revision.sequence) break;
      const frozenItems = new Set(state.frozen.flatMap((edit) => edit.area === "item" ? [edit.resource] : []));
      const frozenEdits = new Set(state.frozen);
      return { kind: "idle", resources: state.resources.flatMap((resource) => !frozenItems.has(resource) ? [resource] : resource.change === "removed" ? [] : [{ ...resource, change: undefined }]),
        edits: state.edits.filter((edit) => !frozenEdits.has(edit)), revisions: [event.revision, ...state.revisions],
        deliveries: { ...state.deliveries, ...Object.fromEntries(event.followers.map((id) => [id, { kind: "delivering" as const, sequence: state.sequence, requestId: state.generation }])) },
      };
    }
    case "delivered": {
      const delivery = state.deliveries[event.follower];
      if (delivery?.kind !== "delivering" || delivery.sequence !== event.sequence || delivery.requestId !== event.requestId) break;
      return { ...state, deliveries: { ...state.deliveries, [event.follower]: { kind: "delivered", sequence: event.sequence } } };
    }
  }
  throw new TransitionError("Demo publication", state.kind, event.kind);
}
