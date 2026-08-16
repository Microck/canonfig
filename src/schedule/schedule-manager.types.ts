import { Schema } from "effect";

import type { ResourceSpecInput } from "../domain/profile.ts";
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

export const syncScheduleFromResourceSpec = (
  spec: Extract<ResourceSpecInput, { readonly kind: "schedule" }>,
): SyncSchedule => {
  const timezone = spec.timezone === "local" ? undefined : spec.timezone;
  switch (spec.calendar.type) {
    case "daily":
      return { kind: "daily", localTime: spec.calendar.at, timezone };
    case "weekly": {
      const value = spec.calendar.days[0] ?? "";
      const weekday = `${value.slice(0, 1).toUpperCase()}${value.slice(1).toLowerCase()}`;
      if (!isScheduleWeekday(weekday)) {
        throw new Error(`unsupported schedule weekday: ${value}`);
      }
      return {
        kind: "weekly",
        weekday,
        localTime: spec.calendar.at,
        timezone,
      };
    }
    case "custom":
      return {
        kind: "custom",
        expression: spec.calendar.expression,
        timezone,
      };
  }
};
