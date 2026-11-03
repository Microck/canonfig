import { Predicate } from "effect";

import type { ConfigValue } from "../../domain/resource.ts";
import type { Diagnostic } from "../harness.ts";
import type { McpServer, SecretValue, TargetId } from "../model.ts";
import type { ConfigTable } from "./shared.ts";

/** How a harness spells an environment reference inside MCP strings. */
export type EnvironmentSyntax = "shell" | "cursor" | "opencode";

/** A literal, or the harness's reference to an environment variable; never its value. */
export function secretValue(value: SecretValue, syntax: EnvironmentSyntax): string {
  if (Predicate.isString(value)) return value;
  switch (syntax) {
    case "cursor":
      return `\${env:${value.fromEnv}}`;
    case "opencode":
      return `{env:${value.fromEnv}}`;
    case "shell":
      return `\${${value.fromEnv}}`;
  }
}

export function secretTable(values: Readonly<Record<string, SecretValue>>, syntax: EnvironmentSyntax): ConfigTable {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, secretValue(value, syntax)]));
}

/** Canonical MCP options some harness formats cannot hold. */
export type McpGap = "timeoutMs" | "enabledTools" | "disabledTools" | "cwd" | "sse";

function hasGap(server: McpServer, gap: McpGap): boolean {
  switch (gap) {
    case "timeoutMs":
      return server.timeoutMs !== undefined;
    case "enabledTools":
      return (server.enabledTools?.length ?? 0) > 0;
    case "disabledTools":
      return (server.disabledTools?.length ?? 0) > 0;
    case "cwd":
      return server.transport === "stdio" && (server.cwd?.length ?? 0) > 0;
    case "sse":
      return server.transport === "sse";
  }
}

/** One warning per MCP server whose options the harness format drops. */
export function mcpGapDiagnostics(
  harness: TargetId,
  servers: ReadonlyArray<readonly [string, McpServer]>,
  gaps: ReadonlyArray<McpGap>,
): Array<Diagnostic> {
  return servers.flatMap(([name, server]): Array<Diagnostic> => {
    const omitted = gaps.filter((gap) => hasGap(server, gap));
    if (omitted.length === 0) return [];
    return [{
      level: "warning",
      code: "MCP_OPTION_UNSUPPORTED",
      harness,
      message: `${harness} cannot represent ${omitted.join(", ")} for MCP server ${name}; those options were omitted.`,
    }];
  });
}

/** Whole-second MCP timeout; a rounded value is reported. */
export function mcpTimeoutSeconds(
  harness: TargetId,
  name: string,
  timeoutMs: number,
  diagnostics: Array<Diagnostic>,
): number {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  if (seconds * 1000 !== timeoutMs) {
    diagnostics.push({
      level: "warning",
      code: "MCP_OPTION_COERCED",
      harness,
      message: `${harness} takes MCP timeouts in whole seconds, so timeoutMs ${timeoutMs} for MCP server ${name} was rounded up to ${seconds}s.`,
    });
  }
  return seconds;
}

export interface StandardMcpOptions {
  /** Emit `type` (`stdio`, `http` or `sse`). */
  readonly type: boolean;
  readonly syntax: EnvironmentSyntax;
  /** Emit `timeoutMs` as `timeout` in milliseconds. */
  readonly timeout: boolean;
}

/**
 * The `mcpServers` entry most clients share: `command`, `args`, `env`, `cwd`
 * for stdio and `url`, `headers` for remote servers.
 */
export function standardMcpServer(server: McpServer, options: StandardMcpOptions): ConfigTable {
  const fields: Array<[string, ConfigValue]> = [];
  if (server.transport === "stdio") {
    if (options.type) fields.push(["type", "stdio"]);
    fields.push(["command", server.command], ["args", server.args]);
    if (Object.keys(server.env).length > 0) fields.push(["env", secretTable(server.env, options.syntax)]);
    if (server.cwd) fields.push(["cwd", server.cwd]);
  } else {
    if (options.type) fields.push(["type", server.transport === "sse" ? "sse" : "http"]);
    fields.push(["url", server.url]);
    if (Object.keys(server.headers).length > 0) fields.push(["headers", secretTable(server.headers, options.syntax)]);
  }
  if (options.timeout && server.timeoutMs !== undefined) fields.push(["timeout", server.timeoutMs]);
  return Object.fromEntries(fields);
}

/** Server name to native entry; a server the translator returns undefined for is left out. */
export function mcpTable(
  servers: ReadonlyArray<readonly [string, McpServer]>,
  translate: (server: McpServer, name: string) => ConfigValue | undefined,
): ConfigTable {
  const entries: Array<[string, ConfigValue]> = [];
  for (const [name, server] of servers) {
    const entry = translate(server, name);
    if (entry !== undefined) entries.push([name, entry]);
  }
  return Object.fromEntries(entries);
}
