import { Schema } from "effect";
import { TaggedError } from "../domain/tagged-error.ts";

export class InvalidAgentTaskError extends TaggedError<InvalidAgentTaskError>()(
  "InvalidAgentTaskError",
  {
    task: Schema.String,
    message: Schema.String,
  },
) {}

export class UnsupportedHarnessError extends TaggedError<UnsupportedHarnessError>()(
  "UnsupportedHarnessError",
  { harness: Schema.String },
) {}

export class DeniedAgentCapabilityError extends TaggedError<DeniedAgentCapabilityError>()(
  "DeniedAgentCapabilityError",
  {
    capability: Schema.String,
    value: Schema.String,
  },
) {}

export class AgentInputLimitError extends TaggedError<AgentInputLimitError>()(
  "AgentInputLimitError",
  {
    actualBytes: Schema.Number,
    maximumBytes: Schema.Number,
  },
) {}

export class AgentExecutionTimeoutError extends TaggedError<AgentExecutionTimeoutError>()(
  "AgentExecutionTimeoutError",
  {
    executable: Schema.String,
    timeoutMilliseconds: Schema.Number,
  },
) {}

export class AgentExecutionCancelledError extends TaggedError<AgentExecutionCancelledError>()(
  "AgentExecutionCancelledError",
  { executable: Schema.String },
) {}

export class AgentOutputLimitError extends TaggedError<AgentOutputLimitError>()(
  "AgentOutputLimitError",
  {
    executable: Schema.String,
    maximumBytes: Schema.Number,
  },
) {}

export class AgentProcessError extends TaggedError<AgentProcessError>()(
  "AgentProcessError",
  {
    executable: Schema.String,
    message: Schema.String,
  },
) {}

export class InvalidAgentResponseError extends TaggedError<InvalidAgentResponseError>()(
  "InvalidAgentResponseError",
  { message: Schema.String },
) {}

export class AgentVerificationError extends TaggedError<AgentVerificationError>()(
  "AgentVerificationError",
  {
    command: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

export type AgentResolutionError =
  | InvalidAgentTaskError
  | UnsupportedHarnessError
  | DeniedAgentCapabilityError
  | AgentInputLimitError
  | AgentExecutionTimeoutError
  | AgentExecutionCancelledError
  | AgentOutputLimitError
  | AgentProcessError
  | InvalidAgentResponseError
  | AgentVerificationError;
