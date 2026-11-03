import type { DesiredArtifact, Diagnostic, HarnessAdapter } from "../core/types.ts";
import { descriptor } from "./descriptor.ts";
import {
  agentDocuments,
  agentMarkdown,
  commandDocuments,
  commandMarkdown,
  cursorHooks,
  enabledHooks,
  hasEnabledMcpServers,
  jsonMcpArtifact,
  ruleDocuments,
  skillArtifacts,
  standardMcpProjectionDiagnostics,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";
import { markdownWithFrontmatter } from "../core/frontmatter.ts";

export const cursorAdapter: HarnessAdapter = {
  descriptor: descriptor(
    "cursor",
    "Cursor",
    ["cursor-agent", "agent"],
    [
      "https://cursor.com/docs/cli/reference/configuration",
      "https://cursor.com/docs/context/rules",
      "https://cursor.com/docs/skills",
      "https://cursor.com/docs/agent/hooks",
    ],
    {
      instructions: "portable",
      rules: "native",
      skills: "native",
      mcp: "native",
      hooks: "native",
      agents: "native",
      commands: "native",
    },
    ["Hook event availability is Cursor-version dependent; unsupported canonical events produce diagnostics."],
  ),
  async build(context) {
    const artifacts: DesiredArtifact[] = [];
    const diagnostics: Diagnostic[] = [];

    artifacts.push(...await skillArtifacts(context, ".cursor/skills", "cursor"));
    if (hasEnabledMcpServers(context)) {
      diagnostics.push(...standardMcpProjectionDiagnostics(context, "cursor"));
      artifacts.push(jsonMcpArtifact(".cursor/mcp.json", "cursor", context));
    }

    if (enabledHooks(context).length > 0) {
      const compiled = cursorHooks(context);
      diagnostics.push(...compiled.diagnostics);
      if (Object.keys(compiled.hooks).length > 0) {
        artifacts.push({
          kind: "json",
          path: ".cursor/hooks.json",
          owner: "cursor",
          rootDefaults: { version: 1 },
          operations: [{ kind: "managed-hooks", path: ["hooks"], hooks: compiled.hooks, marker: ".canonfig/.runtime/hook-runner.mjs" }],
        });
      }
    }

    for (const { rule, content } of await ruleDocuments(context)) {
      const activation = rule.activation ?? (rule.paths.length > 0 ? "path" : "always");
      artifacts.push({
        kind: "replace",
        path: `.cursor/rules/${rule.id}.mdc`,
        owner: "cursor",
        content: markdownWithFrontmatter({
          description: rule.description ?? `Canonfig rule: ${rule.id}`,
          globs: rule.paths.join(","),
          alwaysApply: activation === "always",
        }, content),
      });
    }
    for (const { agent, content } of await agentDocuments(context)) {
      artifacts.push({
        kind: "replace",
        path: `.cursor/agents/${agent.id}.md`,
        owner: "cursor",
        content: agentMarkdown(agent, content, nativeTools("cursor", agent)),
      });
    }
    for (const { command, content } of await commandDocuments(context)) {
      artifacts.push({ kind: "replace", path: `.cursor/commands/${command.id}.md`, owner: "cursor", content: commandMarkdown(command, content) });
    }

    return { artifacts, diagnostics };
  },
};
