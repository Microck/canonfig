import type { Feature, HarnessDescriptor, SupportLevel, TargetId } from "../core/types.ts";

export function descriptor(
  id: TargetId,
  name: string,
  executables: readonly string[],
  docs: readonly string[],
  capabilities: Partial<Record<Feature, SupportLevel>>,
  notes: readonly string[] = [],
  verifiedAt = "2026-08-18",
): HarnessDescriptor {
  return {
    id, name, executables, docs, verifiedAt,
    capabilities: {
      instructions: "portable", rules: "translated", skills: "portable", mcp: "native",
      hooks: "native", agents: "native", commands: "native", permissions: "unsupported", ...capabilities,
    },
    ...(notes.length ? { notes } : {}),
  };
}
