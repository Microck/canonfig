import { Schema } from "effect";

export class InvalidMachinePathError extends Schema.TaggedError<InvalidMachinePathError>()(
  "InvalidMachinePathError",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class MachineFilesystemError extends Schema.TaggedError<MachineFilesystemError>()(
  "MachineFilesystemError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class FileSizeLimitError extends Schema.TaggedError<FileSizeLimitError>()(
  "FileSizeLimitError",
  {
    path: Schema.String,
    maximumBytes: Schema.Number,
  },
) {}

export class ExecutableNotFoundError extends Schema.TaggedError<ExecutableNotFoundError>()(
  "ExecutableNotFoundError",
  {
    name: Schema.String,
  },
) {}

export class ProcessStartError extends Schema.TaggedError<ProcessStartError>()(
  "ProcessStartError",
  {
    executable: Schema.String,
    message: Schema.String,
  },
) {}

export class ProcessTimeoutError extends Schema.TaggedError<ProcessTimeoutError>()(
  "ProcessTimeoutError",
  {
    executable: Schema.String,
    timeoutMilliseconds: Schema.Number,
  },
) {}

export class ProcessOutputLimitError extends Schema.TaggedError<ProcessOutputLimitError>()(
  "ProcessOutputLimitError",
  {
    executable: Schema.String,
    maximumOutputBytes: Schema.Number,
  },
) {}

export class HumanActionRequiredError extends Schema.TaggedError<HumanActionRequiredError>()(
  "HumanActionRequiredError",
  {
    action: Schema.String,
    recovery: Schema.String,
  },
) {}

export class CredentialStorageError extends Schema.TaggedError<CredentialStorageError>()(
  "CredentialStorageError",
  {
    operation: Schema.String,
    reference: Schema.String,
    message: Schema.String,
  },
) {}

export class InvalidSchedulerJobError extends Schema.TaggedError<InvalidSchedulerJobError>()(
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
