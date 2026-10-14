import { Schema } from "effect";

/** JSON-shaped config values shared by the format codecs and text editors. */
export type ConfigJson = Schema.Json;

export type ConfigObject = { [key: string]: ConfigJson };

/** A string, number or boolean config leaf. */
export const isConfigScalar = Schema.is(Schema.Union([Schema.String, Schema.Number, Schema.Boolean]));

export const isConfigObject = (value: ConfigJson | undefined): value is ConfigObject =>
  value !== undefined && value !== null && !Array.isArray(value) && !isConfigScalar(value);

/** Structural equality: object key order is irrelevant, array order is not. */
export const configValuesEqual = (left: ConfigJson | undefined, right: ConfigJson | undefined): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left)) {
    return Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => configValuesEqual(entry, right[index]));
  }
  if (isConfigObject(left) && isConfigObject(right)) {
    const leftKeys = Object.keys(left);
    return leftKeys.length === Object.keys(right).length
      && leftKeys.every((key) => Object.hasOwn(right, key) && configValuesEqual(left[key], right[key]));
  }
  return false;
};

/** The value at literal key segments, or undefined when a segment is missing or crosses a non-object. */
export const configValueAt = (
  document: ConfigJson | undefined,
  segments: ReadonlyArray<string>,
): ConfigJson | undefined => {
  let value = document;
  for (const segment of segments) {
    if (!isConfigObject(value) || !Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
};

export const segmentsStartWith = (
  segments: ReadonlyArray<string>,
  prefix: ReadonlyArray<string>,
): boolean => prefix.length <= segments.length && prefix.every((segment, index) => segments[index] === segment);

export const segmentsEqual = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && segmentsStartWith(left, right);

/** Wraps a value in the objects named by segments: `nest(["a", "b"], 1)` is `{ a: { b: 1 } }`. */
export const nestConfigValue = (segments: ReadonlyArray<string>, value: ConfigJson): ConfigJson =>
  segments.reduceRight<ConfigJson>((inner, segment) => ({ [segment]: inner }), value);

/** A config document edit that cannot be written without changing what the file means. */
export class ConfigRepresentationError extends Error {
  override readonly name = "ConfigRepresentationError";
}
