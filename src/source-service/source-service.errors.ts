import { Schema } from "effect";
import { TaggedError } from "../domain/tagged-error.ts";

import type { MachineStateError } from "../machine/machine-state.errors.ts";

/** The requested service cannot be expressed on this machine (bad input or environment). */
export class SourceServiceConfigurationError
  extends TaggedError<SourceServiceConfigurationError>()(
    "SourceServiceConfigurationError",
    {
      operation: Schema.String,
      message: Schema.String,
    },
  ) {}

/**
 * The native service manager could not be reached or refused the request.
 * `message` names the manager and says what the operator has to do, such as
 * logging in or enabling linger when there is no user session bus.
 */
export class SourceServiceManagerError extends TaggedError<SourceServiceManagerError>()(
  "SourceServiceManagerError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

/** The manager accepted the service, but it is not serving the Source identity. */
export class SourceServiceVerificationError
  extends TaggedError<SourceServiceVerificationError>()(
    "SourceServiceVerificationError",
    {
      operation: Schema.String,
      state: Schema.String,
      message: Schema.String,
    },
  ) {}

export type SourceServiceError =
  | SourceServiceConfigurationError
  | SourceServiceManagerError
  | SourceServiceVerificationError
  | MachineStateError;
