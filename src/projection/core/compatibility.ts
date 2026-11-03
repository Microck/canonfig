import type { CanonfigConfig } from "./schema.ts";
import type { Diagnostic, Feature, HarnessDescriptor, SupportLevel } from "./types.ts";

const FEATURE_LEVEL_WEIGHT = {
  native: 0,
  portable: 0,
  translated: 1,
  shim: 2,
  lossy: 3,
  unsupported: 4,
} satisfies Record<SupportLevel, number>;

/**
 * Adapter warnings that report a value the projection dropped, skipped,
 * rounded or re-typed. Strict mode rejects lossy mappings, so it turns these
 * into errors, which block apply.
 */
const LOSSY_DIAGNOSTIC_CODES: Record<string, true> = {
  MCP_OPTION_UNSUPPORTED: true,
  MCP_ENV_RENAME_UNSUPPORTED: true,
  MCP_ENV_PROJECT_UNSUPPORTED: true,
  MCP_OPTION_COERCED: true,
  MCP_TRANSPORT_UNSUPPORTED: true,
  HOOK_EVENT_UNSUPPORTED: true,
  HOOK_TIMEOUT_ROUNDED: true,
  HERMES_PROFILE_MCP_REQUIRED: true,
  HERMES_PROFILE_HOOKS_REQUIRED: true,
  HERMES_PROFILE_PERMISSIONS_REQUIRED: true,
  KIMI_PROFILE_HOOKS_REQUIRED: true,
  KIMI_PROFILE_PERMISSIONS_REQUIRED: true,
};

/** Canonical features a configuration uses; instructions are always present. */
export function usedFeatures(config: CanonfigConfig): Feature[] {
  const used: Feature[] = ["instructions"];
  if (config.instructions.rules.length > 0) used.push("rules");
  if (config.skills.roots.length > 0) used.push("skills");
  if (Object.keys(config.mcp.servers).length > 0) used.push("mcp");
  if (config.hooks.length > 0) used.push("hooks");
  if (config.agents.length > 0) used.push("agents");
  if (config.commands.length > 0) used.push("commands");
  if (config.permissions.rules.length > 0) used.push("permissions");
  return used;
}

/** One diagnostic per used feature a harness supports below native level. */
export function compatibilityDiagnostics(
  descriptor: HarnessDescriptor,
  features: Feature[],
  strict: boolean,
): Diagnostic[] {
  return features.flatMap((feature): Diagnostic[] => {
    const support = descriptor.capabilities[feature];
    if (support === "native" || support === "portable") return [];
    const strictFailure = strict && FEATURE_LEVEL_WEIGHT[support] >= FEATURE_LEVEL_WEIGHT.shim;
    const unsupported = support === "unsupported";
    return [{
      level: unsupported || strictFailure ? "error" : support === "translated" ? "info" : "warning",
      code: `FEATURE_${support.toUpperCase()}`,
      target: descriptor.id,
      message: `${descriptor.name}: ${feature} support is ${support}.`,
    }];
  });
}

/** Strict mode: raise every lossy adapter warning to an error. */
export function strictDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.map((diagnostic) =>
    diagnostic.level === "warning" && LOSSY_DIAGNOSTIC_CODES[diagnostic.code] === true
      ? { ...diagnostic, level: "error" as const, message: `${diagnostic.message} Strict mode rejects this lossy mapping.` }
      : diagnostic
  );
}
