import type { McpServer, SecretValue } from "../core/schema.ts";
import type { BuildContext, JsonArtifact, TargetId } from "../core/types.ts";

export function secretValue(value: SecretValue): string {
  return typeof value === "string" ? value : `\${${value.fromEnv}}`;
}

export function standardMcpServer(server: McpServer, includeType = true): Record<string, unknown> {
  if (server.transport === "stdio") {
    return {
      ...(includeType ? { type: "stdio" } : {}),
      command: server.command,
      args: server.args,
      ...(Object.keys(server.env).length > 0
        ? { env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, secretValue(value)])) }
        : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
    };
  }
  return {
    ...(includeType ? { type: server.transport === "sse" ? "sse" : "http" } : {}),
    url: server.url,
    ...(Object.keys(server.headers).length > 0
      ? { headers: Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, secretValue(value)])) }
      : {}),
  };
}

export function standardMcpMap(context: BuildContext, includeType = true): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(context.config.mcp.servers)
      .filter(([, server]) => server.enabled)
      .map(([name, server]) => [name, standardMcpServer(server, includeType)]),
  );
}

export function piMcpMap(context: BuildContext): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(context.config.mcp.servers)
      .filter(([, server]) => server.enabled)
      .map(([name, server]) => {
        if (server.transport === "stdio") {
          return [name, {
            command: server.command,
            args: server.args,
            ...(server.cwd ? { cwd: server.cwd } : {}),
            ...(Object.keys(server.env).length
              ? { env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, secretValue(value)])) }
              : {}),
          }];
        }
        return [name, {
          transport: server.transport,
          url: server.url,
          ...(Object.keys(server.headers).length
            ? { headers: Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, secretValue(value)])) }
            : {}),
        }];
      }),
  );
}

export function antigravityMcpMap(context: BuildContext): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(context.config.mcp.servers)
      .filter(([, server]) => server.enabled)
      .map(([name, server]) => {
        if (server.transport === "stdio") {
          return [name, {
            command: server.command,
            args: server.args,
            ...(Object.keys(server.env).length
              ? { env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, secretValue(value)])) }
              : {}),
          }];
        }
        return [name, {
          serverUrl: server.url,
          ...(Object.keys(server.headers).length
            ? { headers: Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, secretValue(value)])) }
            : {}),
        }];
      }),
  );
}

export function openCodeMcpMap(context: BuildContext): Record<string, unknown> {
  return Object.fromEntries(Object.entries(context.config.mcp.servers).map(([name, server]) => {
    if (server.transport === "stdio") {
      return [name, {
        type: "local",
        command: [server.command, ...server.args],
        enabled: server.enabled,
        ...(Object.keys(server.env).length
          ? { environment: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, secretValue(value)])) }
          : {}),
        ...(server.timeoutMs ? { timeout: server.timeoutMs } : {}),
      }];
    }
    return [name, {
      type: "remote",
      url: server.url,
      enabled: server.enabled,
      ...(Object.keys(server.headers).length
        ? { headers: Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, secretValue(value)])) }
        : {}),
      ...(server.timeoutMs ? { timeout: server.timeoutMs } : {}),
    }];
  }));
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}
function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}
function tomlInlineTable(entries: Record<string, string>): string {
  return `{ ${Object.entries(entries).map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`).join(", ")} }`;
}

export function mcpToml(
  context: BuildContext,
  remoteHeadersKey: "http_headers" | "headers" = "http_headers",
): string {
  const sections: string[] = [];
  for (const [name, server] of Object.entries(context.config.mcp.servers)) {
    if (!server.enabled) continue;
    const lines = [`[mcp_servers.${tomlKey(name)}]`];
    if (server.transport === "stdio") {
      lines.push(`command = ${tomlString(server.command)}`);
      if (server.args.length) lines.push(`args = ${tomlArray(server.args)}`);
      if (server.cwd) lines.push(`cwd = ${tomlString(server.cwd)}`);
      if (Object.keys(server.env).length) {
        lines.push(`env = ${tomlInlineTable(Object.fromEntries(
          Object.entries(server.env).map(([key, value]) => [key, secretValue(value)]),
        ))}`);
      }
    } else {
      lines.push(`url = ${tomlString(server.url)}`);
      if (Object.keys(server.headers).length) {
        lines.push(`${remoteHeadersKey} = ${tomlInlineTable(Object.fromEntries(
          Object.entries(server.headers).map(([key, value]) => [key, secretValue(value)]),
        ))}`);
      }
    }
    if (server.enabledTools?.length) lines.push(`enabled_tools = ${tomlArray(server.enabledTools)}`);
    if (server.disabledTools?.length) lines.push(`disabled_tools = ${tomlArray(server.disabledTools)}`);
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

export function jsonMcpArtifact(
  pathname: string,
  owner: TargetId,
  context: BuildContext,
  pathSegments: string[] = ["mcpServers"],
  includeType = true,
): JsonArtifact {
  return {
    kind: "json",
    path: pathname,
    owner,
    operations: [{
      kind: "managed-map",
      path: pathSegments,
      entries: standardMcpMap(context, includeType),
      collision: "error",
    }],
  };
}

export function grokMcpToml(context: BuildContext): string {
  const sections: string[] = [];
  for (const [name, server] of Object.entries(context.config.mcp.servers)) {
    if (!server.enabled) continue;
    const lines = [`[mcp_servers.${tomlKey(name)}]`];
    if (server.transport === "stdio") {
      lines.push(`command = ${tomlString(server.command)}`);
      if (server.args.length) lines.push(`args = ${tomlArray(server.args)}`);
      if (Object.keys(server.env).length) {
        lines.push(`env = ${tomlInlineTable(Object.fromEntries(
          Object.entries(server.env).map(([key, value]) => [key, secretValue(value)]),
        ))}`);
      }
    } else {
      lines.push(`url = ${tomlString(server.url)}`);
      if (Object.keys(server.headers).length) {
        lines.push(`headers = ${tomlInlineTable(Object.fromEntries(
          Object.entries(server.headers).map(([key, value]) => [key, secretValue(value)]),
        ))}`);
      }
    }
    if (server.timeoutMs) {
      const seconds = Math.max(1, Math.ceil(server.timeoutMs / 1000));
      lines.push(`startup_timeout_sec = ${seconds}`);
      lines.push(`tool_timeout_sec = ${seconds}`);
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}
