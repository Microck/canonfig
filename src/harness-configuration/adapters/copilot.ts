import type { DesiredArtifact, Diagnostic, HarnessAdapter } from "../core/types.ts";
import { descriptor } from "./descriptor.ts";
import {
  agentDocuments,
  commandSkillArtifacts,
  copilotHooks,
  enabledHooks,
  ruleDocuments,
  skillArtifacts,
  standardMcpProjectionDiagnostics,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";
import { markdownWithFrontmatter } from "../core/frontmatter.ts";

export const copilotAdapter: HarnessAdapter = {
  descriptor: descriptor(
    "copilot-cli",
    "GitHub Copilot CLI",
    ["copilot"],
    [
      "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions",
      "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills",
      "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-hooks",
      "https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot",
    ],
    {
      instructions: "portable",
      rules: "native",
      skills: "native",
      mcp: "portable",
      hooks: "native",
      agents: "native",
      commands: "translated",
    },
    ["The shared repository .mcp.json is used for MCP; commands compile to Agent Skills."],
  ),
  async build(context) {
    const artifacts: DesiredArtifact[] = [];
    const diagnostics: Diagnostic[] = standardMcpProjectionDiagnostics(context, "copilot-cli");

    const commonSkills = await skillArtifacts(context, ".github/skills", "copilot-cli");
    artifacts.push(...commonSkills);
    const occupiedSkillPaths = new Set(commonSkills.map((artifact) => artifact.path));
    if (enabledHooks(context).length > 0) {
      const compiled = copilotHooks(context);
      diagnostics.push(...compiled.diagnostics);
      if (Object.keys(compiled.hooks).length > 0) {
        artifacts.push({
          kind: "json",
          path: ".github/hooks/canonfig.json",
          owner: "copilot-cli",
          rootDefaults: { version: 1 },
          operations: [{ kind: "managed-hooks", path: ["hooks"], hooks: compiled.hooks, marker: ".canonfig/.runtime/hook-runner.mjs" }],
        });
      }
    }

    for (const { rule, content } of await ruleDocuments(context)) {
      artifacts.push({
        kind: "replace",
        path: `.github/instructions/${rule.id}.instructions.md`,
        owner: "copilot-cli",
        content: markdownWithFrontmatter({
          description: rule.description ?? `Canonfig rule: ${rule.id}`,
          applyTo: rule.paths.length > 0 ? rule.paths.join(",") : "**",
        }, content),
      });
    }
    for (const { agent, content } of await agentDocuments(context)) {
      artifacts.push({
        kind: "replace",
        path: `.github/agents/${agent.id}.agent.md`,
        owner: "copilot-cli",
        content: markdownWithFrontmatter({
          name: agent.id,
          description: agent.description,
          ...(agent.model === "inherit" ? {} : { model: agent.model }),
          tools: nativeTools("copilot-cli", agent),
        }, content),
      });
    }
    for (const artifact of await commandSkillArtifacts(context, ".github/skills", "copilot-cli")) {
      if (occupiedSkillPaths.has(artifact.path)) {
        diagnostics.push({
          level: "error",
          code: "TRANSLATED_SKILL_COLLISION",
          target: "copilot-cli",
          path: artifact.path,
          message: `Copilot command output collides with a canonical skill at ${artifact.path}; rename the skill or command.`,
        });
        continue;
      }
      occupiedSkillPaths.add(artifact.path);
      artifacts.push(artifact);
    }

    return { artifacts, diagnostics };
  },
};
