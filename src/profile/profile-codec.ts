import { Predicate, Schema as S } from "effect";

import type { ContentDigest } from "../domain/brand.ts";

/** Canonical JSON encoding: sorted keys, no insignificant whitespace. */
export const canonicalJson = (value: JsonValue): string => encodeCanonical(value);

export type JsonValue = S.MutableJson;

const encodeCanonical = (value: JsonValue): string => {
  if (value === null) return "null";
  if (Predicate.isString(value)) return JSON.stringify(value);
  if (Predicate.isNumber(value)) {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (Predicate.isBoolean(value)) return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(encodeCanonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${encodeCanonical(value[key])}`);
  return `{${parts.join(",")}}`;
};

/** Content digest over canonical bytes, hex encoded. */
export const digestOf = (value: JsonValue): ContentDigest => sha256Hex(canonicalJson(value));

export const sha256Hex = (text: string): ContentDigest => {
  const bytes = new TextEncoder().encode(text);
  return sha256BytesHex(bytes);
};

/** Digest a managed directory tree, including each entry's exact object shape. */
export const directoryEntriesDigest = (
  entries: ReadonlyArray<{
    readonly path: string;
    readonly digest: string;
    readonly executable?: boolean | undefined;
    readonly mode?: number | undefined;
    readonly objectKind?: string | undefined;
    readonly symlinkTo?: string | undefined;
  }>,
): ContentDigest => {
  const encoded = [...entries]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map((entry) => {
      const kind = entry.objectKind ?? (entry.symlinkTo === undefined ? "regular" : "symlink");
      const mode = kind === "symlink"
        ? "-"
        : entry.mode?.toString(8) ?? (entry.executable === true ? "100" : "0");
      return `${entry.path}\0${entry.digest}\0${kind}\0${mode}\0${entry.symlinkTo ?? ""}`;
    })
    .join("\n");
  return sha256Hex(encoded);
};

/** Stable public digest for the authored file content of a directory resource. */
export const directoryVerificationDigest = (
  files: ReadonlyArray<{
    readonly path: string;
    readonly digest: string;
    readonly executable?: boolean | undefined;
  }>,
): ContentDigest => {
  const encoded = [...files]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map((file) => `${file.path}\0${file.digest}\0${file.executable === true ? "x" : "-"}`)
    .join("\n");
  return sha256Hex(encoded);
};

export const sha256BytesHex = (bytes: Uint8Array): ContentDigest => {
  // Lazy import boundary: node:crypto is the runtime; this codec runs on Node only.
  const { createHash } = nodeCrypto();
  // SAFETY: SHA-256 with hex encoding always returns a content digest string.
  return createHash("sha256").update(bytes).digest("hex") as ContentDigest;
};

let cachedCrypto: typeof import("node:crypto") | null = null;
const nodeCrypto = (): typeof import("node:crypto") => {
  if (cachedCrypto === null) cachedCrypto = requireNodeCrypto();
  return cachedCrypto;
};

const requireNodeCrypto = (): typeof import("node:crypto") => {
  // SAFETY: process is available in the Node runtime this package targets; the
  // dynamic import is resolved at first use and cached.
  const load = globalThis.process?.getBuiltinModule as ((id: string) => typeof import("node:crypto")) | undefined;
  if (load !== undefined) return load("node:crypto");
  throw new Error("node:crypto is unavailable in this runtime");
};

/**
 * Strip JSONC comments and trailing commas from authoring text.
 * Handles line comments, block comments (not inside strings), and trailing commas.
 * JSONC is parsed only at the authoring boundary; canonical forms never contain it.
 */
export const stripJsonc = (text: string): string => {
  let out = "";
  let i = 0;
  let inString = false;
  let stringEscape = false;
  while (i < text.length) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : "";
    if (inString) {
      out += ch;
      if (stringEscape) {
        stringEscape = false;
      } else if (ch === "\\") {
        stringEscape = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      out += " ";
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      out += " ";
      i += 2;
      let terminated = false;
      while (i + 1 < text.length) {
        if (text[i] === "*" && text[i + 1] === "/") {
          terminated = true;
          break;
        }
        i += 1;
      }
      if (!terminated) throw new SyntaxError("unterminated JSONC block comment");
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return removeTrailingCommas(out);
};

const removeTrailingCommas = (text: string): string => {
  let out = "";
  let inString = false;
  let stringEscape = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      out += ch;
      if (stringEscape) {
        stringEscape = false;
      } else if (ch === "\\") {
        stringEscape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/u.test(text[lookahead] ?? "")) lookahead += 1;
      const next = text[lookahead];
      if (next === "}" || next === "]") continue;
    }
    out += ch;
  }
  return out;
};

/** Parse JSONC authoring text into validated JSON data. Throws on invalid JSON. */
export const parseJsonc = (text: string): JsonValue => {
  const stripped = stripJsonc(text);
  return S.decodeUnknownSync(S.MutableJson)(JSON.parse(stripped));
};

/** Parse and decode with a schema at the authoring boundary. */
export const decodeJsonc = <SchemaValue extends S.ConstraintDecoder<unknown, never>>(
  schema: SchemaValue,
): (text: string) => SchemaValue["Type"] =>
  (text: string) =>
    S.decodeUnknownSync(schema, {
      errors: "all",
      onExcessProperty: "error",
    })(parseJsonc(text));
