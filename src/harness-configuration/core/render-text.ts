import { sha256 } from "./hash.ts";
import {
  commentMarkers,
  findTomlSection,
  locateBlock,
  tomlBlockMarkers,
} from "./render-utils.ts";
import type {
  CleanupInstruction,
  DesiredArtifact,
  ManagedTextArtifact,
  TomlEnsureKey,
} from "./types.ts";

export function appendManagedText(
  text: string,
  artifact: ManagedTextArtifact,
  force: boolean,
  conflicts: string[],
): { text: string; cleanup: CleanupInstruction } {
  const markers = commentMarkers(artifact.marker, artifact.comments);
  const existing = locateBlock(text, markers.begin, markers.end);
  if (existing !== undefined) {
    if (!force) {
      conflicts.push(`An unmanaged block already uses marker ${artifact.marker}.`);
    }
    text = `${text.slice(0, existing.start)}${text.slice(existing.end)}`;
  }
  const block = `${markers.begin}\n${artifact.content.trim()}\n${markers.end}\n`;
  const separator = text.trim() === ""
    ? ""
    : text.endsWith("\n\n")
    ? ""
    : text.endsWith("\n")
    ? "\n"
    : "\n\n";
  return {
    text: artifact.placement === "start"
      ? `${block}${separator}${text}`
      : `${text}${separator}${block}`,
    cleanup: {
      kind: "managed-text",
      marker: artifact.marker,
      comments: artifact.comments,
      blockHash: sha256(block),
    },
  };
}

function parseTomlLiteralLine(line: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = line.match(
    new RegExp(`^\\s*${escaped}\\s*=\\s*(.*?)\\s*(?:#.*)?$`, "u"),
  );
  return match?.[1]?.trim();
}

function applyTomlEnsureKey(
  input: string,
  ensure: TomlEnsureKey,
  force: boolean,
  conflicts: string[],
): { text: string; cleanup?: CleanupInstruction } {
  const lines = input.replace(/\r\n/gu, "\n").split("\n");
  let section = findTomlSection(lines, ensure.section);
  if (section === undefined) {
    if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
    lines.push(`[${ensure.section}]`);
    section = { header: lines.length - 1, end: lines.length };
  }
  const escaped = ensure.key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const keyPattern = new RegExp(`^\\s*${escaped}\\s*=`, "u");
  let keyIndex = -1;
  for (let index = section.header + 1; index < section.end; index += 1) {
    if (keyPattern.test(lines[index] ?? "")) {
      keyIndex = index;
      break;
    }
  }
  const marker = `# canonfig:key ${ensure.marker}`;
  const desiredLine = `${ensure.key} = ${ensure.value} ${marker}`;
  if (keyIndex >= 0) {
    const currentLine = lines[keyIndex] ?? "";
    if (parseTomlLiteralLine(currentLine, ensure.key) === ensure.value) {
      return { text: lines.join("\n") };
    }
    if (ensure.collision !== "replace" && !force) {
      conflicts.push(`TOML key ${ensure.section}.${ensure.key} already exists and differs.`);
      return { text: lines.join("\n") };
    }
    lines[keyIndex] = desiredLine;
    return {
      text: lines.join("\n"),
      cleanup: {
        kind: "toml-key",
        section: ensure.section,
        key: ensure.key,
        marker: ensure.marker,
        originalLine: currentLine,
      },
    };
  }
  lines.splice(section.end, 0, desiredLine);
  return {
    text: lines.join("\n"),
    cleanup: {
      kind: "toml-key",
      section: ensure.section,
      key: ensure.key,
      marker: ensure.marker,
    },
  };
}

export function applyTomlArtifact(
  input: string,
  artifact: Extract<DesiredArtifact, { kind: "toml" }>,
  force: boolean,
  conflicts: string[],
): { text: string; cleanup: CleanupInstruction[] } {
  let text = input.replace(/\r\n/gu, "\n");
  const cleanup: CleanupInstruction[] = [];
  for (const ensure of artifact.ensureKeys ?? []) {
    const result = applyTomlEnsureKey(text, ensure, force, conflicts);
    text = result.text;
    if (result.cleanup !== undefined) cleanup.push(result.cleanup);
  }
  for (const managed of artifact.blocks ?? []) {
    const markers = tomlBlockMarkers(managed.marker);
    const existing = locateBlock(text, markers.begin, markers.end);
    if (existing !== undefined) {
      if (!force) {
        conflicts.push(
          `An unmanaged TOML block already uses marker ${managed.marker}.`,
        );
      }
      text = `${text.slice(0, existing.start)}${text.slice(existing.end)}`;
    }
    const sections = [...managed.content.matchAll(/^\s*\[([^\]]+)\]\s*$/gmu)]
      .map((match) => match[1])
      .filter((section): section is string => section !== undefined);
    for (const section of sections) {
      if (findTomlSection(text.split("\n"), section) !== undefined) {
        conflicts.push(
          `TOML section [${section}] already exists outside Canonfig's managed block.`,
        );
      }
    }
    const block = `${markers.begin}\n${managed.content.trim()}\n${markers.end}\n`;
    const separator = text.trim() === ""
      ? ""
      : text.endsWith("\n\n")
      ? ""
      : text.endsWith("\n")
      ? "\n"
      : "\n\n";
    text = `${text}${separator}${block}`;
    cleanup.push({
      kind: "toml-block",
      marker: managed.marker,
      blockHash: sha256(block),
    });
  }
  return {
    text: text.endsWith("\n") ? text : `${text}\n`,
    cleanup,
  };
}
