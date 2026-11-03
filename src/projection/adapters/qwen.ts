import type { Hook, McpServer } from "../core/schema.ts";
import type {
  BuildContext,
  DesiredArtifact,
  Diagnostic,
  HarnessAdapter,
} from "../core/types.ts";
import { markdownWithFrontmatter } from "../core/frontmatter.ts";
import { descriptor } from "./descriptor.ts";
import {
  agentDocuments,
  commandDocuments,
  enabledHooks,
  enabledMcpServerEntries,
  hookCommand,
  secretValue,
  skillArtifacts,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";

const QWEN_EVENT_MAP: Partial<Record<Hook["event"], string>> = {
  session_start: "SessionStart",
  session_end: "SessionEnd",
  prompt_submit: "UserPromptSubmit",
  before_tool: "PreToolUse",
  after_tool: "PostToolUse",
  before_compact: "PreCompact",
  stop: "Stop",
  subagent_start: "SubagentStart",
  subagent_stop: "SubagentStop",
};

const QWEN_MATCHER_EVENTS = new Set([
  "SessionStart",
  "SessionEnd",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "SubagentStart",
  "SubagentStop",
]);

function qwenHooks(
  context: BuildContext,
): { hooks: Record<string, unknown[]>; diagnostics: Diagnostic[] } {
  const hooks: Record<string, unknown[]> = {};
  const diagnostics: Diagnostic[] = [];
  for (const hook of enabledHooks(context)) {
    const event = QWEN_EVENT_MAP[hook.event];
    if (!event) {
      diagnostics.push({
        level: "warning",
        code: "HOOK_EVENT_UNSUPPORTED",
        target: "qwen",
        message: `Qwen Code cannot directly map hook event ${hook.event}; it was skipped.`,
      });
      continue;
    }
    const entry = {
      ...(QWEN_MATCHER_EVENTS.has(event) ? { matcher: "*" } : {}),
      hooks: [{
        type: "command",
        command: hookCommand("qwen", hook),
        timeout: hook.timeoutMs,
      }],
    };
    (hooks[event] ??= []).push(entry);
  }
  return { hooks, diagnostics };
}

function qwenMcpServer(server: McpServer): Record<string, unknown> {
  const common = {
    ...(server.timeoutMs === undefined ? {} : { timeout: server.timeoutMs }),
    ...(server.enabledTools?.length ? { includeTools: server.enabledTools } : {}),
    ...(server.disabledTools?.length ? { excludeTools: server.disabledTools } : {}),
  };
  if (server.transport === "stdio") {
    return {
      command: server.command,
      ...(server.args.length ? { args: server.args } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
      ...(Object.keys(server.env).length
        ? {
            env: Object.fromEntries(
              Object.entries(server.env).map(([key, value]) => [key, secretValue(value)]),
            ),
          }
        : {}),
      ...common,
    };
  }
  return {
    ...(server.transport === "sse" ? { url: server.url } : { httpUrl: server.url }),
    ...(Object.keys(server.headers).length
      ? {
          headers: Object.fromEntries(
            Object.entries(server.headers).map(([key, value]) => [key, secretValue(value)]),
          ),
        }
      : {}),
    ...common,
  };
}

function qwenMcpMap(context: BuildContext): Record<string, unknown> {
  return Object.fromEntries(
    enabledMcpServerEntries(context).map(([name, server]) => [
      name,
      qwenMcpServer(server),
    ]),
  );
}

export const qwenAdapter: HarnessAdapter = {
  descriptor: descriptor(
    "qwen",
    "Qwen Code",
    ["qwen"],
    [
      "https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/skills.md",
      "https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/mcp.md",
      "https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/hooks.md",
      "https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/sub-agents.md",
      "https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/commands.md",
    ],
    {
      instructions: "portable",
      rules: "portable",
      skills: "native",
      mcp: "native",
      hooks: "native",
      agents: "native",
      commands: "native",
    },
    [
      "Qwen Code stores project MCP servers and hooks together in .qwen/settings.json; Canonfig owns only the projected keys.",
      "Canonical streamable HTTP servers map to Qwen's httpUrl field, while legacy SSE servers retain url.",
    ],
    "2026-08-26",
  ),
  async build(context) {
    const artifacts: DesiredArtifact[] = [];
    const diagnostics: Diagnostic[] = [];

    artifacts.push(...await skillArtifacts(context, ".qwen/skills", "qwen"));

    if (enabledMcpServerEntries(context).length > 0) {
      artifacts.push({
        kind: "json",
        path: ".qwen/settings.json",
        owner: "qwen",
        operations: [{
          kind: "managed-map",
          path: ["mcpServers"],
          entries: qwenMcpMap(context),
          collision: "error",
        }],
      });
    }

    const compiledHooks = qwenHooks(context);
    diagnostics.push(...compiledHooks.diagnostics);
    if (Object.keys(compiledHooks.hooks).length > 0) {
      artifacts.push({
        kind: "json",
        path: ".qwen/settings.json",
        owner: "qwen",
        operations: [{
          kind: "managed-hooks",
          path: ["hooks"],
          hooks: compiledHooks.hooks,
          marker: ".canonfig/.runtime/hook-runner.mjs",
        }],
      });
    }

    for (const { agent, content } of await agentDocuments(context)) {
      const tools = nativeTools("qwen", agent);
      artifacts.push({
        kind: "replace",
        path: `.qwen/agents/${agent.id}.md`,
        owner: "qwen",
        content: markdownWithFrontmatter({
          name: agent.id,
          description: agent.description,
          ...(agent.model === "inherit" ? {} : { model: agent.model }),
          tools,
          ...(!agent.writable
            ? { disallowedTools: ["edit", "write_file"] }
            : {}),
        }, content),
      });
    }

    for (const { command, content } of await commandDocuments(context)) {
      artifacts.push({
        kind: "replace",
        path: `.qwen/commands/${command.id}.md`,
        owner: "qwen",
        content: markdownWithFrontmatter({ description: command.description }, content),
      });
    }

    return { artifacts, diagnostics };
  },
};
