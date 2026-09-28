import { stringify as stringifyToml } from "smol-toml";
import {
  Document,
  isMap,
  isNode,
  isScalar,
  parseDocument,
  Scalar,
  visit,
  type ToStringOptions,
} from "yaml";
import { Schema } from "effect";

import type { ResourceSpecInput } from "../domain/profile.ts";
import { configPathSegments } from "../domain/config-path.ts";
import { parseJsoncObject, removeJsoncValue, setJsoncValue } from "./config-jsonc.ts";
import { readTomlDocument, rejectNull, removeTomlValue, setTomlValue } from "./config-toml.ts";
import {
  type ConfigJson,
  ConfigRepresentationError,
  configValueAt,
  configValuesEqual,
  isConfigObject,
} from "./config-value.ts";

export { ConfigRepresentationError } from "./config-value.ts";

export type ConfigFormat =
  Extract<ResourceSpecInput, { readonly kind: "config" }>["format"];

const ConfigDocumentSchema = Schema.Record(Schema.String, Schema.MutableJson);
export interface ConfigDocument {
  [key: string]: typeof Schema.MutableJson.Type;
}

const formatName = { json: "JSON", toml: "TOML", yaml: "YAML" } satisfies Record<ConfigFormat, string>;

/**
 * YAML 1.1 readers (PyYAML, and so Python clients) resolve these plain scalars
 * to booleans, null, numbers or timestamps. YAML 1.2 writers leave most of them
 * plain, so Canonfig quotes every string it writes that matches one.
 */
const yaml11NonString = new RegExp(
  [
    "y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF",
    "~|null|Null|NULL|<<|=",
    "[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+",
    "[-+]?(?:[0-9][0-9_]*)?\\.[0-9.]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\\.[0-9_]*",
    "[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN)",
    "\\d{4}-\\d\\d?-\\d\\d?(?:(?:[Tt]|[ \\t]+)\\d\\d?:\\d\\d:\\d\\d(?:\\.\\d*)?(?:[ \\t]*(?:Z|[-+]\\d\\d?(?::\\d\\d)?))?)?",
  ].map((alternative) => `(?:${alternative})`).join("|").replace(/^/u, "^(?:").concat(")$"),
  "u",
);

/** Quote strings Canonfig created (nodes without a source range) that YAML 1.1 would not read as strings. */
const quoteCreatedYamlStrings = (document: Document): void => {
  visit(document, {
    Pair(_, pair) {
      if (Schema.is(Schema.String)(pair.key)) pair.key = new Scalar(pair.key);
    },
    Scalar(_, scalar) {
      if (scalar.range === undefined && Schema.is(Schema.String)(scalar.value) && yaml11NonString.test(scalar.value)) {
        scalar.type = Scalar.QUOTE_DOUBLE;
      }
    },
  });
};

const parseYaml = (text: string): Document.Parsed => {
  const document = parseDocument(text);
  const error = document.errors[0];
  if (error !== undefined) throw new SyntaxError(error.message);
  return document;
};

/**
 * The document's root mapping; an empty document is an empty mapping. A root
 * that is not an object is a SyntaxError, checked before its values are decoded.
 */
const yamlMapping = (document: Document): ConfigDocument => {
  if (document.contents === null) return {};
  const value: unknown = document.toJS();
  if (!(value instanceof Object) || Array.isArray(value)) {
    throw new SyntaxError(`the ${formatName.yaml} document root is not a mapping`);
  }
  return Schema.decodeUnknownSync(ConfigDocumentSchema)(value);
};

const eolOf = (text: string): string => text.includes("\r\n") ? "\r\n" : "\n";

/** Parse config text. JSON files are read as JSONC; whitespace-only text is an empty document. */
export const parseConfigDocument = (
  format: ConfigFormat,
  text: string,
): ConfigDocument => {
  if (text.trim().length === 0) return {};
  const value = format === "json"
    ? parseJsoncObject(text)
    : format === "toml"
    ? readTomlDocument(text)
    : yamlMapping(parseYaml(text));
  return { ...Schema.decodeUnknownSync(ConfigDocumentSchema)(value) };
};

/** Serialize a document from scratch, for a new file or a digest of owned values. */
export const serializeConfigDocument = (
  format: ConfigFormat,
  document: ConfigDocument,
): string => {
  switch (format) {
    case "json":
      return `${JSON.stringify(document, undefined, 2)}\n`;
    case "toml":
      rejectNull(document, []);
      return stringifyToml(document);
    case "yaml": {
      const yaml = new Document(document);
      quoteCreatedYamlStrings(yaml);
      return yaml.toString({ lineWidth: 0 });
    }
  }
};

