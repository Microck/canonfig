import type { ConfigValue } from "../../domain/resource.ts";
import type { HarnessAdapter, HarnessDescriptor, RootContext, SurfaceContent } from "../harness.ts";
import { markdownWithFrontmatter } from "../frontmatter.ts";
import type { AgentDocument, McpServer } from "../model.ts";
import { OPENCODE_PLUGIN_EVENTS, openCodePluginSource } from "../templates/runtime.ts";
import {
  commandMarkdown,
  type ConfigTable,
  documentFiles,
  instructionsText,
  mcpGapDiagnostics,
  mcpTable,
  nativeHooks,
  secretTable,
  skillDirectoryFiles,
  VERIFIED_AT,
} from "./shared.ts";
import { nativeTools, nativeToolsForCapabilities } from "./tools.ts";

/**
 * The `mcp` map of opencode.json and kilo.jsonc: `local` servers take a
 * command array and `environment`, `remote` servers `url` and `headers`;
 * references use `{env:NAME}` and `timeout` is in milliseconds.
 */
function openCodeMcpServer(server: McpServer): ConfigTable {
  const fields: Array<[string, ConfigValue]> = [];
  if (server.transport === "stdio") {
    fields.push(["type", "local"], ["command", [server.command, ...server.args]], ["enabled", true]);
    if (Object.keys(server.env).length > 0) fields.push(["environment", secretTable(server.env, "opencode")]);
  } else {
    fields.push(["type", "remote"], ["url", server.url], ["enabled", true]);
    if (Object.keys(server.headers).length > 0) fields.push(["headers", secretTable(server.headers, "opencode")]);
  }
  if (server.timeoutMs !== undefined) fields.push(["timeout", server.timeoutMs]);
  return Object.fromEntries(fields);
}

/**
 * A subagent with an explicit permission per native tool: read-only agents
 * keep their read and search tools and are denied the rest; MCP tools follow
 * the `mcp` capability.
 */
function openCodeAgentMarkdown(
  harness: "opencode" | "kilo",
  agent: AgentDocument,
  mcpServers: ReadonlyArray<string>,
): string {
  const readOnly = new Set(nativeToolsForCapabilities(harness, ["read", "search"]));
  const permission: Array<[string, string]> = nativeTools(harness, agent).map((tool) => [
    tool,
    agent.writable || readOnly.has(tool) ? "allow" : "deny",
  ]);
  for (const server of mcpServers) permission.push([`${server}_*`, agent.tools.includes("mcp") ? "allow" : "deny"]);
  const data: Array<[string, ConfigValue]> = [
    ["description", agent.description],
    ["mode", "subagent"],
    ["permission", Object.fromEntries(permission)],
  ];
  if (agent.model !== "inherit") data.push(["model", agent.model]);
  return markdownWithFrontmatter(Object.fromEntries(data), agent.content);
}

export interface OpenCodeFamily {
  readonly descriptor: Omit<HarnessDescriptor, "verifiedAt" | "capabilities">;
  readonly id: "opencode" | "kilo";
  /** Root directory from the machine's directories. */
  readonly root: (context: RootContext) => string;
  readonly config: string;
  readonly alternative: string;
  readonly agents: string;
  readonly plugins: string;
  /** Harness state outside the root, by absolute path. */
  readonly state: (context: RootContext) => ReadonlyArray<string>;
}

/**
 * OpenCode and its fork Kilo share one compiler; only paths, the config file
 * name and identity differ.
 */
export function openCodeFamilyAdapter(family: OpenCodeFamily): HarnessAdapter {
  const harness = family.id;
  return {
    descriptor: {
      ...family.descriptor,
      verifiedAt: VERIFIED_AT,
      capabilities: {
        instructions: "native", rules: "translated", skills: family.id === "kilo" ? "portable" : "native",
        mcp: "native", hooks: "shim", agents: "native", commands: "native",
      },
    },
    layout(context) {
      const root = family.root(context);
      const skills = family.id === "opencode"
        ? [{ id: "skills", kind: "directory" as const, target: context.join(root, "skills") }]
        : [];
      return {
        root,
        surfaces: [
          { id: "instructions", kind: "file", target: context.join(root, "AGENTS.md") },
          ...skills,
          { id: "agents", kind: "directory", target: context.join(root, family.agents) },
          { id: "commands", kind: "directory", target: context.join(root, "commands") },
          { id: "plugin", kind: "file", target: context.join(root, family.plugins, "canonfig.ts") },
          {
            id: "config", kind: "config", target: context.join(root, family.config),
            alternatives: [context.join(root, family.alternative)], format: "json",
            // `provider` holds API keys and stays the user's.
            keys: ["mcp"], settings: { reserved: ["provider"] },
          },
        ],
        neverTouch: [...family.state(context)],
        sharedSkills: family.id === "kilo",
        // Native global directories, not mutation surfaces. Both tools also read shared skills.
        skillSources: [
          { path: context.join(root, "skills"), depth: 6, flat: family.id === "opencode" },
          ...(family.id === "kilo" ? [{ path: context.join(context.home, ".kilo", "skills"), depth: 6 }] : []),
          { path: context.join(context.home, ".agents", "skills"), depth: 6, shared: true, flat: family.id === "opencode" },
          { path: context.join(context.home, ".claude", "skills"), depth: 6 },
        ],
      };
    },
    project(model, _layout, runtime) {
      const contents: Array<SurfaceContent> = [];
      const diagnostics = mcpGapDiagnostics(harness, model.mcp, ["enabledTools", "disabledTools", "cwd"]);

      const instructions = instructionsText(model, true);
      if (instructions) contents.push({ kind: "file", surface: "instructions", content: instructions });
      if (family.id === "opencode" && model.skills.length > 0) {
        contents.push({ kind: "directory", surface: "skills", files: skillDirectoryFiles(model.skills) });
      }
      if (model.agents.length > 0) {
        const servers = model.mcp.map(([name]) => name);
        contents.push({
          kind: "directory", surface: "agents",
          files: documentFiles(model.agents, ".md", (agent) => openCodeAgentMarkdown(harness, agent, servers)),
        });
      }
      if (model.commands.length > 0) {
        contents.push({ kind: "directory", surface: "commands", files: documentFiles(model.commands, ".md", commandMarkdown) });
      }

      const hooks = nativeHooks(harness, model.hooks, OPENCODE_PLUGIN_EVENTS, diagnostics);
      if (hooks.length > 0) {
        contents.push({ kind: "file", surface: "plugin", content: openCodePluginSource(harness, runtime.hookRunner, hooks) });
      }

      if (model.mcp.length > 0) {
        contents.push({ kind: "config", surface: "config", keys: [{ path: "mcp", value: mcpTable(model.mcp, openCodeMcpServer) }] });
      }
      return { contents, diagnostics };
    },
  };
}
