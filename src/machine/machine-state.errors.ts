import { Schema } from "effect";
import { TaggedError } from "../domain/tagged-error.ts";

export class InvalidMachinePathError extends TaggedError<InvalidMachinePathError>()(
  "InvalidMachinePathError",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class MachineFilesystemError extends TaggedError<MachineFilesystemError>()(
  "MachineFilesystemError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class FileSizeLimitError extends TaggedError<FileSizeLimitError>()(
  "FileSizeLimitError",
  {
    path: Schema.String,
    maximumBytes: Schema.Number,
  },
) {}

export class ExecutableNotFoundError extends TaggedError<ExecutableNotFoundError>()(
  "ExecutableNotFoundError",
  {
    name: Schema.String,
  },
) {}

export class ProcessStartError extends TaggedError<ProcessStartError>()(
  "ProcessStartError",
  {
    executable: Schema.String,
    message: Schema.String,
  },
) {}

export class ProcessTimeoutError extends TaggedError<ProcessTimeoutError>()(
  "ProcessTimeoutError",
  {
    executable: Schema.String,
    timeoutMilliseconds: Schema.Number,
  },
) {}

export class ProcessOutputLimitError extends TaggedError<ProcessOutputLimitError>()(
  "ProcessOutputLimitError",
  {
    executable: Schema.String,
    maximumOutputBytes: Schema.Number,
  },
) {}

export class HumanActionRequiredError extends TaggedError<HumanActionRequiredError>()(
  "HumanActionRequiredError",
  {
    action: Schema.String,
    recovery: Schema.String,
  },
) {}

export class CredentialStorageError extends TaggedError<CredentialStorageError>()(
  "CredentialStorageError",
  {
    operation: Schema.String,
    reference: Schema.String,
    message: Schema.String,
  },
) {}

export class InvalidSchedulerJobError extends TaggedError<InvalidSchedulerJobError>()(
  "InvalidSchedulerJobError",
  {
    field: Schema.String,
    message: Schema.String,
  },
) {}

export type MachineStateError =
  | InvalidMachinePathError
  | MachineFilesystemError
  | FileSizeLimitError
  | ExecutableNotFoundError
  | ProcessStartError
  | ProcessTimeoutError
  | ProcessOutputLimitError
  | HumanActionRequiredError
  | CredentialStorageError
  | InvalidSchedulerJobError;
