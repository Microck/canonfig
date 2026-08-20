import { Schema } from "effect";

import type { CliExitCode } from "./exit-codes.ts";
import type { CliPayload } from "./source-commands.ts";

export type CliOutputFormat = "human" | "json";

export interface CliResult {
  readonly command: string;
  readonly message: string;
  readonly data?: CliPayload | undefined;
  readonly exitCode: CliExitCode;
}

const secretField =
  /^(?:credential|credentialValue|password|secret|privateKey|signingKey|tlsKey|accessToken|refreshToken|apiKey|authorization|cookie)$/iu;

interface RenderEnvelope {
  schema: string;
  command: string;
  status: string;
  exitCode: CliExitCode;
  message: string;
  data?: CliPayload | undefined;
}

const redact = (value: CliPayload): CliPayload => {
  if (Array.isArray(value)) return value.map(redact);
  if (
    value === null
    || Schema.is(Schema.String)(value)
    || Schema.is(Schema.Number)(value)
    || Schema.is(Schema.Boolean)(value)
  ) return value;
  const result: { [key: string]: CliPayload | undefined } = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    result[key] = secretField.test(key) ? "[REDACTED]" : redact(entry);
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
    result[key] = ordered(entry);
  }
  return result;
};

export const sanitizeCliData = (value: CliPayload): CliPayload =>
  ordered(redact(value));

export const renderCliResult = (
  result: CliResult,
  format: CliOutputFormat,
): string => {
  const data = result.data === undefined
    ? undefined
    : sanitizeCliData(result.data);
  if (format === "json") {
    const envelope: RenderEnvelope = {
      schema: "canonfig.cli/v1",
      command: result.command,
      status: result.exitCode === 0 ? "success" : "error",
      exitCode: result.exitCode,
      message: result.message,
    };
    if (data !== undefined) envelope.data = data;
    return `${JSON.stringify(envelope)}\n`;
  }
  if (data === undefined) return `${result.message}\n`;
  return `${result.message}\n${JSON.stringify(data, null, 2)}\n`;
};
