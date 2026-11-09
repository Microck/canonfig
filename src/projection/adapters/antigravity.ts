import type { ConfigValue } from "../../domain/resource.ts";
import type { Diagnostic, HarnessAdapter, SurfaceContent } from "../harness.ts";
import type { HookEvent, McpServer } from "../model.ts";
import {
  agentMarkdown,
  type ConfigTable,
  documentFiles,
  hookCommand,
  hookTimeoutSeconds,
  instructionsText,
  jsonFile,
  mcpGapDiagnostics,
  mcpTable,
  mcpTimeoutSeconds,
  nativeHooks,
  secretTable,
  skillDirectoryFiles,
  triggerRuleMarkdown,
  under,
  unsupportedFeatures,
  VERIFIED_AT,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";

/** https://antigravity.google/docs/hooks */
const ANTIGRAVITY_EVENTS: ReadonlyMap<HookEvent, string> = new Map([
  ["session_start", "SessionStart"],
  ["before_tool", "PreToolUse"],
  ["after_tool", "PostToolUse"],
  ["before_agent", "PreInvocation"],
  ["after_agent", "PostInvocation"],
  ["stop", "Stop"],
]);

/**
 * https://antigravity.google/docs/mcp: `command` for stdio, `serverUrl` for
 * streamable HTTP, `timeoutSeconds`. The docs do not name an environment
 * reference syntax, so references keep the previous adapter's `${VAR}` form.
 */
function antigravityMcpServer(server: McpServer, name: string, diagnostics: Array<Diagnostic>): ConfigTable {
  const fields: Array<[string, ConfigValue]> = [];
  if (server.transport === "stdio") {
    fields.push(["command", server.command], ["args", server.args]);
    if (Object.keys(server.env).length > 0) fields.push(["env", secretTable(server.env, "shell")]);
    if (server.cwd) fields.push(["cwd", server.cwd]);
  } else {
    fields.push(["serverUrl", server.url]);
    if (Object.keys(server.headers).length > 0) fields.push(["headers", secretTable(server.headers, "shell")]);
  }
  if (server.enabledTools?.length) fields.push(["enabledTools", server.enabledTools]);
  if (server.disabledTools?.length) fields.push(["disabledTools", server.disabledTools]);
  if (server.timeoutMs !== undefined) {
    fields.push(["timeoutSeconds", mcpTimeoutSeconds("antigravity", name, server.timeoutMs, diagnostics)]);
  }
  return Object.fromEntries(fields);
}

export const antigravityAdapter: HarnessAdapter = {
  descriptor: {
    id: "antigravity",
    name: "Google Antigravity CLI",
    executables: ["agy"],
    docs: [
      "https://antigravity.google/docs/customization-discovery?tab=cli",
      "https://antigravity.google/docs/settings?tab=cli",
      "https://antigravity.google/docs/mcp",
      "https://antigravity.google/docs/hooks",
      "https://antigravity.google/docs/rules",
      "https://antigravity.google/docs/subagents",
    ],
    verifiedAt: VERIFIED_AT,
    capabilities: {
      instructions: "native", rules: "native", skills: "native", mcp: "native",
      hooks: "native", agents: "native", commands: "unsupported",
    },
    notes: ["~/.gemini is shared by the Antigravity CLI, App and IDE; only config/ and AGENTS.md are written."],
  },
  layout(context) {
    const root = context.join(context.home, ".gemini");
    const config = context.join(root, "config");
    return {
      root,
      surfaces: [
        { id: "instructions", kind: "file", target: context.join(root, "AGENTS.md") },
        { id: "rules", kind: "directory", target: context.join(config, "rules") },
        { id: "skills", kind: "directory", target: context.join(config, "skills") },
        { id: "agents", kind: "directory", target: context.join(config, "agents") },
        { id: "hooks", kind: "file", target: context.join(config, "hooks.json") },
        { id: "mcp", kind: "config", target: context.join(config, "mcp_config.json"), format: "json", keys: ["mcpServers"] },
        {
          id: "settings", kind: "config", target: context.join(root, "antigravity-cli", "settings.json"), format: "json",
          keys: [], settings: { reserved: ["trustedWorkspaces", "gcp"] },
        },
      ],
      neverTouch: [context.join(root, "antigravity-cli", "brain"), ...under(context, root, ["antigravity", "antigravity-ide"])],
      sharedSkills: false,
      // CLI-only roots outrank config/skills at runtime. Import preserves distinct copies.
      skillSources: [
        { path: context.join(root, "antigravity-cli", "skills"), depth: 1 },
        { path: context.join(root, "skills"), depth: 1 },
        { path: context.join(config, "skills"), depth: 1 },
      ],
    };
  },
  project(model, _layout, runtime) {
    const contents: Array<SurfaceContent> = [];
    const diagnostics = [
      ...unsupportedFeatures("antigravity", model, [["commands", "Antigravity has no global command directory."]]),
      ...mcpGapDiagnostics("antigravity", model.mcp, ["sse"]),
    ];

    const instructions = instructionsText(model, false);
    if (instructions) contents.push({ kind: "file", surface: "instructions", content: instructions });
    if (model.rules.length > 0) contents.push({ kind: "directory", surface: "rules", files: documentFiles(model.rules, ".md", triggerRuleMarkdown) });
    if (model.skills.length > 0) contents.push({ kind: "directory", surface: "skills", files: skillDirectoryFiles(model.skills) });
    if (model.agents.length > 0) {
      contents.push({
        kind: "directory", surface: "agents",
        files: documentFiles(model.agents, ".md", (agent) => agentMarkdown(agent, nativeTools("antigravity", agent))),
      });
    }

    // hooks.json maps a hook name to `{ enabled, <Event>: [...] }`; tool
    // events wrap their handlers in a matcher group.
    const entries = nativeHooks("antigravity", model.hooks, ANTIGRAVITY_EVENTS, diagnostics).map(({ hook, event }): [string, ConfigValue] => {
      const handler = {
        type: "command",
        command: hookCommand(runtime, "antigravity", hook),
        timeout: hookTimeoutSeconds("antigravity", hook, diagnostics),
      };
      const handlers = event === "PreToolUse" || event === "PostToolUse" ? [{ matcher: ".*", hooks: [handler] }] : [handler];
      return [`canonfig-${hook.id}`, { enabled: true, [event]: handlers }];
    });
    if (entries.length > 0) contents.push({ kind: "file", surface: "hooks", content: jsonFile(Object.fromEntries(entries)) });

    if (model.mcp.length > 0) {
      contents.push({
        kind: "config", surface: "mcp",
        keys: [{ path: "mcpServers", value: mcpTable(model.mcp, (server, name) => antigravityMcpServer(server, name, diagnostics)) }],
      });
    }
    return { contents, diagnostics };
  },
};
