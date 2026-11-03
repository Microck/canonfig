import { Schema } from "effect";

import type { CliIo } from "./cli.ts";
import { CliExitCode, type CliExitCode as CliExitCodeValue } from "./exit-codes.ts";
import { renderCliResult } from "./render.ts";
import { redactText } from "./redaction.ts";
import type { CliPayload } from "./source-commands.ts";

// Output helpers for commands that run outside the Effect CLI tree
// (`skills`, `self-update`) but still emit the
// shared `canonfig.cli/v1` envelope.

export const toCliPayload = <Value>(value: Value): CliPayload =>
  Schema.decodeUnknownSync(Schema.MutableJson)(
    JSON.parse(JSON.stringify(value)),
  );

/** Render one result to stdout on success or stderr otherwise, then set the exit code. */
export const renderCommandResult = (
  io: CliIo,
  input: {
    readonly command: string;
    readonly message: string;
    readonly data?: CliPayload | undefined;
    readonly exitCode: CliExitCodeValue;
    readonly json: boolean;
    readonly human?: string | undefined;
  },
): void => {
  const rendered = input.json
    ? renderCliResult({
      command: input.command,
      message: input.message,
      data: input.data,
      exitCode: input.exitCode,
    }, "json")
    : (input.human === undefined ? renderCliResult({
      command: input.command,
      message: input.message,
      data: input.data,
      exitCode: input.exitCode,
    }, "human") : redactText(input.human));
  if (input.exitCode === CliExitCode.success) io.writeStdout(rendered);
  else io.writeStderr(rendered);
  io.setExitCode(input.exitCode);
};

/**
 * Map a `CanonfigError` code to the CLI exit-code taxonomy by its naming
 * convention. `undefined` (any other thrown value) is an internal defect.
 */
export const commandFailureExitCode = (code: string | undefined): CliExitCodeValue => {
  if (code === undefined) return CliExitCode.internal;
  if (/CONFLICT|COLLISION|EDITED|ESCAPE|STALE/u.test(code)) {
    return CliExitCode.conflictOrDrift;
  }
  if (/APPLY|WRITE|ROLLBACK/u.test(code)) {
    return CliExitCode.verificationOrApplyFailure;
  }
  if (/INVALID|NOT_ALLOWED|NOT_FOUND|UNKNOWN|REQUIRED|EMPTY|PARSE/u.test(code)) {
    return CliExitCode.usageOrConfiguration;
  }
  return CliExitCode.internal;
};
