import type { SchedulerCalendar } from "../machine/machine-state.types.ts";
import type { SyncSchedule } from "./schedule-manager.types.ts";

export const linuxCalendar = (schedule: SyncSchedule): SchedulerCalendar =>
  schedule.kind === "daily"
    ? {
      kind: "daily",
      localTime: schedule.localTime,
      timezone: schedule.timezone,
    }
    : schedule.kind === "weekly"
    ? {
      kind: "weekly",
      weekday: schedule.weekday,
      localTime: schedule.localTime,
      timezone: schedule.timezone,
    }
    : {
      kind: "systemd-on-calendar",
      expression: schedule.expression,
    };
