import type { DesiredArtifact, Diagnostic, HarnessAdapter } from "../core/types.ts";
import { descriptor } from "./descriptor.ts";
import {
  agentSkillArtifacts,
  antigravityHooks,
  antigravityMcpMap,
  commandSkillArtifacts,
  enabledHooks,
  hasEnabledMcpServers,
  ruleDocuments,
  ruleMarkdown,
  skillArtifacts,
} from "./shared.ts";

export const antigravityAdapter: HarnessAdapter = {
  descriptor: descriptor(
    "antigravity",
    "Google Antigravity CLI",
    ["agy"],
    ["https://antigravity.google/docs/mcp", "https://antigravity.google/docs/hooks", "https://antigravity.google/docs/gcli-migration"],
    { instructions: "portable", rules: "native", skills: "portable", mcp: "native", hooks: "native", agents: "translated", commands: "translated" },
    ["Canonical agents and commands compile to Agent Skills; Antigravity exposes subagents separately from portable agent manifests."],
  ),
  async build(context) {
    const artifacts: DesiredArtifact[] = [];
    const diagnostics: Diagnostic[] = [];
    if (hasEnabledMcpServers(context)) {
      artifacts.push({
        kind: "json", path: ".agents/mcp_config.json", owner: "antigravity",
        operations: [{ kind: "managed-map", path: ["mcpServers"], entries: antigravityMcpMap(context), collision: "error" }],
      });
    }
    if (enabledHooks(context).length > 0) {
      const compiled = antigravityHooks(context);
      diagnostics.push(...compiled.diagnostics);
      if (Object.keys(compiled.entries).length > 0) {
        artifacts.push({
          kind: "json", path: ".agents/hooks.json", owner: "antigravity",
          operations: [{ kind: "managed-map", path: [], entries: compiled.entries, collision: "error" }],
        });
      }
    }
    for (const { rule, content } of await ruleDocuments(context)) {
      artifacts.push({ kind: "replace", path: `.agents/rules/${rule.id}.md`, owner: "antigravity", content: ruleMarkdown(rule, content, { trigger: rule.paths.length ? "glob" : "always" }) });
    }

    const commonSkills = await skillArtifacts(context, ".agents/skills", "common");
    artifacts.push(...commonSkills);
    const occupiedSkillPaths = new Set(commonSkills.map((artifact) => artifact.path));
    const translatedSkills = [
      ...await agentSkillArtifacts(context, ".agents/skills", "antigravity"),
      ...await commandSkillArtifacts(context, ".agents/skills", "antigravity"),
    ];
    for (const artifact of translatedSkills) {
      if (occupiedSkillPaths.has(artifact.path)) {
        diagnostics.push({
          level: "error",
          code: "TRANSLATED_SKILL_COLLISION",
          target: "antigravity",
          path: artifact.path,
          message: `Antigravity translated skill output collides at ${artifact.path}; rename the canonical skill, agent, or command.`,
        });
        continue;
      }
      occupiedSkillPaths.add(artifact.path);
      artifacts.push(artifact);
    }
    return { artifacts, diagnostics };
  },
};
