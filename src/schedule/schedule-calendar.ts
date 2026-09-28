import type { MachinePlatform } from "../machine/machine-state.types.ts";
import {
  type NormalizedSyncSchedule,
  scheduleWeekdays,
} from "./schedule-manager.types.ts";

/**
 * Wall-clock semantics of a daily or weekly schedule, computed with Intl.
 *
 * Every native scheduler canonfig renders to evaluates `localTime` against the
 * wall clock of one zone: the named `timezone`, or the machine's own zone.
 * Nothing here asks the native scheduler; it only explains what the rendered
 * calendar means so `schedule set` and `schedule status` can say when the next
 * run is and which days it cannot happen on.
 */

const DAY = 24 * 60 * 60 * 1000;

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

const wallClock = (instant: number, timezone: string): WallClock => {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
};

/**
 * The instant a wall-clock time names in `timezone`, or undefined when that
 * local time does not exist there (skipped by a daylight-saving change).
 */
const instantAt = (
  date: { readonly year: number; readonly month: number; readonly day: number },
  hour: number,
  minute: number,
  timezone: string,
): number | undefined => {
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  let instant = naive;
  // Two correction passes settle the zone offset on either side of a change.
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = wallClock(instant, timezone);
    const offset = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute)
      - Math.floor(instant / 60_000) * 60_000;
    instant = naive - offset;
  }
  const seen = wallClock(instant, timezone);
  return seen.year === date.year && seen.month === date.month && seen.day === date.day
      && seen.hour === hour && seen.minute === minute
    ? instant
    : undefined;
};

/** The zone a schedule's local time is read in. */
export const resolvedScheduleTimezone = (schedule: NormalizedSyncSchedule): string =>
  schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

interface ScheduledDay {
  readonly date: { readonly year: number; readonly month: number; readonly day: number };
  readonly instant: number | undefined;
}

/** Each day, from today in the schedule's zone, the schedule selects. */
function* scheduledDays(
  schedule: Exclude<NormalizedSyncSchedule, { readonly kind: "custom" }>,
  timezone: string,
  now: number,
  days: number,
): Generator<ScheduledDay> {
  const [hourText, minuteText] = schedule.localTime.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const today = wallClock(now, timezone);
  for (let offset = 0; offset <= days; offset += 1) {
    const calendar = new Date(Date.UTC(today.year, today.month - 1, today.day) + offset * DAY);
    // getUTCDay is Sunday-first; scheduleWeekdays is Monday-first.
    const weekday = scheduleWeekdays[(calendar.getUTCDay() + 6) % 7]!;
    if (schedule.kind === "weekly" && !schedule.weekdays.includes(weekday)) continue;
    const date = {
      year: calendar.getUTCFullYear(),
      month: calendar.getUTCMonth() + 1,
      day: calendar.getUTCDate(),
    };
    yield { date, instant: instantAt(date, hour, minute, timezone) };
  }
}

/** When the native scheduler next starts the job, if canonfig can compute it. */
export const nextScheduledRun = (
  schedule: NormalizedSyncSchedule,
  now: number = Date.now(),
): string | undefined => {
  if (schedule.kind === "custom") return undefined;
  const timezone = resolvedScheduleTimezone(schedule);
  for (const day of scheduledDays(schedule, timezone, now, 8)) {
    if (day.instant !== undefined && day.instant > now) {
      return new Date(day.instant).toISOString();
    }
  }
  return undefined;
};

const gapBehavior = {
  linux: "systemd skips the run on those days and runs again on the next scheduled day",
  macos: "launchd does not document this case, so the run on those days may be skipped or start after the clock change",
  windows: "Microsoft leaves Task Scheduler's behavior in the skipped hour unspecified (KB 325413), so the run on those days may be skipped or start after the clock change",
} satisfies Record<MachinePlatform, string>;

/**
 * A warning when the schedule's local time does not exist on some selected
 * day in the next 12 months, naming those days and what the native scheduler
 * does then. Undefined when every selected day has the time.
 */
export const daylightSavingGapWarning = (
  schedule: NormalizedSyncSchedule,
  platform: MachinePlatform,
  now: number = Date.now(),
): string | undefined => {
  if (schedule.kind === "custom") return undefined;
  const timezone = resolvedScheduleTimezone(schedule);
  const skipped = [...scheduledDays(schedule, timezone, now, 366)]
    .filter((day) => day.instant === undefined)
    .map(({ date }) =>
      `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`
    );
  if (skipped.length === 0) return undefined;
  return `${schedule.localTime} does not exist in ${timezone} on ${skipped.join(", ")} `
    + `(daylight-saving change); ${gapBehavior[platform]}. `
    + "Choose a time outside the change window to run on every scheduled day.";
};
