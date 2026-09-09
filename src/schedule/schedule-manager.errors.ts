import { Schema } from "effect";
import { TaggedError } from "../domain/tagged-error.ts";

import type { MachineStateError } from "../machine/machine-state.errors.ts";

export class InvalidScheduleError extends TaggedError<InvalidScheduleError>()(
  "InvalidScheduleError",
  {
    field: Schema.String,
    message: Schema.String,
  },
) {}

export class ScheduleHumanActionRequiredError
  extends TaggedError<ScheduleHumanActionRequiredError>()(
    "ScheduleHumanActionRequiredError",
    {
      action: Schema.String,
      recovery: Schema.String,
    },
  ) {}

export class ScheduleVerificationError
  extends TaggedError<ScheduleVerificationError>()(
    "ScheduleVerificationError",
    {
      operation: Schema.String,
      state: Schema.String,
      message: Schema.String,
    },
  ) {}

export type ScheduleManagerError =
  | InvalidScheduleError
  | ScheduleHumanActionRequiredError
  | ScheduleVerificationError
  | MachineStateError;
