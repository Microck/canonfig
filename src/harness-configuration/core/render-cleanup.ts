import { sha256 } from "./hash.ts";
import { restoreJsonCleanup } from "./render-json.ts";
import {
  commentMarkers,
  locateBlock,
  parseJsonDocument,
  serializeJsonDocument,
  tomlBlockMarkers,
} from "./render-utils.ts";
import type {
  ArtifactState,
  CleanupInstruction,
} from "./types.ts";

function removeManagedText(
  text: string,
  cleanup: Extract<CleanupInstruction, { kind: "managed-text" }>,
  force: boolean,
  conflicts: string[],
): string {
  const markers = commentMarkers(cleanup.marker, cleanup.comments);
  const located = locateBlock(text, markers.begin, markers.end);
  if (located === undefined) {
    conflicts.push(`Managed block ${cleanup.marker} is missing.`);
    return text;
  }
  if (sha256(located.block) !== cleanup.blockHash && !force) {
    conflicts.push(`Managed block ${cleanup.marker} was edited outside Canonfig.`);
    return text;
  }
  return `${text.slice(0, located.start)}${text.slice(located.end)}`
    .replace(/^\s+$/u, "");
}

function removeTomlBlock(
  text: string,
  cleanup: Extract<CleanupInstruction, { kind: "toml-block" }>,
  force: boolean,
  conflicts: string[],
): string {
  const markers = tomlBlockMarkers(cleanup.marker);
  const located = locateBlock(text, markers.begin, markers.end);
  if (located === undefined) {
    conflicts.push(`Managed TOML block ${cleanup.marker} is missing.`);
    return text;
  }
  if (sha256(located.block) !== cleanup.blockHash && !force) {
    conflicts.push(`Managed TOML block ${cleanup.marker} was edited outside Canonfig.`);
    return text;
  }
  return `${text.slice(0, located.start)}${text.slice(located.end)}`;
}

function removeTomlKey(
  text: string,
  cleanup: Extract<CleanupInstruction, { kind: "toml-key" }>,
  conflicts: string[],
): string {
  const lines = text.split(/\r?\n/u);
  const marker = `# canonfig:key ${cleanup.marker}`;
  const index = lines.findIndex((line) => line.includes(marker));
  if (index < 0) {
    conflicts.push(
      `Managed TOML key ${cleanup.section}.${cleanup.key} is missing.`,
    );
    return text;
  }
  if (cleanup.originalLine !== undefined) lines[index] = cleanup.originalLine;
  else lines.splice(index, 1);
  return lines.join("\n");
}

export function unapplyPrevious(
  current: string | Uint8Array | undefined,
  previous: ArtifactState | undefined,
  force: boolean,
  conflicts: string[],
): string | Uint8Array | undefined {
  if (previous === undefined) return current;
  let output = current;
  const jsonCleanups = previous.cleanup.filter((cleanup) =>
    cleanup.kind.startsWith("json-")
  );
  let jsonDocument: Record<string, unknown> | undefined;
  if (jsonCleanups.length > 0 && typeof output === "string" && output.trim() !== "") {
    jsonDocument = parseJsonDocument(output, conflicts);
  }

  for (const cleanup of previous.cleanup) {
    if (cleanup.kind === "replace") {
      if (output === undefined) continue;
      if (sha256(output) !== previous.hash && !force) {
        conflicts.push("Generated file was edited outside Canonfig.");
        continue;
      }
      output = undefined;
      continue;
    }
    if (output instanceof Uint8Array) {
      conflicts.push("Cannot merge text cleanup into a binary file.");
      continue;
    }
    if (
      cleanup.kind === "json-managed-map"
      || cleanup.kind === "json-managed-array"
      || cleanup.kind === "json-managed-hooks"
    ) {
      if (jsonDocument !== undefined) {
        restoreJsonCleanup(jsonDocument, cleanup, force, conflicts);
      }
      continue;
    }
    const text = output ?? "";
    if (cleanup.kind === "managed-text") {
      output = removeManagedText(text, cleanup, force, conflicts);
    } else if (cleanup.kind === "toml-block") {
      output = removeTomlBlock(text, cleanup, force, conflicts);
    } else {
      output = removeTomlKey(text, cleanup, conflicts);
    }
  }

  if (jsonDocument !== undefined && typeof output === "string") output = serializeJsonDocument(jsonDocument);
  return output;
}
