import { Context, type Effect } from "effect";

import type {
  CliCommandFailure,
  CliPayload,
} from "./source-commands.ts";

export interface SetupPlanCommandInput {
  readonly role: string;
  readonly files: ReadonlyArray<string>;
  readonly intent?: string | undefined;
}

export interface SetupApproveCommandInput {
  readonly approver: string;
}

export interface SetupCommandsService {
  readonly plan: (
    input: SetupPlanCommandInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly approve: (
    input: SetupApproveCommandInput,
  ) => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly apply: () => Effect.Effect<CliPayload, CliCommandFailure>;
  readonly status: () => Effect.Effect<CliPayload, CliCommandFailure>;
}

export class SetupCommands extends Context.Service<
  SetupCommands,
  SetupCommandsService
>()("canonfig/cli/SetupCommands") {}
