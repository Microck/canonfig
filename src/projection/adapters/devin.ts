import type { DesiredArtifact, Diagnostic, HarnessAdapter } from "../core/types.ts";
import { descriptor } from "./descriptor.ts";
import {
  agentSkillArtifacts,
  claudeStyleHooks,
  commandSkillArtifacts,
  DEVIN_EVENT_MAP,
  enabledHooks,
  hasEnabledMcpServers,
  jsonMcpArtifact,
  ruleDocuments,
  ruleMarkdown,
  skillArtifacts,
  standardMcpProjectionDiagnostics,
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
    const diagnostics: Diagnostic[] = [];

    const skills = await skillArtifacts(context, ".devin/skills", "devin");
    artifacts.push(...skills);
    if (hasEnabledMcpServers(context)) {
      diagnostics.push(...standardMcpProjectionDiagnostics(context, "devin"));
      artifacts.push(jsonMcpArtifact(".devin/mcp.json", "devin", context));
    }

    if (enabledHooks(context).length > 0) {
      const compiled = claudeStyleHooks(context, DEVIN_EVENT_MAP);
      diagnostics.push(...compiled.diagnostics);
      if (Object.keys(compiled.hooks).length > 0) {
        artifacts.push({
          kind: "json",
          path: ".devin/hooks.v1.json",
          owner: "devin",
          rootDefaults: { version: 1 },
          operations: [{ kind: "managed-hooks", path: ["hooks"], hooks: compiled.hooks, marker: ".canonfig/.runtime/hook-runner.mjs" }],
        });
      }
    }

    for (const { rule, content } of await ruleDocuments(context)) {
      artifacts.push({ kind: "replace", path: `.devin/rules/${rule.id}.md`, owner: "devin", content: ruleMarkdown(rule, content) });
    }

    const occupiedSkillPaths = new Set(skills.map((artifact) => artifact.path));
    const translated = [
      ...await agentSkillArtifacts(context, ".devin/skills", "devin"),
      ...await commandSkillArtifacts(context, ".devin/skills", "devin"),
    ];
    for (const artifact of translated) {
      if (occupiedSkillPaths.has(artifact.path)) {
        diagnostics.push({
          level: "error",
          code: "TRANSLATED_SKILL_COLLISION",
          target: "devin",
          path: artifact.path,
          message: `Devin translated skill output collides with another skill at ${artifact.path}; rename the canonical skill, agent, or command.`,
        });
      } else {
        occupiedSkillPaths.add(artifact.path);
        artifacts.push(artifact);
      }
    }

    return { artifacts, diagnostics };
  },
};
