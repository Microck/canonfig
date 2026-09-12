import { Schema } from "effect";

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
  enabledMcpServerEntries,
  hasEnabledMcpServers,
  secretValue,
  skillArtifacts,
} from "./shared.ts";
import { nativeTools } from "./tools.ts";
const SecretReferenceSchema = Schema.Struct({
  fromEnv: Schema.NonEmptyString,
  default: Schema.optional(Schema.String),
});

interface KimiRemoteHeaders {
  headers?: Record<string, string>;
  bearerTokenEnvVar?: string;
}

interface KimiMcpCommon {
  enabled: boolean;
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  enabledTools?: ReadonlyArray<string>;
  disabledTools?: ReadonlyArray<string>;
}

type KimiMcpProjection = KimiMcpCommon & (
  | {
    transport: "stdio";
    command: string;
    args?: ReadonlyArray<string>;
    env?: Record<string, string>;
    cwd?: string;
  }
  | {
    transport: "sse" | "http";
    url: string;
    headers?: Record<string, string>;
    bearerTokenEnvVar?: string;
  }
);

function remoteHeaders(
  server: Extract<McpServer, { transport: "streamable-http" | "sse" }>,
): KimiRemoteHeaders {
  const result: KimiRemoteHeaders = {};
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(server.headers)) {
    if (
      name.toLowerCase() === "authorization"
      && Schema.is(SecretReferenceSchema)(value)
      && value.default === undefined
    ) {
      result.bearerTokenEnvVar = value.fromEnv;
      continue;
    }
    headers[name] = secretValue(value);
  }
  if (Object.keys(headers).length > 0) result.headers = headers;
  return result;
}

function commonMcpFields(server: McpServer): KimiMcpCommon {
  const common: KimiMcpCommon = { enabled: server.enabled };
  if (server.timeoutMs !== undefined) {
    common.startupTimeoutMs = server.timeoutMs;
    common.toolTimeoutMs = server.timeoutMs;
  }
  if (server.enabledTools !== undefined && server.enabledTools.length > 0) {
    common.enabledTools = server.enabledTools;
  }
  if (server.disabledTools !== undefined && server.disabledTools.length > 0) {
    common.disabledTools = server.disabledTools;
  }
  return common;
}

function kimiMcpServer(server: McpServer): KimiMcpProjection {
  const common = commonMcpFields(server);
  if (server.transport === "stdio") {
    const projection: KimiMcpProjection = {
      transport: "stdio",
      command: server.command,
      ...common,
    };
    if (server.args.length > 0) projection.args = server.args;
    if (Object.keys(server.env).length > 0) {
      projection.env = Object.fromEntries(
        Object.entries(server.env).map(([key, value]) => [
          key,
          secretValue(value),
        ]),
      );
    }
    if (server.cwd !== undefined) projection.cwd = server.cwd;
    return projection;
  }
  return {
    transport: server.transport === "sse" ? "sse" : "http",
    url: server.url,
    ...remoteHeaders(server),
    ...common,
  };
}

function kimiMcpMap(context: BuildContext): Record<string, KimiMcpProjection> {
  // Disabled servers carry no profile material, including the secrets in
  // their env and header maps. See openCodeMcpMap for the same boundary.
  return Object.fromEntries(
    enabledMcpServerEntries(context).map(([name, server]) => [
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

    if (hasEnabledMcpServers(context)) {
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
      const frontmatter: {
        name: string;
        description: string;
        tools: ReadonlyArray<string>;
        model?: string;
        disallowedTools?: ReadonlyArray<string>;
      } = {
        name: agent.id,
        description: agent.description,
        tools,
      };
      if (agent.model !== "inherit") frontmatter.model = agent.model;
      if (
        !agent.writable
        && tools.some((tool) => tool === "Edit" || tool === "Write")
      ) {
        frontmatter.disallowedTools = ["Edit", "Write"];
      }
      artifacts.push({
        kind: "replace",
        path: `.kimi-code/agents/${agent.id}.md`,
        owner: "kimi",
        content: markdownWithFrontmatter(frontmatter, content),
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
