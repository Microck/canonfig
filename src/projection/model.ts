import type { ConfigValue } from "../domain/resource.ts";

/**
 * The Canonical Model: everything `~/.canonfig/` says, after `local/` is
 * merged in. `folder.ts` builds it; adapters read it and never touch the disk.
 */

export const TARGET_IDS = [
  "codex", "claude-code", "amp", "oh-my-pi", "pi", "factory-droid",
  "cursor", "devin", "opencode", "grok-build", "antigravity", "copilot-cli",
  "kimi", "kilo", "hermes", "qwen",
] as const;

export type TargetId = (typeof TARGET_IDS)[number];

export const HOOK_EVENTS = [
  "session_start", "session_end", "prompt_submit", "before_agent", "after_agent",
  "before_tool", "after_tool", "before_compact", "after_compact", "stop",
  "subagent_start", "subagent_stop",
] as const;

export const CAPABILITIES = [
  "read", "write", "search", "shell", "web", "mcp", "subagent", "test", "git",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];
export type Capability = (typeof CAPABILITIES)[number];

/** An environment reference; MCP secrets stay references and are never copied. */
export interface SecretReference {
  readonly fromEnv: string;
  readonly default?: string | undefined;
}

export type SecretValue = string | SecretReference;

interface McpBase {
  readonly timeoutMs?: number | undefined;
  readonly enabledTools?: ReadonlyArray<string> | undefined;
  readonly disabledTools?: ReadonlyArray<string> | undefined;
}

export interface StdioMcpServer extends McpBase {
  readonly transport: "stdio";
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env: Readonly<Record<string, SecretValue>>;
}

export interface RemoteMcpServer extends McpBase {
  readonly transport: "streamable-http" | "sse";
  readonly url: string;
  readonly headers: Readonly<Record<string, SecretValue>>;
}

export type McpServer = StdioMcpServer | RemoteMcpServer;

export interface HookMatcher {
  readonly capabilities: ReadonlyArray<Capability>;
  readonly tools: ReadonlyArray<string>;
  readonly inputRegex?: string | undefined;
}

/**
 * One enabled hook. `run[0]` is absolute when it names a script under the
 * folder's `hooks/` directory, so the hook runner works from any directory.
 */
export interface Hook {
  readonly id: string;
  readonly event: HookEvent;
  readonly matcher: HookMatcher;
  readonly run: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly onFailure: "block" | "warn" | "ignore";
}

export interface RuleDocument {
  readonly id: string;
  readonly description?: string | undefined;
  readonly paths: ReadonlyArray<string>;
  readonly activation?: "always" | "path" | "manual" | "model" | undefined;
  /** Body without frontmatter. */
  readonly content: string;
  /** Absolute path of the authored file, for harnesses that link rules by path. */
  readonly source: string;
}

export interface AgentDocument {
  readonly id: string;
  readonly description: string;
  /** `inherit` leaves the harness default. */
  readonly model: string;
  readonly tools: ReadonlyArray<Capability>;
  readonly writable: boolean;
  readonly content: string;
}

export interface CommandDocument {
  readonly id: string;
  readonly description: string;
  readonly argumentHint?: string | undefined;
  readonly content: string;
}

export interface SkillFile {
  /** Relative to the skill directory, forward slashes. */
  readonly path: string;
  readonly content: Uint8Array;
  readonly executable: boolean;
}

export interface SkillTree {
  readonly name: string;
  readonly description: string;
  readonly files: ReadonlyArray<SkillFile>;
}

export interface SettingsKey {
  /** Config key path with `.` between segments (`\.` escapes a dot). */
  readonly path: string;
  readonly value: ConfigValue;
}

/** Declared `settings.<harness>` keys, sorted by path, per harness. */
export type HarnessSettings = Readonly<Partial<Record<TargetId, ReadonlyArray<SettingsKey>>>>;

export interface CanonicalModel {
  /** Absolute path of the Canonical Folder. */
  readonly folder: string;
  /** Selected harnesses: listed in `canonfig.jsonc`, minus local exclusions. */
  readonly harnesses: ReadonlyArray<TargetId>;
  readonly instructions?: string | undefined;
  readonly rules: ReadonlyArray<RuleDocument>;
  readonly skills: ReadonlyArray<SkillTree>;
  readonly agents: ReadonlyArray<AgentDocument>;
  readonly commands: ReadonlyArray<CommandDocument>;
  /** Enabled hooks only. */
  readonly hooks: ReadonlyArray<Hook>;
  /** Enabled servers only, sorted by name. */
  readonly mcp: ReadonlyArray<readonly [string, McpServer]>;
  readonly settings: HarnessSettings;
}
