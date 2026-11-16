import { Context, type Effect } from "effect";
import type { StateRepository } from "../state/state-repository.service.ts";
import type { ScheduledInvocation } from "../state/state-repository.types.ts";

import type { ScheduleManagerError } from "./schedule-manager.errors.ts";
import type {
  RunScheduleInput,
  RemoveScheduleResult,
  ScheduleChange,
  ScheduleReconciliation,
  ScheduleSnapshot,
  ScheduleStatus,
  SetScheduleInput,
} from "./schedule-manager.types.ts";

export class ScheduleManager extends Context.Service<ScheduleManager, {
  readonly run: (
    input?: RunScheduleInput,
  ) => Effect.Effect<Exclude<ScheduledInvocation, { readonly _tag: "Running" }>, ScheduleManagerError, StateRepository>;
  readonly install: (
    input?: SetScheduleInput,
  ) => Effect.Effect<ScheduleChange, ScheduleManagerError>;
  readonly inspect: (
    input?: SetScheduleInput,
  ) => Effect.Effect<ScheduleStatus, ScheduleManagerError>;
  readonly update: (
    input?: SetScheduleInput,
  ) => Effect.Effect<ScheduleChange, ScheduleManagerError>;
  /** Post-apply convergence that never undoes an out-of-band disable or delete. */
  readonly reconcile: (
    input?: SetScheduleInput,
  ) => Effect.Effect<ScheduleReconciliation, ScheduleManagerError>;
  readonly status: (
    input?: SetScheduleInput,
  ) => Effect.Effect<ScheduleStatus, ScheduleManagerError>;
  readonly snapshot: (
    input?: SetScheduleInput,
  ) => Effect.Effect<ScheduleSnapshot, ScheduleManagerError>;
  readonly restore: (
    input: SetScheduleInput | undefined,
    snapshot: ScheduleSnapshot,
  ) => Effect.Effect<void, ScheduleManagerError>;
  readonly remove: (
    input?: SetScheduleInput,
  ) => Effect.Effect<RemoveScheduleResult, ScheduleManagerError>;
}>()("canonfig/schedule/ScheduleManager") {}
