import type { HarnessAdapter, SurfaceContent } from "../harness.ts";
import { markdownWithFrontmatter } from "../frontmatter.ts";
import {
  agentMarkdown,
  CLAUDE_EVENTS,
  claudeStyleHooks,
  commandMarkdown,
  documentFiles,
  instructionsText,
  mcpGapDiagnostics,
  mcpTable,
  nativeHooks,
  skillDirectoryFiles,
  standardMcpServer,
  under,
  VERIFIED_AT,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";

export const claudeAdapter: HarnessAdapter = {
  descriptor: {
    id: "claude-code",
    name: "Claude Code",
    executables: ["claude"],
    docs: [
      "https://code.claude.com/docs/en/claude-directory.md",
      "https://code.claude.com/docs/en/settings.md",
      "https://code.claude.com/docs/en/mcp.md#mcp-installation-scopes",
      "https://code.claude.com/docs/en/env-vars.md",
    ],
    verifiedAt: VERIFIED_AT,
    capabilities: {
      instructions: "native", rules: "native", skills: "native", mcp: "native",
      hooks: "native", agents: "native", commands: "native",
    },
  },
  layout(context) {
    const configDir = context.environment("CLAUDE_CONFIG_DIR");
    const root = configDir ?? context.join(context.home, ".claude");
    // With CLAUDE_CONFIG_DIR set, `.claude.json` moves into that directory
    // (https://code.claude.com/docs/en/claude-directory.md).
    const userConfig = configDir === undefined
      ? context.join(context.home, ".claude.json")
      : context.join(configDir, ".claude.json");
    return {
      root,
      surfaces: [
        { id: "instructions", kind: "file", target: context.join(root, "CLAUDE.md") },
        { id: "rules", kind: "directory", target: context.join(root, "rules") },
        { id: "skills", kind: "directory", target: context.join(root, "skills") },
        { id: "agents", kind: "directory", target: context.join(root, "agents") },
        { id: "commands", kind: "directory", target: context.join(root, "commands") },
        {
          id: "settings", kind: "config", target: context.join(root, "settings.json"), format: "json",
          keys: ["hooks"], settings: { reserved: [] },
        },
        // Only `mcpServers`: every other key holds OAuth, trust and history.
        { id: "mcp", kind: "config", target: userConfig, format: "json", keys: ["mcpServers"] },
      ],
      neverTouch: under(context, root, [
        ".credentials.json", "projects", "sessions", "history.jsonl", "file-history", "cache",
      ]),
      sharedSkills: false,
      skillSources: [{ path: context.join(root, "skills"), depth: 1 }],
    };
  },
  project(model, _layout, runtime) {
    const contents: Array<SurfaceContent> = [];
    const diagnostics = mcpGapDiagnostics("claude-code", model.mcp, ["timeoutMs", "enabledTools", "disabledTools"]);

    const instructions = instructionsText(model, false);
    if (instructions) contents.push({ kind: "file", surface: "instructions", content: instructions });
    if (model.rules.length > 0) {
      // Claude rule frontmatter takes only `paths`; a rule without paths always loads.
      contents.push({
        kind: "directory", surface: "rules",
        files: documentFiles(model.rules, ".md", (rule) =>
          rule.paths.length > 0 ? markdownWithFrontmatter({ paths: rule.paths }, rule.content) : `${rule.content.trim()}\n`),
      });
    }
    if (model.skills.length > 0) contents.push({ kind: "directory", surface: "skills", files: skillDirectoryFiles(model.skills) });
    if (model.agents.length > 0) {
      const mcpTools = model.mcp.map(([name]) => `mcp__${name}`);
      contents.push({
        kind: "directory", surface: "agents",
        files: documentFiles(model.agents, ".md", (agent) =>
          agentMarkdown(agent, [...new Set([...nativeTools("claude-code", agent), ...(agent.tools.includes("mcp") ? mcpTools : [])])])),
      });
    }
    if (model.commands.length > 0) {
      contents.push({ kind: "directory", surface: "commands", files: documentFiles(model.commands, ".md", commandMarkdown) });
    }

    const hooks = claudeStyleHooks(runtime, "claude-code", nativeHooks("claude-code", model.hooks, CLAUDE_EVENTS, diagnostics), diagnostics);
    if (Object.keys(hooks).length > 0) contents.push({ kind: "config", surface: "settings", keys: [{ path: "hooks", value: hooks }] });

    if (model.mcp.length > 0) {
      contents.push({
        kind: "config", surface: "mcp",
        keys: [{ path: "mcpServers", value: mcpTable(model.mcp, (server) => standardMcpServer(server, { type: true, syntax: "shell", timeout: false })) }],
      });
    }
    return { contents, diagnostics };
  },
};
