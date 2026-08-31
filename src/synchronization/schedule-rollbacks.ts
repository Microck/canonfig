import { Effect, Schema } from "effect";

import type { RunId } from "../domain/brand.ts";
import type { PlannedAction } from "../domain/synchronization.ts";
import type { MachineStateError } from "../machine/machine-state.errors.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import type { MachinePath } from "../machine/machine-state.types.ts";
import { sha256Hex } from "../profile/profile-codec.ts";
import type { ScheduleManagerError } from "../schedule/schedule-manager.errors.ts";
import type { ScheduleManager } from "../schedule/schedule-manager.service.ts";
import type { SetScheduleInput } from "../schedule/schedule-manager.types.ts";
import {
  InvalidExecutionPlanError,
  type SynchronizationExecutionInputError,
} from "./synchronization.errors.ts";

interface ScheduleRollbackContext {
  readonly run: RunId;
  readonly action: Pick<PlannedAction, "id">;
}

const SchedulerSnapshotSchema = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("absent"),
    platform: Schema.Literals(["linux", "macos", "windows"]),
    mechanism: Schema.Literals([
      "systemd-user-timer",
      "launchd-user-agent",
      "task-scheduler",
    ]),
    serviceName: Schema.NonEmptyString,
  }),
  Schema.Struct({
    state: Schema.Literal("present"),
    platform: Schema.Literals(["linux", "macos", "windows"]),
    mechanism: Schema.Literals([
      "systemd-user-timer",
      "launchd-user-agent",
      "task-scheduler",
    ]),
    serviceName: Schema.NonEmptyString,
    enabled: Schema.Boolean,
    active: Schema.optional(Schema.Boolean),
    servicePresent: Schema.Boolean,
    schedulePresent: Schema.Boolean,
    service: Schema.optional(Schema.String),
    schedule: Schema.optional(Schema.String),
    serviceMode: Schema.optional(Schema.Int),
    scheduleMode: Schema.optional(Schema.Int),
    native: Schema.optional(Schema.String),
  }),
]);

const scheduleRollbackReference = (
  context: ScheduleRollbackContext,
): Effect.Effect<
  {
    readonly directory: MachinePath;
    readonly reference: MachinePath;
  },
  SynchronizationExecutionInputError | MachineStateError,
  MachineState
> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const directories = yield* machine.userDirectories();
    const directory = yield* machine.normalizePath({
      path: `canonfig/rollback/${context.run}`,
      base: directories.cache,
    });
    const reference = yield* machine.normalizePath({
      path: `${sha256Hex(context.action.id)}.schedule.json`,
      base: directory,
    });
    return { directory, reference };
  });

/** Capture exact native scheduler state before any schedule action mutates it. */
export const captureScheduleRollback = (
  context: ScheduleRollbackContext,
  scheduleManager: ScheduleManager["Service"],
  input?: SetScheduleInput | undefined,
): Effect.Effect<
  {
    readonly reference: string;
    readonly restore: Effect.Effect<void, ScheduleManagerError | MachineStateError, MachineState>;
  },
  SynchronizationExecutionInputError | MachineStateError | ScheduleManagerError,
  MachineState
> =>
  Effect.gen(function*() {
    const rollback = yield* scheduleRollbackReference(context);
    const snapshot = yield* scheduleManager.snapshot(input);
    const machine = yield* MachineState;
    yield* machine.ensureDirectory({ path: rollback.directory });
    yield* machine.atomicWrite({
      path: rollback.reference,
      content: new TextEncoder().encode(JSON.stringify(snapshot)),
    });
    return {
      reference: rollback.reference.absolute,
      restore: scheduleManager.restore(input, snapshot),
    };
  });

/** Restore a persisted native scheduler snapshot owned by this action. */
export const restoreScheduleRollbackReference = (
  context: ScheduleRollbackContext,
  reference: string,
  scheduleManager: ScheduleManager["Service"],
  input?: SetScheduleInput | undefined,
): Effect.Effect<
  void,
  SynchronizationExecutionInputError | MachineStateError | ScheduleManagerError,
  MachineState
> =>
  Effect.gen(function*() {
    const expected = yield* scheduleRollbackReference(context);
    const machine = yield* MachineState;
    const actual = yield* machine.normalizePath({ path: reference });
    if (actual.absolute !== expected.reference.absolute) {
      return yield* new InvalidExecutionPlanError({
        message: `schedule rollback reference does not belong to action ${context.action.id}`,
      });
    }
    const bytes = yield* machine.readFile({
      path: actual,
      maximumBytes: 16 * 1024 * 1024,
    });
    const snapshot = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(SchedulerSnapshotSchema),
    )(new TextDecoder().decode(bytes)).pipe(
      Effect.mapError((error) =>
        new InvalidExecutionPlanError({
          message: `invalid schedule rollback material for action ${context.action.id}: ${String(error)}`,
        })
      ),
    );
    yield* scheduleManager.restore(input, snapshot);
  });
