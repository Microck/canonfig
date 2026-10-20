import { Cause } from "effect";
import { CliExitCode } from "../cli/exit-codes.ts";
import type { CliResult } from "../cli/render.ts";
import { StateInitializationError } from "./state-initialization.errors.ts";

/** Keep diagnostics opt-in and inside the normal redacted output envelope. */
export const runtimeFailureResult = (
  cause: Cause.Cause<unknown>,
  command: string,
  debug: boolean,
): CliResult => {
  const error = Cause.squash(cause);
  const storageFailure = error instanceof StateInitializationError;
  return {
    command,
    message: storageFailure
      ? error.message
      : "Canonfig could not initialize or complete this command due to an internal error.",
    exitCode: storageFailure ? CliExitCode.humanActionRequired : CliExitCode.internal,
    data: debug && !storageFailure ? { diagnostic: Cause.pretty(cause) } : undefined,
  };
};
