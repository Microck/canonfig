import { Schema } from "effect";
import { parse as parseToml, stringify as stringifyToml, TomlDate, type TomlTable, type TomlValue } from "smol-toml";

import { formatConfigPath } from "../domain/config-path.ts";
import {
  type ConfigJson,
  type ConfigObject,
  ConfigRepresentationError,
  configValueAt,
  configValuesEqual,
  isConfigObject,
  isConfigScalar,
  nestConfigValue,
  segmentsEqual,
  segmentsStartWith,
} from "./config-value.ts";

/**
 * TOML config edits rewrite only the statements that define owned keys.
 * Comments, blank lines, key order and the literal spelling of every other
 * value (`1.0`, dates, big integers, string styles) keep their exact bytes,
 * which parse-and-stringify through smol-toml could not do.
 */

interface TomlHeader {
  readonly path: ReadonlyArray<string>;
  readonly array: boolean;
  /** Inside an array of tables, where config paths cannot address values. */
  readonly inArray: boolean;
  readonly start: number;
  readonly lineEnd: number;
}

interface TomlPair {
  readonly table: ReadonlyArray<string>;
  readonly path: ReadonlyArray<string>;
  readonly inArray: boolean;
  /** Index into headers; -1 for the root table. */
  readonly header: number;
  readonly start: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly lineEnd: number;
}

interface ScannedToml {
  readonly headers: ReadonlyArray<TomlHeader>;
  readonly pairs: ReadonlyArray<TomlPair>;
}

const BasicEscape = Schema.Literals(["b", "t", "n", "f", "r", "e", "\"", "\\"]);

const basicEscapes = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  e: "\u001b",
  "\"": "\"",
  "\\": "\\",
} satisfies Record<typeof BasicEscape.Type, string>;

