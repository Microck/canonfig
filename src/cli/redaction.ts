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
  protectedPrefixes: ReadonlyArray<{ start: number; end: number }> = [],
): string => {
  const ordered = [...new Set(secrets)]
    .filter((secret) => secret.length > 0 && secret !== replacement)
    .sort((left, right) => right.length - left.length);
  // Compute ranges in the original text, never in inserted replacements.
  // Preserve standalone markers, but merge any credential crossing their edges.
  const markers: Array<{ start: number; end: number }> = [];
  for (let start = text.indexOf(replacement); start !== -1;
    start = text.indexOf(replacement, start + replacement.length)) {
    markers.push({ start, end: start + replacement.length });
  }
  const ranges = [...markers];
  const protectedRanges = [...markers, ...protectedPrefixes];
  for (const secret of ordered) {
    for (let start = text.indexOf(secret); start !== -1;
      start = text.indexOf(secret, start + 1)) {
      const end = start + secret.length;
      if (!protectedRanges.some((range) => start >= range.start && end <= range.end)) {
        ranges.push({ start, end });
      }
    }
  }
  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start < previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  let cursor = 0;
  let result = "";
  for (const range of merged) {
    result += text.slice(cursor, range.start) + replacement;
    cursor = range.end;
  }
  return result + text.slice(cursor);
};

/** Preserve recognizable field/flag names, while scrubbing all value segments. */
const redactTextValues = (text: string, secrets: ReadonlyArray<string>): string => {
  const ranges = credentialAssignments.flatMap(([pattern, valueGroup]) =>
    [...text.matchAll(pattern)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length - match[valueGroup]!.length,
    }))
  ).sort((left, right) => left.start - right.start || right.end - left.end);
  return redactKnownValues(text, secrets, ranges);
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
