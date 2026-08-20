import { Schema } from "effect";

export class InvalidAgentTaskError extends Schema.TaggedError<InvalidAgentTaskError>()(
  "InvalidAgentTaskError",
  {
    task: Schema.String,
    message: Schema.String,
  },
) {}

export class UnsupportedHarnessError extends Schema.TaggedError<UnsupportedHarnessError>()(
  "UnsupportedHarnessError",
  { harness: Schema.String },
) {}

export class DeniedAgentCapabilityError extends Schema.TaggedError<DeniedAgentCapabilityError>()(
  "DeniedAgentCapabilityError",
  {
    capability: Schema.String,
    value: Schema.String,
  },
) {}

export class AgentInputLimitError extends Schema.TaggedError<AgentInputLimitError>()(
  "AgentInputLimitError",
  {
    actualBytes: Schema.Number,
    maximumBytes: Schema.Number,
  },
) {}

export class AgentExecutionTimeoutError extends Schema.TaggedError<AgentExecutionTimeoutError>()(
  "AgentExecutionTimeoutError",
  {
    executable: Schema.String,
    timeoutMilliseconds: Schema.Number,
  },
) {}

export class AgentExecutionCancelledError extends Schema.TaggedError<AgentExecutionCancelledError>()(
  "AgentExecutionCancelledError",
  { executable: Schema.String },
) {}

export class AgentOutputLimitError extends Schema.TaggedError<AgentOutputLimitError>()(
  "AgentOutputLimitError",
  {
    executable: Schema.String,
    maximumBytes: Schema.Number,
  },
) {}

export class AgentProcessError extends Schema.TaggedError<AgentProcessError>()(
  "AgentProcessError",
  {
    executable: Schema.String,
    message: Schema.String,
  },
) {}

export class InvalidAgentResponseError extends Schema.TaggedError<InvalidAgentResponseError>()(
  "InvalidAgentResponseError",
  { message: Schema.String },
) {}

export class AgentVerificationError extends Schema.TaggedError<AgentVerificationError>()(
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
