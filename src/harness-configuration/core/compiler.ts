import path from "node:path";
import { BUILTIN_ADAPTERS } from "../adapters/index.ts";
import { commonArtifacts, enabledMcpServerEntries } from "../adapters/shared.ts";
import { configuredTargets, findRepositoryRoot, loadConfig, targetOptions } from "./config.ts";
import { CanonfigError } from "./errors.ts";
import { sha256 } from "./hash.ts";
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

function commonMcpProjectionDiagnostics(context: BuildContext): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [name, server] of enabledMcpServerEntries(context)) {
    const omitted: string[] = [];
    if (server.timeoutMs !== undefined) omitted.push("timeoutMs");
    if (server.enabledTools?.length) omitted.push("enabledTools");
    if (server.disabledTools?.length) omitted.push("disabledTools");
    if (omitted.length > 0) {
      diagnostics.push({
        level: "warning",
        code: "MCP_OPTION_UNSUPPORTED",
        path: ".mcp.json",
        message: `.mcp.json cannot represent ${omitted.join(", ")} for MCP server ${name}; those options were omitted.`,
      });
    }
  }
  return diagnostics;
}

function deduplicateExactReplaceArtifacts(
  artifacts: readonly DesiredArtifact[],
): DesiredArtifact[] {
  const seen = new Set<string>();
  const result: DesiredArtifact[] = [];
  for (const artifact of artifacts) {
    if (artifact.kind !== "replace") {
      result.push(artifact);
      continue;
    }
    const identity = [
      artifact.owner,
      artifact.path,
      artifact.mode ?? "",
      sha256(artifact.content),
    ].join("\0");
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(artifact);
  }
  return result;
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
    if (options.includeCommon !== false) {
      artifacts.push(...await commonArtifacts(commonContext));
      diagnostics.push(...commonMcpProjectionDiagnostics(commonContext));
    }

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

    return {
      root,
      configPath: loaded.path,
      targets,
      artifacts: deduplicateExactReplaceArtifacts(artifacts),
      diagnostics,
    };
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
