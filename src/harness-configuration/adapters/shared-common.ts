import type { BuildContext, DesiredArtifact } from "../core/types.ts";
import { hookRegistryJson, hookRunnerSource } from "../templates/runtime.ts";
import { readCanonfigText, skillArtifacts } from "./shared-documents.ts";
import { enabledHooks } from "./shared-hooks.ts";
import { hasEnabledMcpServers, standardMcpMap } from "./shared-mcp.ts";

export async function commonArtifacts(context: BuildContext): Promise<DesiredArtifact[]> {
  const rootInstructions = await readCanonfigText(context, context.config.instructions.root);
  const scoped = context.config.instructions.rules.length === 0 ? "" : [
    "",
    "## Scoped instruction sources",
    "",
    ...context.config.instructions.rules.map((rule) => {
      const scope = rule.paths.length ? rule.paths.map((item) => `\`${item}\``).join(", ") : "all files";
      return `- Read \`.canonfig/${rule.file}\` when working on ${scope}.`;
    }),
  ].join("\n");

  const artifacts: DesiredArtifact[] = [
    {
      kind: "managed-text",
      path: "AGENTS.md",
      owner: "common",
      marker: "instructions",
      comments: "html",
      placement: "end",
      content: `${rootInstructions.trim()}${scoped}`,
    },
    {
      kind: "managed-text",
      path: ".gitignore",
      owner: "common",
      marker: "state-ignore",
      comments: "hash",
      placement: "end",
      content: ".canonfig/.harness-state.json",
    },
  ];

  artifacts.push(...await skillArtifacts(context, ".agents/skills", "common"));
  if (hasEnabledMcpServers(context)) {
    artifacts.push({
      kind: "json",
      path: ".mcp.json",
      owner: "common",
      operations: [{
        kind: "managed-map",
        path: ["mcpServers"],
        entries: standardMcpMap(context),
        collision: "error",
      }],
    });
  }
  const hooks = enabledHooks(context);
  if (hooks.length > 0) {
    artifacts.push(
      {
        kind: "replace",
        path: ".canonfig/.runtime/hook-runner.mjs",
        owner: "common",
        content: hookRunnerSource(),
        mode: 0o755,
      },
      {
        kind: "replace",
        path: ".canonfig/.runtime/hooks.json",
        owner: "common",
        content: hookRegistryJson(hooks),
      },
    );
  }
  return artifacts;
}
