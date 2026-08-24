import type { DesiredArtifact, Diagnostic, HarnessAdapter } from "../core/types.ts";
import { descriptor } from "./descriptor.ts";
import {
  agentDocuments,
  agentMarkdown,
  claudeStyleHooks,
  commandDocuments,
  commandMarkdown,
  enabledHooks,
  hasEnabledMcpServers,
  jsonMcpArtifact,
  skillArtifacts,
  standardMcpProjectionDiagnostics,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";

export const droidAdapter: HarnessAdapter = {
  descriptor: descriptor(
    "factory-droid",
    "Factory Droid CLI",
    ["droid"],
    ["https://docs.factory.ai/harness/hooks", "https://docs.factory.ai/harness/mcp", "https://docs.factory.ai/droid-cli/settings"],
    { rules: "portable", skills: "native" },
  ),
  async build(context) {
    const artifacts: DesiredArtifact[] = [];
    const diagnostics: Diagnostic[] = [];
    artifacts.push(...await skillArtifacts(context, ".factory/skills", "factory-droid"));
    if (hasEnabledMcpServers(context)) {
      diagnostics.push(...standardMcpProjectionDiagnostics(context, "factory-droid"));
      artifacts.push(jsonMcpArtifact(".factory/mcp.json", "factory-droid", context));
    }
    if (enabledHooks(context).length > 0) {
      const compiled = claudeStyleHooks(context);
      diagnostics.push(...compiled.diagnostics);
      if (Object.keys(compiled.hooks).length > 0) {
        artifacts.push({
          kind: "json", path: ".factory/hooks.json", owner: "factory-droid",
          operations: [{ kind: "managed-hooks", path: ["hooks"], hooks: compiled.hooks, marker: ".canonfig/.runtime/hook-runner.mjs" }],
        });
      }
    }
    for (const { agent, content } of await agentDocuments(context)) {
      artifacts.push({ kind: "replace", path: `.factory/droids/${agent.id}.md`, owner: "factory-droid", content: agentMarkdown(agent, content, nativeTools("factory-droid", agent)) });
    }
    for (const { command, content } of await commandDocuments(context)) {
      artifacts.push({ kind: "replace", path: `.factory/commands/${command.id}.md`, owner: "factory-droid", content: commandMarkdown(command, content) });
    }
    return { artifacts, diagnostics };
  },
};
