/** Redact recognizable credential syntax before text crosses a CLI output boundary. */

import {
  assignedCredential,
  collectLiteralCredentialValues,
  credentialAssignments,
  authorizationCredential,
  isSecretField,
  isEncodedEnvironmentReference,
  privateKeyBlock,
  quotedCredentialKey,
  spacedCredentialFlag,
  urlUserInformation,
} from "../secrets/credential-policy.ts";

const replacement = "[REDACTED]";

/**
 * Scrub caller-supplied secret values wherever they appear, regardless of
 * the surrounding field name. Longest first so overlapping values redact
 * once. Callers pass values already in scope (never a store dump); empty
 * values are skipped because they would match everywhere.
 */
export const redactKnownValues = (
  text: string,
  secrets: ReadonlyArray<string>,
): string => {
  const ordered = [...new Set([...secrets, replacement])]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);
  const pattern = new RegExp(ordered.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"), "gu");
  return text.replace(pattern, replacement);
};

/** Preserve recognizable field/flag names, while scrubbing all value segments. */
const redactTextValues = (text: string, secrets: ReadonlyArray<string>): string => {
  const ranges = credentialAssignments.flatMap(([pattern, valueGroup]) =>
    [...text.matchAll(pattern)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length - match[valueGroup]!.length,
    }))
  ).sort((left, right) => left.start - right.start || right.end - left.end);
  let result = "";
  let cursor = 0;
  for (const range of ranges) {
    if (range.end <= cursor) continue;
    if (range.start >= cursor) {
      result += redactKnownValues(text.slice(cursor, range.start), secrets);
      result += text.slice(range.start, range.end);
    } else {
      result += text.slice(cursor, range.end);
    }
    cursor = range.end;
  }
  return result + redactKnownValues(text.slice(cursor), secrets);
};


const hasOnlySymbolicUrlCredentials = (prefix: string): boolean => {
  try {
    const url = new URL(`${prefix}redaction.invalid`);
    return [url.username, url.password].every((value) =>
      value === "" || isEncodedEnvironmentReference(decodeURIComponent(value)));
  } catch {
    return false;
  }
};

/**
 * This is a presentation safeguard, not a parser for arbitrary shell programs.
 * Callers must still avoid collecting raw authentication files or process output.
 */
export const redactText = (
  text: string,
  secrets: ReadonlyArray<string> = [],
): string =>
  redactTextValues(text
    .replace(privateKeyBlock, replacement)
    .replace(urlUserInformation, (match, scheme: string) =>
      hasOnlySymbolicUrlCredentials(match) ? match : `${scheme}[REDACTED]@`)
    .replace(authorizationCredential, (match, prefix: string, value: string) =>
      isEncodedEnvironmentReference(value) ? match : `${prefix}${replacement}`)
    .replace(assignedCredential, (match, flag: string | undefined, name: string, separator: string, value: string) =>
      isEncodedEnvironmentReference(value) ? match : `${flag ?? ""}${name}${separator}${replacement}`)
    .replace(quotedCredentialKey, (match, name: string, separator: string, value: string) =>
      isEncodedEnvironmentReference(value) ? match : `${name}${separator}"${replacement}"`)
    .replace(spacedCredentialFlag, (match, flag: string, separator: string, value: string) =>
      isEncodedEnvironmentReference(value) ? match : `${flag}${separator}${replacement}`),
    [...collectLiteralCredentialValues(text), ...secrets]);

/** Preserve argv structure while recognizing both --name=value and --name value. */
export const redactArguments = (
  values: ReadonlyArray<string>,
  secrets: ReadonlyArray<string> = [],
): Array<string> => {
  let redactNext = false;
  return values.map((value) => {
    if (redactNext) {
      redactNext = false;
      return replacement;
    }
    const flag = /^--([A-Za-z][A-Za-z0-9_-]*)(?:=(.*))?$/u.exec(value);
    if (flag !== null && isSecretField(flag[1]!)) {
      if (flag[2] !== undefined) return `--${flag[1]}=${replacement}`;
      redactNext = true;
      return value;
    }
    return redactText(value, secrets);
  });
};
