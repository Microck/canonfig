import type { HarnessAdapter, SurfaceContent } from "../harness.ts";
import {
  agentMarkdown,
  claudeStyleHooks,
  commandMarkdown,
  documentFiles,
  DROID_EVENTS,
  instructionsText,
  jsonFile,
  mcpGapDiagnostics,
  mcpTable,
  nativeHooks,
  skillDirectoryFiles,
  standardMcpServer,
  under,
  VERIFIED_AT,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";

export const droidAdapter: HarnessAdapter = {
  descriptor: {
    id: "factory-droid",
    name: "Factory Droid CLI",
    executables: ["droid"],
    docs: [
      "https://docs.factory.com/droid-cli/settings",
      "https://docs.factory.com/harness/mcp",
      "https://docs.factory.com/harness/hooks",
    ],
    verifiedAt: VERIFIED_AT,
    capabilities: {
      instructions: "native", rules: "translated", skills: "native", mcp: "native",
      hooks: "native", agents: "native", commands: "native",
    },
    notes: ["Rules are linked from AGENTS.md."],
  },
  layout(context) {
    const root = context.join(context.home, ".factory");
    return {
      root,
      surfaces: [
        { id: "instructions", kind: "file", target: context.join(root, "AGENTS.md") },
        { id: "skills", kind: "directory", target: context.join(root, "skills") },
        { id: "droids", kind: "directory", target: context.join(root, "droids") },
        { id: "commands", kind: "directory", target: context.join(root, "commands") },
        { id: "hooks", kind: "file", target: context.join(root, "hooks.json") },
        { id: "mcp", kind: "config", target: context.join(root, "mcp.json"), format: "json", keys: ["mcpServers"] },
        {
          id: "settings", kind: "config", target: context.join(root, "settings.json"), format: "json",
          keys: [], settings: { reserved: [] },
        },
      ],
      // The OAuth fallback file beside the keyring is not documented by name.
      neverTouch: under(context, root, ["projects", "sessions", "logs"]),
      sharedSkills: false,
    };
  },
  project(model, _layout, runtime) {
    const contents: Array<SurfaceContent> = [];
    const diagnostics = mcpGapDiagnostics("factory-droid", model.mcp, ["enabledTools", "disabledTools"]);

    const instructions = instructionsText(model, true);
    if (instructions) contents.push({ kind: "file", surface: "instructions", content: instructions });
    if (model.skills.length > 0) contents.push({ kind: "directory", surface: "skills", files: skillDirectoryFiles(model.skills) });
    if (model.agents.length > 0) {
      contents.push({
        kind: "directory", surface: "droids",
        files: documentFiles(model.agents, ".md", (agent) => agentMarkdown(agent, nativeTools("factory-droid", agent))),
      });
    }
    if (model.commands.length > 0) {
      contents.push({ kind: "directory", surface: "commands", files: documentFiles(model.commands, ".md", commandMarkdown) });
    }

    // A standalone hooks.json is keyed directly by event name (https://docs.factory.com/harness/hooks).
    const hooks = claudeStyleHooks(runtime, "factory-droid", nativeHooks("factory-droid", model.hooks, DROID_EVENTS, diagnostics), diagnostics);
    if (Object.keys(hooks).length > 0) contents.push({ kind: "file", surface: "hooks", content: jsonFile(hooks) });

    if (model.mcp.length > 0) {
      // Factory expands `${NAME}` (no default syntax) and takes `timeout` in milliseconds.
      contents.push({
        kind: "config", surface: "mcp",
        keys: [{ path: "mcpServers", value: mcpTable(model.mcp, (server) => standardMcpServer(server, { type: true, syntax: "shell", timeout: true })) }],
      });
    }
    return { contents, diagnostics };
  },
};
