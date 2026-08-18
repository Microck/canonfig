import { Context, type Effect } from "effect";

import type { ScheduleManagerError } from "./schedule-manager.errors.ts";
import type {
  RemoveScheduleResult,
  ScheduleChange,
  ScheduleSnapshot,
  ScheduleStatus,
  SetScheduleInput,
} from "./schedule-manager.types.ts";

export class ScheduleManager extends Context.Service<ScheduleManager, {
  readonly install: (
    input?: SetScheduleInput,
  ) => Effect.Effect<ScheduleChange, ScheduleManagerError>;
  readonly inspect: (
    input?: SetScheduleInput,
  ) => Effect.Effect<ScheduleStatus, ScheduleManagerError>;
  readonly update: (
    input?: SetScheduleInput,
  ) => Effect.Effect<ScheduleChange, ScheduleManagerError>;
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
