import type { SchedulerCalendar } from "../machine/machine-state.types.ts";
import {
  normalizeSyncSchedule,
  type SyncSchedule,
} from "./schedule-manager.types.ts";

export const linuxCalendar = (input: SyncSchedule): SchedulerCalendar => {
  const schedule = normalizeSyncSchedule(input);
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
