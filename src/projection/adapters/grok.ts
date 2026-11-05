import type { ConfigValue } from "../../domain/resource.ts";
import type { Diagnostic, HarnessAdapter, SurfaceContent } from "../harness.ts";
import type { McpServer } from "../model.ts";
import {
  agentMarkdown,
  claudeStyleHooks,
  type ConfigTable,
  documentFiles,
  GROK_EVENTS,
  instructionsText,
  jsonFile,
  mcpGapDiagnostics,
  mcpTable,
  mcpTimeoutSeconds,
  nativeHooks,
  secretTable,
  under,
  unsupportedFeatures,
  VERIFIED_AT,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";

/**
 * `[mcp_servers.<name>]` per https://docs.x.ai/build/features/mcp-servers:
 * Grok expands `${VAR}` in `env` and `headers`; timeouts are whole seconds.
 */
function grokMcpServer(server: McpServer, name: string, diagnostics: Array<Diagnostic>): ConfigTable {
  const fields: Array<[string, ConfigValue]> = [];
  if (server.transport === "stdio") {
    fields.push(["command", server.command]);
    if (server.args.length > 0) fields.push(["args", server.args]);
    if (server.cwd) fields.push(["cwd", server.cwd]);
    if (Object.keys(server.env).length > 0) fields.push(["env", secretTable(server.env, "shell")]);
  } else {
    fields.push(["url", server.url]);
    if (Object.keys(server.headers).length > 0) fields.push(["headers", secretTable(server.headers, "shell")]);
  }
  if (server.timeoutMs !== undefined) {
    const seconds = mcpTimeoutSeconds("grok-build", name, server.timeoutMs, diagnostics);
    fields.push(["startup_timeout_sec", seconds], ["tool_timeout_sec", seconds]);
  }
  return Object.fromEntries(fields);
}

export const grokAdapter: HarnessAdapter = {
  descriptor: {
    id: "grok-build",
    name: "Grok Build CLI",
    executables: ["grok"],
    docs: [
      "https://docs.x.ai/build/settings/reference",
      "https://docs.x.ai/build/features/mcp-servers",
      "https://docs.x.ai/build/features/hooks",
    ],
    verifiedAt: VERIFIED_AT,
    capabilities: {
      instructions: "native", rules: "translated", skills: "portable", mcp: "native",
      hooks: "native", agents: "native", commands: "unsupported",
    },
    notes: ["Rules are linked from AGENTS.md; skills go to the shared ~/.agents/skills/."],
  },
  layout(context) {
    const root = context.environment("GROK_HOME") ?? context.join(context.home, ".grok");
    return {
      root,
      surfaces: [
        { id: "instructions", kind: "file", target: context.join(root, "AGENTS.md") },
        { id: "agents", kind: "directory", target: context.join(root, "agents") },
        { id: "hooks", kind: "file", target: context.join(root, "hooks", "canonfig.json") },
        {
          id: "config", kind: "config", target: context.join(root, "config.toml"), format: "toml",
          keys: ["mcp_servers"], settings: { reserved: ["model.*.api_key"] },
        },
      ],
      neverTouch: under(context, root, ["sessions", "logs", "crash", "mcp_credentials.json", "trusted_folders.toml"]),
      sharedSkills: true,
    };
  },
  project(model, _layout, runtime) {
    const contents: Array<SurfaceContent> = [];
    const diagnostics = [
      ...unsupportedFeatures("grok-build", model, [["commands", "Grok has no global command directory."]]),
      ...mcpGapDiagnostics("grok-build", model.mcp, ["enabledTools", "disabledTools"]),
    ];

    const instructions = instructionsText(model, true);
    if (instructions) contents.push({ kind: "file", surface: "instructions", content: instructions });
    if (model.agents.length > 0) {
      contents.push({
        kind: "directory", surface: "agents",
        files: documentFiles(model.agents, ".md", (agent) => agentMarkdown(agent, nativeTools("grok-build", agent))),
      });
    }

    // ~/.grok/hooks/*.json wrap the Claude-style event map in `hooks`.
    const hooks = claudeStyleHooks(runtime, "grok-build", nativeHooks("grok-build", model.hooks, GROK_EVENTS, diagnostics), diagnostics);
    if (Object.keys(hooks).length > 0) contents.push({ kind: "file", surface: "hooks", content: jsonFile({ hooks }) });

    if (model.mcp.length > 0) {
      contents.push({
        kind: "config", surface: "config",
        keys: [{ path: "mcp_servers", value: mcpTable(model.mcp, (server, name) => grokMcpServer(server, name, diagnostics)) }],
      });
    }
    return { contents, diagnostics };
  },
};
