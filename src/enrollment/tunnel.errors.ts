import { Schema } from "effect";
import { TaggedError } from "../domain/tagged-error.ts";

export class TunnelConfigurationError extends TaggedError<TunnelConfigurationError>()(
  "TunnelConfigurationError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export class TunnelHostKeyError extends TaggedError<TunnelHostKeyError>()(
  "TunnelHostKeyError",
  {
    host: Schema.String,
    message: Schema.String,
  },
) {}

export class TunnelHostKeyBypassError extends TaggedError<TunnelHostKeyBypassError>()(
  "TunnelHostKeyBypassError",
  {
    flag: Schema.String,
    message: Schema.String,
  },
) {}

export class TunnelReadinessError extends TaggedError<TunnelReadinessError>()(
  "TunnelReadinessError",
  {
    endpoint: Schema.String,
    message: Schema.String,
  },
) {}

export class TunnelProcessError extends TaggedError<TunnelProcessError>()(
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
