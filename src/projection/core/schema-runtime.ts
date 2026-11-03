import type { SecretValue } from "./schema-types.ts";

export interface ValidationIssue {
  path: Array<string | number>;
  message: string;
}

export class SchemaValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(
      issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("\n"),
    );
    this.name = "SchemaValidationError";
    this.issues = issues;
  }
}

export type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: SchemaValidationError };

export interface RuntimeSchema<T> {
  parse(input: unknown): T;
  safeParse(input: unknown): SafeParseResult<T>;
}

export type PathPart = string | number;

export class Validator {
  readonly issues: ValidationIssue[] = [];

  issue(path: readonly PathPart[], message: string): void {
    this.issues.push({ path: [...path], message });
  }

  finish<T>(value: T): T {
    if (this.issues.length > 0) throw new SchemaValidationError(this.issues);
    return value;
  }
}

export function schema<T>(
  parser: (input: unknown, validator: Validator, path: PathPart[]) => T,
): RuntimeSchema<T> {
  return {
    parse(input: unknown): T {
      const validator = new Validator();
      return validator.finish(parser(input, validator, []));
    },
    safeParse(input: unknown): SafeParseResult<T> {
      try {
        return { success: true, data: this.parse(input) };
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          return { success: false, error };
        }
        throw error;
      }
    },
  };
}

export function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}

export function objectValue(
  input: unknown,
  validator: Validator,
  path: PathPart[],
): Record<string, unknown> {
  if (!isRecord(input)) {
    validator.issue(path, "Expected an object.");
    return {};
  }
  return input;
}

export function stringValue(
  input: unknown,
  validator: Validator,
  path: PathPart[],
  options: { min?: number; pattern?: RegExp } = {},
): string {
  if (typeof input !== "string") {
    validator.issue(path, "Expected a string.");
    return "";
  }
  if (options.min !== undefined && input.length < options.min) {
    validator.issue(path, `Expected at least ${options.min} character(s).`);
  }
  if (options.pattern && !options.pattern.test(input)) {
    validator.issue(path, "Invalid format.");
  }
  return input;
}

export function optionalString(
  input: unknown,
  validator: Validator,
  path: PathPart[],
): string | undefined {
  return input === undefined ? undefined : stringValue(input, validator, path);
}

export function booleanValue(
  input: unknown,
  validator: Validator,
  path: PathPart[],
  fallback: boolean,
): boolean {
  if (input === undefined) return fallback;
  if (typeof input !== "boolean") {
    validator.issue(path, "Expected a boolean.");
    return fallback;
  }
  return input;
}

export function positiveInteger(
  input: unknown,
  validator: Validator,
  path: PathPart[],
  max?: number,
): number | undefined {
  if (input === undefined) return undefined;
  if (
    typeof input !== "number"
    || !Number.isInteger(input)
    || input <= 0
    || (max !== undefined && input > max)
  ) {
    validator.issue(
      path,
      max === undefined
        ? "Expected a positive integer."
        : `Expected a positive integer no greater than ${max}.`,
    );
    return undefined;
  }
  return input;
}

export function enumValue<const T extends readonly string[]>(
  input: unknown,
  values: T,
  validator: Validator,
  path: PathPart[],
  fallback: T[number],
): T[number] {
  if (typeof input === "string" && values.includes(input)) {
    return input as T[number];
  }
  validator.issue(path, `Expected one of: ${values.join(", ")}.`);
  return fallback;
}

export function stringArray(
  input: unknown,
  validator: Validator,
  path: PathPart[],
  fallback: string[] = [],
): string[] {
  if (input === undefined) return [...fallback];
  if (!Array.isArray(input)) {
    validator.issue(path, "Expected an array of strings.");
    return [...fallback];
  }
  return input.map((value, index) =>
    stringValue(value, validator, [...path, index], { min: 1 })
  );
}

export function relativePath(
  input: unknown,
  validator: Validator,
  path: PathPart[],
  fallback?: string,
): string {
  if (input === undefined && fallback !== undefined) return fallback;
  const value = stringValue(input, validator, path, { min: 1 });
  if (
    value.startsWith("/")
    || value.startsWith("\\")
    || /^[A-Za-z]:[\\/]/u.test(value)
    || value.split(/[\\/]+/u).includes("..")
  ) {
    validator.issue(path, "Path must stay inside .canonfig/.");
  }
  return value;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

export function idValue(
  input: unknown,
  validator: Validator,
  path: PathPart[],
): string {
  return stringValue(input, validator, path, {
    min: 1,
    pattern: ID_PATTERN,
  });
}

export function secretValue(
  input: unknown,
  validator: Validator,
  path: PathPart[],
): SecretValue {
  if (typeof input === "string") return input;
  const value = objectValue(input, validator, path);
  const fromEnv = stringValue(
    value.fromEnv,
    validator,
    [...path, "fromEnv"],
    { min: 1 },
  );
  const fallback = optionalString(
    value.default,
    validator,
    [...path, "default"],
  );
  return fallback === undefined
    ? { fromEnv }
    : { fromEnv, default: fallback };
}

export function secretRecord(
  input: unknown,
  validator: Validator,
  path: PathPart[],
): Record<string, SecretValue> {
  if (input === undefined) return {};
  const value = objectValue(input, validator, path);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      secretValue(item, validator, [...path, key]),
    ]),
  );
}
