import type { DesiredArtifact, Diagnostic, HarnessAdapter } from "../core/types.ts";
import { descriptor } from "./descriptor.ts";
import {
  agentDocuments,
  agentMarkdown,
  commandDocuments,
  commandMarkdown,
  enabledHooks,
  hasEnabledMcpServers,
  jsonMcpArtifact,
  ruleDocuments,
  ruleMarkdown,
  skillArtifacts,
  standardMcpProjectionDiagnostics,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";
import { PI_PLUGIN_EVENT_MAP, piPluginSource } from "../templates/runtime.ts";

const OMP_PLUGIN_EVENTS = new Set(Object.keys(PI_PLUGIN_EVENT_MAP));

export const ompAdapter: HarnessAdapter = {
  descriptor: descriptor(
    "oh-my-pi",
    "Oh My Pi",
    ["omp"],
    [
      "https://github.com/can1357/oh-my-pi/blob/main/docs/config-usage.md",
      "https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md",
      "https://github.com/can1357/oh-my-pi/blob/main/docs/hooks.md",
    ],
    {
      instructions: "portable",
      rules: "native",
      skills: "native",
      mcp: "native",
      hooks: "shim",
      agents: "native",
      commands: "native",
    },
    ["Lifecycle hooks compile to an executable Oh My Pi extension."],
  ),
  async build(context) {
    const artifacts: DesiredArtifact[] = [];
    const diagnostics: Diagnostic[] = [];

    artifacts.push(...await skillArtifacts(context, ".omp/skills", "oh-my-pi"));
    if (hasEnabledMcpServers(context)) {
      diagnostics.push(...standardMcpProjectionDiagnostics(context, "oh-my-pi"));
      artifacts.push(jsonMcpArtifact(".omp/mcp.json", "oh-my-pi", context));
    }

    const hooks = enabledHooks(context);
    const supportedHooks = hooks.filter((hook) => OMP_PLUGIN_EVENTS.has(hook.event));
    for (const hook of hooks) {
      if (!OMP_PLUGIN_EVENTS.has(hook.event)) {
        diagnostics.push({
          level: "warning",
          code: "HOOK_EVENT_UNSUPPORTED",
          target: "oh-my-pi",
          message: `Oh My Pi's generated extension cannot map hook event ${hook.event}; it was skipped.`,
        });
      }
    }
    if (supportedHooks.length > 0) {
      artifacts.push({
        kind: "replace",
        path: ".omp/extensions/canonfig.ts",
        owner: "oh-my-pi",
        content: piPluginSource("oh-my-pi", supportedHooks),
      });
    }

    for (const { rule, content } of await ruleDocuments(context)) {
      artifacts.push({ kind: "replace", path: `.omp/rules/${rule.id}.md`, owner: "oh-my-pi", content: ruleMarkdown(rule, content) });
    }
    for (const { agent, content } of await agentDocuments(context)) {
      artifacts.push({
        kind: "replace",
        path: `.omp/agents/${agent.id}.md`,
        owner: "oh-my-pi",
        content: agentMarkdown(agent, content, nativeTools("oh-my-pi", agent)),
      });
    }
    for (const { command, content } of await commandDocuments(context)) {
      artifacts.push({ kind: "replace", path: `.omp/commands/${command.id}.md`, owner: "oh-my-pi", content: commandMarkdown(command, content) });
    }

    return { artifacts, diagnostics };
  },
};