const sortedKeys = (value: ConfigJson): ConfigJson =>
  Array.isArray(value)
    ? value.map(sortedKeys)
    : isConfigObject(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedKeys(value[key]!)]))
    : value;

/**
 * The canonical bytes of a config resource's owned keys, as published, as
 * desired on a follower, and as observed there. Object keys are sorted the way
 * the signed revision's canonical JSON sorts them, so the digest is the same
 * whether a value comes from the authored profile, the fetched revision or a
 * follower file that lists the same keys in another order.
 */
export const renderConfigDocument = (spec: {
  readonly format: ConfigFormat;
  readonly keys: ReadonlyArray<{ readonly path: string; readonly value: ConfigJson }>;
}): Uint8Array => {
  const document: ConfigDocument = {};
  for (const entry of [...spec.keys].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    setConfigPath(document, entry.path, sortedKeys(Schema.decodeUnknownSync(Schema.MutableJson)(entry.value)));
  }
  return new TextEncoder().encode(serializeConfigDocument(spec.format, document));
};

export const setConfigPath = (
  document: ConfigDocument,
  path: string,
  value: ConfigJson,
): void => {
  const segments = configPathSegments(path);
  const parsedValue = Schema.decodeUnknownSync(Schema.MutableJson)(value);
  let parent = document;
  for (const segment of segments.slice(0, -1)) {
    const child = parent[segment];
    if (child === undefined) {
      const created: ConfigDocument = {};
      parent[segment] = created;
      parent = created;
      continue;
    }
    if (!isConfigObject(child)) {
      throw new TypeError(`config key path crosses a non-object value: ${path}`);
    }
    const mutableNested = { ...child };
    parent[segment] = mutableNested;
    parent = mutableNested;
  }
  parent[segments.at(-1)!] = parsedValue;
};

export const getConfigPath = (
  document: ConfigDocument,
  path: string,
): ConfigJson | undefined => configValueAt(document, configPathSegments(path));

export const removeConfigPath = (
  document: ConfigDocument,
  path: string,
): void => {
  const segments = configPathSegments(path);
  const parents: Array<{
    readonly document: ConfigDocument;
    readonly segment: string;
  }> = [];
  let current = document;
  for (const segment of segments.slice(0, -1)) {
    const nested = current[segment];
    if (!isConfigObject(nested)) return;
    parents.push({ document: current, segment });
    const mutableNested = { ...nested };
    current[segment] = mutableNested;
    current = mutableNested;
  }
  delete current[segments.at(-1)!];
  for (const parent of parents.reverse()) {
    const child = parent.document[parent.segment];
    if (isConfigObject(child) && Object.keys(child).length === 0) {
      delete parent.document[parent.segment];
    }
  }
};

export interface ConfigTextEdit {
  /** Owned paths to delete first; emptied parent objects go with them. */
  readonly removes?: ReadonlyArray<string> | undefined;
  readonly sets: ReadonlyArray<{ readonly path: string; readonly value: ConfigJson }>;
}

