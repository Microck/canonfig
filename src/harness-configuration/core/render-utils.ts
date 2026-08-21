import type { JsonPath, ManagedTextArtifact } from "./types.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return deepEqual(leftKeys, rightKeys)
      && leftKeys.every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}

function stripJsonComments(text: string): string {
  let output = "";
  let index = 0;
  let inString = false;
  let escaped = false;
  while (index < text.length) {
    const character = text[index]!;
    const next = text[index + 1];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      output += "\n";
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (
        index + 1 < text.length
        && !(text[index] === "*" && text[index + 1] === "/")
      ) {
        if (text[index] === "\n") output += "\n";
        index += 1;
      }
      index += 2;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

function removeTrailingCommas(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === ",") {
      let cursor = index + 1;
      while (cursor < text.length && /\s/u.test(text[cursor]!)) cursor += 1;
      if (text[cursor] === "}" || text[cursor] === "]") continue;
    }
    output += character;
  }
  return output;
}

export function parseJsonDocument(
  text: string,
  conflicts: string[],
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(removeTrailingCommas(stripJsonComments(text))) as unknown;
    if (!isRecord(parsed)) {
      conflicts.push("JSON/JSONC root must be an object.");
      return {};
    }
    return parsed;
  } catch (error) {
    conflicts.push(
      `Invalid JSON/JSONC: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
}

export function serializeJsonDocument(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, undefined, 2)}\n`;
}

export function getAtPath(root: unknown, path: JsonPath): unknown {
  let current = root;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function setAtPath(
  root: Record<string, unknown>,
  path: JsonPath,
  value: unknown,
): void {
  if (path.length === 0) {
    if (!isRecord(value)) throw new TypeError("JSON root replacement must be an object");
    for (const key of Object.keys(root)) delete root[key];
    Object.assign(root, value);
    return;
  }
  let parent = root;
  for (const segment of path.slice(0, -1)) {
    const current = parent[segment];
    if (!isRecord(current)) parent[segment] = {};
    parent = parent[segment] as Record<string, unknown>;
  }
  const key = path[path.length - 1]!;
  if (value === undefined) delete parent[key];
  else parent[key] = value;
}

export function commentMarkers(
  marker: string,
  style: ManagedTextArtifact["comments"],
): { begin: string; end: string } {
  const prefix = style === "html" ? "<!-- " : style === "slash" ? "// " : "# ";
  const suffix = style === "html" ? " -->" : "";
  return {
    begin: `${prefix}canonfig:begin ${marker}${suffix}`,
    end: `${prefix}canonfig:end ${marker}${suffix}`,
  };
}

export function locateBlock(
  text: string,
  begin: string,
  end: string,
): { start: number; end: number; block: string } | undefined {
  const start = text.indexOf(begin);
  if (start < 0) return undefined;
  const endStart = text.indexOf(end, start + begin.length);
  if (endStart < 0) return undefined;
  let endOffset = endStart + end.length;
  if (text[endOffset] === "\r" && text[endOffset + 1] === "\n") endOffset += 2;
  else if (text[endOffset] === "\n") endOffset += 1;
  return { start, end: endOffset, block: text.slice(start, endOffset) };
}

export function identityOf(value: unknown, identity: string | undefined): unknown {
  return identity === undefined || !isRecord(value) ? value : value[identity];
}

export function containsMarker(value: unknown, marker: string): boolean {
  if (typeof value === "string") return value.includes(marker);
  if (Array.isArray(value)) return value.some((item) => containsMarker(item, marker));
  return isRecord(value)
    && Object.values(value).some((item) => containsMarker(item, marker));
}

export function tomlBlockMarkers(marker: string): { begin: string; end: string } {
  return {
    begin: `# canonfig:begin ${marker}`,
    end: `# canonfig:end ${marker}`,
  };
}

export function findTomlSection(
  lines: string[],
  section: string,
): { header: number; end: number } | undefined {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const target = new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`, "u");
  for (let index = 0; index < lines.length; index += 1) {
    if (!target.test(lines[index] ?? "")) continue;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^\s*\[\[?.+?\]\]?\s*(?:#.*)?$/u.test(lines[cursor] ?? "")) {
        end = cursor;
        break;
      }
    }
    return { header: index, end };
  }
  return undefined;
}
