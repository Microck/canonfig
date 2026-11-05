// What holds back a self-update change: `self-update disable` refuses while another Canonfig command holds its update
// lease, and an interrupted sync blocks opting in. Pure, with no React, so VersionView and its node tests share one rule.

/** The Canonfig command whose update lease (commandLease in coordination.ts) a self-update change waits for. */
export type UpdateBusy = "service" | "setup" | "publish" | "sync" | "skill";

export interface UpdateGateInput {
  role: "source" | "follower";
  /** The source service is installed and running. */
  serviceInstalled: boolean;
  /** The Service page is installing or removing the service ("service-busy"). */
  serviceBusy: boolean;
  /** Setup is applying its steps. */
  setupApplying: boolean;
  publishing: boolean;
  /** A follower sync is running. */
  syncRunning: boolean;
  /** A follower sync was interrupted and not yet recovered or abandoned. */
  syncInterrupted: boolean;
  /** A skill check, update or tracking is running ("skill-busy"). */
  skillBusy: boolean;
}

/**
 * `busyWith` names the running command an update waits for; `unfinished` is an interrupted sync, which must be
 * finished with this version first (assertNoUnfinishedRun) and blocks opting in too. Skills run on either role.
 */
export function updateGate(s: UpdateGateInput): { busyWith: UpdateBusy | null; unfinished: boolean } {
  const roleBusy: UpdateBusy | null =
    s.role === "source"
      ? s.serviceInstalled || s.serviceBusy
        ? "service"
        : s.setupApplying
          ? "setup"
          : s.publishing
            ? "publish"
            : null
      : s.syncRunning
        ? "sync"
        : null;
  return { busyWith: roleBusy ?? (s.skillBusy ? "skill" : null), unfinished: s.role === "follower" && s.syncInterrupted };
}