const yamlOutputOptions = (text: string): ToStringOptions => ({
  lineWidth: 0,
  indent: /\n( +)[^\s#-]/u.exec(text)?.[1]?.length ?? 2,
  indentSeq: !/(?:^|\n)( *)[^\s#][^\n]*:[ \t]*\r?\n\1- /u.test(text),
  flowCollectionPadding: !/[[{][^\s\]}]/u.test(text) || /[[{] \S/u.test(text),
});

const removeYaml = (document: Document, segments: ReadonlyArray<string>): void => {
  for (let depth = 1; depth < segments.length; depth += 1) {
    if (!isMap(document.getIn(segments.slice(0, depth), true))) return;
  }
  document.deleteIn(segments);
  for (let depth = segments.length - 1; depth > 0; depth -= 1) {
    const ancestor = document.getIn(segments.slice(0, depth), true);
    if (!isMap(ancestor) || ancestor.items.length > 0) break;
    document.deleteIn(segments.slice(0, depth));
  }
};

const setYaml = (document: Document, segments: ReadonlyArray<string>, value: ConfigJson): void => {
  const current = configValueAt(yamlMapping(document), segments);
  if (current !== undefined && configValuesEqual(current, value)) return;
  const existing = document.getIn(segments, true);
  if (isMap(existing) && isConfigObject(value) && isConfigObject(current)) {
    // Edit a mapping key by key so its anchor, comments and untouched entries stay.
    for (const [key, entry] of Object.entries(value)) setYaml(document, [...segments, key], entry);
    for (const key of Object.keys(current)) {
      if (!Object.hasOwn(value, key)) document.deleteIn([...segments, key]);
    }
    return;
  }
  const node = document.createNode(value);
  if (isNode(existing)) {
    node.comment = existing.comment;
    node.commentBefore = existing.commentBefore;
    node.spaceBefore = existing.spaceBefore;
    // Keeping the anchor keeps aliases resolvable; verification then rejects
    // the edit if it would change what an alias elsewhere reads.
    node.anchor = existing.anchor;
    if (
      isScalar(existing)
      && isScalar(node)
      && Schema.is(Schema.Number)(existing.value)
      && Schema.is(Schema.Number)(value)
      && Number.isInteger(value)
      && (!Number.isInteger(existing.value) || (existing.minFractionDigits ?? 0) > 0 || existing.format === "EXP")
    ) {
      if (existing.format === "EXP") node.format = "EXP";
      else node.minFractionDigits = Math.max(1, existing.minFractionDigits ?? 0);
    }
  }
  document.setIn(segments, node);
};

const editYaml = (
  text: string,
  removes: ReadonlyArray<ReadonlyArray<string>>,
  sets: ReadonlyArray<{ readonly segments: ReadonlyArray<string>; readonly value: ConfigJson }>,
): string => {
  const document: Document = parseYaml(text);
  if (document.contents === null) document.contents = document.createNode({});
  for (const segments of removes) removeYaml(document, segments);
  for (const { segments, value } of sets) setYaml(document, segments, value);
  quoteCreatedYamlStrings(document);
  const output = document.toString(yamlOutputOptions(text));
  return eolOf(text) === "\n" ? output : output.replaceAll("\n", "\r\n");
};

/**
 * Apply owned-key edits to existing config text in place. Comments, anchors,
 * layout and the literal spelling of every value outside the owned keys are
 * kept. The result is parsed again and must equal the parsed original with
 * exactly these edits applied; otherwise this throws a
 * ConfigRepresentationError rather than write a file that means something else.
 * `undefined` or whitespace-only text is written as a fresh document.
 */
export const editConfigText = (
  format: ConfigFormat,
  text: string | undefined,
  edit: ConfigTextEdit,
): string => {
  const current = text === undefined ? {} : parseConfigDocument(format, text);
  const expected: ConfigDocument = structuredClone(current);
  const removes = edit.removes ?? [];
  for (const path of removes) removeConfigPath(expected, path);
  for (const entry of edit.sets) setConfigPath(expected, entry.path, entry.value);
  if (text !== undefined && configValuesEqual(current, expected)) return text;
  if (text === undefined || text.trim().length === 0) return serializeConfigDocument(format, expected);
  const removeSegments = removes.map(configPathSegments);
  const sets = edit.sets.map((entry) => ({
    segments: configPathSegments(entry.path),
    value: Schema.decodeUnknownSync(Schema.MutableJson)(entry.value),
  }));
  let output = text;
  try {
    switch (format) {
      case "json":
        for (const segments of removeSegments) output = removeJsoncValue(output, segments);
        for (const { segments, value } of sets) {
          const present = configValueAt(parseJsoncObject(output), segments);
          if (present === undefined || !configValuesEqual(present, value)) output = setJsoncValue(output, segments, value);
        }
        break;
      case "toml":
        for (const segments of removeSegments) output = removeTomlValue(output, segments, expected);
        for (const { segments, value } of sets) output = setTomlValue(output, segments, value, expected);
        break;
      case "yaml":
        output = editYaml(text, removeSegments, sets);
        break;
    }
  } catch (error) {
    if (error instanceof ConfigRepresentationError) throw error;
    throw new ConfigRepresentationError(
      `cannot edit the ${formatName[format]} file in place: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let written: ConfigDocument;
  try {
    written = parseConfigDocument(format, output);
  } catch (error) {
    throw new ConfigRepresentationError(
      `editing the ${formatName[format]} file in place produced invalid ${formatName[format]} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!configValuesEqual(written, expected)) {
    throw new ConfigRepresentationError(
      `cannot edit the ${formatName[format]} file in place without changing values outside the owned keys; an owned key probably shares a YAML anchor or an inline table with other values. Move the owned keys out of the shared value, then run synchronization again`,
    );
  }
  return output;
};
