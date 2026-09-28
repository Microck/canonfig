import { userInfo } from "node:os";
import { dirname } from "node:path";
import { Effect, Layer } from "effect";

import { MachineState } from "../machine/machine-state.service.ts";
import type {
  MachinePlatform,
  RenderedSchedulerJob,
  SchedulerCalendar,
  SchedulerInspection,
} from "../machine/machine-state.types.ts";
import { linuxCalendar } from "./linux-schedule.ts";
import { macosCalendar } from "./macos-schedule.ts";
import {
  daylightSavingGapWarning,
  nextScheduledRun,
  resolvedScheduleTimezone,
} from "./schedule-calendar.ts";
import {
  InvalidScheduleError,
  ScheduleHumanActionRequiredError,
  type ScheduleManagerError,
  ScheduleVerificationError,
} from "./schedule-manager.errors.ts";
import { ScheduleManager } from "./schedule-manager.service.ts";
import {
  defaultSyncSchedule,
  normalizeSyncSchedule,
  type ScheduleChange,
  type NormalizedSyncSchedule,
  type ScheduleReconciliation,
  type ScheduleSnapshot,
  type ScheduleState,
  type ScheduleStatus,
  type SetScheduleInput,
  type SyncSchedule,
} from "./schedule-manager.types.ts";
import { windowsCalendar } from "./windows-schedule.ts";
import { scheduleCommand } from "./schedule-command.ts";

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

const stateOf = (inspection: SchedulerInspection): ScheduleState => {
  if (!inspection.installed) return "not-installed";
  if (!inspection.enabled) return "disabled";
  if (inspection.timezoneChangedSinceBoot) return "timezone-changed";
  // Undefined means the backend cannot observe runtime state, not "stopped".
  // Checked before drift: a stopped job must never look like one the
  // reconciler may re-render and thereby restart.
  if (inspection.active === false) return "inactive";
  if ((inspection.overrides?.length ?? 0) > 0) return "overridden";
  return inspection.matches ? "current" : "drifted";
};

const disabledOutsideCanonfig = (what: string): string =>
  `automation disabled outside Canonfig: the native job ${what}, so scheduled synchronization will not run. Run \`canonfig schedule set\` to restore it, or \`canonfig schedule remove\` to confirm manual operation.`;

const lingerUser = (): string => {
  try {
    return userInfo().username;
  } catch {
    return "$USER";
  }
};

const macosTimezoneRecovery =
  "the macOS time zone changed after boot; launchd may retain the old zone even if the job is reinstalled. Reboot the Mac, sign in to the graphical session, then check `canonfig schedule status` before relying on scheduled runs";

/** The effective state of the native job with what it means for the user. */
const statusFrom = (
  schedule: NormalizedSyncSchedule,
  definition: RenderedSchedulerJob,
  inspection: SchedulerInspection,
): ScheduleStatus => {
  const state = stateOf(inspection);
  const drift = state === "drifted"
    ? inspection.calendarMatches === true ? "binding" as const : "calendar" as const
    : undefined;
  const nextRun = state === "current"
    ? nextScheduledRun(schedule) ?? inspection.nextElapse
    : undefined;
  const detail = (() => {
    switch (state) {
      case "not-installed":
        return disabledOutsideCanonfig("is missing");
      case "disabled":
        return disabledOutsideCanonfig("is disabled");
      case "inactive":
        return disabledOutsideCanonfig("is installed but stopped");
      case "overridden":
        return `a native override changes the Canonfig job (${inspection.overrides!.join(", ")}); `
          + `the effective calendar is ${inspection.effectiveCalendar ?? "unknown"}. Remove the override and run \`systemctl --user daemon-reload\`, or run \`canonfig schedule remove\` and manage the job yourself.`;
      case "timezone-changed":
        return macosTimezoneRecovery;
      case "drifted":
        return drift === "binding"
          ? "the native job keeps its calendar but was rendered by a different Canonfig build (runtime or entrypoint); the next `canonfig sync --apply` re-renders it"
          : "the native job was changed outside Canonfig; the next `canonfig sync --apply` or `canonfig schedule set` restores the selected calendar";
      case "current":
        return nextRun === undefined
          ? "the native job is installed and armed"
          : `the native job is installed and armed; next run ${nextRun}`;
    }
  })();
  const gap = daylightSavingGapWarning(schedule, definition.platform);
  const warnings = [
    ...(gap === undefined ? [] : [gap]),
    ...(definition.platform === "linux" && inspection.lingering === false
      ? [`the systemd user manager stops when you log out (Linger=no), so the job only runs while you are logged in; run \`loginctl enable-linger ${lingerUser()}\` to run it while logged out`]
      : []),
    ...(inspection.timezoneChangedSinceBoot && state !== "timezone-changed"
      ? [macosTimezoneRecovery]
      : []),
  ];
  return {
    state,
    platform: definition.platform,
    schedule,
    definition,
    detail,
    drift,
    timezone: resolvedScheduleTimezone(schedule),
    nextRun,
    overrides: inspection.overrides,
    effectiveCalendar: inspection.effectiveCalendar,
    lastNativeRun: inspection.lastResult,
    lingering: inspection.lingering,
    warnings,
  };
};

