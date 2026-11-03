import type { TargetId } from "./types.ts";

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

export interface SecretReference {
  fromEnv: string;
  default?: string;
}

export type SecretValue = string | SecretReference;

interface McpBase {
  enabled: boolean;
  timeoutMs?: number;
  enabledTools?: string[];
  disabledTools?: string[];
}

export interface StdioMcpServer extends McpBase {
  transport: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, SecretValue>;
}

export interface RemoteMcpServer extends McpBase {
  transport: "streamable-http" | "sse";
  url: string;
  headers: Record<string, SecretValue>;
}

export type McpServer = StdioMcpServer | RemoteMcpServer;

export interface HookMatcher {
  capabilities: Capability[];
  tools: string[];
  inputRegex?: string;
}

export interface Hook {
  id: string;
  event: HookEvent;
  enabled: boolean;
  matcher: HookMatcher;
  run: string[];
  timeoutMs: number;
  onFailure: "block" | "warn" | "ignore";
}

export interface Rule {
  id: string;
  file: string;
  paths: string[];
  activation?: "always" | "path" | "manual" | "model";
  description?: string;
}

export interface Agent {
  id: string;
  file: string;
  description: string;
  model: string;
  tools: Capability[];
  writable: boolean;
}

export interface Command {
  id: string;
  file: string;
  description: string;
  argumentHint?: string;
}

export interface PermissionRule {
  pattern: string;
  action: "allow" | "ask" | "deny";
  reason?: string;
}

export interface TargetEntry {
  enabled: boolean;
  options: Record<string, unknown>;
}

export interface CanonfigConfig {
  version: 1;
  project: { name?: string };
  targets: TargetId[] | Partial<Record<TargetId, TargetEntry>>;
  instructions: {
    root: string;
    rules: Rule[];
  };
  skills: { roots: string[] };
  mcp: { servers: Record<string, McpServer> };
  hooks: Hook[];
  agents: Agent[];
  commands: Command[];
  permissions: { rules: PermissionRule[] };
  extensions: Partial<Record<TargetId, Record<string, unknown>>>;
}
