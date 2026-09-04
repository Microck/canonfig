import { sha256 } from "./hash.ts";
import { unapplyPrevious } from "./render-cleanup.ts";
import { applyJsonArtifact } from "./render-json.ts";
import { appendManagedText, applyTomlArtifact } from "./render-text.ts";
import type {
  ArtifactState,
  CleanupInstruction,
  DesiredArtifact,
} from "./types.ts";

export interface RenderResult {
  content: string | Uint8Array | undefined;
  cleanup: CleanupInstruction[];
  conflicts: string[];
}

export function renderArtifacts(
  artifacts: readonly DesiredArtifact[],
  current: string | Uint8Array | undefined,
  previous: ArtifactState | undefined,
  force = false,
): RenderResult {
  const conflicts: string[] = [];
  // Markers this render will write again are left in place by the cleanup pass
  // so they can be replaced where they stand, which keeps text on both sides of
  // a block where the operator put it.
  const rerenderedMarkers = new Set(
    artifacts
      .filter((artifact) => artifact.kind === "managed-text")
      .map((artifact) => artifact.marker),
  );
  const ownedBlockHashes = new Map(
    (previous?.cleanup ?? [])
      .filter((cleanup) => cleanup.kind === "managed-text")
      .map((cleanup) => [cleanup.marker, cleanup.blockHash] as const),
  );
  const output = unapplyPrevious(
    current,
    previous,
    force,
    conflicts,
    rerenderedMarkers,
  );
  const cleanup: CleanupInstruction[] = [];
  if (artifacts.length === 0) return { content: output, cleanup, conflicts };

  const replacements = artifacts.filter((artifact) => artifact.kind === "replace");
  if (replacements.length > 0) {
    if (artifacts.length !== 1) {
      conflicts.push("A replace artifact cannot share a path with merge artifacts.");
    }
    const replacement = replacements[0];
    if (replacement === undefined) return { content: output, cleanup, conflicts };
    if (
      previous === undefined
      && current !== undefined
      && sha256(current) !== sha256(replacement.content)
      && !force
    ) {
      conflicts.push("File already exists and is not owned by Canonfig.");
    }
    return {
      content: replacement.content,
      cleanup: [{ kind: "replace" }],
      conflicts,
    };
  }

  if (output instanceof Uint8Array) {
    conflicts.push("Cannot merge text configuration into an existing binary file.");
    return { content: output, cleanup, conflicts };
  }
  let text = output ?? "";
  for (const artifact of artifacts) {
    if (artifact.kind === "managed-text") {
      const result = appendManagedText(
        text,
        artifact,
        force,
        conflicts,
        ownedBlockHashes.get(artifact.marker),
      );
      text = result.text;
      cleanup.push(result.cleanup);
    } else if (artifact.kind === "json") {
      const result = applyJsonArtifact(text, artifact, force, conflicts);
      text = result.text;
      cleanup.push(...result.cleanup);
    } else if (artifact.kind === "toml") {
      const result = applyTomlArtifact(text, artifact, force, conflicts);
      text = result.text;
      cleanup.push(...result.cleanup);
    }
  }
  return { content: text, cleanup, conflicts };
}
