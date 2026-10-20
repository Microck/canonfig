import { Schema } from "effect";

/** Redact recognizable credential syntax before text crosses a CLI output boundary. */

import {
  collectLiteralCredentialValues,
  credentialAssignments,
  isSecretField,
  isEncodedEnvironmentReference,
  privateKeyBlock,
  quotedCredentialKey,
  urlUserInformation,
} from "../secrets/credential-policy.ts";

const replacement = "[REDACTED]";

interface RedactionRange { start: number; end: number }

const renderRanges = (text: string, ranges: Array<RedactionRange>): string => {
  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Array<RedactionRange> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  let cursor = 0;
  let result = "";
  for (const range of merged) {
    result += text.slice(cursor, range.start) + replacement;
    cursor = range.end;
  }
  return result + text.slice(cursor);
};

const literalRanges = (
  text: string,
  secrets: ReadonlyArray<string>,
): Array<RedactionRange> => {
  const markers: Array<RedactionRange> = [];
  for (let start = text.indexOf(replacement); start !== -1;
    start = text.indexOf(replacement, start + replacement.length)) {
    markers.push({ start, end: start + replacement.length });
  }
  const ranges = [...markers];
  for (const secret of new Set(secrets)) {
    if (secret.length === 0 || secret === replacement) continue;
    let pending: RedactionRange | undefined;
    let markerIndex = 0;
    for (let start = text.indexOf(secret); start !== -1;
      start = text.indexOf(secret, start + 1)) {
      const end = start + secret.length;
      while (markerIndex < markers.length && markers[markerIndex]!.end <= start) markerIndex += 1;
      const marker = markers[markerIndex];
      if (marker !== undefined && start >= marker.start && end <= marker.end) continue;
      // Coalesce before allocating: a megabyte of repeated one-character
      // credentials must not allocate a million ranges or expand tenfold.
      if (pending !== undefined && start <= pending.end) pending.end = Math.max(pending.end, end);
      else {
        if (pending !== undefined) ranges.push(pending);
        pending = { start, end };
      }
    }
    if (pending !== undefined) ranges.push(pending);
  }
  return ranges;
};

/** Scrub in-scope literal values without interpreting them as regular expressions. */
export const redactKnownValues = (text: string, secrets: ReadonlyArray<string>): string =>
  renderRanges(text, literalRanges(text, secrets));

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
): string => {
  const ranges: Array<RedactionRange> = [];
  for (const match of text.matchAll(privateKeyBlock)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  for (const match of text.matchAll(urlUserInformation)) {
    if (!hasOnlySymbolicUrlCredentials(match[0])) {
      ranges.push({ start: match.index + match[1]!.length, end: match.index + match[0].length - 1 });
    }
  }
  for (const [pattern, valueGroup] of credentialAssignments) {
    for (const match of text.matchAll(pattern)) {
      const value = match[valueGroup]!;
      const end = match.index + match[0].length;
      const start = end - value.length;
      if (isEncodedEnvironmentReference(value)) continue;
      // Preserve JSON string delimiters; other assignment forms retain their
      // established unquoted redaction marker. All offsets refer to original text.
      const quotedJson = pattern === quotedCredentialKey && value.startsWith('"') && value.endsWith('"');
      ranges.push({ start: start + (quotedJson ? 1 : 0), end: end - (quotedJson ? 1 : 0) });
    }
  }
  const known = [...new Set([...collectLiteralCredentialValues(text), ...secrets])]
    .filter((value) => value.length > 0 && value !== replacement);
  // Native JSON may spell the same value with different Unicode/slash escapes.
  // Compare decoded string values, then mask the whole original string body;
  // do not recursively decode literal backslash sequences or rewrite the input.
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"/gu)) {
    try {
      const decoded = Schema.decodeUnknownSync(Schema.String)(JSON.parse(match[0]));
      if (known.some((value) => decoded.includes(value))) {
        ranges.push({ start: match.index + 1, end: match.index + match[0].length - 1 });
      }
    } catch { /* Not a valid JSON string: raw literal matching still applies. */ }
  }
  return renderRanges(text, [...ranges, ...literalRanges(text, known)]);
};

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
