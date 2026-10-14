import { Schema } from "effect";

import {
  type ConfigJson,
  type ConfigObject,
  nestConfigValue,
} from "./config-value.ts";

/**
 * JSON config files are read as JSONC: `//` and `/* *\/` comments and trailing
 * commas are accepted, and edits splice only the owned members so comments and
 * layout elsewhere keep their exact bytes.
 */

type JsonNode =
  | { readonly kind: "object"; readonly start: number; readonly end: number; readonly members: ReadonlyArray<JsonMember> }
  | { readonly kind: "array"; readonly start: number; readonly end: number }
  | { readonly kind: "scalar"; readonly start: number; readonly end: number };

interface JsonMember {
  readonly key: string;
  readonly keyStart: number;
  readonly value: JsonNode;
  /** Index of the `,` that follows this member, when there is one. */
  readonly comma?: number | undefined;
}

interface ScannedJsonc {
  readonly root: JsonNode;
  /** The text with comments and trailing commas blanked, positions unchanged. */
  readonly stripped: string;
}

const lineAndColumn = (text: string, position: number): string => {
  const before = text.slice(0, position);
  const line = before.split("\n").length;
  return `line ${line} column ${position - before.lastIndexOf("\n")}`;
};

const scanJsonc = (text: string): ScannedJsonc => {
  const blanks: Array<readonly [number, number]> = [];
  let position = 0;
  const fail = (message: string): never => {
    throw new SyntaxError(`${message} at ${lineAndColumn(text, position)}`);
  };
  const skipTrivia = (): void => {
    while (position < text.length) {
      const character = text[position]!;
      if (character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\uFEFF") {
        position += 1;
        continue;
      }
      if (text.startsWith("//", position)) {
        const end = text.indexOf("\n", position);
        const stop = end === -1 ? text.length : end;
        blanks.push([position, stop]);
        position = stop;
        continue;
      }
      if (text.startsWith("/*", position)) {
        const end = text.indexOf("*/", position + 2);
        if (end === -1) fail("unterminated block comment");
        blanks.push([position, end + 2]);
        position = end + 2;
        continue;
      }
      return;
    }
  };
  const scanString = (): string => {
    const start = position;
    position += 1;
    while (position < text.length && text[position] !== "\"") {
      if (text[position] === "\n") fail("unterminated string");
      position += text[position] === "\\" ? 2 : 1;
    }
    if (position >= text.length) fail("unterminated string");
    position += 1;
    return text.slice(start, position);
  };
  const scanValue = (): JsonNode => {
    skipTrivia();
    const start = position;
    const character = text[position];
    if (character === "{") {
      position += 1;
      const members: Array<JsonMember> = [];
      for (;;) {
        skipTrivia();
        if (text[position] === "}") break;
        if (text[position] !== "\"") fail("expected a property name or '}'");
        const keyStart = position;
        const key = Schema.decodeUnknownSync(Schema.String)(JSON.parse(scanString()));
        skipTrivia();
        if (text[position] !== ":") fail("expected ':' after a property name");
        position += 1;
        const value = scanValue();
        skipTrivia();
        if (text[position] === ",") {
          const comma = position;
          position += 1;
          members.push({ key, keyStart, value, comma });
          skipTrivia();
          if (text[position] === "}") blanks.push([comma, comma + 1]);
          continue;
        }
        members.push({ key, keyStart, value });
        if (text[position] !== "}") fail("expected ',' or '}' after a property value");
      }
      position += 1;
      return { kind: "object", start, end: position, members };
    }
    if (character === "[") {
      position += 1;
      for (;;) {
        skipTrivia();
        if (text[position] === "]") break;
        scanValue();
        skipTrivia();
        if (text[position] === ",") {
          const comma = position;
          position += 1;
          skipTrivia();
          if (text[position] === "]") blanks.push([comma, comma + 1]);
          continue;
        }
        if (text[position] !== "]") fail("expected ',' or ']' after an array element");
      }
      position += 1;
      return { kind: "array", start, end: position };
    }
    if (character === "\"") {
      scanString();
      return { kind: "scalar", start, end: position };
    }
    while (position < text.length && /[A-Za-z0-9+\-.]/u.test(text[position]!)) position += 1;
    if (position === start) fail("expected a JSON value");
    return { kind: "scalar", start, end: position };
  };
  const root = scanValue();
  skipTrivia();
  if (position < text.length) fail("unexpected text after the JSON document");
  let stripped = text;
  for (const [start, end] of blanks) {
    stripped = stripped.slice(0, start) + stripped.slice(start, end).replace(/[^\n]/gu, " ") + stripped.slice(end);
  }
  return { root, stripped };
};