const snapshotsEqual = (
  left: ScheduleSnapshot,
  right: ScheduleSnapshot,
): boolean => JSON.stringify(left) === JSON.stringify(right);

export const scheduleManagerLayer: Layer.Layer<ScheduleManager, never, MachineState> =
  Layer.effect(
    ScheduleManager,
    Effect.gen(function*() {
      const machine = yield* MachineState;
      const verifyCustomExecutable = (
        rawPath: string,
      ): Effect.Effect<void, ScheduleManagerError> =>
        Effect.gen(function*() {
          // A custom --executable may be an npm wrapper with an env-based
          // shebang. Probe it under the same bounded PATH rendered into the
          // native unit before claiming success. The runtime's own directory
          // is included so user-managed Node installations keep working;
          // shell startup state is still excluded.
          // Windows is skipped: Task Scheduler launches absolute PE paths
          // with the user environment, so no PATH-resolved interpreter
          // stands between the unit and its runtime. Canonfig requires
          // Node >= 24 (engines).
          const probed = yield* machine.normalizePath({ path: rawPath });
          if (probed.platform === "windows") return;
          const nativePath = [...new Set([
            dirname(probed.absolute),
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
          ])].join(":");
          const probe = yield* machine.runProcess({
            executable: probed,
            arguments: ["--version"],
            environment: [{ name: "PATH", value: nativePath }],
            timeoutMilliseconds: 10_000,
            maximumOutputBytes: 64 * 1024,
          }).pipe(Effect.catch(() => Effect.succeed(null)));
          if (probe === null || probe.exitCode !== 0) {
            const detail = probe === null
              ? "did not start"
              : `exited with code ${probe.exitCode}`;
            return yield* new ScheduleHumanActionRequiredError({
              action: "install a scheduled sync whose executable runs under the native scheduler",
              recovery:
                `The custom executable ${probed.absolute} ${detail} with PATH=${nativePath} (native scheduler environment, Node >= 24 required). Retry without --executable to pin the running interpreter (${process.execPath} ${process.version}), or install Node >= 24 where the scheduler can see it.`,
            });
          }
        });

      const definition = Effect.fn("ScheduleManager.definition")(
        function*(input: SetScheduleInput = {}): Effect.fn.Return<
          {
            readonly schedule: NormalizedSyncSchedule;
            readonly definition: RenderedSchedulerJob;
          },
          ScheduleManagerError
        > {
          const schedule = yield* validateSchedule(input.schedule ?? defaultSyncSchedule);
          const command = scheduleCommand(input.executable);
          const executable = yield* machine.normalizePath({ path: command.executable });
          const calendar = yield* calendarFor(executable.platform, schedule);
          const rendered = yield* machine.renderSchedulerJob({
            name: "canonfig-sync",
            description: "Canonfig follower synchronization",
            executable,
            arguments: command.arguments,
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
          return statusFrom(desired.schedule, desired.definition, inspection);
        },
      );

      const snapshot = Effect.fn("ScheduleManager.snapshot")(
        function*(input: SetScheduleInput = {}): Effect.fn.Return<
          ScheduleSnapshot,
          ScheduleManagerError
        > {
          const desired = yield* definition(input);
          return yield* machine.snapshotSchedulerJob(desired.definition);
        },
      );

      const restore = Effect.fn("ScheduleManager.restore")(
        function*(
          input: SetScheduleInput | undefined,
          prior: ScheduleSnapshot,
        ): Effect.fn.Return<void, ScheduleManagerError> {
          const desired = yield* definition(input ?? {});
          if (
            prior.platform !== desired.definition.platform
            || prior.mechanism !== desired.definition.mechanism
            || prior.serviceName !== desired.definition.serviceName
          ) {
            return yield* new ScheduleVerificationError({
              operation: "restore",
              state: "invalid-snapshot",
              message: "native scheduler snapshot does not belong to this schedule",
            });
          }
          yield* machine.restoreSchedulerJob(desired.definition, prior);
          const after = yield* machine.snapshotSchedulerJob(desired.definition);
          if (!snapshotsEqual(after, prior)) {
            return yield* new ScheduleVerificationError({
              operation: "restore",
              state: after.state,
              message: "native scheduler did not restore its exact prior state",
            });
          }
        },
      );

      const upsert = Effect.fn("ScheduleManager.upsert")(
        function*(input: SetScheduleInput = {}): Effect.fn.Return<
          ScheduleChange,
          ScheduleManagerError
        > {
          if (input.executable !== undefined) {
            yield* verifyCustomExecutable(input.executable);
          }
          const desired = yield* definition(input);
          const inspection = yield* machine.inspectSchedulerJob(desired.definition);
          const before = statusFrom(desired.schedule, desired.definition, inspection);
          if (inspection.timezoneChangedSinceBoot) {
            return yield* new ScheduleHumanActionRequiredError({
              action: "arm the macOS schedule after a timezone change",
              recovery: macosTimezoneRecovery,
            });
          }
          if (before.state === "current") return { change: "unchanged", status: before };
          // Rewriting the unit cannot undo a drop-in: the job would stay
          // overridden while the command claimed success.
          if (before.state === "overridden") {
            return yield* new ScheduleHumanActionRequiredError({
              action: "install the Canonfig scheduled synchronization",
              recovery: before.detail,
            });
          }
          // A stopped, disabled, or deleted job is restored here: an explicit
          // install is the user's decision, unlike the post-apply reconciler.
          yield* machine.installSchedulerJob(desired.definition);
          const after = statusFrom(
            desired.schedule,
            desired.definition,
            yield* machine.inspectSchedulerJob(desired.definition),
          );
          if (after.state !== "current") {
            return yield* new ScheduleVerificationError({
              operation: before.state === "not-installed" ? "install" : "update",
              state: after.state,
              message: `native scheduler did not converge to the requested definition: ${after.detail}`,
            });
          }
          return {
            change: before.state === "not-installed" ? "installed" : "updated",
            status: after,
          };
        },
      );

      /**
       * The post-apply reconciler. It re-renders drift in a job that is armed,
       * and leaves anything the user did outside Canonfig as is: a deleted,
       * disabled, stopped, or overridden job is reported, never recreated or
       * re-enabled behind the user's back.
       */
      const reconcile = Effect.fn("ScheduleManager.reconcile")(
        function*(input: SetScheduleInput = {}): Effect.fn.Return<
          ScheduleReconciliation,
          ScheduleManagerError
        > {
          const before = yield* inspect(input);
          if (before.state === "current") return { action: "unchanged", status: before };
          if (before.state !== "drifted") return { action: "left-as-is", status: before };
          const updated = yield* upsert(input);
          return { action: "updated", status: updated.status };
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
              state: stateOf(after),
              message: "native scheduler still reports the schedule as installed",
            });
          }
          return { change: "removed" };
        },
      );

      return ScheduleManager.of({
        install: upsert,
        inspect,
        snapshot,
        restore,
        update: upsert,
        reconcile,
        status: inspect,
        remove,
      });
    }),
  );
