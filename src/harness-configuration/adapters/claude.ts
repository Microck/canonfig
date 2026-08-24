import type { DesiredArtifact, Diagnostic, HarnessAdapter } from "../core/types.ts";
import { descriptor } from "./descriptor.ts";
import {
  agentDocuments,
  agentMarkdown,
  claudeStyleHooks,
  commandDocuments,
  commandMarkdown,
  enabledHooks,
  enabledMcpServerEntries,
  ruleDocuments,
  ruleMarkdown,
  skillArtifacts,
  standardMcpProjectionDiagnostics,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";

export const claudeAdapter: HarnessAdapter = {
  descriptor: descriptor(
    "claude-code",
    "Claude Code",
    ["claude"],
    ["https://docs.anthropic.com/en/docs/claude-code/settings", "https://docs.anthropic.com/en/docs/claude-code/hooks"],
    { instructions: "translated", rules: "native", skills: "native", mcp: "native", hooks: "native", agents: "native", commands: "native" },
    ["CLAUDE.md is generated as a small bridge to the canonical AGENTS.md."],
  ),
  async build(context) {
    const artifacts: DesiredArtifact[] = [{
      kind: "managed-text", path: "CLAUDE.md", owner: "claude-code", marker: "instructions-import",
      comments: "html", placement: "start", content: "@AGENTS.md",
    }];
    const diagnostics: Diagnostic[] = standardMcpProjectionDiagnostics(context, "claude-code");

    artifacts.push(...await skillArtifacts(context, ".claude/skills", "claude-code"));
    for (const { rule, content } of await ruleDocuments(context)) {
      artifacts.push({ kind: "replace", path: `.claude/rules/${rule.id}.md`, owner: "claude-code", content: ruleMarkdown(rule, content, rule.paths.length ? { paths: rule.paths } : {}) });
    }
    if (enabledHooks(context).length > 0) {
      const compiled = claudeStyleHooks(context);
      diagnostics.push(...compiled.diagnostics);
      if (Object.keys(compiled.hooks).length > 0) {
        artifacts.push({
          kind: "json", path: ".claude/settings.json", owner: "claude-code",
          operations: [{ kind: "managed-hooks", path: ["hooks"], hooks: compiled.hooks, marker: ".canonfig/.runtime/hook-runner.mjs" }],
        });
      }
    }
    for (const { agent, content } of await agentDocuments(context)) {
      const tools = nativeTools("claude-code", agent);
      if (agent.tools.includes("mcp")) {
        tools.push(...enabledMcpServerEntries(context).map(([name]) => `mcp__${name}`));
      }
      artifacts.push({
        kind: "replace",
        path: `.claude/agents/${agent.id}.md`,
        owner: "claude-code",
        content: agentMarkdown(agent, content, [...new Set(tools)]),
      });
    }
    for (const { command, content } of await commandDocuments(context)) {
      artifacts.push({ kind: "replace", path: `.claude/commands/${command.id}.md`, owner: "claude-code", content: commandMarkdown(command, content) });
    }
    return { artifacts, diagnostics };
  },
};