const scanToml = (text: string): ScannedToml => {
  const headers: Array<TomlHeader> = [];
  const pairs: Array<TomlPair> = [];
  const arrayTables: Array<ReadonlyArray<string>> = [];
  let position = 0;
  const fail = (message: string): never => {
    const before = text.slice(0, position);
    throw new SyntaxError(
      `${message} at line ${before.split("\n").length} column ${position - before.lastIndexOf("\n")}`,
    );
  };
  const skipBlanks = (): void => {
    while (text[position] === " " || text[position] === "\t") position += 1;
  };
  const skipLineRest = (): number => {
    skipBlanks();
    if (text[position] === "#") {
      while (position < text.length && text[position] !== "\n" && text[position] !== "\r") position += 1;
    }
    const end = position;
    if (text.startsWith("\r\n", position)) position += 2;
    else if (text[position] === "\n") position += 1;
    else if (position < text.length) fail("expected the end of the line");
    return end;
  };
  const scanBasicString = (): string => {
    position += 1;
    let value = "";
    while (text[position] !== "\"") {
      const character = text[position];
      if (character === undefined || character === "\n") fail("unterminated string");
      if (character === "\\") {
        const escape = text[position + 1]!;
        const width = escape === "u" ? 4 : escape === "U" ? 8 : escape === "x" ? 2 : 0;
        if (width > 0) {
          value += String.fromCodePoint(Number.parseInt(text.slice(position + 2, position + 2 + width), 16));
          position += 2 + width;
          continue;
        }
        const decoded = Schema.is(BasicEscape)(escape) ? basicEscapes[escape] : undefined;
        if (decoded === undefined) fail("invalid string escape");
        value += decoded;
        position += 2;
        continue;
      }
      value += character;
      position += 1;
    }
    position += 1;
    return value;
  };
  const scanKey = (): ReadonlyArray<string> => {
    const segments: Array<string> = [];
    for (;;) {
      skipBlanks();
      if (text[position] === "\"") {
        segments.push(scanBasicString());
      } else if (text[position] === "'") {
        const end = text.indexOf("'", position + 1);
        if (end === -1 || text.slice(position, end).includes("\n")) fail("unterminated literal string");
        segments.push(text.slice(position + 1, end));
        position = end + 1;
      } else {
        const match = /^[A-Za-z0-9_-]+/u.exec(text.slice(position, position + 4096));
        if (match === null) fail("expected a key");
        segments.push(match![0]);
        position += match![0].length;
      }
      skipBlanks();
      if (text[position] !== ".") return segments;
      position += 1;
    }
  };
  const skipQuoted = (): boolean => {
    for (const delimiter of ["\"\"\"", "'''"]) {
      if (!text.startsWith(delimiter, position)) continue;
      position += 3;
      for (;;) {
        if (position >= text.length) fail("unterminated multi-line string");
        if (delimiter === "\"\"\"" && text[position] === "\\") {
          position += 2;
          continue;
        }
        if (text.startsWith(delimiter, position)) {
          position += 3;
          // Up to two quote characters directly before the closing delimiter
          // belong to the string content.
          for (let extra = 0; extra < 2 && text[position] === delimiter[0]; extra += 1) position += 1;
          return true;
        }
        position += 1;
      }
    }
    if (text[position] === "\"") {
      scanBasicString();
      return true;
    }
    if (text[position] === "'") {
      const end = text.indexOf("'", position + 1);
      if (end === -1) fail("unterminated literal string");
      position = end + 1;
      return true;
    }
    return false;
  };
  const scanValue = (): void => {
    if (skipQuoted()) return;
    if (text[position] === "[" || text[position] === "{") {
      let depth = 0;
      do {
        if (skipQuoted()) continue;
        const character = text[position];
        if (character === undefined) fail("unterminated array or inline table");
        if (character === "#") {
          while (position < text.length && text[position] !== "\n") position += 1;
          continue;
        }
        if (character === "[" || character === "{") depth += 1;
        if (character === "]" || character === "}") depth -= 1;
        position += 1;
      } while (depth > 0);
      return;
    }
    const start = position;
    while (position < text.length && !/[\s,\]}#]/u.test(text[position]!)) position += 1;
    // An offset date-time may separate the date and time with one space.
    if (/^\d{4}-\d{2}-\d{2}$/u.test(text.slice(start, position)) && /^ \d{2}:/u.test(text.slice(position, position + 4))) {
      position += 1;
      while (position < text.length && !/[\s,\]}#]/u.test(text[position]!)) position += 1;
    }
    if (position === start) fail("expected a value");
  };

  let table: ReadonlyArray<string> = [];
  let tableInArray = false;
  while (position < text.length) {
    const character = text[position]!;
    if (character === " " || character === "\t" || character === "\r" || character === "\n" || character === "\uFEFF") {
      position += 1;
      continue;
    }
    if (character === "#") {
      skipLineRest();
      continue;
    }
    const start = position;
    if (character === "[") {
      const array = text[position + 1] === "[";
      position += array ? 2 : 1;
      const path = scanKey();
      if (!text.startsWith(array ? "]]" : "]", position)) fail("expected the end of a table header");
      position += array ? 2 : 1;
      const lineEnd = skipLineRest();
      const inArray = array || arrayTables.some((entry) => entry.length < path.length && segmentsStartWith(path, entry));
      if (array) arrayTables.push(path);
      headers.push({ path, array, inArray, start, lineEnd });
      table = path;
      tableInArray = inArray;
      continue;
    }
    const key = scanKey();
    if (text[position] !== "=") fail("expected '=' after a key");
    position += 1;
    skipBlanks();
    const valueStart = position;
    scanValue();
    const valueEnd = position;
    const lineEnd = skipLineRest();
    pairs.push({
      table,
      path: [...table, ...key],
      inArray: tableInArray,
      header: headers.length - 1,
      start,
      valueStart,
      valueEnd,
      lineEnd,
    });
  }
  return { headers, pairs };
};

const readTomlRaw = (text: string): TomlTable => parseToml(text, { integersAsBigInt: "asNeeded" });

const isTomlBigInt = Schema.is(Schema.BigInt);

const lossyForJson = (value: TomlValue): boolean => {
  if (value instanceof TomlDate || isTomlBigInt(value)) return true;
  if (Array.isArray(value)) return value.some(lossyForJson);
  return !isConfigScalar(value) && Object.values(value).some(lossyForJson);
};