/** Parse JSONC text whose root is an object. Throws a SyntaxError naming the line and column. */
export const parseJsoncObject = (text: string): ConfigObject => {
  const scanned = scanJsonc(text);
  const value: unknown = JSON.parse(scanned.stripped);
  if (!Schema.is(Schema.JsonObject)(value)) throw new SyntaxError("the JSON document root is not an object");
  return value;
};

const lineStart = (text: string, position: number): number => text.lastIndexOf("\n", position - 1) + 1;

const indentationAt = (text: string, position: number): string => {
  const start = lineStart(text, position);
  return /^[ \t]*/u.exec(text.slice(start))![0];
};

const indentUnit = (text: string): string => {
  const match = /\n([ \t]+)\S/u.exec(text);
  return match === null ? "  " : match[1]!;
};

const eolOf = (text: string): string => text.includes("\r\n") ? "\r\n" : "\n";

const render = (value: ConfigJson, indentation: string, unit: string, eol: string): string =>
  JSON.stringify(value, undefined, unit).replaceAll("\n", `${eol}${indentation}`);

/** End of the line holding `position` when only blanks or a line comment follow it there. */
const endOfLineAfter = (text: string, position: number): number | undefined => {
  const match = /^[ \t]*(?:\/\/[^\n]*)?(?=\r?\n|$)/u.exec(text.slice(position));
  if (match === null) return undefined;
  const end = position + match[0].length;
  return text[end - 1] === "\r" ? end - 1 : end;
};

const lastMember = (node: JsonNode, key: string): { member: JsonMember; index: number } | undefined => {
  if (node.kind !== "object") return undefined;
  for (let index = node.members.length - 1; index >= 0; index -= 1) {
    if (node.members[index]!.key === key) return { member: node.members[index]!, index };
  }
  return undefined;
};

const insertMember = (
  text: string,
  object: Extract<JsonNode, { kind: "object" }>,
  key: string,
  value: ConfigJson,
): string => {
  const unit = indentUnit(text);
  const eol = eolOf(text);
  const last = object.members.at(-1);
  if (last === undefined) {
    const outer = indentationAt(text, object.start);
    const inner = `${outer}${unit}`;
    const member = `${JSON.stringify(key)}: ${render(value, inner, unit, eol)}`;
    const body = text.slice(object.start + 1, object.end - 1);
    const insertion = body.trim().length === 0
      ? `${eol}${inner}${member}${eol}${outer}`
      : `${eol}${inner}${member}${body.includes("\n") ? "" : " "}`;
    const replaced = body.trim().length === 0 ? "" : body;
    return text.slice(0, object.start + 1) + insertion + replaced + text.slice(object.end - 1);
  }
  const ownLine = text.slice(lineStart(text, last.keyStart), last.keyStart).trim().length === 0;
  const indentation = ownLine ? indentationAt(text, last.keyStart) : "";
  // A member sharing its line with others is written compactly to match.
  const member = `${JSON.stringify(key)}: ${ownLine ? render(value, indentation, unit, eol) : JSON.stringify(value)}`;
  if (last.comma !== undefined) {
    const lineEnd = ownLine ? endOfLineAfter(text, last.comma + 1) : undefined;
    return lineEnd === undefined
      ? `${text.slice(0, last.comma + 1)} ${member},${text.slice(last.comma + 1)}`
      : `${text.slice(0, lineEnd)}${eol}${indentation}${member},${text.slice(lineEnd)}`;
  }
  const valueEnd = last.value.end;
  const lineEnd = ownLine ? endOfLineAfter(text, valueEnd) : undefined;
  return lineEnd === undefined
    ? `${text.slice(0, valueEnd)}, ${member}${text.slice(valueEnd)}`
    : `${text.slice(0, valueEnd)},${text.slice(valueEnd, lineEnd)}${eol}${indentation}${member}${text.slice(lineEnd)}`;
};

