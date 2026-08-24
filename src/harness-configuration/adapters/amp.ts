import type { DesiredArtifact, Diagnostic, HarnessAdapter } from "../core/types.ts";
import { descriptor } from "./descriptor.ts";
import {
  agentDocuments,
  commandSkillArtifacts,
  enabledHooks,
  hasEnabledMcpServers,
  ruleDocuments,
  ruleMarkdown,
  skillArtifacts,
  standardMcpMap,
  standardMcpProjectionDiagnostics,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";
import { AMP_PLUGIN_EVENT_MAP, ampPluginSource } from "../templates/runtime.ts";

const AMP_PLUGIN_EVENTS = new Set(Object.keys(AMP_PLUGIN_EVENT_MAP));

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

    if (hasEnabledMcpServers(context)) {
      diagnostics.push(...standardMcpProjectionDiagnostics(context, "amp", false));
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
    const hooks = enabledHooks(context);
    const supportedHooks = hooks.filter((hook) => AMP_PLUGIN_EVENTS.has(hook.event));
    for (const hook of hooks) {
      if (!AMP_PLUGIN_EVENTS.has(hook.event)) {
        diagnostics.push({
          level: "warning",
          code: "HOOK_EVENT_UNSUPPORTED",
          target: "amp",
          message: `Amp's generated plugin cannot map hook event ${hook.event}; it was skipped.`,
        });
      }
    }
    if (supportedHooks.length > 0 || agents.length > 0) {
      artifacts.push({
        kind: "replace",
        path: ".amp/plugins/canonfig.ts",
        owner: "amp",
        content: ampPluginSource(
          supportedHooks,
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

    const commonSkillPaths = new Set(
      (await skillArtifacts(context, ".agents/skills", "common")).map((artifact) => artifact.path),
    );
    for (const artifact of await commandSkillArtifacts(context, ".agents/skills", "amp")) {
      if (commonSkillPaths.has(artifact.path)) {
        diagnostics.push({
          level: "error",
          code: "TRANSLATED_SKILL_COLLISION",
          target: "amp",
          path: artifact.path,
          message: `Amp command output collides with a canonical skill at ${artifact.path}; rename the skill or command.`,
        });
      } else {
        artifacts.push(artifact);
      }
    }
    return { artifacts, diagnostics };
  },
};
