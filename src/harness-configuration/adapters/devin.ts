import type { DesiredArtifact, HarnessAdapter } from "../core/types.ts";
import { descriptor } from "./descriptor.ts";
import {
  agentSkillArtifacts,
  claudeStyleHooks,
  commandSkillArtifacts,
  jsonMcpArtifact,
  ruleDocuments,
  ruleMarkdown,
  skillArtifacts,
} from "./shared.ts";

export const devinAdapter: HarnessAdapter = {
  descriptor: descriptor(
    "devin",
    "Devin CLI / Devin Local",
    ["devin"],
    [
      "https://docs.devin.ai/cli/extensibility/configuration",
      "https://docs.devin.ai/cli/extensibility/rules",
      "https://docs.devin.ai/cli/extensibility/mcp",
      "https://docs.devin.ai/cli/extensibility/hooks",
      "https://docs.devin.ai/cli/extensibility/skills",
    ],
    {
      instructions: "portable",
      rules: "native",
      skills: "native",
      mcp: "native",
      hooks: "native",
      agents: "translated",
      commands: "translated",
    },
    ["Canonical agents and commands compile to Devin-discoverable Agent Skills."],
  ),
  async build(context) {
    const artifacts: DesiredArtifact[] = [];
    const diagnostics = [];

    artifacts.push(...await skillArtifacts(context, ".devin/skills", "devin"));
    if (Object.keys(context.config.mcp.servers).length > 0) artifacts.push(jsonMcpArtifact(".devin/mcp.json", "devin", context));

    if (context.config.hooks.length > 0) {
      const compiled = claudeStyleHooks(context);
      diagnostics.push(...compiled.diagnostics);
      artifacts.push({
        kind: "json",
        path: ".devin/hooks.v1.json",
        owner: "devin",
        rootDefaults: { version: 1 },
        operations: [{ kind: "managed-hooks", path: ["hooks"], hooks: compiled.hooks, marker: ".canonfig/.runtime/hook-runner.mjs" }],
      });
    }

    for (const { rule, content } of await ruleDocuments(context)) {
      artifacts.push({ kind: "replace", path: `.devin/rules/${rule.id}.md`, owner: "devin", content: ruleMarkdown(rule, content) });
    }
    artifacts.push(...await agentSkillArtifacts(context, ".devin/skills", "devin"));
    artifacts.push(...await commandSkillArtifacts(context, ".devin/skills", "devin"));

    return { artifacts, diagnostics };
  },
};
