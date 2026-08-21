import type { HarnessAdapter, DesiredArtifact } from "../core/types.ts";
import { descriptor } from "./descriptor.ts";
import {
  agentSkillArtifacts,
  antigravityHooks,
  antigravityMcpMap,
  commandSkillArtifacts,
  ruleDocuments,
  ruleMarkdown,
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
    const diagnostics = [];
    if (Object.keys(context.config.mcp.servers).length) {
      artifacts.push({
        kind: "json", path: ".agents/mcp_config.json", owner: "antigravity",
        operations: [{ kind: "managed-map", path: ["mcpServers"], entries: antigravityMcpMap(context), collision: "error" }],
      });
    }
    if (context.config.hooks.length) {
      const compiled = antigravityHooks(context);
      diagnostics.push(...compiled.diagnostics);
      artifacts.push({
        kind: "json", path: ".agents/hooks.json", owner: "antigravity",
        operations: [{ kind: "managed-map", path: [], entries: compiled.entries, collision: "error" }],
      });
    }
    for (const { rule, content } of await ruleDocuments(context)) {
      artifacts.push({ kind: "replace", path: `.agents/rules/${rule.id}.md`, owner: "antigravity", content: ruleMarkdown(rule, content, { trigger: rule.paths.length ? "glob" : "always" }) });
    }
    artifacts.push(...await agentSkillArtifacts(context, ".agents/skills", "antigravity"));
    artifacts.push(...await commandSkillArtifacts(context, ".agents/skills", "antigravity"));
    return { artifacts, diagnostics };
  },
};
