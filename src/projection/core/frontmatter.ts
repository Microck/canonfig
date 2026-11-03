import YAML from "yaml";

export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  "allowed-tools"?: string | string[];
}

export interface MarkdownDocument { data: Record<string, unknown>; content: string; }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseMarkdownDocument(source: string): MarkdownDocument {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return { data: {}, content: normalized.trim() };
  const body = normalized.slice(4);
  const match = /^---[ \t]*(?:\n|$)/mu.exec(body);
  if (!match) throw new Error("Unterminated YAML frontmatter block.");
  const rawData = body.slice(0, match.index);
  const parsed = rawData.trim() === "" ? {} : (YAML.parse(rawData) as unknown);
  if (!isRecord(parsed)) throw new Error("YAML frontmatter must be an object.");
  return { data: parsed, content: body.slice(match.index + match[0].length).trim() };
}

export function parseSkill(source: string): { data: SkillFrontmatter; content: string } {
  const parsed = parseMarkdownDocument(source);
  const { data } = parsed;
  if (typeof data.name !== "string" || data.name.length === 0) throw new Error("Skill frontmatter requires a non-empty name.");
  if (typeof data.description !== "string" || data.description.length === 0) throw new Error("Skill frontmatter requires a non-empty description.");
  if (data.license !== undefined && typeof data.license !== "string") throw new Error("Skill license must be a string.");
  if (data.compatibility !== undefined && typeof data.compatibility !== "string") throw new Error("Skill compatibility must be a string.");
  if (data.metadata !== undefined && !isRecord(data.metadata)) throw new Error("Skill metadata must be an object.");
  const allowedTools = data["allowed-tools"];
  if (allowedTools !== undefined && typeof allowedTools !== "string" && !(Array.isArray(allowedTools) && allowedTools.every((item) => typeof item === "string"))) {
    throw new Error("Skill allowed-tools must be a string or an array of strings.");
  }
  const result: SkillFrontmatter = {
    name: data.name,
    description: data.description,
    ...(typeof data.license === "string" ? { license: data.license } : {}),
    ...(typeof data.compatibility === "string" ? { compatibility: data.compatibility } : {}),
    ...(isRecord(data.metadata) ? { metadata: data.metadata } : {}),
    ...(typeof allowedTools === "string" || Array.isArray(allowedTools) ? { "allowed-tools": allowedTools as string | string[] } : {}),
  };
  return { data: result, content: parsed.content };
}

export function markdownWithFrontmatter(data: Record<string, unknown>, content: string): string {
  const frontmatter = YAML.stringify(data, { lineWidth: 0 }).trimEnd();
  return `---\n${frontmatter}\n---\n${content.trim()}\n`;
}
