import type { Agent, Capability } from "../core/schema.ts";
import type { TargetId } from "../core/types.ts";

const maps: Record<TargetId, Record<Capability, string[]>> = {
  codex: { read: ["read_file"], write: ["apply_patch"], search: ["grep", "glob"], shell: ["shell"], web: ["web_search"], mcp: ["mcp"], subagent: ["spawn_agent"], test: ["shell"], git: ["shell"] },
  "claude-code": { read: ["Read"], write: ["Edit", "Write"], search: ["Grep", "Glob"], shell: ["Bash"], web: ["WebFetch", "WebSearch"], mcp: [], subagent: ["Task"], test: ["Bash"], git: ["Bash"] },
  amp: { read: ["read"], write: ["edit", "write"], search: ["grep", "glob"], shell: ["Bash"], web: ["web"], mcp: ["mcp"], subagent: ["agent"], test: ["Bash"], git: ["Bash"] },
  "oh-my-pi": { read: ["read"], write: ["edit", "write"], search: ["search", "find"], shell: ["bash"], web: ["web_search"], mcp: ["mcp"], subagent: ["task"], test: ["bash"], git: ["bash"] },
  pi: { read: ["read"], write: ["edit", "write"], search: ["grep", "find"], shell: ["bash"], web: ["web"], mcp: ["mcp"], subagent: ["task"], test: ["bash"], git: ["bash"] },
  "factory-droid": { read: ["Read"], write: ["Edit", "Create", "ApplyPatch"], search: ["Grep", "Glob", "LS"], shell: ["Execute"], web: ["FetchUrl", "WebSearch"], mcp: ["mcp__.*"], subagent: ["Task"], test: ["Execute"], git: ["Execute"] },
  cursor: { read: ["Read"], write: ["Edit", "Write"], search: ["Grep", "Glob"], shell: ["Shell"], web: ["WebFetch", "WebSearch"], mcp: ["MCP"], subagent: ["Agent"], test: ["Shell"], git: ["Shell"] },
  devin: { read: ["read"], write: ["edit", "write"], search: ["grep", "glob"], shell: ["exec"], web: ["web"], mcp: ["mcp"], subagent: ["subagent"], test: ["exec"], git: ["exec"] },
  opencode: { read: ["read"], write: ["edit", "write"], search: ["grep", "glob"], shell: ["bash"], web: ["webfetch"], mcp: [], subagent: ["task"], test: ["bash"], git: ["bash"] },
  "grok-build": { read: ["Read"], write: ["Edit", "Write"], search: ["Grep", "Glob"], shell: ["Bash"], web: ["WebFetch", "WebSearch"], mcp: ["mcp__.*"], subagent: ["Agent"], test: ["Bash"], git: ["Bash"] },
  antigravity: { read: ["view_file"], write: ["write_to_file", "replace_file_content", "multi_replace_file_content"], search: ["grep_search", "find_by_name", "list_dir"], shell: ["run_command"], web: ["browser_*", "search_web"], mcp: ["mcp_*"], subagent: ["task"], test: ["run_command"], git: ["run_command"] },
  "copilot-cli": { read: ["Read"], write: ["Edit", "Write"], search: ["Grep", "Glob"], shell: ["Bash"], web: ["WebFetch", "WebSearch"], mcp: ["mcp__*"], subagent: ["Task"], test: ["Bash"], git: ["Bash"] },
};

export function nativeToolsForCapabilities(target: TargetId, capabilities: readonly Capability[]): string[] {
  return [...new Set(capabilities.flatMap((capability) => maps[target][capability]))];
}

export function nativeTools(target: TargetId, agent: Agent): string[] {
  return nativeToolsForCapabilities(target, agent.tools);
}
