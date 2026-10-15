// Schedule picker shared by the follower's Schedule and the profile's default.
// Mirrors `canonfig schedule set <daily@HH:mm|weekly:Day[,Day...]@HH:mm>` and `--default`.
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Field, settingsGroup } from "./kit";

export const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export type Day = (typeof WEEK)[number];
const WEEKDAYS: Day[] = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const FULL: Record<Day, string> = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

/** "default" follows the profile's schedule; "days" is any set of weekdays. */
export type Cadence = "default" | "daily" | "weekdays" | "days";

export interface Schedule {
  cadence: Cadence;
  days: Day[];
  time: string;
}

function daysOf(s: Schedule): Day[] {
  if (s.cadence === "weekdays") return WEEKDAYS;
  if (s.cadence === "days") return WEEK.filter((d) => s.days.includes(d));
  return [...WEEK];
}

/** `HH:mm` on a 24-hour clock, the only time form `canonfig schedule set` accepts. */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Why the schedule can't be saved, or null when it can. A browser time input
 * reports "" while any part is blank, so an incomplete time fails here too.
 * Callers disable Save and hide the CLI line while this is non-null, since
 * `daily@` or `weekly:@09:00` isn't a command the CLI accepts.
 */
export function scheduleError(s: Schedule): string | null {
  if (s.cadence === "default") return null;
  if (s.cadence === "days" && s.days.length === 0) return DAYS_ERROR;
  if (!TIME.test(s.time)) return TIME_ERROR;
  return null;
}
const DAYS_ERROR = "Pick at least one day.";
const TIME_ERROR = "Enter a complete time, like 09:00.";

/** The schedule argument the CLI takes, e.g. `weekly:Mon,Tue,Wed,Thu,Fri@08:00`. */
export function scheduleArg(s: Schedule) {
  if (s.cadence === "default") return "--default";
  if (s.cadence === "daily") return `daily@${s.time}`;
  return `weekly:${daysOf(s).join(",")}@${s.time}`;
}

export function scheduleSummary(s: Schedule, defaultLabel: string) {
  if (s.cadence === "default") return defaultLabel;
  if (s.cadence === "daily") return `Every day at ${s.time}`;
  if (s.cadence === "weekdays") return `Weekdays at ${s.time}`;
  const days = daysOf(s);
  if (days.length === 0) return "No days picked";
  return `${days.length === 1 ? `Every ${FULL[days[0]]}` : days.join(", ")} at ${s.time}`;
}

const NO_CHECK = "None until the schedule is complete";

/** The next scheduled check after now, in this browser's local time, as the follower's scheduler would run it. */
export function nextCheck(s: Schedule, defaultTime: string) {
  // An incomplete schedule never runs, so there is no next check to promise.
  if (scheduleError(s)) return NO_CHECK;
  const days = daysOf(s);
  const time = s.cadence === "default" ? defaultTime : s.time;
  const now = new Date();
  // getDay() counts from Sunday; WEEK starts on Monday.
  const today = (now.getDay() + 6) % 7;
  const [hours, minutes] = time.split(":").map(Number);
  // Today still counts while its check time is ahead.
  const first = now.getHours() * 60 + now.getMinutes() < hours * 60 + minutes ? 0 : 1;
  for (let i = first; i <= 7; i += 1) {
    const d = WEEK[(today + i) % 7];
    if (!days.includes(d)) continue;
    if (i === 0) return `Today at ${time}`;
    if (i === 1) return `Tomorrow at ${time}`;
    return `${i === 7 ? "Next " : ""}${FULL[d]} at ${time}`;
  }
  return NO_CHECK;
}

const OPTIONS: { value: Cadence; label: string }[] = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "days", label: "Pick days" },
];

export function ScheduleFields({
  idPrefix,
  value,
  onChange,
  defaultLabel,
}: {
  idPrefix: string;
  value: Schedule;
  onChange: (s: Schedule) => void;
  /** Offer "use the profile's default" first, labelled with what that default is. */
  defaultLabel?: string;
}) {
  const options = defaultLabel ? [{ value: "default" as const, label: `Same as the Source (${defaultLabel})` }, ...OPTIONS] : OPTIONS;
  const shownDays = daysOf(value);
  const custom = value.cadence !== "default";
  // Both problems can hold at once, so each shows under its own control.
  const daysError = value.cadence === "days" && value.days.length === 0 ? DAYS_ERROR : null;
  const timeError = custom && !TIME.test(value.time) ? TIME_ERROR : null;
  const toggle = (d: Day) => {
    const next = shownDays.includes(d) ? shownDays.filter((x) => x !== d) : WEEK.filter((x) => x === d || shownDays.includes(x));
    // Picking a day from an "every day" or "weekdays" schedule turns it into a custom set.
    onChange({ ...value, cadence: next.length === 5 && WEEKDAYS.every((d) => next.includes(d)) ? "weekdays" : next.length === 7 ? "daily" : "days", days: next });
  };
  return (
    <div className="grid gap-4">
      <Field label="When">
        <RadioGroup
          value={value.cadence}
          onValueChange={(c: Cadence) => onChange({ ...value, cadence: c, days: c === "days" && value.days.length === 0 ? WEEKDAYS : value.days })}
          aria-label="When"
          className={settingsGroup}
        >
          {options.map((o) => (
            <Label key={o.value} htmlFor={`${idPrefix}-${o.value}`} className="flex h-[36px] cursor-pointer items-center gap-2 px-[16px] text-base font-normal hover:bg-raised/40">
              <RadioGroupItem id={`${idPrefix}-${o.value}`} value={o.value} />
              {o.label}
            </Label>
          ))}
        </RadioGroup>
      </Field>
      {custom && (
        <div className="flex flex-wrap items-start gap-4">
          <Field label="Days" error={daysError}>
            <div className="flex gap-1" role="group" aria-label="Days">
              {WEEK.map((d) => {
                const on = shownDays.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    aria-label={FULL[d]}
                    onClick={() => toggle(d)}
                    className={cn(
                      "h-7 w-10 rounded-md border text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                      on ? "border-border-strong bg-raised text-foreground" : "border-border text-faint hover:text-muted-foreground",
                    )}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label="Time" htmlFor={`${idPrefix}-time`} error={timeError}>
            <div className="flex items-center gap-2">
              <Input
                id={`${idPrefix}-time`}
                type="time"
                value={value.time}
                onChange={(e) => onChange({ ...value, time: e.target.value })}
                aria-invalid={timeError ? true : undefined}
                aria-describedby={timeError ? `${idPrefix}-time-note` : undefined}
                className="w-32 font-mono text-sm tabular-nums [color-scheme:dark]"
              />
              <span className="text-sm text-faint">local time</span>
            </div>
          </Field>
        </div>
      )}
    </div>
  );
}
