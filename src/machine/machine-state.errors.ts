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

/**
 * `executable` rather than `name`: a field named `name` shadows `Error.name`,
 * which rendered this error as the bare executable (`ruff: name="ruff"`).
 * `searched` lists every directory tried, in order.
 */
export class ExecutableNotFoundError extends TaggedError<ExecutableNotFoundError>()(
  "ExecutableNotFoundError",
  {
    executable: Schema.String,
    searched: Schema.Array(Schema.String),
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

/**
 * A filesystem cannot hold what an operation is about to write. Raised before
 * anything is written: by the disk preflight of a run (for each target's
 * filesystem and the rollback cache) and before a blob download, and for an
 * ENOSPC that still happens while writing the transport cache.
 */
export class InsufficientDiskError extends TaggedError<InsufficientDiskError>()(
  "InsufficientDiskError",
  {
    path: Schema.String,
    requiredBytes: Schema.BigInt,
    availableBytes: Schema.BigInt,
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

/**
 * The operator-facing cause and next step of a failed native credential-store
 * operation. Credential stores fail for local reasons (no session bus, a
 * locked keyring or Keychain, a missing client tool), so callers that report
 * the failure keep this text instead of blaming the Source Machine.
 */
export const credentialFailureDetail = (error: MachineStateError): string => {
  switch (error._tag) {
    case "HumanActionRequiredError":
      return `${error.action}: ${error.recovery}`;
    case "CredentialStorageError":
      return error.message;
    case "ProcessTimeoutError":
      return `the credential store command ${error.executable} did not answer within ${error.timeoutMilliseconds} ms; a locked keyring or Keychain may be waiting for an unlock prompt that this session cannot show`;
    case "ProcessStartError":
      return `the credential store command ${error.executable} could not start: ${error.message}`;
    case "ExecutableNotFoundError":
      return `the credential store command could not be found: ${error.message}`;
    default:
      return error.message;
  }
};
