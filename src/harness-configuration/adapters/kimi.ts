import type { McpServer } from "../core/schema.ts";
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
  commandSkillArtifacts,
  enabledHooks,
  secretValue,
  skillArtifacts,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";

function remoteHeaders(
  server: Extract<McpServer, { transport: "streamable-http" | "sse" }>,
): { headers?: Record<string, string>; bearerTokenEnvVar?: string } {
  const headers: Record<string, string> = {};
  let bearerTokenEnvVar: string | undefined;
  for (const [name, value] of Object.entries(server.headers)) {
    if (
      name.toLowerCase() === "authorization"
      && typeof value !== "string"
      && value.default === undefined
    ) {
      bearerTokenEnvVar = value.fromEnv;
      continue;
    }
    headers[name] = secretValue(value);
  }
  return {
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(bearerTokenEnvVar === undefined ? {} : { bearerTokenEnvVar }),
  };
}

function kimiMcpServer(server: McpServer): Record<string, unknown> {
  const common = {
    enabled: server.enabled,
    ...(server.timeoutMs === undefined
      ? {}
      : {
          startupTimeoutMs: server.timeoutMs,
          toolTimeoutMs: server.timeoutMs,
        }),
    ...(server.enabledTools?.length ? { enabledTools: server.enabledTools } : {}),
    ...(server.disabledTools?.length ? { disabledTools: server.disabledTools } : {}),
  };
  if (server.transport === "stdio") {
    return {
      transport: "stdio",
      command: server.command,
      ...(server.args.length ? { args: server.args } : {}),
      ...(Object.keys(server.env).length
        ? {
            env: Object.fromEntries(
              Object.entries(server.env).map(([key, value]) => [key, secretValue(value)]),
            ),
          }
        : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
      ...common,
    };
  }
  return {
    transport: server.transport === "sse" ? "sse" : "http",
    url: server.url,
    ...remoteHeaders(server),
    ...common,
  };
}

function kimiMcpMap(context: BuildContext): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(context.config.mcp.servers).map(([name, server]) => [
      name,
      kimiMcpServer(server),
    ]),
  );
}

export const kimiAdapter: HarnessAdapter = {
  descriptor: descriptor(
    "kimi",
    "Kimi Code CLI",
    ["kimi"],
    [
      "https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/skills.md",
      "https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/mcp.md",
      "https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/hooks.md",
      "https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/agents.md",
    ],
    {
      instructions: "portable",
      rules: "portable",
      skills: "portable",
      mcp: "native",
      hooks: "lossy",
      agents: "native",
      commands: "translated",
      permissions: "lossy",
    },
    [
      "Kimi discovers project Agent Skills from .agents/skills, so canonical skills remain shared rather than copied.",
      "Commands compile to Agent Skills and remain available through Kimi's /skill:<name> interface.",
      "Kimi hooks and permanent permission rules live in the user-level config.toml; Canonfig does not mutate that profile-scoped file from a project projection.",
    ],
    "2026-08-26",
  ),
  async build(context) {
    const artifacts: DesiredArtifact[] = [];
    const diagnostics: Diagnostic[] = [];

    if (Object.keys(context.config.mcp.servers).length > 0) {
      artifacts.push({
        kind: "json",
        path: ".kimi-code/mcp.json",
        owner: "kimi",
        operations: [{
          kind: "managed-map",
          path: ["mcpServers"],
          entries: kimiMcpMap(context),
          collision: "error",
        }],
      });
    }

    for (const { agent, content } of await agentDocuments(context)) {
      const tools = nativeTools("kimi", agent);
      artifacts.push({
        kind: "replace",
        path: `.kimi-code/agents/${agent.id}.md`,
        owner: "kimi",
        content: markdownWithFrontmatter({
          name: agent.id,
          description: agent.description,
          ...(agent.model === "inherit" ? {} : { model: agent.model }),
          tools,
          ...(!agent.writable && tools.some((tool) => tool === "Edit" || tool === "Write")
            ? { disallowedTools: ["Edit", "Write"] }
            : {}),
        }, content),
      });
    }

    const commonSkillPaths = new Set(
      (await skillArtifacts(context, ".agents/skills", "common"))
        .map((artifact) => artifact.path),
    );
    for (const artifact of await commandSkillArtifacts(
      context,
      ".agents/skills",
      "kimi",
    )) {
      if (commonSkillPaths.has(artifact.path)) {
        diagnostics.push({
          level: "error",
          code: "TRANSLATED_SKILL_COLLISION",
          target: "kimi",
          path: artifact.path,
          message: `Kimi command output collides with a canonical skill at ${artifact.path}; rename the skill or command.`,
        });
      } else {
        artifacts.push(artifact);
      }
    }

    if (enabledHooks(context).length > 0) {
      diagnostics.push({
        level: "warning",
        code: "KIMI_PROFILE_HOOKS_REQUIRED",
        target: "kimi",
        message: "Kimi Code hooks are stored in the user-level config.toml, so project hooks were not installed automatically.",
      });
    }
    if (context.config.permissions.rules.length > 0) {
      diagnostics.push({
        level: "warning",
        code: "KIMI_PROFILE_PERMISSIONS_REQUIRED",
        target: "kimi",
        message: "Kimi Code permanent permission rules are profile-scoped; canonical project permission rules were not installed automatically.",
      });
    }

    return { artifacts, diagnostics };
  },
};
