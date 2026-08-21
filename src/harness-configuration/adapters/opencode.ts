import type { DesiredArtifact, Diagnostic, HarnessAdapter } from "../core/types.ts";
import { descriptor } from "./descriptor.ts";
import {
  agentDocuments,
  commandDocuments,
  commandMarkdown,
  enabledHooks,
  openCodeMcpMap,
  skillArtifacts,
} from "./shared.ts";
import { nativeTools, nativeToolsForCapabilities } from "./tools.ts";
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
      rules: "portable",
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

    if (Object.keys(context.config.mcp.servers).length > 0) {
      artifacts.push({
        kind: "json",
        path: "opencode.json",
        owner: "opencode",
        rootDefaults: { $schema: "https://opencode.ai/config.json" },
        operations: [{ kind: "managed-map", path: ["mcp"], entries: openCodeMcpMap(context), collision: "error" }],
      });
    }

    const hooks = enabledHooks(context);
    const supportedHooks = hooks.filter((hook) => hook.event === "before_tool" || hook.event === "after_tool");
    for (const hook of hooks) {
      if (hook.event !== "before_tool" && hook.event !== "after_tool") {
        diagnostics.push({
          level: "warning",
          code: "HOOK_EVENT_UNSUPPORTED",
          target: "opencode",
          message: `OpenCode's generated plugin cannot map hook event ${hook.event}; it was skipped.`,
        });
      }
    }
    if (supportedHooks.length > 0) {
      artifacts.push({
        kind: "replace",
        path: ".opencode/plugins/canonfig.ts",
        owner: "opencode",
        content: openCodePluginSource(supportedHooks),
      });
    }

    const readOnlyTools = new Set(nativeToolsForCapabilities("opencode", ["read", "search"]));
    for (const { agent, content } of await agentDocuments(context)) {
      const permissions = Object.fromEntries(nativeTools("opencode", agent).map((tool) => [
        tool,
        agent.writable || readOnlyTools.has(tool) ? "allow" : "deny",
      ]));
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

    return { artifacts, diagnostics };
  },
};