const toConfigJson = (value: TomlValue): ConfigJson => {
  if (value instanceof TomlDate) return value.toISOString();
  if (isTomlBigInt(value)) return Number(value);
  if (Array.isArray(value)) return value.map(toConfigJson);
  return isConfigScalar(value) ? value : toConfigObject(value);
};

const toConfigObject = (table: TomlTable): ConfigObject =>
  Object.fromEntries(Object.entries(table).map(([key, entry]) => [key, toConfigJson(entry)]));

/**
 * Parse a TOML document into config values. Datetimes read as their TOML text
 * and integers outside the safe range as the nearest number: both are only
 * compared, and an edit never rewrites them through this model.
 */
export const readTomlDocument = (text: string): ConfigObject => toConfigObject(readTomlRaw(text));

const eolOf = (text: string): string => text.includes("\r\n") ? "\r\n" : "\n";

const lineStart = (text: string, position: number): number => text.lastIndexOf("\n", position - 1) + 1;

const afterLineBreak = (text: string, position: number): number =>
  text.startsWith("\r\n", position) ? position + 2 : text[position] === "\n" ? position + 1 : position;

const tomlKey = (segments: ReadonlyArray<string>): string =>
  segments.map((segment) =>
    /^[A-Za-z0-9_-]+$/u.test(segment) ? segment : stringifyToml({ v: segment }).slice(4).trimEnd()
  ).join(".");

const floatLiteral = (literal: string): boolean =>
  /^[+-]?(?:inf|nan)$/u.test(literal)
  || (/^[+-]?\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?$/u.test(literal) && /[.eE]/u.test(literal));

/** Throw a ConfigRepresentationError naming the key when a value holds null, which TOML cannot write. */
export const rejectNull = (value: ConfigJson, path: ReadonlyArray<string>): void => {
  if (value === null) {
    throw new ConfigRepresentationError(`TOML has no null value, so ${formatConfigPath(path)} cannot be written`);
  }
  if (Array.isArray(value)) value.forEach((entry: ConfigJson) => rejectNull(entry, path));
  else if (isConfigObject(value)) {
    for (const [key, entry] of Object.entries(value)) rejectNull(entry, [...path, key]);
  }
};

