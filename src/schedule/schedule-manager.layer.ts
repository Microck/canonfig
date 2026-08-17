import { Effect, Layer } from "effect";

import { MachineState } from "../machine/machine-state.service.ts";
import type {
  MachinePlatform,
  RenderedSchedulerJob,
  SchedulerCalendar,
} from "../machine/machine-state.types.ts";
import { linuxCalendar } from "./linux-schedule.ts";
import { macosCalendar } from "./macos-schedule.ts";
import {
  InvalidScheduleError,
  type ScheduleManagerError,
  ScheduleVerificationError,
} from "./schedule-manager.errors.ts";
import { ScheduleManager } from "./schedule-manager.service.ts";
import {
  defaultSyncSchedule,
  normalizeSyncSchedule,
  type ScheduleChange,
  type NormalizedSyncSchedule,
  type ScheduleStatus,
  type SetScheduleInput,
  type SyncSchedule,
} from "./schedule-manager.types.ts";
import { windowsCalendar } from "./windows-schedule.ts";

const syncArguments = ["sync", "--apply", "--no-input"] as const;
const validLocalTime = /^([01]\d|2[0-3]):[0-5]\d$/u;

const validateSchedule = (
  schedule: SyncSchedule,
): Effect.Effect<NormalizedSyncSchedule, InvalidScheduleError> => {
  schedule = normalizeSyncSchedule(schedule);
  if (schedule.kind === "custom") {
    if (
      schedule.expression.trim() !== schedule.expression
      || schedule.expression.length === 0
      || /[\n\r\0]/u.test(schedule.expression)
    ) {
      return Effect.fail(new InvalidScheduleError({
        field: "expression",
        message: "custom calendar expression must be non-empty and single-line",
      }));
    }
    if (schedule.timezone === undefined) return Effect.succeed(schedule);
    if (
      schedule.timezone.trim() !== schedule.timezone
      || schedule.timezone.length === 0
      || /[\n\r\0]/u.test(schedule.timezone)
    ) {
      return Effect.fail(new InvalidScheduleError({
        field: "timezone",
        message: "timezone must be a non-empty IANA timezone name",
      }));
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone }).format();
    } catch {
      return Effect.fail(new InvalidScheduleError({
        field: "timezone",
        message: `unsupported IANA timezone: ${schedule.timezone}`,
      }));
    }
    return Effect.succeed(schedule);
  }
  if (!validLocalTime.test(schedule.localTime)) {
    return Effect.fail(new InvalidScheduleError({
      field: "localTime",
      message: "local time must use 24-hour HH:mm format",
    }));
  }
  if (schedule.kind === "weekly" && schedule.weekdays.length === 0) {
    return Effect.fail(new InvalidScheduleError({
      field: "weekdays",
      message: "weekly schedule must declare at least one weekday",
    }));
  }
  if (schedule.timezone === undefined) return Effect.succeed(schedule);
  if (
    schedule.timezone.trim() !== schedule.timezone
    || schedule.timezone.length === 0
    || /[\n\r\0]/u.test(schedule.timezone)
  ) {
    return Effect.fail(new InvalidScheduleError({
      field: "timezone",
      message: "timezone must be a non-empty IANA timezone name",
    }));
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone }).format();
  } catch {
    return Effect.fail(new InvalidScheduleError({
      field: "timezone",
      message: `unsupported IANA timezone: ${schedule.timezone}`,
    }));
  }
  return Effect.succeed(schedule);
};

const calendarFor = (
  platform: MachinePlatform,
  schedule: SyncSchedule,
): Effect.Effect<SchedulerCalendar, ScheduleManagerError> => {
  switch (platform) {
    case "linux":
      return Effect.succeed(linuxCalendar(schedule));
    case "macos":
      return macosCalendar(schedule);
    case "windows":
      return windowsCalendar(schedule);
  }
};

