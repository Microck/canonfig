import { Effect } from "effect";

import type { SchedulerCalendar } from "../machine/machine-state.types.ts";
import { ScheduleHumanActionRequiredError } from "./schedule-manager.errors.ts";
import {
  normalizeSyncSchedule,
  type SyncSchedule,
} from "./schedule-manager.types.ts";

export const macosCalendar = (
  schedule: SyncSchedule,
): Effect.Effect<SchedulerCalendar, ScheduleHumanActionRequiredError> => {
  schedule = normalizeSyncSchedule(schedule);
  if (schedule.kind === "custom") {
    return Effect.fail(new ScheduleHumanActionRequiredError({
      action: "use a daily or weekly schedule on macOS",
      recovery:
        "launchd does not support the requested custom calendar expression. Choose a daily or weekly schedule, then retry.",
    }));
  }
  if (schedule.timezone !== undefined) {
    return Effect.fail(new ScheduleHumanActionRequiredError({
      action: "use the macOS follower timezone for scheduled sync",
      recovery:
        "launchd calendar intervals follow the macOS user timezone and cannot bind a named timezone. Remove the explicit timezone or change the follower timezone.",
    }));
  }
  return Effect.succeed(schedule.kind === "daily"
    ? { kind: "daily", localTime: schedule.localTime }
    : {
      kind: "weekly",
      weekdays: schedule.weekdays,
      localTime: schedule.localTime,
    });
};
