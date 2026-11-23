import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Predicate, Schema } from "effect";
import { windowsPowerShellExecutable } from "../machine/windows-credentials.ts";
import { scheduleCommand } from "../schedule/schedule-command.ts";
import type { McpServer, RemoteMcpServer } from "./model.ts";

export const mcpProxyHost = "127.0.0.1";
export const mcpProxyDefaultPort = 17343;
export const mcpProxyBindingFile = "mcp-proxy.json";
const mcpProxyRoutePrefix = "/mcp/";
const mcpProxyAuthorizationPrefix = "Bearer canonfig-mcp-";
const McpProxyPort = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));
const McpProxyBinding = Schema.fromJsonString(Schema.Struct({
  port: McpProxyPort,
  seed: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
}));
type McpProxyBinding = typeof McpProxyBinding.Type;

const readWindowsBinding = async (path: string): Promise<string> => {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$file=[IO.File]::Open($env:CANONFIG_PROXY_BINDING_PATH,'Open','Read','Read')",
    // Check and read the same handle even if an ancestor path changes.
    "$acl=if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::GetAccessControl($file) } else { $file.GetAccessControl() }",
    "$sidType=[Security.Principal.SecurityIdentifier]",
    "$user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    // The OS and its administrators can already access the user's files.
    "$trusted=@($user,'S-1-5-18','S-1-5-32-544')",
    "if ($acl.GetOwner($sidType).Value -notin $trusted -or -not $acl.AreAccessRulesProtected) { exit 1 }",
    "foreach ($rule in $acl.GetAccessRules($true,$true,$sidType)) { if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted) { exit 1 } }",
    "$reader=[IO.StreamReader]::new($file); try { [Console]::Write($reader.ReadToEnd()) } finally { $reader.Dispose() }",
  ].join(";");
  const { stdout } = await promisify(execFile)(windowsPowerShellExecutable(), ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, CANONFIG_PROXY_BINDING_PATH: path }, timeout: 60_000, maxBuffer: 4096, windowsHide: true,
  });
  return stdout;
};

export const readMcpProxyBinding = async (folder: string): Promise<McpProxyBinding | undefined> => {
  const path = join(folder, mcpProxyBindingFile);
  const info = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (info === undefined) return undefined;
  if (!info.isFile()) throw new Error("Expected a regular MCP proxy binding file");
  const decodeBinding = Schema.decodeUnknownSync(McpProxyBinding);
  if (process.platform === "win32") return decodeBinding(await readWindowsBinding(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat({ bigint: true });
    if (opened.ino !== info.ino || opened.dev !== info.dev || opened.ctimeNs !== info.ctimeNs) {
      throw new Error("MCP proxy binding changed while checking permissions");
    }
    if (process.getuid && (opened.uid !== BigInt(process.getuid()) || (opened.mode & 0o077n) !== 0n)) {
      throw new Error("Expected a private MCP proxy binding file");
    }
    return decodeBinding(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
};

export const newMcpProxyBinding = (port: number): McpProxyBinding => ({ port, seed: randomBytes(32).toString("hex") });

export const mcpProxyUrl = (port: number): URL => new URL(`http://${mcpProxyHost}:${port}`);
export const mcpProxyAuthorization = (binding: McpProxyBinding, name: string): string =>
  `${mcpProxyAuthorizationPrefix}${createHmac("sha256", binding.seed).update(name).digest("hex")}`;

export const isMcpProxyAuthorization = (value: string): boolean =>
  value.startsWith(mcpProxyAuthorizationPrefix)
  && /^[a-f0-9]{64}$/u.test(value.slice(mcpProxyAuthorizationPrefix.length));

export const mcpProxyRouteName = (path: string | undefined): string | undefined => {
  if (!path?.startsWith(mcpProxyRoutePrefix)) return undefined;
  const name = path.slice(mcpProxyRoutePrefix.length);
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(name) ? name : undefined;
};

export const isMcpProxyUpstream = (value: string): boolean => {
  const url = URL.parse(value);
  if (!url || url.username || url.password || url.hash) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname));
};

export const proxyMcpServer = (name: string, server: RemoteMcpServer, binding: McpProxyBinding): RemoteMcpServer => ({
  transport: "streamable-http",
  url: `${mcpProxyUrl(binding.port).origin}${mcpProxyRoutePrefix}${name}`,
  headers: { Authorization: mcpProxyAuthorization(binding, name) },
  timeoutMs: server.timeoutMs,
  enabledTools: server.enabledTools,
  disabledTools: server.disabledTools,
});

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
