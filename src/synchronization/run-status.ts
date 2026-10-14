import type { SynchronizationOutcome } from "../domain/synchronization.ts";
import type {
  ActionJournalState,
  RecoveryState,
} from "../state/state-repository.types.ts";

export interface LifecycleState {
  readonly reached: boolean;
  readonly detail: string;
}

export interface OpenRunOwner {
  readonly pid: number;
  readonly operation: string;
  readonly since: string;
}

/** Where one planned action of an open run stands, from its last journal event. */
export interface OpenRunActionProgress {
  readonly action: string;
  readonly resource: string;
  readonly kind: string;
  readonly state: ActionJournalState;
  readonly attempt: number;
  readonly recordedAt: string;
}

export interface OpenRunReport {
  readonly run: string;
  readonly revision: string;
  readonly startedAt: string;
  /** Present while a live process still owns the run. */
  readonly owner?: OpenRunOwner | undefined;
  readonly finishedActions: number;
  readonly totalActions: number;
  readonly actions: ReadonlyArray<OpenRunActionProgress>;
  readonly drift: ReadonlyArray<RecoveryState["drift"][number]["conflict"]>;
  readonly next: string;
}

/**
 * The open run as an operator needs to see it: each planned action once, in
 * plan order, with the state of its latest journal event. Status used to show
 * the first journal event of every action, which is always `pending` at
 * attempt 0, so a half-applied run looked untouched.
 */
export const openRunReport = (
  recovery: RecoveryState,
  owner: OpenRunOwner | undefined,
): OpenRunReport => {
  const latest = new Map<string, RecoveryState["actions"][number]>();
  for (const event of recovery.actions) latest.set(event.action, event);
  const actions = recovery.run.plan.actions.map((action): OpenRunActionProgress => {
    const event = latest.get(action.id);
    return {
      action: action.id,
      resource: action.resource,
      kind: action.kind,
      state: event?.state ?? "pending",
      attempt: event?.attempt ?? 0,
      recordedAt: event?.recordedAt ?? recovery.run.startedAt,
    };
  });
  const finishedActions = actions.filter((action) =>
    action.state === "succeeded" || action.state === "skipped"
  ).length;
  return {
    run: recovery.run.id,
    revision: recovery.run.revision,
    startedAt: recovery.run.startedAt,
    owner,
    finishedActions,
    totalActions: actions.length,
    actions,
    drift: recovery.drift.map((entry) => entry.conflict),
    next: owner === undefined
      ? "run 'canonfig recover' to finish or roll back this run, or 'canonfig abandon' to close it and keep the files as they are"
      : `wait for process ${String(owner.pid)} ('${owner.operation}') to finish`,
  };
};

/**
 * Convergence as the whole follower sees it. The Source-side check only asks
 * whether the latest revision appears among the applied resources, and those
 * are recorded per action as a run proceeds, so it answered `reached: true`
 * for a run that was killed halfway or ended in FollowerDrift.
 */
export const followerConvergence = (
  reported: LifecycleState,
  openRun: OpenRunReport | undefined,
  lastOutcome: SynchronizationOutcome["outcome"] | undefined,
): LifecycleState => {
  if (openRun !== undefined) {
    return {
      reached: false,
      detail: `run ${openRun.run} is ${openRun.owner === undefined ? "interrupted" : "in progress"} (${String(openRun.finishedActions)} of ${String(openRun.totalActions)} actions finished); ${openRun.next}`,
    };
  }
  if (lastOutcome !== undefined && lastOutcome !== "Converged") {
    return {
      reached: false,
      detail: `the last synchronization run ended ${lastOutcome}; ${reported.detail}`,
    };
  }
  return reported;
};
