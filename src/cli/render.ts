import { Schema } from "effect";

import { CliExitCode } from "./exit-codes.ts";
import { renderHumanSummary } from "./human-summary.ts";
import { isEnvironmentReference, isSecretField } from "../secrets/credential-policy.ts";
import { redactArguments, redactText } from "./redaction.ts";
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

type PayloadPath = ReadonlyArray<string | number>;
const isBindingReference = (path: PayloadPath, harnessBindings: boolean): boolean =>
  harnessBindings && path.length === 3 && path[0] === "secretBindings"
  && Schema.is(Schema.Number)(path[1]) && path[2] === "secret";

const redact = (value: CliPayload, secrets: ReadonlyArray<string> = [], harnessBindings = false, path: PayloadPath = []): CliPayload => {
  if (Array.isArray(value)) {
    return Schema.is(StringArray)(value)
      ? redactArguments(value, secrets)
      : value.map((entry, index) => redact(entry, secrets, harnessBindings, [...path, index]));
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
      value: !isBindingReference([...path, key], harnessBindings)
          && (isSecretField(key) || (namedSecret && key === "value"))
          && !(Schema.is(Schema.String)(entry) && isEnvironmentReference(entry))
        ? "[REDACTED]"
        : redact(entry, secrets, harnessBindings, [...path, key]),
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
const collectSecretValues = (value: CliPayload, harnessBindings = false, path: PayloadPath = []): Array<string> => {
  if (Array.isArray(value)) return value.flatMap((entry, index) => collectSecretValues(entry, harnessBindings, [...path, index]));
  if (Schema.is(Schema.String)(value)) return [];
  if (value === null || Schema.is(Schema.Number)(value) || Schema.is(Schema.Boolean)(value)) return [];
  const found: Array<string> = [];
  const namedSecret = "name" in value
    && Schema.is(Schema.String)(value.name)
    && isSecretField(value.name);
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (
      !isBindingReference([...path, key], harnessBindings)
      && Schema.is(Schema.String)(entry)
      && (isSecretField(key) || (namedSecret && key === "value"))
      && entry !== "[REDACTED]"
      && !isEnvironmentReference(entry)
    ) found.push(entry);
    else found.push(...collectSecretValues(entry, harnessBindings, [...path, key]));
  }
  return found;
};

const knownSecretsFor = (
  data: CliPayload | undefined,
  secrets: ReadonlyArray<string>,
  harnessBindings = false,
): Array<string> => [
  ...(data === undefined ? [] : collectSecretValues(data, harnessBindings)),
  ...secrets,
];

export const sanitizeCliData = (
  value: CliPayload,
  secrets: ReadonlyArray<string> = [],
  harnessBindings = false,
): CliPayload => {
  const known = [...collectSecretValues(value, harnessBindings), ...secrets];
  return ordered(redact(value, known, harnessBindings));
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
  // Only this command's documented binding DTO carries symbolic names in a
  // legacy field called `secret`. Do not relax arbitrary secret-shaped fields.
  const harnessBindings = result.command === "agent.harness.get" || result.command === "agent.harness.set";
  const known = knownSecretsFor(result.data, secrets, harnessBindings);
  const data = result.data === undefined
    ? undefined
    : sanitizeCliData(result.data, secrets, harnessBindings);
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
  // A usage failure already ends with the help hint; its exit code adds nothing.
  if (result.command === "usage") return `${message}\n`;
  return renderHumanSummary(result.command, message, result.exitCode, data);
};
