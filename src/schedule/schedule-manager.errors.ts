import { Schema } from "effect";

import type { MachineStateError } from "../machine/machine-state.errors.ts";

export class InvalidScheduleError extends Schema.TaggedError<InvalidScheduleError>()(
  "InvalidScheduleError",
  {
    field: Schema.String,
    message: Schema.String,
  },
) {}

export class ScheduleHumanActionRequiredError
  extends Schema.TaggedError<ScheduleHumanActionRequiredError>()(
    "ScheduleHumanActionRequiredError",
    {
      action: Schema.String,
      recovery: Schema.String,
    },
  ) {}

export class ScheduleVerificationError
  extends Schema.TaggedError<ScheduleVerificationError>()(
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
