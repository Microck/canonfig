import { Schema } from "effect";
import YAML from "yaml";

import { ConfigValue } from "../domain/resource.ts";

/** Frontmatter values are config values: YAML null fails decoding instead of passing through. */
export type FrontmatterData = Readonly<Record<string, ConfigValue>>;

export interface MarkdownDocument {
  readonly data: FrontmatterData;
  readonly content: string;
}

const decodeFrontmatter = Schema.decodeUnknownSync(Schema.Record(Schema.String, ConfigValue));

export function parseMarkdownDocument(source: string): MarkdownDocument {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return { data: {}, content: normalized.trim() };
  const body = normalized.slice(4);
  const match = /^---[ \t]*(?:\n|$)/mu.exec(body);
  if (!match) throw new Error("Unterminated YAML frontmatter block.");
  const rawData = body.slice(0, match.index);
  const content = body.slice(match.index + match[0].length).trim();
  if (rawData.trim() === "") return { data: {}, content };
  try {
    return { data: decodeFrontmatter(YAML.parse(rawData)), content };
  } catch (error) {
    throw new Error("YAML frontmatter must be an object of strings, numbers, booleans, lists and objects.", { cause: error });
  }
}

export function markdownWithFrontmatter(data: FrontmatterData, content: string): string {
  const frontmatter = YAML.stringify(data, { lineWidth: 0 }).trimEnd();
  return `---\n${frontmatter}\n---\n${content.trim()}\n`;
}
