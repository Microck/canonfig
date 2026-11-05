import type { ConfigValue } from "../../domain/resource.ts";
import type { Diagnostic, HarnessAdapter, SurfaceContent } from "../harness.ts";
import type { McpServer } from "../model.ts";
import { PI_PLUGIN_EVENTS, piPluginSource } from "../templates/runtime.ts";
import {
  commandMarkdown,
  type ConfigTable,
  documentFiles,
  instructionsText,
  mcpGapDiagnostics,
  mcpTable,
  mcpTimeoutSeconds,
  nativeHooks,
  secretTable,
  skillDirectoryFiles,
  under,
  unsupportedFeatures,
  VERIFIED_AT,
} from "./shared.ts";

/**
 * Pi's built-in MCP client (https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md):
 * `command` selects stdio and `url` selects streamable HTTP; `timeout` is in
 * seconds; SSE is rejected, so SSE servers are reported and left out.
 */
function piMcpServer(server: McpServer, name: string, diagnostics: Array<Diagnostic>): ConfigTable | undefined {
  if (server.transport === "sse") {
    diagnostics.push({
      level: "warning", code: "MCP_TRANSPORT_UNSUPPORTED", harness: "pi",
      message: `Pi rejects the legacy SSE transport, so MCP server ${name} was not projected.`,
    });
    return undefined;
  }
  const fields: Array<[string, ConfigValue]> = [];
  if (server.transport === "stdio") {
    fields.push(["command", server.command], ["args", server.args]);
    if (Object.keys(server.env).length > 0) fields.push(["env", secretTable(server.env, "shell")]);
    if (server.cwd) fields.push(["cwd", server.cwd]);
  } else {
    fields.push(["url", server.url]);
    if (Object.keys(server.headers).length > 0) fields.push(["headers", secretTable(server.headers, "shell")]);
  }
  if (server.timeoutMs !== undefined) fields.push(["timeout", mcpTimeoutSeconds("pi", name, server.timeoutMs, diagnostics)]);
  return Object.fromEntries(fields);
}

export const piAdapter: HarnessAdapter = {
  descriptor: {
    id: "pi",
    name: "Pi Coding Agent",
    executables: ["pi"],
    docs: [
      "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md",
      "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md",
    ],
    verifiedAt: VERIFIED_AT,
    capabilities: {
      instructions: "native", rules: "translated", skills: "native", mcp: "native",
      hooks: "shim", agents: "unsupported", commands: "native",
    },
    notes: [
      "Rules are linked from AGENTS.md; commands are prompt templates in prompts/.",
      "Lifecycle hooks compile to a Pi extension.",
    ],
  },
  layout(context) {
    const root = context.environment("PI_CODING_AGENT_DIR") ?? context.join(context.home, ".pi", "agent");
    return {
      root,
      surfaces: [
        { id: "instructions", kind: "file", target: context.join(root, "AGENTS.md") },
        { id: "skills", kind: "directory", target: context.join(root, "skills") },
        { id: "prompts", kind: "directory", target: context.join(root, "prompts") },
        { id: "extension", kind: "file", target: context.join(root, "extensions", "canonfig.ts") },
        { id: "mcp", kind: "config", target: context.join(root, "mcp.json"), format: "json", keys: ["mcpServers"] },
        {
          id: "settings", kind: "config", target: context.join(root, "settings.json"), format: "json",
          keys: [], settings: { reserved: [] },
        },
      ],
      neverTouch: under(context, root, ["auth.json", "mcp-auth.json", "models.json", "sessions", "logs"]),
      sharedSkills: false,
    };
  },
  project(model, _layout, runtime) {
    const contents: Array<SurfaceContent> = [];
    const diagnostics = [
      ...unsupportedFeatures("pi", model, [["agents", "Pi has no subagent definitions."]]),
      ...mcpGapDiagnostics("pi", model.mcp, ["enabledTools", "disabledTools"]),
    ];

    const instructions = instructionsText(model, true);
    if (instructions) contents.push({ kind: "file", surface: "instructions", content: instructions });
    if (model.skills.length > 0) contents.push({ kind: "directory", surface: "skills", files: skillDirectoryFiles(model.skills) });
    if (model.commands.length > 0) {
      contents.push({ kind: "directory", surface: "prompts", files: documentFiles(model.commands, ".md", commandMarkdown) });
    }

    const hooks = nativeHooks("pi", model.hooks, PI_PLUGIN_EVENTS, diagnostics);
    if (hooks.length > 0) contents.push({ kind: "file", surface: "extension", content: piPluginSource("pi", runtime.hookRunner, hooks) });

    const servers = mcpTable(model.mcp, (server, name) => piMcpServer(server, name, diagnostics));
    if (Object.keys(servers).length > 0) contents.push({ kind: "config", surface: "mcp", keys: [{ path: "mcpServers", value: servers }] });
    return { contents, diagnostics };
  },
};
