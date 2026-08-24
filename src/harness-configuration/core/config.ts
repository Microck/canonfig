import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { CanonfigConfigSchema, type CanonfigConfig } from "./schema.ts";
import { CanonfigError } from "./errors.ts";
import { TARGET_IDS, type TargetId } from "./types.ts";

export const CANONFIG_DIR = ".canonfig";
export const CONFIG_FILENAMES = ["harness.yaml", "harness.yml", "harness.json"] as const;
export const STATE_FILENAME = ".harness-state.json";

export async function findRepositoryRoot(start = process.cwd()): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    for (const filename of CONFIG_FILENAMES) {
      try { await fs.access(path.join(current, CANONFIG_DIR, filename)); return current; } catch { /* continue */ }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new CanonfigError("CONFIG_NOT_FOUND", `No ${CANONFIG_DIR}/harness.yaml found from ${path.resolve(start)} upward. Run \"canonfig harness init\" first.`);
    }
    current = parent;
  }
}

export async function findConfigFile(root: string): Promise<string> {
  for (const filename of CONFIG_FILENAMES) {
    const candidate = path.join(root, CANONFIG_DIR, filename);
    try { await fs.access(candidate); return candidate; } catch { /* continue */ }
  }
  throw new CanonfigError("CONFIG_NOT_FOUND", `Missing ${CANONFIG_DIR}/harness.yaml in ${root}`);
}

export async function loadConfig(root: string): Promise<{ config: CanonfigConfig; path: string }> {
  const configPath = await findConfigFile(root);
  const raw = await fs.readFile(configPath, "utf8");
  let parsed: unknown;
  try { parsed = configPath.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw); }
  catch (error) { throw new CanonfigError("CONFIG_PARSE", `Could not parse ${configPath}: ${String(error)}`, error); }

  const result = CanonfigConfigSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("\n");
    throw new CanonfigError("CONFIG_INVALID", `Invalid ${path.relative(root, configPath)}:\n${details}`, result.error);
  }
  return { config: result.data, path: configPath };
}

export function configuredTargets(config: CanonfigConfig): TargetId[] {
  if (Array.isArray(config.targets)) return [...config.targets];
  const targetMap = config.targets as Partial<Record<TargetId, { enabled: boolean }>>;
  return TARGET_IDS.filter((id) => targetMap[id]?.enabled === true);
}

export function targetOptions(config: CanonfigConfig, target: TargetId): Record<string, unknown> {
  const targetMap = config.targets as Partial<Record<TargetId, { options: Record<string, unknown> }>>;
  const direct = Array.isArray(config.targets) ? {} : (targetMap[target]?.options ?? {});
  return { ...direct, ...(config.extensions[target] ?? {}) };
}

export function parseTargetList(input: string | undefined): TargetId[] | undefined {
  if (!input) return undefined;
  const values = input.split(",").map((value) => value.trim()).filter(Boolean);
  const invalid = values.filter((value) => !TARGET_IDS.includes(value as TargetId));
  if (invalid.length > 0) throw new CanonfigError("TARGET_INVALID", `Unknown target(s): ${invalid.join(", ")}`);
  return [...new Set(values)] as TargetId[];
}
