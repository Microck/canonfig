import type { ConfigValue } from "../../domain/resource.ts";
import type { Diagnostic, HarnessAdapter, SurfaceContent } from "../harness.ts";
import { markdownWithFrontmatter } from "../frontmatter.ts";
import type { AgentDocument, HookEvent, McpServer } from "../model.ts";
import {
  byEvent,
  type ConfigEntry,
  type ConfigTable,
  documentFiles,
  hookCommand,
  instructionsText,
  mcpTable,
  nativeHooks,
  secretTable,
  under,
  VERIFIED_AT,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";

const QWEN_EVENTS: ReadonlyMap<HookEvent, string> = new Map([
  ["session_start", "SessionStart"],
  ["session_end", "SessionEnd"],
  ["prompt_submit", "UserPromptSubmit"],
  ["before_tool", "PreToolUse"],
  ["after_tool", "PostToolUse"],
  ["before_compact", "PreCompact"],
  ["stop", "Stop"],
  ["subagent_start", "SubagentStart"],
  ["subagent_stop", "SubagentStop"],
]);

/** Qwen events that accept a matcher. */
const QWEN_MATCHER_EVENTS = new Set(["SessionStart", "SessionEnd", "PreToolUse", "PostToolUse", "PreCompact", "SubagentStart", "SubagentStop"]);

/**
 * `mcpServers` entries (docs/users/configuration/settings.md): streamable HTTP
 * uses `httpUrl`, SSE keeps `url`; `timeout` is in milliseconds and
 * `includeTools`/`excludeTools` filter tools. Qwen resolves `${VAR}` in settings.
 */
function qwenMcpServer(server: McpServer): ConfigTable {
  const fields: Array<[string, ConfigValue]> = [];
  if (server.transport === "stdio") {
    fields.push(["command", server.command]);
    if (server.args.length > 0) fields.push(["args", server.args]);
    if (server.cwd) fields.push(["cwd", server.cwd]);
    if (Object.keys(server.env).length > 0) fields.push(["env", secretTable(server.env, "shell")]);
  } else {
    fields.push([server.transport === "sse" ? "url" : "httpUrl", server.url]);
    if (Object.keys(server.headers).length > 0) fields.push(["headers", secretTable(server.headers, "shell")]);
  }
  if (server.timeoutMs !== undefined) fields.push(["timeout", server.timeoutMs]);
  if (server.enabledTools?.length) fields.push(["includeTools", server.enabledTools]);
  if (server.disabledTools?.length) fields.push(["excludeTools", server.disabledTools]);
  return Object.fromEntries(fields);
}

function qwenAgentMarkdown(agent: AgentDocument): string {
  const data: Array<[string, ConfigValue]> = [["name", agent.id], ["description", agent.description]];
  if (agent.model !== "inherit") data.push(["model", agent.model]);
  data.push(["tools", nativeTools("qwen", agent)]);
  if (!agent.writable) data.push(["disallowedTools", ["edit", "write_file"]]);
  return markdownWithFrontmatter(Object.fromEntries(data), agent.content);
}

export const qwenAdapter: HarnessAdapter = {
  descriptor: {
    id: "qwen",
    name: "Qwen Code",
    executables: ["qwen"],
    docs: [
      "https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/settings.md",
      "https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/config/storage.ts",
    ],
    verifiedAt: VERIFIED_AT,
    capabilities: {
      instructions: "native", rules: "translated", skills: "portable", mcp: "native",
      hooks: "native", agents: "native", commands: "native",
    },
    notes: ["Rules are linked from QWEN.md; skills go to the shared ~/.agents/skills/."],
  },
  layout(context) {
    const root = context.environment("QWEN_HOME") ?? context.join(context.home, ".qwen");
    return {
      root,
      surfaces: [
        { id: "instructions", kind: "file", target: context.join(root, "QWEN.md") },
        { id: "agents", kind: "directory", target: context.join(root, "agents") },
        { id: "commands", kind: "directory", target: context.join(root, "commands") },
        {
          id: "settings", kind: "config", target: context.join(root, "settings.json"), format: "json",
          keys: ["mcpServers", "hooks"], settings: { reserved: [] },
        },
      ],
      neverTouch: under(context, root, [
        "oauth_creds.json", "mcp-oauth-tokens.json", "google_accounts.json", ".env", "installation_id",
        "projects", "tmp", "memory.md", "file-history", "ide",
      ]),
      sharedSkills: true,
      // SkillManager user roots from SKILL_PROVIDER_CONFIG_DIRS in config/storage.ts.
      skillSources: [
        { path: context.join(root, "skills"), depth: 1 },
        { path: context.join(context.home, ".agents", "skills"), depth: 1, shared: true },
      ],
    };
  },
  project(model, _layout, runtime) {
    const contents: Array<SurfaceContent> = [];
    const diagnostics: Array<Diagnostic> = [];

    const instructions = instructionsText(model, true);
    if (instructions) contents.push({ kind: "file", surface: "instructions", content: instructions });
    if (model.agents.length > 0) contents.push({ kind: "directory", surface: "agents", files: documentFiles(model.agents, ".md", qwenAgentMarkdown) });
    if (model.commands.length > 0) {
      contents.push({
        kind: "directory", surface: "commands",
        files: documentFiles(model.commands, ".md", (command) => markdownWithFrontmatter({ description: command.description }, command.content)),
      });
    }

    // Qwen hook timeouts are milliseconds.
    const hooks = byEvent(nativeHooks("qwen", model.hooks, QWEN_EVENTS, diagnostics).map(({ hook, event }) => {
      const entry: Array<[string, ConfigValue]> = [];
      if (QWEN_MATCHER_EVENTS.has(event)) entry.push(["matcher", "*"]);
      entry.push(["hooks", [{ type: "command", command: hookCommand(runtime, "qwen", hook), timeout: hook.timeoutMs }]]);
      return [event, Object.fromEntries(entry)];
    }));

    const keys: Array<ConfigEntry> = [];
    if (model.mcp.length > 0) keys.push({ path: "mcpServers", value: mcpTable(model.mcp, qwenMcpServer) });
    if (Object.keys(hooks).length > 0) keys.push({ path: "hooks", value: hooks });
    if (keys.length > 0) contents.push({ kind: "config", surface: "settings", keys });
    return { contents, diagnostics };
  },
};
