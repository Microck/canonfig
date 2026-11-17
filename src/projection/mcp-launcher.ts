import { Predicate } from "effect";
import { scheduleCommand } from "../schedule/schedule-command.ts";
import type { McpServer } from "./model.ts";

/** No credential lookup belongs in projection, including plans and digests. */
export const usesSharedSecret = (server: McpServer): boolean =>
  Object.values(server.transport === "stdio" ? server.env : server.headers)
    .some((value) => !Predicate.isString(value) && "fromSecret" in value);

/** All adapters receive the same PATH-independent installed launcher. */
export const projectedMcpServer = (name: string, server: McpServer): McpServer => {
  if (!usesSharedSecret(server)) return server;
  const binding = scheduleCommand();
  return {
    transport: "stdio",
    command: binding.executable,
    args: [binding.arguments[0]!, "mcp", "run", name],
    env: {},
    timeoutMs: server.timeoutMs,
    enabledTools: server.enabledTools,
    disabledTools: server.disabledTools,
  };
};
