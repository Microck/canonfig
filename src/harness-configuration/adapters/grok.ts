import type { DesiredArtifact, Diagnostic, HarnessAdapter } from "../core/types.ts";
import { descriptor } from "./descriptor.ts";
import {
  agentDocuments,
  agentMarkdown,
  claudeStyleHooks,
  commandDocuments,
  commandMarkdown,
  enabledHooks,
  GROK_EVENT_MAP,
  grokMcpToml,
  ruleDocuments,
  skillArtifacts,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";

export const grokAdapter: HarnessAdapter = {
  descriptor: descriptor(
    "grok-build",
    "Grok Build CLI",
    ["grok"],
    ["https://docs.x.ai/build/cli/reference", "https://docs.x.ai/build/features/skills-plugins-marketplaces", "https://docs.x.ai/build/features/mcp-servers", "https://docs.x.ai/build/features/hooks"],
    { instructions: "portable", rules: "portable", skills: "native", mcp: "native", hooks: "native", agents: "native", commands: "native" },
    ["Project hooks require Grok workspace hook trust."],
  ),
  async build(context) {
    const artifacts: DesiredArtifact[] = [];
    const diagnostics: Diagnostic[] = [];
    artifacts.push(...await skillArtifacts(context, ".grok/skills", "grok-build"));

    const mcp = grokMcpToml(context);
    if (mcp) artifacts.push({ kind: "toml", path: ".grok/config.toml", owner: "grok-build", blocks: [{ marker: "mcp-servers", content: mcp }] });

    if (enabledHooks(context).length > 0) {
      const compiled = claudeStyleHooks(context, GROK_EVENT_MAP);
      diagnostics.push(...compiled.diagnostics);
      if (Object.keys(compiled.hooks).length > 0) {
        artifacts.push({
          kind: "json", path: ".grok/hooks/canonfig.json", owner: "grok-build", rootDefaults: { version: 1 },
          operations: [{ kind: "managed-hooks", path: ["hooks"], hooks: compiled.hooks, marker: ".canonfig/.runtime/hook-runner.mjs" }],
        });
      }
    }

    for (const { agent, content } of await agentDocuments(context)) {
      artifacts.push({ kind: "replace", path: `.grok/agents/${agent.id}.md`, owner: "grok-build", content: agentMarkdown(agent, content, nativeTools("grok-build", agent)) });
    }
    for (const { command, content } of await commandDocuments(context)) {
      artifacts.push({ kind: "replace", path: `.grok/commands/${command.id}.md`, owner: "grok-build", content: commandMarkdown(command, content) });
    }
    for (const { rule, content } of await ruleDocuments(context)) {
      if (rule.paths.length > 0) {
        diagnostics.push({
          level: "warning",
          code: "RULE_SCOPE_LOST",
          target: "grok-build",
          path: `.canonfig/${rule.file}`,
          message: `Grok project rules cannot preserve Canonfig's path scope for ${rule.id}; the native rule file was skipped and the scoped AGENTS.md bridge remains authoritative.`,
        });
        continue;
      }
      artifacts.push({ kind: "replace", path: `.grok/rules/${rule.id}.md`, owner: "grok-build", content });
    }
    return { artifacts, diagnostics };
  },
};
