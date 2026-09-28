import { Schema } from "effect";

import type { ScheduleDefault } from "../domain/profile.ts";
import type {
  MachinePlatform,
  RenderedSchedulerJob,
  SchedulerRunResult,
  SchedulerSnapshot,
} from "../machine/machine-state.types.ts";
import type { FollowerSynchronizationConfiguration } from "../synchronization/follower-sync-config.ts";

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

/** A schedule input whose calendar is already decided: what status and doctor probe against. */
export interface ResolvedScheduleInput extends SetScheduleInput {
  readonly schedule: SyncSchedule;
}

/**
 * The effective native state of the job, not only whether its files match.
 *
 * - `not-installed`, `disabled`, `inactive`: deleted, disabled, or stopped
 *   (unloaded) outside Canonfig; the job will not fire.
 * - `overridden`: a native override (a systemd drop-in) changes the job.
 * - `drifted`: the installed definition differs from the rendered one; see
 *   `drift` for whether only Canonfig's binding or the calendar differs.
 */
export type ScheduleState =
  | "not-installed"
  | "current"
  | "drifted"
  | "disabled"
  | "inactive"
  | "timezone-changed"
  | "overridden";

export interface ScheduleStatus {
  readonly state: ScheduleState;
  readonly platform: MachinePlatform;
  readonly schedule: SyncSchedule;
  readonly definition: RenderedSchedulerJob;
  /** One sentence describing the state and the next action. */
  readonly detail: string;
  /** For `drifted`: only the runtime/entrypoint binding differs, or the calendar too. */
  readonly drift?: "binding" | "calendar" | undefined;
  /** The zone `localTime` is read in: the named timezone, or this machine's own. */
  readonly timezone: string;
  /** The next start, computed from the calendar or reported by the native scheduler. */
  readonly nextRun?: string | undefined;
  readonly overrides?: ReadonlyArray<string> | undefined;
  readonly effectiveCalendar?: string | undefined;
  /** The last run the native scheduler itself recorded. */
  readonly lastNativeRun?: SchedulerRunResult | undefined;
  /** Linux: whether the user manager keeps running while logged out. */
  readonly lingering?: boolean | undefined;
  /** Conditions under which a selected run will not happen: DST gaps, no linger. */
  readonly warnings: ReadonlyArray<string>;
}

export type ScheduleSnapshot = SchedulerSnapshot;

export interface ScheduleChange {
  readonly change: "installed" | "unchanged" | "updated";
  readonly status: ScheduleStatus;
}

/** What the post-apply reconciler did with the native job. */
export interface ScheduleReconciliation {
  /**
   * `left-as-is`: the job was deleted, disabled, stopped, or overridden
   * outside Canonfig. Sync respects that and never recreates or re-enables
   * it; only an explicit `schedule set` does.
   */
  readonly action: "unchanged" | "updated" | "left-as-is";
  readonly status: ScheduleStatus;
}

/**
 * What a sync did or offers about the native job, reported in plan and apply
 * output so no schedule change or refusal is silent.
 *
 * - `available`: the profile declares a default, but this follower never
 *   consented to scheduling; nothing is installed.
 * - `kept-unmanaged`: a job exists without a decision (installed by an earlier
 *   release); it is kept as is.
 * - `removed`: the inherited profile default was withdrawn.
 * - `failed`: the native scheduler could not be inspected or updated; the
 *   resource run is unaffected.
 */
export interface ScheduleSyncReport {
  readonly action:
    | ScheduleReconciliation["action"]
    | "available"
    | "kept-unmanaged"
    | "removed"
    | "failed";
  readonly state?: ScheduleState | undefined;
  readonly detail: string;
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
  }
};

/**
 * What this follower's native job should be, or undefined when it should have
 * none. Only the follower's explicit decision installs a job: `schedule` pins
 * a calendar this machine chose, and `inherit` (`schedule set --default`)
 * follows the profile's `scheduleDefault`. Without a decision a profile
 * default is only offered, never installed: automatic scheduling needs the
 * follower's consent.
 *
 * `schedule status`, the doctor scheduler probe, and the reconciler that runs
 * after a converged apply all resolve the job through this, so they cannot
 * disagree about what "drifted" means. A `schedule` override pins the calendar
 * this machine chose, not the rendered binding: the runtime and entrypoint
 * still belong to canonfig, so a renderer change is drift here too and the
 * next apply re-renders the job with the operator's cadence intact.
 */
export const desiredScheduleInput = (
  override: FollowerSynchronizationConfiguration["scheduleOverride"],
  scheduleDefault: ScheduleDefault | undefined,
): ResolvedScheduleInput | undefined => {
  if (override?.kind === "schedule") {
    return override.executable === undefined
      ? { schedule: override.schedule }
      : { schedule: override.schedule, executable: override.executable };
  }
  return override?.kind === "inherit" && scheduleDefault !== undefined
    ? { schedule: syncScheduleFromDefault(scheduleDefault) }
    : undefined;
};

/**
 * The sync report when this follower made no schedule decision: a profile
 * default is offered, never installed.
 */
export const scheduleAvailableDetail = (schedule: ScheduleDefault): string => {
  const normalized = syncScheduleFromDefault(schedule);
  const calendar = normalized.kind === "weekly"
    ? `weekly:${normalized.weekdays.join(",")}@${schedule.at}`
    : `daily@${schedule.at}`;
  return `schedule available: the profile suggests ${calendar} in this machine's time zone; run \`canonfig schedule set --default\` to install it`;
};

/** Status of a job left behind without a decision, e.g. by a v2.x or v3.x auto-install. */
export const unmanagedScheduleDetail =
  "a Canonfig native schedule installed by an earlier release is kept as is but no longer managed; run `canonfig schedule set --default` or `canonfig schedule set <calendar>` to manage it, or `canonfig schedule remove` to delete it";

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

