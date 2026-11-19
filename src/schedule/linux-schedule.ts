import type { SchedulerCalendar } from "../machine/machine-state.types.ts";
import type { SyncSchedule } from "./schedule-manager.types.ts";

export const linuxCalendar = (schedule: SyncSchedule): SchedulerCalendar => {
  if (schedule.kind === "daily") {
    return {
      kind: "daily",
      localTime: schedule.localTime,
      timezone: schedule.timezone,
    };
  }
  if (schedule.kind === "weekly") {
    return {
      kind: "weekly",
      weekdays: schedule.weekdays,
      localTime: schedule.localTime,
      timezone: schedule.timezone,
    };
  }
  return {
    kind: "systemd-on-calendar",
    expression: schedule.expression,
    timezone: schedule.timezone,
  };
};