/** An inline TOML value; an integral number replacing a float literal stays a float. */
const inlineValue = (value: ConfigJson, previousLiteral?: string): string => {
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[ ${value.map((entry: ConfigJson) => inlineValue(entry)).join(", ")} ]`;
  }
  if (isConfigObject(value)) {
    const entries = Object.entries(value);
    return entries.length === 0
      ? "{}"
      : `{ ${entries.map(([key, entry]) => `${tomlKey([key])} = ${inlineValue(entry)}`).join(", ")} }`;
  }
  if (
    Schema.is(Schema.Number)(value)
    && Number.isSafeInteger(value)
    && previousLiteral !== undefined
    && floatLiteral(previousLiteral.trim())
  ) {
    return `${value}.0`;
  }
  return stringifyToml({ v: value }).slice(4).trimEnd();
};

const replacePairValue = (text: string, pair: TomlPair, value: ConfigJson): string => {
  rejectNull(value, pair.path);
  return text.slice(0, pair.valueStart)
    + inlineValue(value, text.slice(pair.valueStart, pair.valueEnd))
    + text.slice(pair.valueEnd);
};

const pairLineSpan = (text: string, pair: TomlPair): readonly [number, number] =>
  [lineStart(text, pair.start), afterLineBreak(text, pair.lineEnd)];

/** Start of the comment lines written directly above a header, which belong to it. */
const attachedCommentStart = (text: string, header: TomlHeader): number => {
  let start = lineStart(text, header.start);
  while (start > 0) {
    const previous = lineStart(text, start - 1);
    if (!text.slice(previous, start).trimStart().startsWith("#")) break;
    start = previous;
  }
  return start;
};

const regionEnd = (text: string, scanned: ScannedToml, index: number): number => {
  const next = scanned.headers[index + 1];
  return next === undefined ? text.length : attachedCommentStart(text, next);
};

/** A pair inside an inline value takes its whole new value from the target document. */
const rerenderPair = (text: string, pair: TomlPair, target: ConfigObject): string => {
  const previous = readTomlRaw(`v = ${text.slice(pair.valueStart, pair.valueEnd)}`)["v"];
  if (lossyForJson(previous)) {
    throw new ConfigRepresentationError(
      `cannot rewrite the inline TOML value ${formatConfigPath(pair.path)} without changing a datetime or large integer inside it`,
    );
  }
  const value = configValueAt(target, pair.path);
  if (value === undefined) {
    const [start, end] = pairLineSpan(text, pair);
    return text.slice(0, start) + text.slice(end);
  }
  return replacePairValue(text, pair, value);
};

const deleteSubtree = (text: string, path: ReadonlyArray<string>, target: ConfigObject): string => {
  const scanned = scanToml(text);
  const container = scanned.pairs.find((pair) =>
    !pair.inArray && pair.path.length < path.length && segmentsStartWith(path, pair.path)
  );
  if (container !== undefined) return rerenderPair(text, container, target);
  const ranges: Array<readonly [number, number]> = [];
  scanned.headers.forEach((header, index) => {
    if (segmentsStartWith(header.path, path)) {
      ranges.push([lineStart(text, header.start), regionEnd(text, scanned, index)]);
    }
  });
  for (const pair of scanned.pairs) {
    if (!segmentsStartWith(pair.path, path)) continue;
    const span = pairLineSpan(text, pair);
    if (!ranges.some(([start, end]) => span[0] >= start && span[1] <= end)) ranges.push(span);
  }
  return ranges
    .sort((left, right) => right[0] - left[0])
    .reduce((result, [start, end]) => result.slice(0, start) + result.slice(end), text);
};

const insertAfterLine = (text: string, lineEnd: number, line: string): string =>
  `${text.slice(0, lineEnd)}${eolOf(text)}${line}${text.slice(lineEnd)}`;

const insertBlock = (text: string, position: number, block: string): string => {
  const eol = eolOf(text);
  let before = text.slice(0, position);
  const after = text.slice(position);
  if (before.length > 0 && !before.endsWith("\n")) before += eol;
  if (before.trim().length > 0 && !before.endsWith(`${eol}${eol}`)) before += eol;
  const body = block.replaceAll("\n", eol);
  return before + body + (after.length > 0 && !after.startsWith(eol) ? eol : "") + after;
};

const sectionPosition = (text: string, scanned: ScannedToml, path: ReadonlyArray<string>): number => {
  let best = -1;
  let bestShared = 0;
  scanned.headers.forEach((header, index) => {
    let shared = 0;
    while (shared < Math.min(header.path.length, path.length) && header.path[shared] === path[shared]) shared += 1;
    if (shared > 0 && shared >= bestShared) {
      best = index;
      bestShared = shared;
    }
  });
  return best === -1 ? text.length : regionEnd(text, scanned, best);
};

const insertValue = (text: string, path: ReadonlyArray<string>, value: ConfigJson): string => {
  rejectNull(value, path);
  const scanned = scanToml(text);
  const asSection = isConfigObject(value)
    || (Array.isArray(value) && value.length > 0 && value.every(isConfigObject));
  if (asSection) {
    const section = isConfigObject(value) && Object.keys(value).length === 0
      ? `[${tomlKey(path)}]\n`
      : stringifyToml(nestConfigValue(path, value));
    return insertBlock(text, sectionPosition(text, scanned, path), section);
  }
  const parent = path.slice(0, -1);
  const pairLine = (relative: ReadonlyArray<string>, indentation: string) =>
    `${indentation}${tomlKey(relative)} = ${inlineValue(value)}`;
  const indentationOf = (pair: TomlPair) => /^[ \t]*/u.exec(text.slice(lineStart(text, pair.start)))![0];
  if (parent.length === 0) {
    const last = scanned.pairs.filter((pair) => pair.header === -1).at(-1);
    if (last !== undefined) return insertAfterLine(text, last.lineEnd, pairLine(path, indentationOf(last)));
    const first = scanned.headers[0];
    if (first === undefined) return insertBlock(text, text.length, `${pairLine(path, "")}\n`);
    const position = attachedCommentStart(text, first);
    const eol = eolOf(text);
    return `${text.slice(0, position)}${pairLine(path, "")}${eol}${eol}${text.slice(position)}`;
  }
  const hostIndex = scanned.headers.findIndex((header) =>
    !header.array && !header.inArray && segmentsEqual(header.path, parent)
  );
  if (hostIndex !== -1) {
    const last = scanned.pairs.filter((pair) => pair.header === hostIndex).at(-1);
    return last === undefined
      ? insertAfterLine(text, scanned.headers[hostIndex]!.lineEnd, pairLine(path.slice(-1), ""))
      : insertAfterLine(text, last.lineEnd, pairLine(path.slice(-1), indentationOf(last)));
  }
  // A parent built from dotted keys (`[a]` holding `b.c = 1`) grows by another
  // dotted key in the same table, which keeps the table defined in one place.
  const dotted = scanned.pairs.filter((pair) =>
    !pair.inArray
    && pair.path.length > parent.length
    && segmentsStartWith(pair.path, parent)
    && segmentsStartWith(parent, pair.table)
  ).at(-1);
  if (dotted !== undefined) {
    return insertAfterLine(text, dotted.lineEnd, pairLine(path.slice(dotted.table.length), indentationOf(dotted)));
  }
  return insertBlock(
    text,
    sectionPosition(text, scanned, parent),
    `[${tomlKey(parent)}]\n${pairLine(path.slice(-1), "")}\n`,
  );
};

/**
 * Set the value at literal key segments. `target` is the whole document the
 * edit sequence is converging on; it supplies the new text of an inline table
 * or array that contains the key.
 */
export const setTomlValue = (
  text: string,
  path: ReadonlyArray<string>,
  value: ConfigJson,
  target: ConfigObject,
): string => {
  rejectNull(value, path);
  const current = configValueAt(readTomlDocument(text), path);
  if (current !== undefined && configValuesEqual(current, value)) return text;
  const scanned = scanToml(text);
  const container = scanned.pairs.find((pair) =>
    !pair.inArray && pair.path.length < path.length && segmentsStartWith(path, pair.path)
  );
  if (container !== undefined) return rerenderPair(text, container, target);
  const exact = scanned.pairs.find((pair) => !pair.inArray && segmentsEqual(pair.path, path));
  if (exact !== undefined) return replacePairValue(text, exact, value);
  if (isConfigObject(value) && isConfigObject(current)) {
    // A table defined by a header or dotted keys is edited key by key, so
    // comments and untouched values inside it survive.
    let next = text;
    for (const [key, entry] of Object.entries(value)) next = setTomlValue(next, [...path, key], entry, target);
    for (const key of Object.keys(current)) {
      if (!Object.hasOwn(value, key)) next = deleteSubtree(next, [...path, key], target);
    }
    return configValueAt(readTomlDocument(next), path) === undefined ? insertValue(next, path, {}) : next;
  }
  return insertValue(current === undefined ? text : deleteSubtree(text, path, target), path, value);
};

/**
 * Remove the value at literal key segments, then every ancestor table left
 * empty, matching removeConfigPath on the parsed document.
 */
export const removeTomlValue = (text: string, path: ReadonlyArray<string>, target: ConfigObject): string => {
  const document = readTomlDocument(text);
  for (let depth = 1; depth < path.length; depth += 1) {
    if (!isConfigObject(configValueAt(document, path.slice(0, depth)))) return text;
  }
  let next = deleteSubtree(text, path, target);
  for (let depth = path.length - 1; depth > 0; depth -= 1) {
    const ancestor = configValueAt(readTomlDocument(next), path.slice(0, depth));
    if (!isConfigObject(ancestor) || Object.keys(ancestor).length > 0) break;
    next = deleteSubtree(next, path.slice(0, depth), target);
  }
  return next;
};
