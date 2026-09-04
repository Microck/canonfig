import { Schema } from "effect";

import type { ResourceSpecInput, ScheduleDefault } from "../domain/profile.ts";
import type {
  MachinePlatform,
  RenderedSchedulerJob,
  SchedulerSnapshot,
} from "../machine/machine-state.types.ts";

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

const isScheduleWeekday = (value: string): value is ScheduleWeekday =>
  scheduleWeekdays.some((candidate) => candidate === value);

export const SyncScheduleSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("daily"),
    localTime: Schema.NonEmptyString,
    timezone: Schema.optional(Schema.NonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("weekly"),
    weekdays: Schema.Array(Schema.Literals(scheduleWeekdays)),
    localTime: Schema.NonEmptyString,
    timezone: Schema.optional(Schema.NonEmptyString),
  }),
  // Accept v2 schedules written before multi-day weekly schedules were
  // introduced. Normalization below converts this shape to `weekdays`.
  Schema.Struct({
    kind: Schema.Literal("weekly"),
    weekday: Schema.Literals(scheduleWeekdays),
    localTime: Schema.NonEmptyString,
    timezone: Schema.optional(Schema.NonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("custom"),
    expression: Schema.NonEmptyString,
    timezone: Schema.optional(Schema.NonEmptyString),
  }),
]);

export type SyncSchedule =
  | {
    readonly kind: "daily";
    readonly localTime: string;
    readonly timezone?: string | undefined;
  }
  | {
    readonly kind: "weekly";
    readonly weekdays: ReadonlyArray<ScheduleWeekday>;
    readonly timezone?: string | undefined;
    readonly localTime: string;
  }
  | {
    /** Backward-compatible input shape; normalizeSyncSchedule removes it. */
    readonly kind: "weekly";
    readonly weekday: ScheduleWeekday;
    readonly localTime: string;
    readonly timezone?: string | undefined;
  }
  | {
    readonly kind: "custom";
    readonly expression: string;
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

export type ScheduleSnapshot = SchedulerSnapshot;

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

/** Convert the signed profile-level schedule contract to native scheduler input. */
export const syncScheduleFromDefault = (
  schedule: ScheduleDefault,
): NormalizedSyncSchedule => {
  const timezone = schedule.timezone === "local" ? undefined : schedule.timezone;
  switch (schedule.type) {
    case "daily":
      return timezone === undefined
        ? { kind: "daily", localTime: schedule.at }
        : { kind: "daily", localTime: schedule.at, timezone };
    case "weekly": {
      const weekdays = schedule.days.map((value) => {
        const weekday = `${value.slice(0, 1).toUpperCase()}${value.slice(1).toLowerCase()}`;
        if (!isScheduleWeekday(weekday)) {
          throw new Error(`unsupported schedule weekday: ${value}`);
        }
        return weekday;
      });
      const normalized = {
        kind: "weekly" as const,
        weekdays: [...new Set(weekdays)].sort(
          (left, right) => weekdayIndex.get(left)! - weekdayIndex.get(right)!,
        ),
        localTime: schedule.at,
      };
      return timezone === undefined ? normalized : { ...normalized, timezone };
    }
    case "custom":
      return timezone === undefined
        ? { kind: "custom", expression: schedule.expression }
        : { kind: "custom", expression: schedule.expression, timezone };
  }
};

const weekdayIndex = new Map(
  scheduleWeekdays.map((weekday, index) => [weekday, index] as const),
);

export const scheduleWeekdaysFor = (
  schedule: Extract<SyncSchedule, { readonly kind: "weekly" }>,
): ReadonlyArray<ScheduleWeekday> =>
  "weekdays" in schedule
    ? [...new Set(schedule.weekdays)].sort(
      (left, right) => weekdayIndex.get(left)! - weekdayIndex.get(right)!,
    )
    : [schedule.weekday];

export type NormalizedSyncSchedule = Exclude<SyncSchedule, {
  readonly kind: "weekly";
}> | {
  readonly kind: "weekly";
  readonly weekdays: ReadonlyArray<ScheduleWeekday>;
  readonly localTime: string;
  readonly timezone?: string | undefined;
};

export const normalizeSyncSchedule = (
  schedule: SyncSchedule,
): NormalizedSyncSchedule => {
  if (schedule.kind !== "weekly") return schedule;
  const normalized = {
    kind: "weekly" as const,
    weekdays: scheduleWeekdaysFor(schedule),
    localTime: schedule.localTime,
  };
  return schedule.timezone === undefined
    ? normalized
    : { ...normalized, timezone: schedule.timezone };
};

