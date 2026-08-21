import type { CanonfigConfig } from "./schema.ts";

export const TARGET_IDS = [
  "codex", "claude-code", "amp", "oh-my-pi", "pi", "factory-droid",
  "cursor", "devin", "opencode", "grok-build", "antigravity", "copilot-cli",
] as const;

export type TargetId = (typeof TARGET_IDS)[number];
export type ArtifactOwner = TargetId | "common";
export type SupportLevel = "native" | "portable" | "translated" | "shim" | "lossy" | "unsupported";
export type Feature = "instructions" | "rules" | "skills" | "mcp" | "hooks" | "agents" | "commands" | "permissions";

export interface HarnessDescriptor {
  id: TargetId;
  name: string;
  executables: readonly string[];
  docs: readonly string[];
  verifiedAt: string;
  capabilities: Readonly<Record<Feature, SupportLevel>>;
  notes?: readonly string[];
}

export interface Diagnostic {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
  target?: TargetId;
  path?: string;
}

export type JsonPath = readonly string[];

export interface ReplaceArtifact {
  kind: "replace";
  path: string;
  owner: ArtifactOwner;
  content: string | Uint8Array;
  mode?: number;
  description?: string;
}

export interface ManagedTextArtifact {
  kind: "managed-text";
  path: string;
  owner: ArtifactOwner;
  content: string;
  marker: string;
  comments: "html" | "hash" | "slash";
  placement?: "start" | "end";
  description?: string;
}

export interface JsonDefaultsOperation {
  kind: "defaults";
  entries: ReadonlyArray<{ path: JsonPath; value: unknown }>;
}

export interface JsonManagedMapOperation {
  kind: "managed-map";
  path: JsonPath;
  entries: Readonly<Record<string, unknown>>;
  collision?: "error" | "replace";
}

export interface JsonManagedArrayOperation {
  kind: "managed-array";
  path: JsonPath;
  values: readonly unknown[];
  identity?: string;
}

export interface JsonManagedHooksOperation {
  kind: "managed-hooks";
  path: JsonPath;
  hooks: Readonly<Record<string, readonly unknown[]>>;
  marker: string;
}

export type JsonOperation =
  | JsonDefaultsOperation
  | JsonManagedMapOperation
  | JsonManagedArrayOperation
  | JsonManagedHooksOperation;

export interface JsonArtifact {
  kind: "json";
  path: string;
  owner: ArtifactOwner;
  operations: readonly JsonOperation[];
  rootDefaults?: Readonly<Record<string, unknown>>;
  description?: string;
}

export interface TomlManagedBlock {
  marker: string;
  content: string;
}

export interface TomlEnsureKey {
  section: string;
  key: string;
  value: string;
  marker: string;
  collision?: "error" | "replace";
}

export interface TomlArtifact {
  kind: "toml";
  path: string;
  owner: ArtifactOwner;
  blocks?: readonly TomlManagedBlock[];
  ensureKeys?: readonly TomlEnsureKey[];
  description?: string;
}

export type DesiredArtifact = ReplaceArtifact | ManagedTextArtifact | JsonArtifact | TomlArtifact;

export interface ManagedTextCleanup {
  kind: "managed-text";
  marker: string;
  comments: ManagedTextArtifact["comments"];
  blockHash: string;
}
export interface JsonManagedMapCleanup {
  kind: "json-managed-map";
  path: string[];
  entries: Record<string, unknown>;
  originals: Record<string, { existed: boolean; value?: unknown }>;
}
export interface JsonManagedArrayCleanup {
  kind: "json-managed-array"; path: string[]; values: unknown[]; identity?: string;
}
export interface JsonManagedHooksCleanup {
  kind: "json-managed-hooks";
  path: string[];
  marker: string;
  events?: string[];
  originals?: Record<string, { existed: boolean; value?: unknown }>;
}
export interface TomlBlockCleanup { kind: "toml-block"; marker: string; blockHash: string; }
export interface TomlKeyCleanup {
  kind: "toml-key"; section: string; key: string; marker: string; originalLine?: string;
}
export interface ReplaceCleanup { kind: "replace"; }

export type CleanupInstruction =
  | ManagedTextCleanup | JsonManagedMapCleanup | JsonManagedArrayCleanup
  | JsonManagedHooksCleanup | TomlBlockCleanup | TomlKeyCleanup | ReplaceCleanup;

export interface ArtifactState {
  owner: ArtifactOwner;
  hash: string;
  existedBefore: boolean;
  mode?: number;
  cleanup: CleanupInstruction[];
}

export interface CanonfigState {
  version: 1;
  generatedAt: string;
  canonfigVersion: string;
  artifacts: Record<string, ArtifactState>;
}

export type PlanAction = "create" | "update" | "delete" | "unchanged" | "conflict";

export interface PlanEntry {
  path: string;
  owner: ArtifactOwner;
  action: PlanAction;
  reason?: string | undefined;
  before?: string | undefined;
  after?: string | undefined;
  content?: string | Uint8Array | undefined;
  binary?: boolean | undefined;
  mode?: number | undefined;
  nextState?: ArtifactState | undefined;
}

export interface Plan {
  root: string;
  targets: TargetId[];
  entries: PlanEntry[];
  diagnostics: Diagnostic[];
  nextState: CanonfigState;
}

export interface BuildContext {
  root: string;
  canonfigDir: string;
  config: CanonfigConfig;
  target: TargetId;
  targetOptions: Record<string, unknown>;
}

export interface BuildResult { artifacts: DesiredArtifact[]; diagnostics: Diagnostic[]; }
export interface HarnessAdapter {
  descriptor: HarnessDescriptor;
  build(context: BuildContext): Promise<BuildResult>;
}
