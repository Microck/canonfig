import { Schema } from "effect";

export class TunnelConfigurationError extends Schema.TaggedError<TunnelConfigurationError>()(
  "TunnelConfigurationError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export class TunnelHostKeyError extends Schema.TaggedError<TunnelHostKeyError>()(
  "TunnelHostKeyError",
  {
    host: Schema.String,
    message: Schema.String,
  },
) {}

export class TunnelHostKeyBypassError extends Schema.TaggedError<TunnelHostKeyBypassError>()(
  "TunnelHostKeyBypassError",
  {
    flag: Schema.String,
    message: Schema.String,
  },
) {}

export class TunnelReadinessError extends Schema.TaggedError<TunnelReadinessError>()(
  "TunnelReadinessError",
  {
    endpoint: Schema.String,
    message: Schema.String,
  },
) {}

export class TunnelProcessError extends Schema.TaggedError<TunnelProcessError>()(
  "TunnelProcessError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export type TunnelError =
  | TunnelConfigurationError
  | TunnelHostKeyError
  | TunnelHostKeyBypassError
  | TunnelReadinessError
  | TunnelProcessError;
