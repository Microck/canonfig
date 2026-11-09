import { Predicate } from "effect";

import type { ConfigValue } from "../../domain/resource.ts";
import type { HarnessAdapter, SurfaceContent } from "../harness.ts";
import { markdownWithFrontmatter } from "../frontmatter.ts";
import type { AgentDocument, HookEvent, McpServer } from "../model.ts";
import {
  type ConfigTable,
  documentFiles,
  hookCommand,
  hookTimeoutSeconds,
  instructionsText,
  mcpTable,
  nativeHooks,
  secretTable,
  secretValue,
  under,
  unsupportedFeatures,
  VERIFIED_AT,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";

/** https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/hooks.md (event reference). */
const KIMI_EVENTS: ReadonlyMap<HookEvent, string> = new Map([
  ["session_start", "SessionStart"],
  ["session_end", "SessionEnd"],
  ["prompt_submit", "UserPromptSubmit"],
  ["before_tool", "PreToolUse"],
  ["after_tool", "PostToolUse"],
  ["before_compact", "PreCompact"],
  ["after_compact", "PostCompact"],
  ["stop", "Stop"],
  ["subagent_start", "SubagentStart"],
  ["subagent_stop", "SubagentStop"],
]);

/**
 * Kimi's mcp.json entry. An `Authorization` header that is a bare
 * environment reference maps to `bearerTokenEnvVar`; other references use
 * `${VAR}`.
 */
function kimiMcpServer(server: McpServer): ConfigTable {
  const fields: Array<[string, ConfigValue]> = [];
  if (server.transport === "stdio") {
    fields.push(["transport", "stdio"], ["command", server.command]);
    if (server.args.length > 0) fields.push(["args", server.args]);
    if (Object.keys(server.env).length > 0) fields.push(["env", secretTable(server.env, "shell")]);
    if (server.cwd !== undefined) fields.push(["cwd", server.cwd]);
  } else {
    fields.push(["transport", server.transport === "sse" ? "sse" : "http"], ["url", server.url]);
    const headers: Array<[string, string]> = [];
    for (const [name, value] of Object.entries(server.headers)) {
      if (name.toLowerCase() === "authorization" && !Predicate.isString(value) && value.default === undefined) {
        fields.push(["bearerTokenEnvVar", value.fromEnv]);
      } else {
        headers.push([name, secretValue(value, "shell")]);
      }
    }
    if (headers.length > 0) fields.push(["headers", Object.fromEntries(headers)]);
  }
  if (server.timeoutMs !== undefined) fields.push(["startupTimeoutMs", server.timeoutMs], ["toolTimeoutMs", server.timeoutMs]);
  if (server.enabledTools?.length) fields.push(["enabledTools", server.enabledTools]);
  if (server.disabledTools?.length) fields.push(["disabledTools", server.disabledTools]);
  return Object.fromEntries(fields);
}

function kimiAgentMarkdown(agent: AgentDocument): string {
  const tools = nativeTools("kimi", agent);
  const data: Array<[string, ConfigValue]> = [["name", agent.id], ["description", agent.description], ["tools", tools]];
  if (agent.model !== "inherit") data.push(["model", agent.model]);
  if (!agent.writable && tools.some((tool) => tool === "Edit" || tool === "Write")) data.push(["disallowedTools", ["Edit", "Write"]]);
  return markdownWithFrontmatter(Object.fromEntries(data), agent.content);
}

export const kimiAdapter: HarnessAdapter = {
  descriptor: {
    id: "kimi",
    name: "Kimi Code CLI",
    executables: ["kimi"],
    docs: [
      "https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/data-locations.md",
      "https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/config-files.md",
      "https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/hooks.md",
      "https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/agents.md",
      "https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/mcp.md",
    ],
    verifiedAt: VERIFIED_AT,
    capabilities: {
      instructions: "native", rules: "translated", skills: "portable", mcp: "native",
      hooks: "native", agents: "native", commands: "unsupported",
    },
    notes: ["Rules are linked from AGENTS.md; skills go to the shared ~/.agents/skills/."],
  },
  layout(context) {
    const root = context.environment("KIMI_CODE_HOME") ?? context.join(context.home, ".kimi-code");
    return {
      root,
      surfaces: [
        { id: "instructions", kind: "file", target: context.join(root, "AGENTS.md") },
        { id: "agents", kind: "directory", target: context.join(root, "agents") },
        { id: "mcp", kind: "config", target: context.join(root, "mcp.json"), format: "json", keys: ["mcpServers"] },
        // `permission.rules` is owned only when declared; `providers` and the
        // built-in services hold API keys.
        {
          id: "config", kind: "config", target: context.join(root, "config.toml"), format: "toml",
          keys: ["hooks"], settings: { reserved: ["providers", "services.*.api_key"] },
        },
      ],
      neverTouch: under(context, root, ["credentials", "sessions", "session_index.jsonl", "user-history", "logs", "bin"]),
      sharedSkills: true,
      // KIMI_CODE_HOME relocates private skills, but not the generic shared root.
      skillSources: [
        { path: context.join(root, "skills"), depth: 64, flat: true },
        { path: context.join(context.home, ".agents", "skills"), depth: 64, shared: true, flat: true },
      ],
    };
  },
  project(model, _layout, runtime) {
    const contents: Array<SurfaceContent> = [];
    const diagnostics = unsupportedFeatures("kimi", model, [["commands", "Kimi has no global command directory."]]);

    const instructions = instructionsText(model, true);
    if (instructions) contents.push({ kind: "file", surface: "instructions", content: instructions });
    if (model.agents.length > 0) contents.push({ kind: "directory", surface: "agents", files: documentFiles(model.agents, ".md", kimiAgentMarkdown) });

    // config.toml `[[hooks]]`: one table per hook with `event`, `matcher`,
    // `command` and `timeout` in seconds (config-files.md, hooks.md).
    const hooks = nativeHooks("kimi", model.hooks, KIMI_EVENTS, diagnostics).map(({ hook, event }) => ({
      event,
      command: hookCommand(runtime, "kimi", hook),
      timeout: hookTimeoutSeconds("kimi", hook, diagnostics),
    }));
    if (hooks.length > 0) contents.push({ kind: "config", surface: "config", keys: [{ path: "hooks", value: hooks }] });

    if (model.mcp.length > 0) {
      contents.push({ kind: "config", surface: "mcp", keys: [{ path: "mcpServers", value: mcpTable(model.mcp, kimiMcpServer) }] });
    }
    return { contents, diagnostics };
  },
};
