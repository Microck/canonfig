import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { Option, Schema } from "effect";

import type { ResourceSpecInput } from "../domain/profile.ts";

export type ConfigFormat =
  Extract<ResourceSpecInput, { readonly kind: "config" }>["format"];

const ConfigDocumentSchema = Schema.Record(Schema.String, Schema.MutableJson);
export interface ConfigDocument {
  [key: string]: typeof Schema.MutableJson.Type;
}

export const parseConfigDocument = (
  format: ConfigFormat,
  text: string,
): ConfigDocument => {
  switch (format) {
    case "json": {
      const decoded = Schema.decodeUnknownSync(ConfigDocumentSchema)(
        JSON.parse(text),
      );
      return { ...decoded };
    }
    case "toml": {
      const decoded = Schema.decodeUnknownSync(ConfigDocumentSchema)(
        parseToml(text),
      );
      return { ...decoded };
    }
    case "yaml": {
      const decoded = Schema.decodeUnknownSync(ConfigDocumentSchema)(
        parseYaml(text),
      );
      return { ...decoded };
    }
  }
};

export const serializeConfigDocument = (
  format: ConfigFormat,
  document: ConfigDocument,
): string => {
  switch (format) {
    case "json":
      return `${JSON.stringify(document, undefined, 2)}\n`;
    case "toml":
      return stringifyToml(document);
    case "yaml":
      return stringifyYaml(document);
  }
};

const pathSegments = (path: string): ReadonlyArray<string> => {
  const segments = path.split(".");
  if (segments.some((segment) => segment.length === 0)) {
    throw new TypeError(`config key path contains an empty segment: ${path}`);
  }
  return segments;
};

export const setConfigPath = (
  document: ConfigDocument,
  path: string,
  value: typeof Schema.MutableJson.Type
    | Extract<ResourceSpecInput, { readonly kind: "config" }>["keys"][number]["value"],
): void => {
  const segments = pathSegments(path);
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
    const nested = Option.getOrUndefined(
      Schema.decodeUnknownOption(ConfigDocumentSchema)(child),
    );
    if (nested === undefined) {
      throw new TypeError(`config key path crosses a non-object value: ${path}`);
    }
    const mutableNested = { ...nested };
    parent[segment] = mutableNested;
    parent = mutableNested;
  }
  parent[segments.at(-1)!] = parsedValue;
};

export const getConfigPath = (
  document: ConfigDocument,
  path: string,
): typeof Schema.MutableJson.Type | undefined => {
  const segments = pathSegments(path);
  let value: typeof Schema.MutableJson.Type = document;
  for (const segment of segments) {
    const parent: Readonly<ConfigDocument> | undefined = Option.getOrUndefined(
      Schema.decodeUnknownOption(ConfigDocumentSchema)(value),
    );
    if (parent === undefined) return undefined;
    value = parent[segment];
    if (value === undefined) return undefined;
  }
  return value;
};

export const removeConfigPath = (
  document: ConfigDocument,
  path: string,
): void => {
  const segments = pathSegments(path);
  const parents: Array<{
    readonly document: ConfigDocument;
    readonly segment: string;
  }> = [];
  let current = document;
  for (const segment of segments.slice(0, -1)) {
    const nested = Option.getOrUndefined(
      Schema.decodeUnknownOption(ConfigDocumentSchema)(current[segment]),
    );
    if (nested === undefined) return;
    parents.push({ document: current, segment });
    const mutableNested = { ...nested };
    current[segment] = mutableNested;
    current = mutableNested;
  }
  delete current[segments.at(-1)!];
  for (const parent of parents.reverse()) {
    const child = parent.document[parent.segment];
    const nested = child === undefined
      ? undefined
      : Option.getOrUndefined(
        Schema.decodeUnknownOption(ConfigDocumentSchema)(child),
      );
    if (
      nested !== undefined
      && Object.keys(nested).length === 0
    ) {
      delete parent.document[parent.segment];
    }
  }
};