const stateOf = (
  installed: boolean,
  enabled: boolean,
  matches: boolean,
): ScheduleStatus["state"] => {
  if (!installed) return "not-installed";
  if (!matches) return "drifted";
  return enabled ? "current" : "disabled";
};

export const scheduleManagerLayer: Layer.Layer<ScheduleManager, never, MachineState> =
  Layer.effect(
    ScheduleManager,
    Effect.gen(function*() {
      const machine = yield* MachineState;

      const definition = Effect.fn("ScheduleManager.definition")(
        function*(input: SetScheduleInput = {}): Effect.fn.Return<
          {
            readonly schedule: SyncSchedule;
            readonly definition: RenderedSchedulerJob;
          },
          ScheduleManagerError
        > {
          const schedule = yield* validateSchedule(input.schedule ?? defaultSyncSchedule);
          const executable = input.executable === undefined
            ? (yield* machine.findExecutable({ name: "canonfig" })).path
            : yield* machine.normalizePath({ path: input.executable });
          const calendar = yield* calendarFor(executable.platform, schedule);
          const rendered = yield* machine.renderSchedulerJob({
            name: "canonfig-sync",
            description: "Canonfig follower synchronization",
            executable,
            arguments: syncArguments,
            calendar,
          });
          return { schedule, definition: rendered };
        },
      );

      const inspect = Effect.fn("ScheduleManager.inspect")(
        function*(input: SetScheduleInput = {}): Effect.fn.Return<
          ScheduleStatus,
          ScheduleManagerError
        > {
          const desired = yield* definition(input);
          const inspection = yield* machine.inspectSchedulerJob(desired.definition);
          return {
            state: stateOf(
              inspection.installed,
              inspection.enabled,
              inspection.matches,
            ),
            platform: desired.definition.platform,
            schedule: desired.schedule,
            definition: desired.definition,
          };
        },
      );

      const upsert = Effect.fn("ScheduleManager.upsert")(
        function*(input: SetScheduleInput = {}): Effect.fn.Return<
          ScheduleChange,
          ScheduleManagerError
        > {
          const desired = yield* definition(input);
          const before = yield* machine.inspectSchedulerJob(desired.definition);
          if (before.installed && before.enabled && before.matches) {
            return {
              change: "unchanged",
              status: {
                state: "current",
                platform: desired.definition.platform,
                schedule: desired.schedule,
                definition: desired.definition,
              },
            };
          }
          yield* machine.installSchedulerJob(desired.definition);
          const after = yield* machine.inspectSchedulerJob(desired.definition);
          const afterState = stateOf(after.installed, after.enabled, after.matches);
          if (afterState !== "current") {
            return yield* new ScheduleVerificationError({
              operation: before.installed ? "update" : "install",
              state: afterState,
              message: "native scheduler did not converge to the requested definition",
            });
          }
          return {
            change: before.installed ? "updated" : "installed",
            status: {
              state: afterState,
              platform: desired.definition.platform,
              schedule: desired.schedule,
              definition: desired.definition,
            },
          };
        },
      );

      const remove = Effect.fn("ScheduleManager.remove")(
        function*(input: SetScheduleInput = {}): Effect.fn.Return<
          { readonly change: "removed" | "unchanged" },
          ScheduleManagerError
        > {
          const desired = yield* definition(input);
          const before = yield* machine.inspectSchedulerJob(desired.definition);
          if (!before.installed) return { change: "unchanged" };
          yield* machine.removeSchedulerJob(desired.definition);
          const after = yield* machine.inspectSchedulerJob(desired.definition);
          if (after.installed) {
            return yield* new ScheduleVerificationError({
              operation: "remove",
              state: stateOf(after.installed, after.enabled, after.matches),
              message: "native scheduler still reports the schedule as installed",
            });
          }
          return { change: "removed" };
        },
      );

      return ScheduleManager.of({
        install: upsert,
        inspect,
        update: upsert,
        status: inspect,
        remove,
      });
    }),
  );
