import { Effect, Layer, Schema } from "effect";

import { describeRuntimeError } from "../cli/failure-taxonomy.ts";
import {
  CliCommandFailure,
  type CliPayload,
} from "../cli/source-commands.ts";
import { SetupCommands } from "../cli/setup-commands.ts";
import { Enrollment } from "../enrollment/enrollment.service.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import {
  applySetup,
  approveSetup,
  planSetup,
  setupJournalPath,
  setupStatus,
  type SetupStatus,
} from "./setup.controller.ts";
import { SetupError } from "./setup.errors.ts";
import type { SetupJournal } from "./setup.types.ts";

const toPayload = (value: SetupJournal | SetupStatus): CliPayload =>
  Schema.decodeUnknownSync(Schema.MutableJson)(
    JSON.parse(JSON.stringify(value)),
  );

const setupFailure = (error: SetupError): CliCommandFailure => {
  const described = describeRuntimeError(error);
  return new CliCommandFailure({
    category: described.category,
    message: described.message,
  });
};

/**
 * The setup command graph. Only the local machine state and enrollment take
 * part: no agent adapters are required, so known recipes complete with the
 * outer agent unavailable.
 */
export const setupCommandsLayer = (
  statePath: string,
): Layer.Layer<SetupCommands, never, MachineState | Enrollment> =>
  Layer.effect(
    SetupCommands,
    Effect.gen(function*() {
      const machine = yield* MachineState;
      const enrollment = yield* Enrollment;
      const journalPath = setupJournalPath(statePath);
      const run = (
        effect: Effect.Effect<SetupJournal, SetupError, MachineState | Enrollment>,
      ): Effect.Effect<CliPayload, CliCommandFailure> =>
        effect.pipe(
          Effect.provideService(MachineState, machine),
          Effect.provideService(Enrollment, enrollment),
          Effect.mapBoth({
            onFailure: setupFailure,
            onSuccess: (value) => toPayload(value),
          }),
        );
      return SetupCommands.of({
        plan: (input) => run(planSetup({
          roleText: input.role,
          files: input.files,
          intent: input.intent,
        }, journalPath)),
        approve: (input) => run(approveSetup(input.approver, journalPath)),
        apply: () => run(applySetup(journalPath)),
        status: () =>
          setupStatus(journalPath).pipe(
            Effect.provideService(MachineState, machine),
            Effect.mapBoth({ onFailure: setupFailure, onSuccess: (value) => toPayload(value) }),
          ),
      });
    }),
  );
