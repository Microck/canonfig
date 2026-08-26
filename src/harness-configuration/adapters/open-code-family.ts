import type {
  DesiredArtifact,
  Diagnostic,
  HarnessAdapter,
  TargetId,
} from "../core/types.ts";
import { markdownWithFrontmatter } from "../core/frontmatter.ts";
import { openCodePluginSource } from "../templates/runtime.ts";
import { descriptor } from "./descriptor.ts";
import {
  agentDocuments,
  commandDocuments,
  commandMarkdown,
  enabledHooks,
  enabledMcpServerEntries,
  openCodeMcpMap,
  skillArtifacts,
} from "./shared.ts";
import { nativeTools, nativeToolsForCapabilities } from "./tools.ts";

interface OpenCodeFamilyDefinition {
  id: Extract<TargetId, "opencode" | "kilo">;
  name: string;
  executables: readonly string[];
  docs: readonly string[];
  schemaUrl: string;
  configPath: string;
  resourceRoot: string;
  notes: readonly string[];
}

export function createOpenCodeFamilyAdapter(
  definition: OpenCodeFamilyDefinition,
): HarnessAdapter {
  return {
    descriptor: descriptor(
      definition.id,
      definition.name,
      definition.executables,
      definition.docs,
      {
        instructions: "portable",
        rules: "portable",
        skills: "native",
        mcp: "native",
        hooks: "shim",
        agents: "native",
        commands: "native",
      },
      definition.notes,
      "2026-08-26",
    ),
    async build(context) {
      const artifacts: DesiredArtifact[] = [];
      const diagnostics: Diagnostic[] = [];
      const root = definition.resourceRoot;

      artifacts.push(...await skillArtifacts(context, `${root}/skills`, definition.id));

      if (Object.keys(context.config.mcp.servers).length > 0) {
        artifacts.push(
          {
            kind: "json",
            path: definition.configPath,
            owner: definition.id,
            operations: [{
              kind: "managed-map",
              path: ["mcp"],
              entries: openCodeMcpMap(context),
              collision: "error",
            }],
          },
          {
            kind: "json",
            path: definition.configPath,
            owner: definition.id,
            rootDefaults: { $schema: definition.schemaUrl },
            operations: [],
          },
        );
      }

      const hooks = enabledHooks(context);
      const supportedHooks = hooks.filter((hook) =>
        hook.event === "before_tool" || hook.event === "after_tool"
      );
      for (const hook of hooks) {
        if (hook.event !== "before_tool" && hook.event !== "after_tool") {
          diagnostics.push({
            level: "warning",
            code: "HOOK_EVENT_UNSUPPORTED",
            target: definition.id,
            message: `${definition.name}'s generated plugin cannot map hook event ${hook.event}; it was skipped.`,
          });
        }
      }
      if (supportedHooks.length > 0) {
        artifacts.push({
          kind: "replace",
          path: `${root}/plugins/canonfig.ts`,
          owner: definition.id,
          content: openCodePluginSource(definition.id, supportedHooks),
        });
      }

      const readOnlyTools = new Set(
        nativeToolsForCapabilities(definition.id, ["read", "search"]),
      );
      const mcpServerNames = enabledMcpServerEntries(context).map(([name]) => name);
      for (const { agent, content } of await agentDocuments(context)) {
        const permissions: Record<string, string> = Object.fromEntries(
          nativeTools(definition.id, agent).map((tool) => [
            tool,
            agent.writable || readOnlyTools.has(tool) ? "allow" : "deny",
          ]),
        );
        for (const serverName of mcpServerNames) {
          permissions[`${serverName}_*`] = agent.tools.includes("mcp") ? "allow" : "deny";
        }
        artifacts.push({
          kind: "replace",
          path: `${root}/agents/${agent.id}.md`,
          owner: definition.id,
          content: markdownWithFrontmatter({
            description: agent.description,
            mode: "subagent",
            ...(agent.model === "inherit" ? {} : { model: agent.model }),
            permission: permissions,
          }, content),
        });
      }

      for (const { command, content } of await commandDocuments(context)) {
        artifacts.push({
          kind: "replace",
          path: `${root}/commands/${command.id}.md`,
          owner: definition.id,
          content: commandMarkdown(command, content),
        });
      }

      return { artifacts, diagnostics };
    },
  };
}
