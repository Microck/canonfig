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

const redact = (value: CliPayload, secrets: ReadonlyArray<string> = []): CliPayload => {
  if (Array.isArray(value)) {
    return Schema.is(StringArray)(value)
      ? redactArguments(value, secrets)
      : value.map((entry) => redact(entry, secrets));
  }
  if (Schema.is(Schema.String)(value)) return redactText(value, secrets);
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
        : redact(entry, secrets),
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

/**
 * Values carried under a secret name are scrubbed everywhere in the same
 * output, so a value that also appears under an arbitrary name, in a URL,
 * or in free text does not leak through a non-secret-shaped field.
 */
const collectSecretValues = (value: CliPayload): Array<string> => {
  if (Array.isArray(value)) return value.flatMap(collectSecretValues);
  if (Schema.is(Schema.String)(value)) return [];
  if (value === null || Schema.is(Schema.Number)(value) || Schema.is(Schema.Boolean)(value)) return [];
  const found: Array<string> = [];
  const namedSecret = "name" in value
    && Schema.is(Schema.String)(value.name)
    && isSecretField(value.name);
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (
      Schema.is(Schema.String)(entry)
      && (isSecretField(key) || (namedSecret && key === "value"))
      && entry !== "[REDACTED]"
    ) found.push(entry);
    else found.push(...collectSecretValues(entry));
  }
  return found;
};

const knownSecretsFor = (
  data: CliPayload | undefined,
  secrets: ReadonlyArray<string>,
): Array<string> => [
  ...(data === undefined ? [] : collectSecretValues(data)),
  ...secrets,
];

export const sanitizeCliData = (
  value: CliPayload,
  secrets: ReadonlyArray<string> = [],
): CliPayload => {
  const known = [...collectSecretValues(value), ...secrets];
  return ordered(redact(value, known));
};

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
  secrets: ReadonlyArray<string> = [],
): string => {
  const known = knownSecretsFor(result.data, secrets);
  const data = result.data === undefined
    ? undefined
    : sanitizeCliData(result.data, secrets);
  const message = redactText(result.message, known);
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
