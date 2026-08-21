import type { DesiredArtifact, Diagnostic, HarnessAdapter } from "../core/types.ts";
import { descriptor } from "./descriptor.ts";
import {
  agentDocuments,
  commandSkillArtifacts,
  ruleDocuments,
  ruleMarkdown,
  standardMcpMap,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";
import { ampPluginSource } from "../templates/runtime.ts";

const AMP_PLUGIN_EVENTS = new Set([
  "before_tool", "after_tool", "session_start", "before_agent", "after_agent",
]);

export const ampAdapter: HarnessAdapter = {
  descriptor: descriptor(
    "amp",
    "Amp",
    ["amp"],
    [
      "https://ampcode.com/manual",
      "https://ampcode.com/manual#mcp",
      "https://ampcode.com/manual#agent-skills",
      "https://ampcode.com/manual#plugins",
    ],
    {
      instructions: "portable",
      rules: "translated",
      skills: "portable",
      mcp: "native",
      hooks: "shim",
      agents: "translated",
      commands: "translated",
    },
    [
      "Hooks and custom subagents compile into an Amp TypeScript plugin.",
      "Commands compile to Agent Skills so they remain invokable without relying on an unstable command manifest.",
    ],
  ),
  async build(context) {
    const artifacts: DesiredArtifact[] = [];
    const diagnostics: Diagnostic[] = [];

    if (Object.keys(context.config.mcp.servers).length > 0) {
      artifacts.push({
        kind: "json",
        path: ".amp/settings.json",
        owner: "amp",
        operations: [{
          kind: "managed-map",
          path: ["amp.mcpServers"],
          entries: standardMcpMap(context, false),
          collision: "error",
        }],
      });
    }

    const agents = await agentDocuments(context);
    if (context.config.hooks.length > 0 || agents.length > 0) {
      for (const hook of context.config.hooks) {
        if (hook.enabled && !AMP_PLUGIN_EVENTS.has(hook.event)) {
          diagnostics.push({
            level: "warning",
            code: "HOOK_EVENT_UNSUPPORTED",
            target: "amp",
            message: `Amp's generated plugin cannot map hook event ${hook.event}; it was skipped.`,
          });
        }
      }
      artifacts.push({
        kind: "replace",
        path: ".amp/plugins/canonfig.ts",
        owner: "amp",
        content: ampPluginSource(
          context.config.hooks,
          agents.map(({ agent, content }) => ({ agent, content, tools: nativeTools("amp", agent) })),
        ),
      });
    }

    for (const { rule, content } of await ruleDocuments(context)) {
      artifacts.push({
        kind: "replace",
        path: `.amp/rules/${rule.id}.md`,
        owner: "amp",
        content: ruleMarkdown(rule, content),
      });
    }

    artifacts.push(...await commandSkillArtifacts(context, ".agents/skills", "amp"));
    return { artifacts, diagnostics };
  },
};
