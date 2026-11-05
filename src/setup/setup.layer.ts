import { Effect, Layer, Schema } from "effect";

import { describeRuntimeError } from "../cli/failure-taxonomy.ts";
import {
  CliCommandFailure,
  type CliPayload,
} from "../cli/source-commands.ts";
import { SetupCommands } from "../cli/setup-commands.ts";
import { Enrollment } from "../enrollment/enrollment.service.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { StateRepository } from "../state/state-repository.service.ts";
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
 * The setup command graph. Only the local machine state, enrollment and the
 * state database (harness takeovers) take part: no agent adapters are
 * required, so known recipes complete with the outer agent unavailable.
 */
export const setupCommandsLayer = (
  statePath: string,
): Layer.Layer<SetupCommands, never, MachineState | Enrollment | StateRepository> =>
  Layer.effect(
    SetupCommands,
    Effect.gen(function*() {
      const machine = yield* MachineState;
      const enrollment = yield* Enrollment;
      const repository = yield* StateRepository;
      const journalPath = setupJournalPath(statePath);
      const environment = (name: string) => process.env[name];
      const run = (
        effect: Effect.Effect<SetupJournal, SetupError, MachineState | Enrollment | StateRepository>,
      ): Effect.Effect<CliPayload, CliCommandFailure> =>
        effect.pipe(
          Effect.provideService(MachineState, machine),
          Effect.provideService(Enrollment, enrollment),
          Effect.provideService(StateRepository, repository),
          Effect.mapBoth({
            onFailure: setupFailure,
            onSuccess: (value) => toPayload(value),
          }),
        );
      return SetupCommands.of({
        plan: (input) => run(planSetup({
          roleText: input.role,
          scopeText: input.scope,
          modeText: input.mode,
          files: input.files,
          intent: input.intent,
          harnesses: input.harnesses,
          imports: input.imports,
          environment,
        }, journalPath)),
        approve: (input) => run(approveSetup(input.approver, journalPath)),
        apply: () => run(applySetup(journalPath, environment)),
        status: () =>
          setupStatus(journalPath).pipe(
            Effect.provideService(MachineState, machine),
            Effect.mapBoth({ onFailure: setupFailure, onSuccess: (value) => toPayload(value) }),
          ),
      });
    }),
  );
