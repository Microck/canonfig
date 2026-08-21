import type { DesiredArtifact, Diagnostic, HarnessAdapter } from "../core/types.ts";
import { descriptor } from "./descriptor.ts";
import {
  agentDocuments,
  commandDocuments,
  commandMarkdown,
  openCodeMcpMap,
  ruleDocuments,
  skillArtifacts,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";
import { markdownWithFrontmatter } from "../core/frontmatter.ts";
import { openCodePluginSource } from "../templates/runtime.ts";

export const opencodeAdapter: HarnessAdapter = {
  descriptor: descriptor(
    "opencode",
    "OpenCode",
    ["opencode"],
    [
      "https://opencode.ai/docs/config/",
      "https://opencode.ai/docs/agents/",
      "https://opencode.ai/docs/skills/",
      "https://opencode.ai/docs/plugins/",
    ],
    {
      instructions: "portable",
      rules: "native",
      skills: "native",
      mcp: "native",
      hooks: "shim",
      agents: "native",
      commands: "native",
    },
    ["Tool hooks compile into an OpenCode TypeScript plugin; non-tool lifecycle events are not emitted."],
  ),
  async build(context) {
    const artifacts: DesiredArtifact[] = [];
    const diagnostics: Diagnostic[] = [];

    artifacts.push(...await skillArtifacts(context, ".opencode/skills", "opencode"));

    const configOperations: DesiredArtifact[] = [];
    const jsonOperations: Array<
      | { kind: "managed-map"; path: string[]; entries: Record<string, unknown>; collision: "error" }
      | { kind: "managed-array"; path: string[]; values: unknown[] }
    > = [];
    if (Object.keys(context.config.mcp.servers).length > 0) {
      jsonOperations.push({ kind: "managed-map", path: ["mcp"], entries: openCodeMcpMap(context), collision: "error" });
    }
    if (context.config.instructions.rules.length > 0) {
      jsonOperations.push({
        kind: "managed-array",
        path: ["instructions"],
        values: context.config.instructions.rules.map((rule) => `.canonfig/${rule.file}`),
      });
    }
    if (jsonOperations.length > 0) {
      configOperations.push({
        kind: "json",
        path: "opencode.json",
        owner: "opencode",
        rootDefaults: { $schema: "https://opencode.ai/config.json" },
        operations: jsonOperations,
      });
    }
    artifacts.push(...configOperations);

    if (context.config.hooks.length > 0) {
      for (const hook of context.config.hooks) {
        if (hook.enabled && hook.event !== "before_tool" && hook.event !== "after_tool") {
          diagnostics.push({
            level: "warning",
            code: "HOOK_EVENT_UNSUPPORTED",
            target: "opencode",
            message: `OpenCode's generated plugin cannot map hook event ${hook.event}; it was skipped.`,
          });
        }
      }
      artifacts.push({
        kind: "replace",
        path: ".opencode/plugins/canonfig.ts",
        owner: "opencode",
        content: openCodePluginSource(context.config.hooks),
      });
    }

    for (const { agent, content } of await agentDocuments(context)) {
      const permissions = Object.fromEntries(nativeTools("opencode", agent).map((tool) => [tool, agent.writable ? "allow" : tool === "read" || tool === "grep" || tool === "glob" ? "allow" : "ask"]));
      artifacts.push({
        kind: "replace",
        path: `.opencode/agents/${agent.id}.md`,
        owner: "opencode",
        content: markdownWithFrontmatter({
          description: agent.description,
          mode: "subagent",
          ...(agent.model === "inherit" ? {} : { model: agent.model }),
          permission: permissions,
        }, content),
      });
    }
    for (const { command, content } of await commandDocuments(context)) {
      artifacts.push({ kind: "replace", path: `.opencode/commands/${command.id}.md`, owner: "opencode", content: commandMarkdown(command, content) });
    }
    for (const { rule, content } of await ruleDocuments(context)) {
      artifacts.push({ kind: "replace", path: `.opencode/rules/${rule.id}.md`, owner: "opencode", content });
    }

    return { artifacts, diagnostics };
  },
};
