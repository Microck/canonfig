import path from "node:path";
import { BUILTIN_ADAPTERS } from "../adapters/index.ts";
import { commonArtifacts } from "../adapters/shared.ts";
import { configuredTargets, findRepositoryRoot, loadConfig, targetOptions } from "./config.ts";
import { CanonfigError } from "./errors.ts";
import { createPlan } from "./planner.ts";
import type {
  BuildContext,
  DesiredArtifact,
  Diagnostic,
  Feature,
  HarnessAdapter,
  HarnessDescriptor,
  Plan,
  SupportLevel,
  TargetId,
} from "./types.ts";
import { validateProject } from "./validation.ts";

export interface CompileOptions {
  cwd?: string | undefined;
  root?: string | undefined;
  targets?: readonly TargetId[] | undefined;
  strict?: boolean | undefined;
  force?: boolean | undefined;
  includeCommon?: boolean | undefined;
}

export interface BuildProjectResult {
  root: string;
  configPath: string;
  targets: TargetId[];
  artifacts: DesiredArtifact[];
  diagnostics: Diagnostic[];
}

const FEATURE_LEVEL_WEIGHT: Record<SupportLevel, number> = {
  native: 0,
  portable: 0,
  translated: 1,
  shim: 2,
  lossy: 3,
  unsupported: 4,
};

function usedFeatures(config: BuildContext["config"]): Feature[] {
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

function compatibilityDiagnostics(
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

export class AdapterRegistry {
  readonly #adapters = new Map<TargetId, HarnessAdapter>();

  constructor(adapters: readonly HarnessAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: HarnessAdapter): this {
    if (this.#adapters.has(adapter.descriptor.id)) {
      throw new CanonfigError("ADAPTER_DUPLICATE", `An adapter is already registered for ${adapter.descriptor.id}.`);
    }
    this.#adapters.set(adapter.descriptor.id, adapter);
    return this;
  }

  replace(adapter: HarnessAdapter): this {
    this.#adapters.set(adapter.descriptor.id, adapter);
    return this;
  }

  get(id: TargetId): HarnessAdapter {
    const adapter = this.#adapters.get(id);
    if (!adapter) throw new CanonfigError("ADAPTER_MISSING", `No adapter is registered for ${id}.`);
    return adapter;
  }

  list(): HarnessAdapter[] {
    return [...this.#adapters.values()].sort((left, right) => left.descriptor.id.localeCompare(right.descriptor.id));
  }
}

export function createDefaultRegistry(): AdapterRegistry {
  return new AdapterRegistry(BUILTIN_ADAPTERS);
}

export class HarnessConfigurationCompiler {
  constructor(readonly registry: AdapterRegistry = createDefaultRegistry()) {}

  async build(options: CompileOptions = {}): Promise<BuildProjectResult> {
    const root = options.root
      ? path.resolve(options.root)
      : await findRepositoryRoot(options.cwd ?? process.cwd());
    const loaded = await loadConfig(root);
    const targets = [...new Set(options.targets ?? configuredTargets(loaded.config))];
    if (targets.length === 0) throw new CanonfigError("TARGET_EMPTY", "No enabled targets were selected.");

    const diagnostics = await validateProject(root, loaded.config);
    const artifacts: DesiredArtifact[] = [];
    const commonContext: BuildContext = {
      root,
      canonfigDir: path.join(root, ".canonfig"),
      config: loaded.config,
      target: targets[0]!,
      targetOptions: {},
    };
    if (options.includeCommon !== false) artifacts.push(...await commonArtifacts(commonContext));

    const features = usedFeatures(loaded.config);
    for (const target of targets) {
      const adapter = this.registry.get(target);
      diagnostics.push(...compatibilityDiagnostics(adapter.descriptor, features, options.strict ?? false));
      const context: BuildContext = {
        root,
        canonfigDir: path.join(root, ".canonfig"),
        config: loaded.config,
        target,
        targetOptions: targetOptions(loaded.config, target),
      };
      const result = await adapter.build(context);
      artifacts.push(...result.artifacts);
      diagnostics.push(...result.diagnostics);
    }

    return { root, configPath: loaded.path, targets, artifacts, diagnostics };
  }

  async plan(options: CompileOptions = {}): Promise<Plan> {
    const built = await this.build(options);
    return createPlan(
      built.root,
      built.targets,
      built.artifacts,
      built.diagnostics,
      { force: options.force ?? false },
    );
  }
}
