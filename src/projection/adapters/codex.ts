import { Predicate } from "effect";
import { stringify as stringifyToml } from "smol-toml";

import type { ConfigValue } from "../../domain/resource.ts";
import type { Diagnostic, HarnessAdapter, SurfaceContent } from "../harness.ts";
import type { AgentDocument, McpServer, SecretValue } from "../model.ts";
import {
  claudeStyleHooks,
  CODEX_EVENTS,
  type ConfigTable,
  documentFiles,
  instructionsText,
  jsonFile,
  mcpGapDiagnostics,
  mcpTable,
  nativeHooks,
  under,
  unsupportedFeatures,
  VERIFIED_AT,
} from "./shared.ts";

interface SplitSecrets {
  /** `[key, value]` for literal strings. */
  readonly literal: Array<[string, string]>;
  /** `[key, variable]` for environment references. */
  readonly references: Array<[string, string]>;
}

function splitSecrets(values: Readonly<Record<string, SecretValue>>): SplitSecrets {
  const literal: Array<[string, string]> = [];
  const references: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(values)) {
    if (Predicate.isString(value)) literal.push([key, value]);
    else references.push([key, value.fromEnv]);
  }
  return { literal, references };
}

/**
 * `[mcp_servers.<name>]` per https://developers.openai.com/codex/config-reference.
 * Environment references become `env_vars` (forwarded by the same name) and
 * `env_http_headers`; Codex never sees a secret value.
 */
function codexMcpServer(server: McpServer): ConfigTable {
  const fields: Array<[string, ConfigValue]> = [];
  if (server.transport === "stdio") {
    fields.push(["command", server.command]);
    if (server.args.length > 0) fields.push(["args", server.args]);
    if (server.cwd) fields.push(["cwd", server.cwd]);
    const { literal, references } = splitSecrets(server.env);
    const forwarded = references.filter(([key, variable]) => key === variable).map(([key]) => key);
    if (literal.length > 0) fields.push(["env", Object.fromEntries(literal)]);
    if (forwarded.length > 0) fields.push(["env_vars", forwarded]);
  } else {
    fields.push(["url", server.url]);
    const { literal, references } = splitSecrets(server.headers);
    if (literal.length > 0) fields.push(["http_headers", Object.fromEntries(literal)]);
    if (references.length > 0) fields.push(["env_http_headers", Object.fromEntries(references)]);
  }
  if (server.enabledTools?.length) fields.push(["enabled_tools", server.enabledTools]);
  if (server.disabledTools?.length) fields.push(["disabled_tools", server.disabledTools]);
  return Object.fromEntries(fields);
}

function codexMcpDiagnostics(servers: ReadonlyArray<readonly [string, McpServer]>): Array<Diagnostic> {
  const diagnostics = mcpGapDiagnostics("codex", servers, ["timeoutMs"]);
  for (const [name, server] of servers) {
    if (server.transport === "sse") {
      diagnostics.push({
        level: "warning", code: "MCP_TRANSPORT_UNSUPPORTED", harness: "codex",
        message: `Codex supports streamable HTTP but not legacy SSE; MCP server ${name} is written as streamable HTTP.`,
      });
    }
    if (server.transport !== "stdio") continue;
    for (const [key, value] of Object.entries(server.env)) {
      if (Predicate.isString(value) || value.fromEnv === key) continue;
      diagnostics.push({
        level: "warning", code: "MCP_ENV_RENAME_UNSUPPORTED", harness: "codex",
        message: `Codex forwards environment variables only under their own name, so ${value.fromEnv} cannot become ${key} for MCP server ${name}; the binding was omitted.`,
      });
    }
  }
  return diagnostics;
}

/** A standalone custom agent file, per https://developers.openai.com/codex/subagents. */
function codexAgentToml(agent: AgentDocument): string {
  const fields: Array<[string, string]> = [["name", agent.id], ["description", agent.description]];
  if (agent.model !== "inherit") fields.push(["model", agent.model]);
  fields.push(["developer_instructions", agent.content.trim()]);
  return `${stringifyToml(Object.fromEntries(fields))}\n`;
}

export const codexAdapter: HarnessAdapter = {
  descriptor: {
    id: "codex",
    name: "OpenAI Codex",
    executables: ["codex"],
    docs: [
      "https://developers.openai.com/codex/guides/agents-md",
      "https://developers.openai.com/codex/config-reference",
      "https://developers.openai.com/codex/skills",
      "https://developers.openai.com/codex/auth",
      "https://developers.openai.com/codex/hooks",
      "https://developers.openai.com/codex/subagents",
    ],
    verifiedAt: VERIFIED_AT,
    capabilities: {
      instructions: "native", rules: "translated", skills: "portable", mcp: "native",
      hooks: "native", agents: "native", commands: "unsupported",
    },
    notes: [
      "Rules are linked from ~/.codex/AGENTS.md; ~/.codex/rules/ holds the execution policy Codex writes.",
      "Skills go to the shared ~/.agents/skills/.",
    ],
  },
  layout(context) {
    const root = context.environment("CODEX_HOME") ?? context.join(context.home, ".codex");
    return {
      root,
      surfaces: [
        { id: "instructions", kind: "file", target: context.join(root, "AGENTS.md") },
        { id: "agents", kind: "directory", target: context.join(root, "agents") },
        { id: "hooks", kind: "file", target: context.join(root, "hooks.json") },
        {
          id: "config", kind: "config", target: context.join(root, "config.toml"), format: "toml",
          keys: ["mcp_servers"], settings: { reserved: [] },
        },
      ],
      // Codex also keeps SQLite state in the root; its file names are not documented.
      neverTouch: under(context, root, ["auth.json", "history.jsonl", "log", "sessions", "rules"]),
      sharedSkills: true,
      // Native user roots, in host_roots.rs order; neither expands write ownership.
      skillSources: [
        { path: context.join(root, "skills"), depth: 64 },
        { path: context.join(context.home, ".agents", "skills"), depth: 64, shared: true },
      ],
    };
  },
  project(model, _layout, runtime) {
    const contents: Array<SurfaceContent> = [];
    const diagnostics = unsupportedFeatures("codex", model, [
      ["commands", "Codex has no global slash-command directory."],
    ]);

    const instructions = instructionsText(model, true);
    if (instructions) contents.push({ kind: "file", surface: "instructions", content: instructions });

    if (model.agents.length > 0) {
      for (const agent of model.agents) {
        if (!agent.writable) {
          diagnostics.push({
            level: "warning", code: "AGENT_OPTION_UNSUPPORTED", harness: "codex",
            message: `Codex custom agents inherit the parent sandbox, so read-only agent ${agent.id} can still write.`,
          });
        }
      }
      contents.push({ kind: "directory", surface: "agents", files: documentFiles(model.agents, ".toml", codexAgentToml) });
    }

    const hooks = claudeStyleHooks(runtime, "codex", nativeHooks("codex", model.hooks, CODEX_EVENTS, diagnostics), diagnostics);
    if (Object.keys(hooks).length > 0) contents.push({ kind: "file", surface: "hooks", content: jsonFile({ hooks }) });

    if (model.mcp.length > 0) {
      diagnostics.push(...codexMcpDiagnostics(model.mcp));
      contents.push({ kind: "config", surface: "config", keys: [{ path: "mcp_servers", value: mcpTable(model.mcp, codexMcpServer) }] });
    }
    return { contents, diagnostics };
  },
};
