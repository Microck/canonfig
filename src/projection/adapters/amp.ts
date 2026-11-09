import type { HarnessAdapter, SurfaceContent } from "../harness.ts";
import { AMP_PLUGIN_EVENTS, ampPluginSource } from "../templates/runtime.ts";
import {
  instructionsText,
  mcpGapDiagnostics,
  mcpTable,
  nativeHooks,
  standardMcpServer,
  VERIFIED_AT,
  xdgCacheHome,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";

export const ampAdapter: HarnessAdapter = {
  descriptor: {
    id: "amp",
    name: "Amp",
    executables: ["amp"],
    docs: [
      "https://ampcode.com/docs/markdown/cli/settings",
      "https://ampcode.com/docs/markdown/customize/agents-md",
      "https://ampcode.com/docs/markdown/customize/skills",
      "https://ampcode.com/docs/markdown/customize/mcp",
      "https://ampcode.com/docs/markdown/customize/plugins",
      "https://ampcode.com/security#client-security",
    ],
    verifiedAt: VERIFIED_AT,
    capabilities: {
      instructions: "native", rules: "translated", skills: "portable", mcp: "native",
      hooks: "shim", agents: "translated", commands: "translated",
    },
    notes: [
      "Hooks, subagents and commands compile into one Amp plugin.",
      "Rules are linked from AGENTS.md; skills go to the shared ~/.agents/skills/.",
    ],
  },
  layout(context) {
    // Settings and AGENTS.md live in ~/.config/amp on every platform; only the
    // system plugin directory follows XDG_CONFIG_HOME
    // (https://ampcode.com/docs/markdown/customize/plugins).
    const root = context.join(context.home, ".config", "amp");
    const xdg = context.environment("XDG_CONFIG_HOME");
    const plugins = xdg === undefined ? context.join(root, "plugins") : context.join(xdg, "amp", "plugins");
    const data = context.join(context.home, ".local", "share", "amp");
    return {
      root,
      surfaces: [
        { id: "instructions", kind: "file", target: context.join(root, "AGENTS.md") },
        { id: "plugin", kind: "file", target: context.join(plugins, "canonfig.ts") },
        {
          id: "settings", kind: "config", target: context.join(root, "settings.json"),
          alternatives: [context.join(root, "settings.jsonc")], format: "json",
          keys: ["amp\\.mcpServers"], settings: { reserved: [] },
        },
      ],
      neverTouch: [
        context.join(data, "secrets.json"),
        context.join(data, "threads"),
        context.join(xdgCacheHome(context), "amp"),
      ],
      sharedSkills: true,
      // https://ampcode.com/docs/markdown/customize/skills, local source precedence.
      skillSources: [
        { path: context.join(context.home, ".config", "agents", "skills"), depth: 5 },
        { path: context.join(context.home, ".agents", "skills"), depth: 5, shared: true },
        { path: context.join(root, "skills"), depth: 5 },
        { path: context.join(context.home, ".claude", "skills"), depth: 5 },
      ],
    };
  },
  project(model, _layout, runtime) {
    const contents: Array<SurfaceContent> = [];
    const diagnostics = mcpGapDiagnostics("amp", model.mcp, ["timeoutMs", "enabledTools", "disabledTools", "sse"]);

    const instructions = instructionsText(model, true);
    if (instructions) contents.push({ kind: "file", surface: "instructions", content: instructions });

    const hooks = nativeHooks("amp", model.hooks, AMP_PLUGIN_EVENTS, diagnostics);
    if (hooks.length > 0 || model.agents.length > 0 || model.commands.length > 0) {
      contents.push({
        kind: "file", surface: "plugin",
        content: ampPluginSource(
          runtime.hookRunner,
          hooks,
          model.agents.map((agent) => ({ agent, tools: nativeTools("amp", agent) })),
          model.commands,
        ),
      });
    }

    if (model.mcp.length > 0) {
      // Amp infers the transport from `command` or `url`; it has no `type` field.
      contents.push({
        kind: "config", surface: "settings",
        keys: [{ path: "amp\\.mcpServers", value: mcpTable(model.mcp, (server) => standardMcpServer(server, { type: false, syntax: "shell", timeout: false })) }],
      });
    }
    return { contents, diagnostics };
  },
};
