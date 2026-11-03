import { Context, type Effect } from "effect";

import type {
  CliCommandFailure,
  CliPayload,
} from "./source-commands.ts";

/**
 * The Source setup import request. `offer` (the default) lists what each
 * selected harness holds without importing; `none` does not read the
 * harnesses at all; `some` names harnesses or single item ids.
 */
export type SetupImportRequest =
  | { readonly kind: "offer" }
  | { readonly kind: "none" }
  | { readonly kind: "all" }
  | { readonly kind: "some"; readonly requested: ReadonlyArray<string> };

export interface SetupPlanCommandInput {
  readonly role: string;
  readonly scope?: string | undefined;
  readonly mode?: string | undefined;
  readonly files: ReadonlyArray<string>;
  readonly intent?: string | undefined;
  readonly harnesses?: ReadonlyArray<string> | undefined;
  readonly imports: SetupImportRequest;
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
