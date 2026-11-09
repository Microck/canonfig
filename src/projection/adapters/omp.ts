import type { HarnessAdapter, SurfaceContent } from "../harness.ts";
import { PI_PLUGIN_EVENTS, piPluginSource } from "../templates/runtime.ts";
import {
  agentMarkdown,
  commandMarkdown,
  documentFiles,
  globRuleMarkdown,
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

export const ompAdapter: HarnessAdapter = {
  descriptor: {
    id: "oh-my-pi",
    name: "Oh My Pi",
    executables: ["omp"],
    docs: [
      "https://github.com/can1357/oh-my-pi/blob/main/docs/config-usage.md",
      "https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md",
      "https://github.com/can1357/oh-my-pi/blob/main/packages/utils/src/dirs.ts",
    ],
    verifiedAt: VERIFIED_AT,
    capabilities: {
      instructions: "native", rules: "native", skills: "native", mcp: "native",
      hooks: "shim", agents: "native", commands: "native",
    },
    notes: ["Lifecycle hooks compile to an Oh My Pi extension."],
  },
  layout(context) {
    // packages/utils/src/dirs.ts: PI_CONFIG_DIR is a directory name under the
    // home directory (default `.omp`), not a path. A named profile
    // (OMP_PROFILE, then PI_PROFILE) uses `<base>/profiles/<name>/agent` and
    // ignores PI_CODING_AGENT_DIR; otherwise PI_CODING_AGENT_DIR replaces the
    // agent directory.
    const base = context.join(context.home, context.environment("PI_CONFIG_DIR") ?? ".omp");
    const profile = context.environment("OMP_PROFILE") ?? context.environment("PI_PROFILE");
    const root = profile === undefined
      ? context.environment("PI_CODING_AGENT_DIR") ?? context.join(base, "agent")
      : context.join(base, "profiles", profile, "agent");
    return {
      root,
      surfaces: [
        { id: "instructions", kind: "file", target: context.join(root, "AGENTS.md") },
        { id: "rules", kind: "directory", target: context.join(root, "rules") },
        { id: "skills", kind: "directory", target: context.join(root, "skills") },
        { id: "agents", kind: "directory", target: context.join(root, "agents") },
        { id: "commands", kind: "directory", target: context.join(root, "commands") },
        { id: "extension", kind: "file", target: context.join(root, "extensions", "canonfig.ts") },
        { id: "mcp", kind: "config", target: context.join(root, "mcp.json"), format: "json", keys: ["mcpServers"] },
        {
          id: "settings", kind: "config", target: context.join(root, "config.yml"),
          alternatives: [context.join(root, "config.yaml")], format: "yaml",
          keys: [], settings: { reserved: [] },
        },
      ],
      // agent.db holds auth. Logs and install-id sit in the profile-independent base.
      neverTouch: [
        ...under(context, root, ["agent.db", "history.db", "models.db", "sessions", "blobs", "memories"]),
        ...under(context, base, ["logs", "install-id"]),
      ],
      sharedSkills: false,
      // discovery/agents.ts also reads the shared user directory, independently of native writes.
      skillSources: [
        { path: context.join(root, "skills"), depth: 64 },
        { path: context.join(context.home, ".agents", "skills"), depth: 64, shared: true },
      ],
    };
  },
  project(model, _layout, runtime) {
    const contents: Array<SurfaceContent> = [];
    const diagnostics = mcpGapDiagnostics("oh-my-pi", model.mcp, ["enabledTools", "disabledTools"]);

    const instructions = instructionsText(model, false);
    if (instructions) contents.push({ kind: "file", surface: "instructions", content: instructions });
    if (model.rules.length > 0) contents.push({ kind: "directory", surface: "rules", files: documentFiles(model.rules, ".md", globRuleMarkdown) });
    if (model.skills.length > 0) contents.push({ kind: "directory", surface: "skills", files: skillDirectoryFiles(model.skills) });
    if (model.agents.length > 0) {
      contents.push({
        kind: "directory", surface: "agents",
        files: documentFiles(model.agents, ".md", (agent) => agentMarkdown(agent, nativeTools("oh-my-pi", agent))),
      });
    }
    if (model.commands.length > 0) {
      contents.push({ kind: "directory", surface: "commands", files: documentFiles(model.commands, ".md", commandMarkdown) });
    }

    const hooks = nativeHooks("oh-my-pi", model.hooks, PI_PLUGIN_EVENTS, diagnostics);
    if (hooks.length > 0) contents.push({ kind: "file", surface: "extension", content: piPluginSource("oh-my-pi", runtime.hookRunner, hooks) });

    if (model.mcp.length > 0) {
      // OMP-native mcp.json takes `timeout` in milliseconds.
      contents.push({
        kind: "config", surface: "mcp",
        keys: [{ path: "mcpServers", value: mcpTable(model.mcp, (server) => standardMcpServer(server, { type: true, syntax: "shell", timeout: true })) }],
      });
    }
    return { contents, diagnostics };
  },
};
