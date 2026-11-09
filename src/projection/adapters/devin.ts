import type { ConfigValue } from "../../domain/resource.ts";
import type { HarnessAdapter, SurfaceContent } from "../harness.ts";
import type { McpServer } from "../model.ts";
import {
  agentMarkdown,
  claudeStyleHooks,
  type ConfigTable,
  DEVIN_EVENTS,
  documentFiles,
  instructionsText,
  mcpGapDiagnostics,
  mcpTable,
  nativeHooks,
  secretTable,
  triggerRuleMarkdown,
  unsupportedFeatures,
  VERIFIED_AT,
  xdgDataHome,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";

/**
 * https://docs.devin.ai/cli/extensibility/mcp/configuration: stdio servers
 * take `command`, `args`, `env`; remote servers `url`, `transport` and
 * `headers`. The docs show `${env:VAR}` only for OAuth fields, so env and
 * header references keep the previous adapter's `${VAR}` form (unverified).
 */
function devinMcpServer(server: McpServer): ConfigTable {
  const fields: Array<[string, ConfigValue]> = [];
  if (server.transport === "stdio") {
    fields.push(["command", server.command], ["args", server.args]);
    if (Object.keys(server.env).length > 0) fields.push(["env", secretTable(server.env, "shell")]);
  } else {
    fields.push(["url", server.url], ["transport", server.transport === "sse" ? "sse" : "http"]);
    if (Object.keys(server.headers).length > 0) fields.push(["headers", secretTable(server.headers, "shell")]);
  }
  return Object.fromEntries(fields);
}

export const devinAdapter: HarnessAdapter = {
  descriptor: {
    id: "devin",
    name: "Devin CLI",
    executables: ["devin"],
    docs: [
      "https://docs.devin.ai/cli/extensibility/configuration",
      "https://docs.devin.ai/cli/extensibility/rules",
      "https://docs.devin.ai/cli/extensibility/mcp/configuration",
      "https://docs.devin.ai/cli/extensibility/hooks",
      "https://docs.devin.ai/cli/subagents",
      "https://docs.devin.ai/cli/enterprise/devin-auth#credentials-file-location",
    ],
    verifiedAt: VERIFIED_AT,
    capabilities: {
      instructions: "native", rules: "native", skills: "portable", mcp: "native",
      hooks: "native", agents: "native", commands: "unsupported",
    },
    notes: ["Skills go to the shared ~/.agents/skills/."],
  },
  layout(context) {
    const windows = context.platform === "windows";
    const root = windows ? context.join(context.appData, "devin") : context.join(context.home, ".config", "devin");
    // credentials.toml sits in the root on Windows and in the XDG data
    // directory elsewhere (https://docs.devin.ai/cli/enterprise/devin-auth).
    const state = windows
      ? [context.join(root, "credentials.toml"), context.join(root, "cli", "logs"), context.join(root, "sessions")]
      : [context.join(xdgDataHome(context), "devin"), context.join(root, "cli", "logs"), context.join(root, "sessions")];
    return {
      root,
      surfaces: [
        { id: "instructions", kind: "file", target: context.join(root, "AGENTS.md") },
        { id: "agents", kind: "directory", target: context.join(root, "agents") },
        { id: "rules", kind: "directory", target: context.join(context.home, ".devin", "rules") },
        {
          id: "config", kind: "config", target: context.join(root, "config.json"), format: "json",
          keys: ["hooks"], settings: { reserved: [] },
        },
        { id: "mcp", kind: "config", target: context.join(root, "mcp_config.json"), format: "json", keys: ["mcpServers"] },
      ],
      neverTouch: state,
      sharedSkills: true,
      // Global roots from cli/extensibility/skills. No inferred channel-specific ~/.codeium roots.
      skillSources: [
        { path: context.join(context.home, ".agents", "skills"), depth: 64, shared: true },
        { path: context.join(root, "skills"), depth: 64 },
      ],
    };
  },
  project(model, _layout, runtime) {
    const contents: Array<SurfaceContent> = [];
    const diagnostics = [
      ...unsupportedFeatures("devin", model, [["commands", "Devin has no global command directory."]]),
      ...mcpGapDiagnostics("devin", model.mcp, ["timeoutMs", "enabledTools", "disabledTools", "cwd"]),
    ];

    const instructions = instructionsText(model, false);
    if (instructions) contents.push({ kind: "file", surface: "instructions", content: instructions });
    if (model.rules.length > 0) contents.push({ kind: "directory", surface: "rules", files: documentFiles(model.rules, ".md", triggerRuleMarkdown) });
    if (model.agents.length > 0) {
      contents.push({
        kind: "directory", surface: "agents",
        files: documentFiles(model.agents, ".md", (agent) => agentMarkdown(agent, nativeTools("devin", agent))),
      });
    }

    // The user config.json `hooks` key holds the Claude-style event map.
    const hooks = claudeStyleHooks(runtime, "devin", nativeHooks("devin", model.hooks, DEVIN_EVENTS, diagnostics), diagnostics);
    if (Object.keys(hooks).length > 0) contents.push({ kind: "config", surface: "config", keys: [{ path: "hooks", value: hooks }] });

    if (model.mcp.length > 0) {
      contents.push({ kind: "config", surface: "mcp", keys: [{ path: "mcpServers", value: mcpTable(model.mcp, devinMcpServer) }] });
    }
    return { contents, diagnostics };
  },
};
