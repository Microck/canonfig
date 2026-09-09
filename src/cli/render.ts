import { Schema } from "effect";

import { CliExitCode } from "./exit-codes.ts";
import { isSecretField, redactArguments, redactText } from "./redaction.ts";
import type { CliPayload } from "./source-commands.ts";

export type CliOutputFormat = "human" | "json";

export interface CliResult {
  readonly command: string;
  readonly message: string;
  readonly data?: CliPayload | undefined;
  readonly exitCode: CliExitCode;
}

interface RenderEnvelope {
  schema: string;
  command: string;
  status: string;
  exitCode: CliExitCode;
  message: string;
  data?: CliPayload | undefined;
}

/** An argv-shaped array: every entry is a string, so flag pairs stay recognizable. */
const StringArray = Schema.Array(Schema.String);

const redact = (value: CliPayload): CliPayload => {
  if (Array.isArray(value)) {
    return Schema.is(StringArray)(value)
      ? redactArguments(value)
      : value.map(redact);
  }
  if (Schema.is(Schema.String)(value)) return redactText(value);
  if (
    value === null
    || Schema.is(Schema.Number)(value)
    || Schema.is(Schema.Boolean)(value)
  ) return value;
  const result: { [key: string]: CliPayload | undefined } = {};
  const namedSecret = "name" in value
    && Schema.is(Schema.String)(value.name)
    && isSecretField(value.name);
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    Object.defineProperty(result, key, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: isSecretField(key) || (namedSecret && key === "value")
        ? "[REDACTED]"
        : redact(entry),
    });
  }
  return result;
};

const ordered = (value: CliPayload): CliPayload => {
  if (Array.isArray(value)) return value.map(ordered);
  if (
    value === null
    || Schema.is(Schema.String)(value)
    || Schema.is(Schema.Number)(value)
    || Schema.is(Schema.Boolean)(value)
  ) return value;
  const result: { [key: string]: CliPayload | undefined } = {};
  for (
    const [key, entry] of Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
  ) {
    if (entry === undefined) continue;
    Object.defineProperty(result, key, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: ordered(entry),
    });
  }
  return result;
};

export const sanitizeCliData = (value: CliPayload): CliPayload =>
  ordered(redact(value));

/**
 * Renders a usage failure in the requested format.
 *
 * Usage failures used to print two human lines whatever the output mode, so a
 * program driving Canonfig with `--json` got unparseable text for the whole
 * class of parse errors while every post-parse failure was a proper envelope.
 * The help hint is presentation, so it is added only for human output and never
 * becomes part of the envelope's message.
 */
export const renderUsageFailure = (
  message: string,
  format: CliOutputFormat,
): string => {
  const rendered = renderCliResult({
    command: "usage",
    message,
    exitCode: CliExitCode.usageOrConfiguration,
  }, format);
  return format === "json"
    ? rendered
    : `${rendered}Run 'canonfig --help' for usage.\n`;
};

export const renderCliResult = (
  result: CliResult,
  format: CliOutputFormat,
): string => {
  const data = result.data === undefined
    ? undefined
    : sanitizeCliData(result.data);
  const message = redactText(result.message);
  if (format === "json") {
    const envelope: RenderEnvelope = {
      schema: "canonfig.cli/v1",
      command: result.command,
      status: result.exitCode === 0 ? "success" : "error",
      exitCode: result.exitCode,
      message,
    };
    if (data !== undefined) envelope.data = data;
    return `${JSON.stringify(envelope)}\n`;
  }
  if (data === undefined) return `${message}\n`;
  return `${message}\n${JSON.stringify(data, null, 2)}\n`;
};
