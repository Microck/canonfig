import { Predicate } from "effect";
import { scheduleCommand } from "../schedule/schedule-command.ts";
import type { McpServer } from "./model.ts";

/** No credential lookup belongs in projection, including plans and digests. */
export const usesSharedSecret = (server: McpServer): boolean =>
  Object.values(server.transport === "stdio" ? server.env : server.headers)
    .some((value) => !Predicate.isString(value) && "fromSecret" in value);

/** All adapters receive the same PATH-independent installed launcher. */
export const projectedMcpServer = (
  name: string, server: McpServer, platform: NodeJS.Platform = process.platform,
): McpServer => {
  if (!usesSharedSecret(server)) return server;
  const binding = scheduleCommand();
  // Filtered harness environments must retain the bus session and source names,
  // not the server's destination names or any resolved/default values.
  const names = new Set(platform === "linux" ? ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"] : []);
  for (const value of Object.values(server.transport === "stdio" ? server.env : server.headers)) {
    if (!Predicate.isString(value) && "fromEnv" in value) names.add(value.fromEnv);
  }
  return {
    transport: "stdio",
    command: binding.executable,
    args: [binding.arguments[0]!, "mcp", "run", name],
    env: Object.fromEntries([...names].map((name) => [name, { fromEnv: name }])),
    timeoutMs: server.timeoutMs,
    enabledTools: server.enabledTools,
    disabledTools: server.disabledTools,
  };
};
