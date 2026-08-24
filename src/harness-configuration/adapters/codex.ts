import type { DesiredArtifact, Diagnostic, HarnessAdapter } from "../core/types.ts";
import { descriptor } from "./descriptor.ts";
import {
  agentDocuments,
  CODEX_EVENT_MAP,
  codexMcpDiagnostics,
  commandSkillArtifacts,
  enabledHooks,
  mcpToml,
  claudeStyleHooks,
} from "./shared.ts";

function tomlString(value: string): string { return JSON.stringify(value); }
function tomlMultiline(value: string): string {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"""', '\\"\\"\\"');
  return `"""\n${escaped.trim()}\n"""`;
}

export const codexAdapter: HarnessAdapter = {
  descriptor: descriptor(
    "codex",
    "OpenAI Codex",
    ["codex"],
    [
      "https://developers.openai.com/codex/config-reference",
      "https://developers.openai.com/codex/subagents",
      "https://developers.openai.com/codex/hooks",
    ],
    {
      instructions: "portable",
      rules: "translated",
      skills: "portable",
      mcp: "native",
      hooks: "native",
      agents: "native",
      commands: "translated",
    },
    ["Commands compile to Agent Skills because Codex uses skills as the portable command surface."],
  ),
  async build(context) {
    const artifacts: DesiredArtifact[] = [];
    const diagnostics: Diagnostic[] = [];

    const mcp = mcpToml(context);
    if (mcp) {
      diagnostics.push(...codexMcpDiagnostics(context));
      artifacts.push({
        kind: "toml", path: ".codex/config.toml", owner: "codex",
        blocks: [{ marker: "mcp-servers", content: mcp }],
        description: "Codex project MCP servers",
      });
    }

    if (enabledHooks(context).length > 0) {
      const compiled = claudeStyleHooks(context, CODEX_EVENT_MAP);
      diagnostics.push(...compiled.diagnostics);
      if (Object.keys(compiled.hooks).length > 0) {
        artifacts.push({
          kind: "json", path: ".codex/hooks.json", owner: "codex",
          rootDefaults: { version: 1 },
          operations: [{ kind: "managed-hooks", path: ["hooks"], hooks: compiled.hooks, marker: ".canonfig/.runtime/hook-runner.mjs" }],
          description: "Codex lifecycle hooks",
        });
      }
    }

    for (const { agent, content } of await agentDocuments(context)) {
      const lines = [
        `name = ${tomlString(agent.id)}`,
        `description = ${tomlString(agent.description)}`,
        ...(agent.model === "inherit" ? [] : [`model = ${tomlString(agent.model)}`]),
        `sandbox_mode = ${tomlString(agent.writable ? "workspace-write" : "read-only")}`,
        `developer_instructions = ${tomlMultiline(content)}`,
        "",
      ];
      artifacts.push({ kind: "replace", path: `.codex/agents/${agent.id}.toml`, owner: "codex", content: lines.join("\n") });
    }

    artifacts.push(...await commandSkillArtifacts(context, ".codex/skills", "codex"));
    return { artifacts, diagnostics };
  },
};
