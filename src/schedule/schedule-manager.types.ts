import type { MachinePlatform, RenderedSchedulerJob } from "../machine/machine-state.types.ts";

export const scheduleWeekdays = [
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun",
] as const;

export type ScheduleWeekday = typeof scheduleWeekdays[number];

export type SyncSchedule =
  | {
    readonly kind: "daily";
    readonly localTime: string;
    readonly timezone?: string | undefined;
  }
  | {
    readonly kind: "weekly";
    readonly weekday: ScheduleWeekday;
    readonly localTime: string;
    readonly timezone?: string | undefined;
  };

export interface SetScheduleInput {
  readonly schedule?: SyncSchedule | undefined;
  readonly executable?: string | undefined;
}

export interface ScheduleStatus {
  readonly state: "not-installed" | "current" | "drifted" | "disabled";
  readonly platform: MachinePlatform;
  readonly schedule: SyncSchedule;
  readonly definition: RenderedSchedulerJob;
}

export interface ScheduleChange {
  readonly change: "installed" | "unchanged" | "updated";
  readonly status: ScheduleStatus;
}

export interface RemoveScheduleResult {
  readonly change: "removed" | "unchanged";
}

export const defaultSyncSchedule: SyncSchedule = {
  kind: "daily",
  localTime: "00:00",
};
