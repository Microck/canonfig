import type { ConfigValue } from "../../domain/resource.ts";
import type { Diagnostic, Feature, RootContext } from "../harness.ts";
import type { CanonicalModel, TargetId } from "../model.ts";

export * from "./shared-documents.ts";
export * from "./shared-hooks.ts";
export * from "./shared-mcp.ts";

/** Date every adapter layout was last checked against its vendor documentation. */
export const VERIFIED_AT = "2026-11-03";

/** A structured config object, as it lands under an owned key. */
export type ConfigTable = Readonly<Record<string, ConfigValue>>;

/** One owned key and its value in a config surface's content. */
export interface ConfigEntry {
  readonly path: string;
  readonly value: ConfigValue;
}

/** `$XDG_CONFIG_HOME`, else `~/.config` (also on Windows, where XDG-style CLIs use it). */
export function xdgConfigHome(context: RootContext): string {
  return context.environment("XDG_CONFIG_HOME") ?? context.join(context.home, ".config");
}

/** `$XDG_DATA_HOME`, else `~/.local/share`. */
export function xdgDataHome(context: RootContext): string {
  return context.environment("XDG_DATA_HOME") ?? context.join(context.home, ".local", "share");
}

/** `$XDG_CACHE_HOME`, else `~/.cache`. */
export function xdgCacheHome(context: RootContext): string {
  return context.environment("XDG_CACHE_HOME") ?? context.join(context.home, ".cache");
}

/** `$XDG_STATE_HOME`, else `~/.local/state`. */
export function xdgStateHome(context: RootContext): string {
  return context.environment("XDG_STATE_HOME") ?? context.join(context.home, ".local", "state");
}

/** Absolute paths for entries directly under `root`. */
export function under(context: RootContext, root: string, names: ReadonlyArray<string>): Array<string> {
  return names.map((name) => context.join(root, name));
}

const FEATURE_ITEMS = {
  instructions: (model: CanonicalModel) => (model.instructions?.trim() ? 1 : 0),
  rules: (model: CanonicalModel) => model.rules.length,
  skills: (model: CanonicalModel) => model.skills.length,
  mcp: (model: CanonicalModel) => model.mcp.length,
  hooks: (model: CanonicalModel) => model.hooks.length,
  agents: (model: CanonicalModel) => model.agents.length,
  commands: (model: CanonicalModel) => model.commands.length,
} satisfies Record<Feature, (model: CanonicalModel) => number>;

/**
 * One warning per feature the model uses but the harness has no global
 * surface for. The feature is reported, never written somewhere else.
 */
export function unsupportedFeatures(
  harness: TargetId,
  model: CanonicalModel,
  features: ReadonlyArray<readonly [Feature, string]>,
): Array<Diagnostic> {
  return features
    .filter(([feature]) => FEATURE_ITEMS[feature](model) > 0)
    .map(([feature, reason]) => ({
      level: "warning",
      code: "FEATURE_UNSUPPORTED",
      harness,
      message: `${harness} has no global ${feature} surface: ${reason} The ${feature} were not projected.`,
    }));
}