const deleteMember = (text: string, object: Extract<JsonNode, { kind: "object" }>, index: number): string => {
  const member = object.members[index]!;
  const start = lineStart(text, member.keyStart);
  const ownLine = text.slice(start, member.keyStart).trim().length === 0;
  const tail = member.comma === undefined ? member.value.end : member.comma + 1;
  const lineEnd = ownLine ? endOfLineAfter(text, tail) : undefined;
  let removeStart = member.keyStart;
  let removeEnd = tail;
  if (lineEnd !== undefined) {
    removeStart = start;
    removeEnd = lineEnd + (text.startsWith("\r\n", lineEnd) ? 2 : text[lineEnd] === "\n" ? 1 : 0);
  } else {
    while (removeEnd < text.length && (text[removeEnd] === " " || text[removeEnd] === "\t")) removeEnd += 1;
  }
  let result = text.slice(0, removeStart) + text.slice(removeEnd);
  // The last member leaves its predecessor's separator dangling; drop it unless
  // the removed member itself carried a trailing comma.
  const previous = object.members[index - 1];
  if (index === object.members.length - 1 && member.comma === undefined && previous?.comma !== undefined) {
    result = result.slice(0, previous.comma) + result.slice(previous.comma + 1);
  }
  return result;
};

/** Set the value at literal key segments, creating missing parent objects. */
export const setJsoncValue = (text: string, segments: ReadonlyArray<string>, value: ConfigJson): string => {
  let node = scanJsonc(text).root;
  for (let index = 0; index < segments.length; index += 1) {
    if (node.kind !== "object") {
      throw new TypeError(`config key path crosses a non-object value: ${segments.slice(0, index).join(".")}`);
    }
    const found = lastMember(node, segments[index]!);
    if (found === undefined) {
      return insertMember(text, node, segments[index]!, nestConfigValue(segments.slice(index + 1), value));
    }
    if (index === segments.length - 1) {
      const target = found.member.value;
      const keyLine = lineStart(text, found.member.keyStart);
      const rendered = text.slice(keyLine, found.member.keyStart).trim().length === 0
        ? render(value, indentationAt(text, found.member.keyStart), indentUnit(text), eolOf(text))
        : JSON.stringify(value);
      return text.slice(0, target.start) + rendered + text.slice(target.end);
    }
    node = found.member.value;
  }
  return text;
};

/**
 * Remove the member at literal key segments, then every ancestor object that
 * is left empty, matching removeConfigPath on the parsed document.
 */
export const removeJsoncValue = (text: string, segments: ReadonlyArray<string>): string => {
  const chain: Array<{ readonly object: Extract<JsonNode, { kind: "object" }>; readonly index: number }> = [];
  let node = scanJsonc(text).root;
  for (const segment of segments) {
    if (node.kind !== "object") return text;
    const found = lastMember(node, segment);
    if (found === undefined) break;
    chain.push({ object: node, index: found.index });
    node = found.member.value;
  }
  let level: number;
  if (chain.length === segments.length) {
    level = chain.length - 1;
  } else {
    // An absent leaf under an existing, already empty parent still prunes that
    // parent, exactly as removeConfigPath does.
    if (chain.length !== segments.length - 1 || node.kind !== "object" || node.members.length > 0 || chain.length === 0) {
      return text;
    }
    level = chain.length - 1;
  }
  // Removing the only member of an object empties it, so the splice moves up to
  // the member holding that object. The root object itself always stays.
  while (level > 0 && chain[level]!.object.members.length === 1) level -= 1;
  const entry = chain[level]!;
  return deleteMember(text, entry.object, entry.index);
};
