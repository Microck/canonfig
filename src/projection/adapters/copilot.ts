import type { ConfigValue } from "../../domain/resource.ts";
import type { HarnessAdapter, SurfaceContent } from "../harness.ts";
import { markdownWithFrontmatter } from "../frontmatter.ts";
import type { HookEvent, McpServer } from "../model.ts";
import {
  agentMarkdown,
  byEvent,
  type ConfigTable,
  documentFiles,
  hookCommand,
  hookTimeoutSeconds,
  instructionsText,
  jsonFile,
  mcpGapDiagnostics,
  mcpTable,
  nativeHooks,
  secretTable,
  skillDirectoryFiles,
  under,
  unsupportedFeatures,
  VERIFIED_AT,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";

/** https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks */
const COPILOT_EVENTS: ReadonlyMap<HookEvent, string> = new Map([
  ["session_start", "sessionStart"],
  ["session_end", "sessionEnd"],
  ["prompt_submit", "userPromptSubmitted"],
  ["before_tool", "preToolUse"],
  ["after_tool", "postToolUse"],
  ["stop", "agentStop"],
  ["subagent_start", "subagentStart"],
  ["subagent_stop", "subagentStop"],
  ["before_compact", "preCompact"],
]);

/**
 * `~/.copilot/mcp-config.json` entries
 * (https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers):
 * `type` is `local`, `http` or `sse`, and `tools` is the allowlist. The page
 * shows no environment reference syntax; references use `${VAR}` (unverified).
 */
function copilotMcpServer(server: McpServer): ConfigTable {
  const fields: Array<[string, ConfigValue]> = [];
  if (server.transport === "stdio") {
    fields.push(["type", "local"], ["command", server.command], ["args", server.args]);
    if (Object.keys(server.env).length > 0) fields.push(["env", secretTable(server.env, "shell")]);
  } else {
    fields.push(["type", server.transport === "sse" ? "sse" : "http"], ["url", server.url]);
    if (Object.keys(server.headers).length > 0) fields.push(["headers", secretTable(server.headers, "shell")]);
  }
  fields.push(["tools", server.enabledTools?.length ? server.enabledTools : ["*"]]);
  return Object.fromEntries(fields);
}

export const copilotAdapter: HarnessAdapter = {
  descriptor: {
    id: "copilot-cli",
    name: "GitHub Copilot CLI",
    executables: ["copilot"],
    docs: [
      "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference",
      "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks",
      "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers",
    ],
    verifiedAt: VERIFIED_AT,
    capabilities: {
      instructions: "native", rules: "native", skills: "native", mcp: "native",
      hooks: "native", agents: "native", commands: "unsupported",
    },
  },
  layout(context) {
    const root = context.environment("COPILOT_HOME") ?? context.join(context.home, ".copilot");
    return {
      root,
      surfaces: [
        { id: "instructions", kind: "file", target: context.join(root, "copilot-instructions.md") },
        { id: "rules", kind: "directory", target: context.join(root, "instructions") },
        { id: "skills", kind: "directory", target: context.join(root, "skills") },
        { id: "agents", kind: "directory", target: context.join(root, "agents") },
        { id: "hooks", kind: "file", target: context.join(root, "hooks", "canonfig.json") },
        { id: "mcp", kind: "config", target: context.join(root, "mcp-config.json"), format: "json", keys: ["mcpServers"] },
        {
          id: "settings", kind: "config", target: context.join(root, "settings.json"), format: "json",
          keys: [], settings: { reserved: [] },
        },
      ],
      neverTouch: under(context, root, [
        "config.json", "mcp-oauth-config", "mcp-secrets", "session-state", "session-store.db",
        "command-history-state", "logs", "ide", "plugin-data", "permissions-config.json", "providers.json",
      ]),
      sharedSkills: false,
      skillSources: [
        { path: context.join(root, "skills"), depth: 1 },
        { path: context.join(context.home, ".agents", "skills"), depth: 1, shared: true },
      ],
    };
  },
  project(model, _layout, runtime) {
    const contents: Array<SurfaceContent> = [];
    const diagnostics = [
      ...unsupportedFeatures("copilot-cli", model, [["commands", "Copilot CLI has no global command directory."]]),
      ...mcpGapDiagnostics("copilot-cli", model.mcp, ["timeoutMs", "disabledTools", "cwd"]),
    ];

    const instructions = instructionsText(model, false);
    if (instructions) contents.push({ kind: "file", surface: "instructions", content: instructions });
    if (model.rules.length > 0) {
      contents.push({
        kind: "directory", surface: "rules",
        files: documentFiles(model.rules, ".instructions.md", (rule) => markdownWithFrontmatter({
          description: rule.description ?? `Canonfig rule: ${rule.id}`,
          applyTo: rule.paths.length > 0 ? rule.paths.join(",") : "**",
        }, rule.content)),
      });
    }
    if (model.skills.length > 0) contents.push({ kind: "directory", surface: "skills", files: skillDirectoryFiles(model.skills) });
    if (model.agents.length > 0) {
      contents.push({
        kind: "directory", surface: "agents",
        files: documentFiles(model.agents, ".agent.md", (agent) => agentMarkdown(agent, nativeTools("copilot-cli", agent))),
      });
    }

    const hooks = byEvent(nativeHooks("copilot-cli", model.hooks, COPILOT_EVENTS, diagnostics).map(({ hook, event }) => {
      const command = hookCommand(runtime, "copilot-cli", hook);
      const entry: Array<[string, ConfigValue]> = [
        ["type", "command"],
        ["bash", command],
        ["powershell", command],
        ["timeoutSec", hookTimeoutSeconds("copilot-cli", hook, diagnostics)],
      ];
      if (event === "preToolUse" || event === "postToolUse") entry.push(["matcher", ".*"]);
      return [event, Object.fromEntries(entry)];
    }));
    if (Object.keys(hooks).length > 0) contents.push({ kind: "file", surface: "hooks", content: jsonFile({ version: 1, hooks }) });

    if (model.mcp.length > 0) {
      contents.push({ kind: "config", surface: "mcp", keys: [{ path: "mcpServers", value: mcpTable(model.mcp, copilotMcpServer) }] });
    }
    return { contents, diagnostics };
  },
};
