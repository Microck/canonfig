import type { DesiredArtifact, Diagnostic, HarnessAdapter } from "../core/types.ts";
import { descriptor } from "./descriptor.ts";
import {
  agentSkillArtifacts,
  commandDocuments,
  commandMarkdown,
  piMcpMap,
  ruleDocuments,
  ruleMarkdown,
  skillArtifacts,
} from "./shared.ts";
import { piPluginSource } from "../templates/runtime.ts";

const PI_PLUGIN_EVENTS = new Set([
  "before_tool", "after_tool", "session_start", "session_end", "before_agent", "before_compact", "stop",
]);

function mcpPackageOption(options: Record<string, unknown>): string | false {
  if (options.mcpPackage === false) return false;
  if (typeof options.mcpPackage === "string" && options.mcpPackage.trim()) return options.mcpPackage;
  return "npm:pi-mcp-extension";
}

export const piAdapter: HarnessAdapter = {
  descriptor: descriptor(
    "pi",
    "Pi Coding Agent",
    ["pi"],
    [
      "https://pi.dev/docs/latest/settings",
      "https://pi.dev/docs/latest/extensions",
      "https://pi.dev/docs/latest/skills",
    ],
    {
      instructions: "portable",
      rules: "translated",
      skills: "native",
      mcp: "shim",
      hooks: "shim",
      agents: "lossy",
      commands: "native",
    },
    [
      "Pi does not ship a core MCP client; Canonfig writes a compatible MCP file and registers a configurable third-party package.",
      "Canonical agents compile to Agent Skills because Pi has no equivalent static subagent manifest.",
    ],
  ),
  async build(context) {
    const artifacts: DesiredArtifact[] = [];
    const diagnostics: Diagnostic[] = [];

    artifacts.push(...await skillArtifacts(context, ".pi/skills", "pi"));

    if (Object.keys(context.config.mcp.servers).length > 0) {
      artifacts.push({
        kind: "json",
        path: ".pi/mcp.json",
        owner: "pi",
        operations: [{ kind: "managed-map", path: ["mcpServers"], entries: piMcpMap(context), collision: "error" }],
      });
      const mcpPackage = mcpPackageOption(context.targetOptions);
      if (mcpPackage === false) {
        diagnostics.push({
          level: "warning",
          code: "PI_MCP_PACKAGE_DISABLED",
          target: "pi",
          message: "Pi MCP output was generated, but no MCP extension package will be registered because targets.pi.options.mcpPackage is false.",
        });
      } else {
        artifacts.push({
          kind: "json",
          path: ".pi/settings.json",
          owner: "pi",
          operations: [{ kind: "managed-array", path: ["packages"], values: [mcpPackage] }],
        });
        diagnostics.push({
          level: "warning",
          code: "PI_THIRD_PARTY_MCP",
          target: "pi",
          message: `Pi MCP support depends on the executable third-party package ${mcpPackage}; review and trust it before loading project resources.`,
        });
      }
    }

    if (context.config.hooks.length > 0) {
      for (const hook of context.config.hooks) {
        if (hook.enabled && !PI_PLUGIN_EVENTS.has(hook.event)) {
          diagnostics.push({
            level: "warning",
            code: "HOOK_EVENT_UNSUPPORTED",
            target: "pi",
            message: `Pi's generated extension cannot map hook event ${hook.event}; it was skipped.`,
          });
        }
      }
      artifacts.push({
        kind: "replace",
        path: ".pi/extensions/canonfig.ts",
        owner: "pi",
        content: piPluginSource("pi", context.config.hooks),
      });
    }

    for (const { rule, content } of await ruleDocuments(context)) {
      artifacts.push({ kind: "replace", path: `.pi/rules/${rule.id}.md`, owner: "pi", content: ruleMarkdown(rule, content) });
    }
    for (const { command, content } of await commandDocuments(context)) {
      artifacts.push({ kind: "replace", path: `.pi/prompts/${command.id}.md`, owner: "pi", content: commandMarkdown(command, content) });
    }
    artifacts.push(...await agentSkillArtifacts(context, ".pi/skills", "pi"));

    return { artifacts, diagnostics };
  },
};
