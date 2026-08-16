import { Effect } from "effect";

import type { SchedulerCalendar } from "../machine/machine-state.types.ts";
import { ScheduleHumanActionRequiredError } from "./schedule-manager.errors.ts";
import type { SyncSchedule } from "./schedule-manager.types.ts";

export const windowsCalendar = (
  schedule: SyncSchedule,
): Effect.Effect<SchedulerCalendar, ScheduleHumanActionRequiredError> => {
  if (schedule.timezone !== undefined) {
    return Effect.fail(new ScheduleHumanActionRequiredError({
      action: "use the Windows follower timezone for scheduled sync",
      recovery:
        "Task Scheduler calendar triggers follow the Windows user timezone and cannot preserve a named IANA timezone across DST. Remove the explicit timezone or change the follower timezone.",
    }));
  }
  return Effect.succeed(schedule.kind === "daily"
    ? { kind: "daily", localTime: schedule.localTime }
    : {
      kind: "weekly",
      weekday: schedule.weekday,
      localTime: schedule.localTime,
    });
};
