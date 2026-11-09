import type { ConfigValue } from "../../domain/resource.ts";
import type { HarnessAdapter, SurfaceContent } from "../harness.ts";
import type { HookEvent, McpServer } from "../model.ts";
import {
  byEvent,
  type ConfigEntry,
  type ConfigTable,
  hookCommand,
  hookTimeoutSeconds,
  mcpGapDiagnostics,
  mcpTable,
  nativeHooks,
  secretTable,
  skillTreeFiles,
  under,
  unsupportedFeatures,
  VERIFIED_AT,
} from "./shared.ts";

/**
 * Shell hook events (plugin hook names) from
 * https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/hooks.md.
 * `pre_llm_call` runs before each model call, the closest match for `before_agent`.
 */
const HERMES_EVENTS: ReadonlyMap<HookEvent, string> = new Map([
  ["session_start", "on_session_start"],
  ["session_end", "on_session_end"],
  ["before_tool", "pre_tool_call"],
  ["after_tool", "post_tool_call"],
  ["before_agent", "pre_llm_call"],
  ["after_agent", "post_llm_call"],
  ["after_compact", "post_compaction"],
  ["subagent_start", "subagent_start"],
  ["subagent_stop", "subagent_stop"],
]);

/**
 * `mcp_servers` entries (features/mcp.md): `command`, `args`, `env`, `cwd`
 * for stdio, `url` and `headers` for HTTP. Hermes resolves `${VAR}` in
 * command, args, url and headers; `env` references use the same form (unverified).
 */
function hermesMcpServer(server: McpServer): ConfigTable {
  const fields: Array<[string, ConfigValue]> = [];
  if (server.transport === "stdio") {
    fields.push(["command", server.command], ["args", server.args]);
    if (Object.keys(server.env).length > 0) fields.push(["env", secretTable(server.env, "shell")]);
    if (server.cwd) fields.push(["cwd", server.cwd]);
  } else {
    fields.push(["url", server.url]);
    if (Object.keys(server.headers).length > 0) fields.push(["headers", secretTable(server.headers, "shell")]);
  }
  return Object.fromEntries(fields);
}

export const hermesAdapter: HarnessAdapter = {
  descriptor: {
    id: "hermes",
    name: "Hermes Agent",
    executables: ["hermes"],
    docs: [
      "https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md",
      "https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md",
      "https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/hooks.md",
      "https://hermes-agent.nousresearch.com/docs/user-guide/profiles",
    ],
    verifiedAt: VERIFIED_AT,
    capabilities: {
      instructions: "unsupported", rules: "unsupported", skills: "native", mcp: "native",
      hooks: "native", agents: "unsupported", commands: "unsupported",
    },
    notes: [
      "SOUL.md is Hermes's identity, not instructions, so instructions and rules are not projected.",
      "Each published skill owns one skills/<name> directory; Hermes's own skills stay untouched.",
      "Hermes asks once per new hook command before running it.",
    ],
  },
  layout(context, model) {
    // HERMES_HOME selects the active profile's home.
    const root = context.environment("HERMES_HOME") ?? context.join(context.home, ".hermes");
    const skills = context.join(root, "skills");
    return {
      root,
      surfaces: [
        ...model.skills.map((skill) => ({ id: `skill.${skill.name}`, kind: "directory" as const, target: context.join(skills, skill.name) })),
        {
          id: "config", kind: "config", target: context.join(root, "config.yaml"), format: "yaml",
          keys: ["mcp_servers", "hooks"],
        },
      ],
      neverTouch: [
        ...under(context, root, ["SOUL.md", ".env", "auth.json", "sessions", "state.db", "logs", "cache", "memories"]),
        ...under(context, skills, [".hub", ".bundled_manifest"]),
      ],
      sharedSkills: false,
      // agent/skill_utils.py: categories recurse, including below skills, but not support dirs.
      skillSources: [{
        path: skills,
        depth: 64,
        includeHidden: true,
        excludedDirectories: [
          ".git", ".github", ".hub", ".archive", ".curator_backups", ".locks", ".hermes-dist",
          ".venv", "venv", "node_modules", "site-packages", "__pycache__",
          ".tox", ".nox", ".pytest_cache", ".mypy_cache", ".ruff_cache",
        ],
        pruneWithinSkill: ["references", "templates", "assets", "scripts"],
      }],
    };
  },
  project(model, _layout, runtime) {
    const contents: Array<SurfaceContent> = model.skills.map((skill) => ({
      kind: "directory", surface: `skill.${skill.name}`, files: skillTreeFiles(skill),
    }));
    const diagnostics = [
      ...unsupportedFeatures("hermes", model, [
        ["instructions", "SOUL.md is an identity, not an instruction file."],
        ["rules", "Hermes has no global rules location."],
        ["agents", "Hermes has no subagent definitions."],
        ["commands", "Hermes has no command directory."],
      ]),
      ...mcpGapDiagnostics("hermes", model.mcp, ["timeoutMs", "enabledTools", "disabledTools"]),
    ];

    // config.yaml `hooks`: `{ <event>: [{ matcher, command, timeout, fail_closed }] }`,
    // timeout in seconds; `fail_closed` applies to pre_tool_call only.
    const hooks = byEvent(nativeHooks("hermes", model.hooks, HERMES_EVENTS, diagnostics).map(({ hook, event }) => {
      const entry: Array<[string, ConfigValue]> = [
        ["command", hookCommand(runtime, "hermes", hook)],
        ["timeout", hookTimeoutSeconds("hermes", hook, diagnostics)],
      ];
      if (event === "pre_tool_call" && hook.onFailure === "block") entry.push(["fail_closed", true]);
      return [event, Object.fromEntries(entry)];
    }));

    const keys: Array<ConfigEntry> = [];
    if (model.mcp.length > 0) keys.push({ path: "mcp_servers", value: mcpTable(model.mcp, hermesMcpServer) });
    if (Object.keys(hooks).length > 0) keys.push({ path: "hooks", value: hooks });
    if (keys.length > 0) contents.push({ kind: "config", surface: "config", keys });
    return { contents, diagnostics };
  },
};
