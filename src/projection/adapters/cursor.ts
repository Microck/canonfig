import type { ConfigValue } from "../../domain/resource.ts";
import type { HarnessAdapter, SurfaceContent } from "../harness.ts";
import type { HookEvent } from "../model.ts";
import {
  agentMarkdown,
  byEvent,
  documentFiles,
  hookCommand,
  hookTimeoutSeconds,
  jsonFile,
  mcpGapDiagnostics,
  mcpTable,
  nativeHooks,
  standardMcpServer,
  under,
  unsupportedFeatures,
  VERIFIED_AT,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";

/** https://cursor.com/docs/agent/hooks */
const CURSOR_EVENTS: ReadonlyMap<HookEvent, string> = new Map([
  ["session_start", "sessionStart"],
  ["session_end", "sessionEnd"],
  ["prompt_submit", "beforeSubmitPrompt"],
  ["before_tool", "preToolUse"],
  ["after_tool", "postToolUse"],
  ["before_compact", "preCompact"],
  ["stop", "stop"],
  ["subagent_start", "subagentStart"],
  ["subagent_stop", "subagentStop"],
]);

export const cursorAdapter: HarnessAdapter = {
  descriptor: {
    id: "cursor",
    name: "Cursor",
    executables: ["cursor-agent", "agent"],
    genericExecutables: ["agent"],
    docs: [
      "https://cursor.com/docs/cli/reference/configuration",
      "https://cursor.com/docs/mcp",
      "https://cursor.com/docs/rules#user-rules",
      "https://cursor.com/docs/agent/hooks",
    ],
    verifiedAt: VERIFIED_AT,
    capabilities: {
      instructions: "unsupported", rules: "unsupported", skills: "portable", mcp: "native",
      hooks: "native", agents: "native", commands: "unsupported",
    },
    notes: [
      "Cursor keeps user rules in its settings, outside the filesystem.",
      "Skills go to the shared ~/.agents/skills/.",
    ],
  },
  layout(context) {
    const configDir = context.environment("CURSOR_CONFIG_DIR");
    const root = configDir ?? context.join(context.home, ".cursor");
    // cli-config.json moves with CURSOR_CONFIG_DIR, or to $XDG_CONFIG_HOME/cursor
    // on Linux (https://cursor.com/docs/cli/reference/configuration).
    const xdg = context.platform === "linux" ? context.environment("XDG_CONFIG_HOME") : undefined;
    const cliConfig = configDir === undefined && xdg !== undefined
      ? context.join(xdg, "cursor", "cli-config.json")
      : context.join(root, "cli-config.json");
    return {
      root,
      surfaces: [
        { id: "agents", kind: "directory", target: context.join(root, "agents") },
        { id: "hooks", kind: "file", target: context.join(root, "hooks.json") },
        { id: "mcp", kind: "config", target: context.join(root, "mcp.json"), format: "json", keys: ["mcpServers"] },
        { id: "settings", kind: "config", target: cliConfig, format: "json", keys: [], settings: { reserved: [] } },
      ],
      // The CLI login credential and IDE state paths are not documented.
      neverTouch: under(context, root, ["chats", "worktrees", "extensions"]),
      sharedSkills: true,
    };
  },
  project(model, _layout, runtime) {
    const contents: Array<SurfaceContent> = [];
    const diagnostics = [
      ...unsupportedFeatures("cursor", model, [
        ["instructions", "Cursor keeps user rules in its settings, outside the filesystem."],
        ["rules", "Cursor keeps user rules in its settings, outside the filesystem."],
        ["commands", "Cursor has no global command directory."],
      ]),
      ...mcpGapDiagnostics("cursor", model.mcp, ["timeoutMs", "enabledTools", "disabledTools"]),
    ];

    if (model.agents.length > 0) {
      contents.push({
        kind: "directory", surface: "agents",
        files: documentFiles(model.agents, ".md", (agent) => agentMarkdown(agent, nativeTools("cursor", agent))),
      });
    }

    const hooks = byEvent(nativeHooks("cursor", model.hooks, CURSOR_EVENTS, diagnostics).map(({ hook, event }) => {
      const entry: Array<[string, ConfigValue]> = [
        ["command", hookCommand(runtime, "cursor", hook)],
        ["timeout", hookTimeoutSeconds("cursor", hook, diagnostics)],
      ];
      if (event === "preToolUse" || event === "postToolUse") entry.push(["matcher", ".*"]);
      return [event, Object.fromEntries(entry)];
    }));
    if (Object.keys(hooks).length > 0) contents.push({ kind: "file", surface: "hooks", content: jsonFile({ version: 1, hooks }) });

    if (model.mcp.length > 0) {
      contents.push({
        kind: "config", surface: "mcp",
        keys: [{ path: "mcpServers", value: mcpTable(model.mcp, (server) => standardMcpServer(server, { type: true, syntax: "cursor", timeout: false })) }],
      });
    }
    return { contents, diagnostics };
  },
};
