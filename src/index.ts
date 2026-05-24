#!/usr/bin/env node
import { Command, Option } from "commander";
import chokidar from "chokidar";
import { createHash, randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir, platform, tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

const VERSION = "0.3.9";
const DEFAULT_PORT = 17342;
const DEFAULT_TIMEOUT_MS = 5_000;
const CODEXPORT_DIR = ".codexport";
const MASTER_ID_FILE = "master-id.json";
const LOCAL_FILE = "local.toml";
const MCPS_LOCAL_FILE = "mcps.local.toml";
const LAST_BUNDLE_FILE = "last-bundle.json";
const CACHE_BUNDLE_FILE = "bundle.json";
const APPLIED_FILES_FILE = "applied-files.json";
const MCP_MANIFEST_FILE = "mcp-manifest.json";
const MANAGED_MCP_RUNNER_FILE = "codexport-mcp-run.mjs";

const INCLUDE_ROOTS = [
  "AGENTS.md",
  "RTK.md",
  "config.toml",
  "auth.json",
  ".credentials.json",
  "multi-auth",
  "hooks.json",
  "hooks",
  "prompts",
  "rules",
  "skills",
  "skill-libraries",
  "mise.toml"
];

const EXCLUDE_PARTS = new Set([
  "logs",
  "log",
  "cache",
  "caches",
  "tmp",
  "temp",
  "sessions",
  "history",
  "compact-handoffs",
  "shell-snapshots",
  ".sqlite",
  ".sqlite3"
]);

const MCP_ENV_EXPORT_NAMES = [
  "KAGI_API_KEY",
  "KAGI_SESSION_TOKEN",
  "KAGI_CLI_PROFILE"
];

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface FileEntry {
  path: string;
  mode: number;
  kind: "file" | "symlink";
  content: string;
}

interface Bundle {
  version: 1;
  builtAt: string;
  sourceRoot: string;
  revision: string;
  files: FileEntry[];
  sourceEnv?: Record<string, string>;
}

interface MasterIdentity {
  secret: string;
  fingerprint: string;
}

interface LocalConfig {
  role?: "master" | "follower";
  masterUrl?: string;
  masterFingerprint?: string;
  lastRevision?: string;
  codexDir?: string;
  port?: number;
  allowMcpOverrides?: string[];
  allowSkillOverrides?: string[];
  pathVariables?: Record<string, string>;
}

interface McpManifest {
  version: 1;
  sourceRoot?: string;
  sourceEnv?: Record<string, string>;
  servers: Record<string, Json>;
}

interface CliContext {
  homeDir: string;
  stateDir: string;
  codexDir: string;
  quiet: boolean;
  json: boolean;
  noInput: boolean;
}

interface McpLaunchSpec {
  command: string;
  args: string[];
  repair?: McpRepairSpec;
}

interface McpRepairSpec {
  whenMissing: string;
  command: string;
  args: string[];
}

class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 1,
    public readonly details?: Json
  ) {
    super(message);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeRelative(input: string): string {
  return input.split(path.sep).join("/");
}

function userPath(homeDir: string, ...parts: string[]): string {
  return path.join(homeDir, ...parts);
}

function defaultContext(options: { home?: string; codexDir?: string; quiet?: boolean; json?: boolean; noInput?: boolean }): CliContext {
  const homeDir = options.home ? path.resolve(options.home) : homedir();
  return {
    homeDir,
    stateDir: userPath(homeDir, CODEXPORT_DIR),
    codexDir: path.resolve(options.codexDir ?? userPath(homeDir, ".codex")),
    quiet: Boolean(options.quiet),
    json: Boolean(options.json),
    noInput: Boolean(options.noInput)
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw error;
  }
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  if (!(await pathExists(filePath))) return undefined;
  return readFile(filePath, "utf8");
}

async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  const text = await readTextIfExists(filePath);
  if (!text) return undefined;
  return JSON.parse(text) as T;
}

async function writeJsonAtomic(filePath: string, value: Json): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmpPath, filePath);
}

async function writeFileReplacingExisting(filePath: string, content: Buffer | string, options?: Parameters<typeof writeFile>[2]): Promise<void> {
  try {
    await writeFile(filePath, content, options);
    return;
  } catch (error) {
    if (!isPermissionError(error)) throw error;
  }

  if (await pathExists(filePath)) {
    try {
      await chmod(filePath, 0o666);
    } catch (error) {
      if (!isPermissionError(error)) throw error;
    }
    await rm(filePath, { force: true });
  }
  await writeFile(filePath, content, options);
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}

function parseTomlObject(text: string, filePath: string): Record<string, unknown> {
  try {
    const parsed = parseToml(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CliError(`${filePath} must contain a TOML table`, 2);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Failed to parse ${filePath}: ${asError(error).message}`, 2);
  }
}

async function readLocalConfig(ctx: CliContext): Promise<LocalConfig> {
  const filePath = path.join(ctx.stateDir, LOCAL_FILE);
  const text = await readTextIfExists(filePath);
  if (!text) return {};
  const parsed = parseTomlObject(text, filePath);
  return {
    role: parsed.role as LocalConfig["role"],
    masterUrl: parsed.masterUrl as string | undefined,
    masterFingerprint: parsed.masterFingerprint as string | undefined,
    lastRevision: parsed.lastRevision as string | undefined,
    codexDir: parsed.codexDir as string | undefined,
    port: typeof parsed.port === "number" ? parsed.port : undefined,
    allowMcpOverrides: Array.isArray(parsed.allowMcpOverrides) ? parsed.allowMcpOverrides.map(String) : undefined,
    allowSkillOverrides: Array.isArray(parsed.allowSkillOverrides) ? parsed.allowSkillOverrides.map(String) : undefined,
    pathVariables: parsed.pathVariables && typeof parsed.pathVariables === "object" ? parsed.pathVariables as Record<string, string> : undefined
  };
}

async function writeLocalConfig(ctx: CliContext, config: LocalConfig): Promise<void> {
  await ensureDir(ctx.stateDir);
  await writeFile(path.join(ctx.stateDir, LOCAL_FILE), stringifyToml(removeUndefined({ ...config }) as Record<string, Json>), "utf8");
}

function removeUndefined(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function loadMasterIdentity(ctx: CliContext): Promise<MasterIdentity> {
  const filePath = path.join(ctx.stateDir, MASTER_ID_FILE);
  const existing = await readJsonIfExists<MasterIdentity>(filePath);
  if (existing?.secret && existing.fingerprint === sha256(existing.secret)) return existing;
  const secret = randomBytes(32).toString("hex");
  const identity = { secret, fingerprint: sha256(secret) };
  await writeJsonAtomic(filePath, identity as unknown as Json);
  return identity;
}

function shouldExclude(relativePath: string): boolean {
  const parts = relativePath.split("/");
  return parts.some((part) => EXCLUDE_PARTS.has(part) || part.endsWith(".sqlite") || part.endsWith(".sqlite3"));
}

async function collectFiles(root: string): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  for (const includeRoot of INCLUDE_ROOTS) {
    const absolute = path.join(root, includeRoot);
    if (!(await pathExists(absolute))) continue;
    await walkIncluded(root, absolute, files);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

async function walkIncluded(root: string, absolute: string, files: FileEntry[]): Promise<void> {
  const relative = normalizeRelative(path.relative(root, absolute));
  if (!relative || shouldExclude(relative)) return;
  const entryStat = await lstat(absolute);
  if (entryStat.isSymbolicLink()) {
    return;
  }
  if (entryStat.isDirectory()) {
    const children = await readdir(absolute);
    for (const child of children) {
      await walkIncluded(root, path.join(absolute, child), files);
    }
    return;
  }
  if (entryStat.isFile()) {
    files.push({
      path: relative,
      mode: entryStat.mode & 0o777,
      kind: "file",
      content: (await readFile(absolute)).toString("base64")
    });
  }
}

function computeRevision(files: FileEntry[], sourceEnv: Record<string, string> = {}): string {
  const normalized = files.map((file) => ({
    path: file.path,
    mode: file.mode,
    kind: file.kind,
    contentHash: sha256(Buffer.from(file.content, "base64"))
  }));
  return sha256(JSON.stringify({ files: normalized, sourceEnv }));
}

async function buildBundle(codexDir: string): Promise<Bundle> {
  const files = await collectFiles(codexDir);
  const sourceEnv = collectSourceEnv();
  const revision = computeRevision(files, sourceEnv);
  return {
    version: 1,
    builtAt: new Date().toISOString(),
    sourceRoot: codexDir,
    revision,
    files,
    sourceEnv
  };
}

function collectSourceEnv(): Record<string, string> {
  const sourceEnv: Record<string, string> = {};
  for (const name of MCP_ENV_EXPORT_NAMES) {
    const value = process.env[name];
    if (value) sourceEnv[name] = value;
  }
  return sourceEnv;
}

async function saveMasterBundle(ctx: CliContext, bundle: Bundle): Promise<void> {
  await writeJsonAtomic(path.join(ctx.stateDir, LAST_BUNDLE_FILE), bundle as unknown as Json);
}

async function readMasterBundle(ctx: CliContext): Promise<Bundle> {
  const bundle = await readJsonIfExists<Bundle>(path.join(ctx.stateDir, LAST_BUNDLE_FILE));
  if (bundle) return bundle;
  const built = await buildBundle(ctx.codexDir);
  await saveMasterBundle(ctx, built);
  return built;
}

function formatJoinCommand(masterUrl: string, fingerprint: string): string {
  return `npx codexport follower join --master ${masterUrl} --fingerprint ${fingerprint}`;
}

function buildJoinLink(masterUrl: string, fingerprint: string): string {
  const url = new URL(masterUrl);
  const join = new URL("codexport://join");
  join.searchParams.set("host", url.hostname);
  join.searchParams.set("port", url.port || String(DEFAULT_PORT));
  join.searchParams.set("fingerprint", fingerprint);
  join.searchParams.set("protocol", url.protocol.replace(":", ""));
  join.searchParams.set("version", "1");
  return join.toString();
}

function parseJoinLink(input: string): { masterUrl: string; fingerprint: string } {
  if (!input.startsWith("codexport://")) {
    throw new CliError("Join input must be a codexport://join link or use --master and --fingerprint.", 2);
  }
  const url = new URL(input);
  if (url.hostname !== "join") throw new CliError("Unsupported codexport link. Expected codexport://join.", 2);
  const host = url.searchParams.get("host");
  const port = url.searchParams.get("port") ?? String(DEFAULT_PORT);
  const fingerprint = url.searchParams.get("fingerprint");
  const protocol = url.searchParams.get("protocol") ?? "http";
  if (!host || !fingerprint) throw new CliError("Join link is missing host or fingerprint.", 2);
  return { masterUrl: `${protocol}://${host}:${port}`, fingerprint };
}

function requestJson<T>(url: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new CliError(`GET ${url} failed with HTTP ${res.statusCode}: ${body.slice(0, 300)}`, 1));
          return;
        }
        try {
          resolve(JSON.parse(body) as T);
        } catch (error) {
          reject(new CliError(`GET ${url} returned invalid JSON: ${asError(error).message}`, 1));
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new CliError(`GET ${url} timed out after ${timeoutMs}ms`, 1));
    });
    req.on("error", reject);
    req.end();
  });
}

async function fetchMeta(masterUrl: string, timeoutMs: number): Promise<{ fingerprint: string; revision: string; fileCount: number; version: number }> {
  return requestJson(new URL("/meta", masterUrl).toString(), timeoutMs);
}

async function fetchBundle(masterUrl: string, timeoutMs: number): Promise<Bundle> {
  return requestJson(new URL("/bundle", masterUrl).toString(), timeoutMs);
}

function verifyBundle(bundle: Bundle): void {
  if (bundle.version !== 1 || !Array.isArray(bundle.files)) {
    throw new CliError("Bundle has an unsupported format.", 1);
  }
  const actualRevision = computeRevision(bundle.files, bundle.sourceEnv ?? {});
  if (bundle.revision !== actualRevision) {
    throw new CliError(`Bundle revision mismatch. Expected ${bundle.revision}, computed ${actualRevision}.`, 1);
  }
  for (const file of bundle.files) {
    if (path.isAbsolute(file.path) || file.path.includes("..") || file.path.includes("\\")) {
      throw new CliError(`Bundle contains unsafe path: ${file.path}`, 1);
    }
  }
}

async function readCachedBundle(ctx: CliContext): Promise<Bundle> {
  const bundle = await readJsonIfExists<Bundle>(path.join(ctx.stateDir, CACHE_BUNDLE_FILE));
  if (!bundle) throw new CliError("No staged bundle exists. Run codexport sync first.", 1);
  verifyBundle(bundle);
  return bundle;
}

async function writeCachedBundle(ctx: CliContext, bundle: Bundle): Promise<void> {
  verifyBundle(bundle);
  await writeJsonAtomic(path.join(ctx.stateDir, CACHE_BUNDLE_FILE), bundle as unknown as Json);
}

function decodeFile(file: FileEntry): Buffer {
  return Buffer.from(file.content, "base64");
}

function extractTomlTableNames(text: string, prefix: string): Set<string> {
  const names = new Set<string>();
  const pattern = new RegExp(`^\\s*\\[${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\"?([^"\\]]+)\"?\\]\\s*$`);
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(pattern);
    if (match) names.add(match[1]);
  }
  return names;
}

function mergeTomlText(canonical: string, localMcpText: string | undefined, localConfig: LocalConfig, sourceRoot?: string, sourceEnv: Record<string, string> = {}): string {
  const expandedCanonical = expandPathVariables(rewritePortableConfig(canonical, localConfig, sourceRoot, sourceEnv), localConfig);
  if (!localMcpText?.trim()) return expandedCanonical;
  const canonicalMcps = extractTomlTableNames(canonical, "mcp_servers");
  const localMcps = extractTomlTableNames(localMcpText, "mcp_servers");
  const allowed = new Set(localConfig.allowMcpOverrides ?? []);
  const conflicts = [...localMcps].filter((name) => canonicalMcps.has(name) && !allowed.has(name));
  if (conflicts.length) {
    throw new CliError(`Local MCP conflicts with canonical names: ${conflicts.join(", ")}. Add allowMcpOverrides in ~/.codexport/local.toml to override intentionally.`, 1, { conflicts });
  }
  return `${expandedCanonical.trimEnd()}\n\n# Follower-local MCP overlay from ~/.codexport/mcps.local.toml\n${localMcpText.trim()}\n`;
}

function rewritePortableConfig(canonical: string, localConfig: LocalConfig, sourceRoot?: string, sourceEnv: Record<string, string> = {}): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseTomlObject(canonical, "canonical config.toml");
  } catch {
    return canonical;
  }
  const sourceHome = inferHomeFromCodexDir(sourceRoot);
  const mcpServers = parsed.mcp_servers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    rewritePortableTableKeys(parsed, sourceRoot, sourceHome);
    rewriteLoopbackUrls(parsed, localConfig.masterUrl);
    return stringifyToml(parsed as Record<string, Json>);
  }

  rewritePortableTableKeys(parsed, sourceRoot, sourceHome);
  rewriteLoopbackUrls(parsed, localConfig.masterUrl);
  for (const [name, rawServer] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (!rawServer || typeof rawServer !== "object" || Array.isArray(rawServer)) continue;
    const server = rawServer as Record<string, unknown>;
    mergeSourceEnvForMcp(name, server, sourceEnv);
    rewriteManagedMcpServer(name, server, sourceRoot, sourceHome);
  }

  return stringifyToml(parsed as Record<string, Json>);
}

function buildMcpManifest(canonical: string, sourceRoot?: string, sourceEnv: Record<string, string> = {}): McpManifest | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseTomlObject(canonical, "canonical config.toml");
  } catch {
    return undefined;
  }
  const mcpServers = parsed.mcp_servers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) return undefined;
  const servers: Record<string, Json> = {};
  for (const [name, rawServer] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (!rawServer || typeof rawServer !== "object" || Array.isArray(rawServer)) continue;
    const server = structuredClone(rawServer) as Record<string, unknown>;
    mergeSourceEnvForMcp(name, server, sourceEnv);
    servers[name] = server as Json;
  }
  return { version: 1, sourceRoot, sourceEnv, servers };
}

function mergeSourceEnvForMcp(name: string, server: Record<string, unknown>, sourceEnv: Record<string, string>): void {
  if (name !== "kagi-mcp") return;
  const env = server.env && typeof server.env === "object" && !Array.isArray(server.env) ? server.env as Record<string, unknown> : {};
  for (const key of ["KAGI_API_KEY", "KAGI_SESSION_TOKEN", "KAGI_CLI_PROFILE"]) {
    if (typeof env[key] !== "string" && sourceEnv[key]) env[key] = sourceEnv[key];
  }
  server.env = env;
}

function rewritePortableTableKeys(table: Record<string, unknown>, sourceRoot?: string, sourceHome?: string): void {
  const rewritten: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(table)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      rewritePortableTableKeys(value as Record<string, unknown>, sourceRoot, sourceHome);
    }
    rewritten[rewritePortablePath(key, sourceRoot, sourceHome)] = value;
  }
  for (const key of Object.keys(table)) {
    delete table[key];
  }
  for (const [key, value] of Object.entries(rewritten)) {
    table[key] = value;
  }
}

function rewriteLoopbackUrls(value: unknown, masterUrl: string | undefined): unknown {
  if (!masterUrl) return value;
  if (typeof value === "string") return rewriteLoopbackUrl(value, masterUrl);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = rewriteLoopbackUrls(value[index], masterUrl);
    }
    return value;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    (value as Record<string, unknown>)[key] = rewriteLoopbackUrls(item, masterUrl);
  }
  return value;
}

function rewriteLoopbackUrl(value: string, masterUrl: string): string {
  let parsed: URL;
  let master: URL;
  try {
    parsed = new URL(value);
    master = new URL(masterUrl);
  } catch {
    return value;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return value;
  if (!isLoopbackHost(parsed.hostname)) return value;
  parsed.hostname = master.hostname;
  return parsed.toString();
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost"
    || normalized === "[::1]"
    || normalized === "::1"
    || normalized === "0.0.0.0"
    || normalized.startsWith("127.");
}

function rewriteManagedMcpServer(name: string, server: Record<string, unknown>, sourceRoot?: string, sourceHome?: string): void {
  if (typeof server.url === "string") return;

  server.command = "${node}";
  server.args = ["${codexportMcpRunner}", "mcp", "run", name];

  if (server.env && typeof server.env === "object" && !Array.isArray(server.env)) {
    for (const [key, value] of Object.entries(server.env as Record<string, unknown>)) {
      if (typeof value === "string") {
        (server.env as Record<string, unknown>)[key] = rewritePortablePath(value, sourceRoot, sourceHome);
      }
    }
  }

  if (typeof server.command === "string" && !server.url) {
    ensurePortablePathEnv(server);
  }
}

function portableMcpLauncher(name: string, command: string, args: unknown[], sourceHome: string | undefined, server: Record<string, unknown>): McpLaunchSpec | undefined {
  const commandName = basenameAnyPlatform(command);
  if (commandName === "npx" || commandName === "bunx" || commandName === "uvx") {
    return allStrings(args) ? { command: commandName, args: args as string[] } : undefined;
  }

  if (name === "kagi-mcp" || commandName === "kagi-mcp") {
    const env = server.env && typeof server.env === "object" && !Array.isArray(server.env) ? server.env as Record<string, unknown> : {};
    if (typeof env.KAGI_API_KEY === "string" && env.KAGI_API_KEY.length > 0) {
      return { command: "npx", args: ["-y", "kagi-mcp"] };
    }
    if (typeof env.KAGI_SESSION_TOKEN === "string" && env.KAGI_SESSION_TOKEN.length > 0) {
      return { command: "npx", args: ["-y", "kagi-cli", "mcp"] };
    }
  }

  const nodePackage = nodePackageFromServer(command, args) ?? workspacePackageFromServer(command, args, sourceHome);
  if (nodePackage) {
    return { command: "npx", args: ["-y", nodePackage.packageName, ...nodePackage.remainingArgs] };
  }

  if (name === "discord-py-self" || commandName === "discord-py-self-mcp") {
    const remainingArgs = allStrings(args) ? args as string[] : [];
    return {
      command: "uvx",
      args: ["--from", "git+https://github.com/Microck/discord.py-self-mcp.git", "discord-py-self-mcp", ...remainingArgs],
      repair: {
        whenMissing: "uvx",
        command: "__codexport_install_uv",
        args: []
      }
    };
  }

  if (name === "qmd" || commandName === "qmd") {
    const remainingArgs = allStrings(args) ? args as string[] : [];
    return { command: "npx", args: ["-y", "-p", "@tobilu/qmd", "qmd", ...remainingArgs] };
  }

  const npmPackage = npmPackageForPortableMcp(name, commandName);
  if (npmPackage) {
    const remainingArgs = packageLauncherArgs(commandName, args);
    return { command: "npx", args: ["-y", npmPackage, ...remainingArgs] };
  }

  const uvTool = uvToolForPortableMcp(name, commandName);
  if (uvTool) {
    const remainingArgs = allStrings(args) ? args as string[] : [];
    return {
      command: "uvx",
      args: ["--from", uvTool.packageName, uvTool.binaryName, ...remainingArgs],
      repair: {
        whenMissing: "uvx",
        command: "__codexport_install_uv",
        args: []
      }
    };
  }

  if (name === "fff" || commandName === "fff-mcp") {
    const remainingArgs = allStrings(args) ? args as string[] : [];
    return {
      command: "fff-mcp",
      args: remainingArgs,
      repair: {
        whenMissing: "fff-mcp",
        command: "__codexport_install_fff_mcp",
        args: []
      }
    };
  }

  if (name === "gitquarry-mcp" || commandName === "gitquarry-mcp") {
    const remainingArgs = allStrings(args) ? args as string[] : [];
    return {
      command: "gitquarry-mcp",
      args: remainingArgs,
      repair: {
        whenMissing: "gitquarry-mcp",
        command: "cargo",
        args: ["install", "--git", "https://github.com/Microck/gitquarry-mcp.git", "--locked"]
      }
    };
  }

  return undefined;
}

function mcpHasRequiredPortableEnv(name: string, command: string, server: Record<string, unknown>): boolean {
  if (name !== "kagi-mcp" && basenameAnyPlatform(command) !== "kagi-mcp") return true;
  const env = server.env && typeof server.env === "object" && !Array.isArray(server.env) ? server.env as Record<string, unknown> : undefined;
  return (typeof env?.KAGI_API_KEY === "string" && env.KAGI_API_KEY.length > 0)
    || (typeof env?.KAGI_SESSION_TOKEN === "string" && env.KAGI_SESSION_TOKEN.length > 0);
}

function ensurePortablePathEnv(server: Record<string, unknown>): void {
  const env = server.env && typeof server.env === "object" && !Array.isArray(server.env) ? server.env as Record<string, unknown> : {};
  const existingPath = typeof env.PATH === "string" ? env.PATH : undefined;
  const fallbackPath = platform() === "win32"
    ? ["${home}/AppData/Roaming/npm", "C:/Program Files/nodejs", "C:/Windows/System32", "C:/Windows"]
    : ["/usr/local/bin", "/usr/bin", "/bin"];
  const portableBins = ["${home}/.bun/bin", "${home}/.local/bin", "${home}/.cargo/bin", "${home}/go/bin", ...fallbackPath];
  env.PATH = [...portableBins, existingPath].filter(Boolean).join(path.delimiter);
  server.env = env;
}

function npmPackageForPortableMcp(name: string, commandName: string): string | undefined {
  const knownPackages: Record<string, string> = {
    "camofox-browser-mcp": "camofox-browser-mcp",
    "dora": "@butttons/dora",
    "grep-app": "@247arjun/mcp-grep",
    "kagi-mcp": "kagi-mcp",
    "keywords-everywhere": "mcp-keywords-everywhere",
    "mcp-grep": "@247arjun/mcp-grep",
    "mcp-vnc": "@hrrrsn/mcp-vnc",
    "opensrc-mcp": "opensrc-mcp",
    "opensrc-mcp-stdio": "opensrc-mcp",
    "perplexity-webui": "perplexity-webui-mcp",
    "perplexity-webui-mcp": "perplexity-webui-mcp",
    "reddit-mcp-buddy": "reddit-mcp-buddy",
    "xcodebuildmcp": "xcodebuildmcp"
  };
  return knownPackages[name] ?? knownPackages[commandName];
}

function packageLauncherArgs(commandName: string, args: unknown[]): string[] {
  if (!allStrings(args)) return [];
  const remainingArgs = args as string[];
  const [entrypoint, ...afterEntrypoint] = remainingArgs;
  if ((commandName === "node" || commandName === "bun") && typeof entrypoint === "string") {
    const normalized = normalizePathForCompare(entrypoint);
    if (isAbsoluteAnyPlatform(entrypoint) || normalized.endsWith(".js") || normalized.endsWith(".mjs") || normalized.endsWith(".ts")) {
      return afterEntrypoint;
    }
  }
  return remainingArgs;
}

function uvToolForPortableMcp(name: string, commandName: string): { packageName: string; binaryName: string } | undefined {
  const knownTools: Record<string, { packageName: string; binaryName: string }> = {
    "discord-py-self": { packageName: "discord-py-self-mcp", binaryName: "discord-py-self-mcp" },
    "discord-py-self-mcp": { packageName: "discord-py-self-mcp", binaryName: "discord-py-self-mcp" },
    "markitdown-mcp": { packageName: "markitdown-mcp", binaryName: "markitdown-mcp" }
  };
  return knownTools[name] ?? knownTools[commandName];
}

function rewritePortableCommand(command: string, sourceRoot?: string): string {
  const sourceRelative = rewriteSourceRootPath(command, sourceRoot);
  if (sourceRelative !== command) return sourceRelative;
  if (!isAbsoluteAnyPlatform(command)) return command;
  return basenameAnyPlatform(command);
}

function rewritePortablePath(value: string, sourceRoot?: string, sourceHome?: string): string {
  const sourceRootPath = rewriteSourceRootPath(value, sourceRoot);
  if (sourceRootPath !== value) return sourceRootPath;
  return rewriteSourceHomePath(value, sourceHome);
}

function nodePackageFromServer(command: string, args: unknown[]): { packageName: string; remainingArgs: string[] } | undefined {
  if (basenameAnyPlatform(command) !== "node") return undefined;
  const [entrypoint, ...remainingArgs] = args;
  if (typeof entrypoint !== "string" || !isAbsoluteAnyPlatform(entrypoint)) return undefined;
  if (!allStrings(remainingArgs)) return undefined;
  const packageName = packageNameFromNodeModulesPath(entrypoint);
  if (!packageName) return undefined;
  return { packageName, remainingArgs: remainingArgs as string[] };
}

function workspacePackageFromServer(command: string, args: unknown[], sourceHome?: string): { packageName: string; remainingArgs: string[] } | undefined {
  if (basenameAnyPlatform(command) !== "node") return undefined;
  const [entrypoint, ...remainingArgs] = args;
  if (!sourceHome || typeof entrypoint !== "string" || !isAbsoluteAnyPlatform(entrypoint) || !allStrings(remainingArgs)) return undefined;
  const normalizedEntry = normalizePathForCompare(entrypoint);
  const workspacePrefix = `${normalizePathForCompare(sourceHome)}/workspace/`;
  if (!normalizedEntry.startsWith(workspacePrefix)) return undefined;
  const packageName = normalizedEntry.slice(workspacePrefix.length).split("/")[0];
  if (!packageName) return undefined;
  return { packageName, remainingArgs: remainingArgs as string[] };
}

function allStrings(values: unknown[]): boolean {
  return values.every((value) => typeof value === "string");
}

function packageNameFromNodeModulesPath(value: string): string | undefined {
  const parts = normalizePathForCompare(value).split("/");
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (nodeModulesIndex === -1) return undefined;
  const first = parts[nodeModulesIndex + 1];
  if (!first) return undefined;
  if (first.startsWith("@")) {
    const second = parts[nodeModulesIndex + 2];
    return second ? `${first}/${second}` : undefined;
  }
  return first;
}

function inferHomeFromCodexDir(sourceRoot?: string): string | undefined {
  if (!sourceRoot || basenameAnyPlatform(sourceRoot) !== ".codex") return undefined;
  const normalized = normalizePathForCompare(sourceRoot);
  return normalized.slice(0, -"/.codex".length);
}

function rewriteSourceRootPath(value: string, sourceRoot?: string): string {
  if (!sourceRoot || !isAbsoluteAnyPlatform(value)) return value;
  const normalizedSourceRoot = normalizePathForCompare(sourceRoot);
  const normalizedValue = normalizePathForCompare(value);
  if (normalizedValue === normalizedSourceRoot) return "${codexDir}";
  if (!normalizedValue.startsWith(`${normalizedSourceRoot}/`)) return value;
  const relative = normalizedValue.slice(normalizedSourceRoot.length + 1);
  return `\${codexDir}/${relative}`;
}

function rewriteSourceHomePath(value: string, sourceHome?: string): string {
  if (!sourceHome || !isAbsoluteAnyPlatform(value)) return value;
  const normalizedSourceHome = normalizePathForCompare(sourceHome);
  const normalizedValue = normalizePathForCompare(value);
  if (normalizedValue === normalizedSourceHome) return "${home}";
  if (!normalizedValue.startsWith(`${normalizedSourceHome}/`)) return value;
  const relative = normalizedValue.slice(normalizedSourceHome.length + 1);
  return `\${home}/${relative}`;
}

function isAbsoluteAnyPlatform(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function basenameAnyPlatform(value: string): string {
  return value.includes("\\") ? path.win32.basename(value) : path.posix.basename(value);
}

function dirnameAnyPlatform(value: string): string {
  return value.includes("\\") || /^[A-Za-z]:\//.test(value) ? path.win32.dirname(value) : path.posix.dirname(value);
}

function normalizePathForCompare(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/g, "");
}

async function bundleForCurrentRevision(ctx: CliContext, local: LocalConfig, meta: { revision: string }, timeoutMs: number): Promise<Bundle> {
  const cached = await readJsonIfExists<Bundle>(path.join(ctx.stateDir, CACHE_BUNDLE_FILE));
  if (cached?.revision === meta.revision) {
    verifyBundle(cached);
    return cached;
  }
  if (!local.masterUrl) throw new CliError("This machine is not enrolled. Run codexport follower join first.", 1);
  const bundle = await fetchBundle(local.masterUrl, timeoutMs);
  if (bundle.revision !== meta.revision) throw new CliError("Master changed revision during sync. Retry.", 1);
  await writeCachedBundle(ctx, bundle);
  return bundle;
}

function expandPathVariables(text: string, localConfig: LocalConfig): string {
  const configuredCodexDir = localConfig.codexDir ?? path.join(homedir(), ".codex");
  const variables: Record<string, string> = {
    home: basenameAnyPlatform(configuredCodexDir) === ".codex" ? dirnameAnyPlatform(configuredCodexDir) : homedir(),
    codexDir: configuredCodexDir,
    ...(localConfig.pathVariables ?? {})
  };
  return text.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, name: string) => {
    const replacement = variables[name];
    return replacement === undefined ? match : replacement.replace(/\\/g, "\\\\");
  });
}

async function assertSkillConflicts(ctx: CliContext, bundle: Bundle, localConfig: LocalConfig): Promise<void> {
  const canonicalSkills = new Set(
    bundle.files
      .filter((file) => file.path.startsWith("skills/"))
      .map((file) => file.path.split("/")[1])
      .filter(Boolean)
  );
  const localSkillsDir = path.join(ctx.stateDir, "skills");
  if (!(await pathExists(localSkillsDir))) return;
  const localNames = await readdir(localSkillsDir);
  const allowed = new Set(localConfig.allowSkillOverrides ?? []);
  const conflicts = localNames.filter((name) => canonicalSkills.has(name) && !allowed.has(name));
  if (conflicts.length) {
    throw new CliError(`Local skills conflict with canonical names: ${conflicts.join(", ")}. Add allowSkillOverrides in ~/.codexport/local.toml to override intentionally.`, 1, { conflicts });
  }
}

async function applyBundle(ctx: CliContext, bundle: Bundle): Promise<void> {
  verifyBundle(bundle);
  const localConfig = await readLocalConfig(ctx);
  await assertSkillConflicts(ctx, bundle, localConfig);
  await ensureDir(ctx.codexDir);
  const managedMcpRunner = await writeManagedMcpRunner(ctx);

  const nextFiles = new Set(bundle.files.map((file) => file.path));
  const previousFiles = await readJsonIfExists<string[]>(path.join(ctx.stateDir, APPLIED_FILES_FILE)) ?? [];
  for (const previousFile of previousFiles) {
    if (nextFiles.has(previousFile)) continue;
    const target = path.join(ctx.codexDir, previousFile);
    if (path.relative(ctx.codexDir, target).startsWith("..")) continue;
    await rm(target, { recursive: true, force: true });
  }

  for (const file of bundle.files) {
    const target = path.join(ctx.codexDir, file.path);
    await ensureDir(path.dirname(target));
    if (file.path === "config.toml") continue;
    if (file.path === "hooks.json") {
      await writeFileReplacingExisting(target, sanitizeHooksJson(decodeFile(file).toString("utf8")), { mode: file.mode });
      continue;
    }
    await writeFileReplacingExisting(target, decodeFile(file), { mode: file.mode });
  }

  const configEntry = bundle.files.find((file) => file.path === "config.toml");
  if (configEntry) {
    const canonicalConfig = decodeFile(configEntry).toString("utf8");
    const localMcpText = await readTextIfExists(path.join(ctx.stateDir, MCPS_LOCAL_FILE));
    const manifest = buildMcpManifest(canonicalConfig, bundle.sourceRoot, bundle.sourceEnv);
    if (manifest) {
      await writeJsonAtomic(path.join(ctx.stateDir, MCP_MANIFEST_FILE), manifest as unknown as Json);
    }
    const generated = mergeTomlText(
      canonicalConfig,
      localMcpText,
      {
        ...localConfig,
        codexDir: ctx.codexDir,
        pathVariables: {
          ...(localConfig.pathVariables ?? {}),
          node: process.execPath,
          codexportMcpRunner: managedMcpRunner
        }
      },
      bundle.sourceRoot,
      bundle.sourceEnv
    );
    const configPath = path.join(ctx.codexDir, "config.toml");
    if (await pathExists(configPath)) {
      const backupPath = `${configPath}.codexport-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await writeFile(backupPath, await readFile(configPath));
    }
    await writeFileReplacingExisting(configPath, generated, "utf8");
  }

  const localSkillsDir = path.join(ctx.stateDir, "skills");
  if (await pathExists(localSkillsDir)) {
    const targetLocalSkills = path.join(ctx.codexDir, "skills-local");
    await rm(targetLocalSkills, { recursive: true, force: true });
    await copyDirectory(localSkillsDir, targetLocalSkills);
  }

  await writeLocalConfig(ctx, { ...localConfig, lastRevision: bundle.revision, codexDir: ctx.codexDir });
  await installHook(ctx, 3_000);
  await writeJsonAtomic(path.join(ctx.stateDir, APPLIED_FILES_FILE), bundle.files.map((file) => file.path) as unknown as Json);
}

function sanitizeHooksJson(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (Array.isArray(parsed.SessionStart)) {
      parsed.SessionStart = parsed.SessionStart.filter((hook) => !isCodexportHook(hook));
    }
    return `${JSON.stringify(parsed, null, 2)}\n`;
  } catch {
    return text;
  }
}

async function writeManagedMcpRunner(ctx: CliContext): Promise<string> {
  const binDir = path.join(ctx.stateDir, "bin");
  const runnerPath = path.join(binDir, MANAGED_MCP_RUNNER_FILE);
  await ensureDir(binDir);
  await writeFileReplacingExisting(runnerPath, await readFile(fileURLToPath(import.meta.url)), { mode: 0o755 });
  await copyManagedRunnerDependencies(binDir);
  if (platform() !== "win32") await chmod(runnerPath, 0o755);
  return runnerPath;
}

async function copyManagedRunnerDependencies(binDir: string): Promise<void> {
  const packageRoot = await findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  if (!packageRoot) return;
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const copied = new Set<string>();
  for (const packageName of Object.keys(packageJson.dependencies ?? {})) {
    await copyManagedRunnerDependency(packageRoot, binDir, packageName, copied);
  }
}

async function copyManagedRunnerDependency(fromRoot: string, binDir: string, packageName: string, copied: Set<string>): Promise<void> {
  if (copied.has(packageName)) return;
  copied.add(packageName);
  const source = await resolveInstalledDependency(fromRoot, packageName);
  if (!source || !(await pathExists(source))) return;

  const target = path.join(binDir, "node_modules", ...packageName.split("/"));
  await rm(target, { recursive: true, force: true });
  await copyDirectory(source, target);

  const packageJsonPath = path.join(source, "package.json");
  if (!(await pathExists(packageJsonPath))) return;
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  for (const childName of Object.keys({ ...(packageJson.dependencies ?? {}), ...(packageJson.optionalDependencies ?? {}) })) {
    await copyManagedRunnerDependency(source, binDir, childName, copied);
  }
}

async function resolveInstalledDependency(fromRoot: string, packageName: string): Promise<string | undefined> {
  const parts = packageName.split("/");
  let current = fromRoot;
  while (true) {
    const candidates = [
      path.join(current, "node_modules", ...parts),
      basenameAnyPlatform(current) === "node_modules" ? path.join(current, ...parts) : undefined
    ].filter(Boolean) as string[];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function findPackageRoot(startDir: string): Promise<string | undefined> {
  let current = startDir;
  while (true) {
    if (await pathExists(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function commandMcpRun(ctx: CliContext, name: string): Promise<void> {
  const manifest = await readJsonIfExists<McpManifest>(path.join(ctx.stateDir, MCP_MANIFEST_FILE));
  if (!manifest?.servers?.[name]) {
    throw new CliError(`No managed MCP named ${name}. Run codexport sync --apply first.`, 1);
  }
  const localConfig = await readLocalConfig(ctx);
  const sourceHome = inferHomeFromCodexDir(manifest.sourceRoot);
  const server = structuredClone(manifest.servers[name]) as Record<string, unknown>;
  mergeSourceEnvForMcp(name, server, manifest.sourceEnv ?? {});
  rewritePortableTableKeys(server, manifest.sourceRoot, sourceHome);
  rewriteLoopbackUrls(server, localConfig.masterUrl);
  if (typeof server.url === "string") {
    throw new CliError(`MCP ${name} is URL-based and should not be launched through codexport mcp run.`, 2);
  }
  const command = typeof server.command === "string" ? expandPathVariables(server.command, { ...localConfig, codexDir: ctx.codexDir }) : undefined;
  const args = Array.isArray(server.args)
    ? server.args.map((arg) => typeof arg === "string" ? expandPathVariables(rewritePortablePath(arg, manifest.sourceRoot, sourceHome), { ...localConfig, codexDir: ctx.codexDir }) : String(arg))
    : [];
  if (!command) throw new CliError(`MCP ${name} has no command.`, 1);
  ensurePortablePathEnv(server);

  const launcher = mcpHasRequiredPortableEnv(name, command, server)
    ? portableMcpLauncher(name, command, args, sourceHome, server)
    : undefined;
  const runCommandName = launcher?.command ?? rewritePortableCommand(command, manifest.sourceRoot);
  const runArgs = launcher?.args ?? args;
  const childEnv = { ...process.env, ...portableServerEnv(server, manifest.sourceRoot, sourceHome, { ...localConfig, codexDir: ctx.codexDir }) };
  await repairMcpLauncherIfNeeded(launcher, childEnv);
  await repairGitquarryEnvIfNeeded(name, childEnv);
  await runCommandWithEnv(runCommandName, runArgs, childEnv);
}

function portableServerEnv(server: Record<string, unknown>, sourceRoot: string | undefined, sourceHome: string | undefined, localConfig: LocalConfig): NodeJS.ProcessEnv {
  const env = server.env && typeof server.env === "object" && !Array.isArray(server.env) ? server.env as Record<string, unknown> : {};
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      out[key] = expandPathVariables(rewritePortablePath(value, sourceRoot, sourceHome), localConfig);
    }
  }
  return out;
}

async function repairMcpLauncherIfNeeded(launcher: McpLaunchSpec | undefined, env: NodeJS.ProcessEnv): Promise<void> {
  if (!launcher?.repair) return;
  if (await executableExists(launcher.repair.whenMissing, env)) return;
  if (launcher.repair.command === "__codexport_install_fff_mcp") {
    await installFffMcp(env);
  } else if (launcher.repair.command === "__codexport_install_uv") {
    await installUv(env);
  } else {
    await runRepairCommandWithEnv(launcher.repair.command, launcher.repair.args, env);
  }
  if (!(await executableExists(launcher.repair.whenMissing, env))) {
    throw new CliError(`MCP repair completed but ${launcher.repair.whenMissing} is still not on PATH.`, 1);
  }
}

async function installUv(env: NodeJS.ProcessEnv): Promise<void> {
  if (platform() === "win32") {
    await runRepairCommandWithEnv("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "irm https://astral.sh/uv/install.ps1 | iex"
    ], env);
  } else {
    await runRepairCommandWithEnv("sh", ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"], env);
  }
  const installHome = env.HOME ?? env.USERPROFILE ?? homedir();
  const uvBinDir = platform() === "win32"
    ? path.join(installHome, ".local", "bin")
    : path.join(installHome, ".local", "bin");
  const pathValue = env.PATH ?? "";
  if (!pathValue.split(path.delimiter).includes(uvBinDir)) {
    env.PATH = [uvBinDir, pathValue].filter(Boolean).join(path.delimiter);
  }
}

async function installFffMcp(env: NodeJS.ProcessEnv): Promise<void> {
  const target = fffReleaseTarget();
  const releasesResponse = await fetch("https://api.github.com/repos/dmtrKovalenko/fff.nvim/releases");
  if (!releasesResponse.ok) {
    throw new CliError(`Failed to fetch FFF MCP releases: HTTP ${releasesResponse.status}.`, 1);
  }
  const releases = await releasesResponse.json() as Array<{ tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string }> }>;
  const assetName = `fff-mcp-${target}${platform() === "win32" ? ".exe" : ""}`;
  const release = releases.find((item) => item.assets?.some((asset) => asset.name === assetName));
  const asset = release?.assets?.find((item) => item.name === assetName);
  if (!asset?.browser_download_url) {
    throw new CliError(`No FFF MCP release asset found for ${target}.`, 1);
  }

  const binaryResponse = await fetch(asset.browser_download_url);
  if (!binaryResponse.ok) {
    throw new CliError(`Failed to download ${assetName}: HTTP ${binaryResponse.status}.`, 1);
  }
  const installHome = env.HOME ?? env.USERPROFILE ?? homedir();
  const installDir = path.join(installHome, ".local", "bin");
  const binaryPath = path.join(installDir, platform() === "win32" ? "fff-mcp.exe" : "fff-mcp");
  await ensureDir(installDir);
  await writeFileReplacingExisting(binaryPath, Buffer.from(await binaryResponse.arrayBuffer()), { mode: 0o755 });
  if (platform() !== "win32") await chmod(binaryPath, 0o755);

  const pathValue = env.PATH ?? "";
  if (!pathValue.split(path.delimiter).includes(installDir)) {
    env.PATH = [installDir, pathValue].filter(Boolean).join(path.delimiter);
  }
}

function fffReleaseTarget(): string {
  const os = platform();
  const arch = process.arch;
  if (os === "linux") {
    if (arch === "x64") return "x86_64-unknown-linux-musl";
    if (arch === "arm64") return "aarch64-unknown-linux-musl";
  }
  if (os === "darwin") {
    if (arch === "x64") return "x86_64-apple-darwin";
    if (arch === "arm64") return "aarch64-apple-darwin";
  }
  if (os === "win32") {
    if (arch === "x64") return "x86_64-pc-windows-msvc";
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
  }
  throw new CliError(`Unsupported FFF MCP platform: ${os}/${arch}.`, 1);
}

async function repairGitquarryEnvIfNeeded(name: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (name !== "gitquarry-mcp") return;
  const current = env.GITQUARRY_CLI_PATH;
  if (current && await executableExists(current, env)) return;
  const existing = await resolveExecutable("gitquarry", env);
  if (existing) {
    env.GITQUARRY_CLI_PATH = existing;
    return;
  }

  const installHome = env.HOME ?? env.USERPROFILE ?? homedir();
  const installDir = path.join(installHome, ".codexport", "tools", "gitquarry");
  const binaryPath = platform() === "win32"
    ? path.join(installDir, "node_modules", ".bin", "gitquarry.cmd")
    : path.join(installDir, "node_modules", ".bin", "gitquarry");
  if (await pathExists(binaryPath)) {
    env.GITQUARRY_CLI_PATH = binaryPath;
    return;
  }
  await ensureDir(installDir);
  await runRepairCommandWithEnv("npm", ["install", "--prefix", installDir, "gitquarry"], env);
  if (!(await pathExists(binaryPath))) {
    throw new CliError("MCP repair installed gitquarry but could not find its npm shim.", 1);
  }
  env.GITQUARRY_CLI_PATH = binaryPath;
}

async function executableExists(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return Boolean(await resolveExecutable(command, env));
}

async function resolveExecutable(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (isAbsoluteAnyPlatform(command) || command.includes(path.sep) || command.includes("/") || command.includes("\\")) {
    return await pathExists(command) ? command : undefined;
  }

  const pathValue = env.PATH ?? process.env.PATH ?? "";
  const extensions = platform() === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension}`);
      if (await pathExists(candidate)) return candidate;
    }
  }
  return undefined;
}

async function copyDirectory(source: string, target: string): Promise<void> {
  await ensureDir(target);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await ensureDir(path.dirname(targetPath));
      await writeFileReplacingExisting(targetPath, await readFile(sourcePath));
    } else if (entry.isSymbolicLink()) {
      const linkTarget = await readlink(sourcePath);
      await symlink(linkTarget, targetPath);
    }
  }
}

async function installHook(ctx: CliContext, timeoutMs: number): Promise<void> {
  await ensureDir(ctx.codexDir);
  const managedRunner = await writeManagedMcpRunner(ctx);
  const hooksPath = path.join(ctx.codexDir, "hooks.json");
  const existingText = await readTextIfExists(hooksPath);
  const existing = existingText ? JSON.parse(existingText) as Record<string, unknown> : {};
  const hooks = existing.SessionStart && Array.isArray(existing.SessionStart) ? existing.SessionStart as unknown[] : [];
  const command = `${shellQuote(process.execPath)} ${shellQuote(managedRunner)} hook sync --timeout-ms ${timeoutMs} --no-input`;
  const filtered = hooks.filter((hook) => !isCodexportHook(hook));
  filtered.push({ name: "codexport-sync", command, timeoutMs });
  await writeJsonAtomic(hooksPath, { ...existing, SessionStart: filtered } as unknown as Json);
}

function shellQuote(value: string): string {
  if (platform() === "win32") return `"${value.replace(/"/g, '\\"')}"`;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function isCodexportHook(hook: unknown): boolean {
  if (!hook || typeof hook !== "object") return false;
  const record = hook as { name?: unknown; command?: unknown };
  if (record.name === "codexport-sync") return true;
  return typeof record.command === "string" && /\bcodexport\b/.test(record.command);
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new CliError(`${command} ${args.join(" ")} exited with ${code}`, code ?? 1));
    });
  });
}

function runCommandWithEnv(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.on("error", (error) => {
      const message = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? `MCP launcher program not found: ${command}. Install it on this follower or add it to PATH.`
        : asError(error).message;
      reject(new CliError(message, 1));
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new CliError(`${command} ${args.join(" ")} exited with ${code}`, code ?? 1));
    });
  });
}

function runRepairCommandWithEnv(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
    child.stdout.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("error", (error) => {
      const message = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? `MCP repair program not found: ${command}. Install it on this follower or add it to PATH.`
        : asError(error).message;
      reject(new CliError(message, 1));
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new CliError(`${command} ${args.join(" ")} exited with ${code}`, code ?? 1));
    });
  });
}

async function installMasterService(ctx: CliContext, port: number, dryRun: boolean): Promise<string> {
  const command = `${process.execPath} ${realpathSync(fileURLToPath(import.meta.url))} master serve --port ${port}`;
  if (platform() === "linux") {
    const unitDir = path.join(ctx.homeDir, ".config", "systemd", "user");
    const unitPath = path.join(unitDir, "codexport-master.service");
    const unit = `[Unit]
Description=Codexport master server

[Service]
ExecStart=${command}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
    if (!dryRun) {
      await ensureDir(unitDir);
      await writeFile(unitPath, unit, "utf8");
      await runCommand("systemctl", ["--user", "daemon-reload"]);
      await runCommand("systemctl", ["--user", "enable", "--now", "codexport-master.service"]);
    }
    return unitPath;
  }
  if (platform() === "win32") {
    const taskName = "CodexportMaster";
    if (!dryRun) {
      await runCommand("schtasks.exe", ["/Create", "/TN", taskName, "/SC", "ONLOGON", "/TR", command, "/F"]);
      await runCommand("schtasks.exe", ["/Run", "/TN", taskName]);
    }
    return taskName;
  }
  throw new CliError(`Unsupported service platform: ${platform()}`, 1);
}

function print(ctx: CliContext, value: Json | string): void {
  if (ctx.quiet) return;
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify(typeof value === "string" ? { message: value } : value, null, 2)}\n`);
  } else {
    process.stdout.write(`${typeof value === "string" ? value : humanSummary(value)}\n`);
  }
}

function humanSummary(value: Json): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return String(value);
  return Object.entries(value).map(([key, item]) => `${key}: ${String(item)}`).join("\n");
}

function masterUrl(host: string, port: number): string {
  if (host.startsWith("http://") || host.startsWith("https://")) return host;
  return `http://${host}:${port}`;
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got ${value}`);
  }
  return parsed;
}

async function commandMasterInit(ctx: CliContext, options: { port?: number }): Promise<void> {
  const identity = await loadMasterIdentity(ctx);
  const bundle = await buildBundle(ctx.codexDir);
  await saveMasterBundle(ctx, bundle);
  await writeLocalConfig(ctx, { ...(await readLocalConfig(ctx)), role: "master", codexDir: ctx.codexDir, port: options.port ?? DEFAULT_PORT });
  print(ctx, { role: "master", fingerprint: identity.fingerprint, revision: bundle.revision, files: bundle.files.length });
}

async function commandMasterRebuild(ctx: CliContext): Promise<void> {
  const bundle = await buildBundle(ctx.codexDir);
  await saveMasterBundle(ctx, bundle);
  print(ctx, { revision: bundle.revision, files: bundle.files.length });
}

async function commandMasterLink(ctx: CliContext, options: { host?: string; port?: number }): Promise<void> {
  const identity = await loadMasterIdentity(ctx);
  const local = await readLocalConfig(ctx);
  const port = options.port ?? local.port ?? DEFAULT_PORT;
  const host = options.host ?? "master.tailnet.ts.net";
  const url = masterUrl(host, port);
  print(ctx, {
    joinLink: buildJoinLink(url, identity.fingerprint),
    command: formatJoinCommand(url, identity.fingerprint)
  });
}

async function commandMasterServe(ctx: CliContext, options: { host: string; port: number; watch: boolean }): Promise<void> {
  const identity = await loadMasterIdentity(ctx);
  let bundle = await readMasterBundle(ctx);
  let rebuilding = false;

  async function rebuild(reason: string): Promise<void> {
    if (rebuilding) return;
    rebuilding = true;
    try {
      bundle = await buildBundle(ctx.codexDir);
      await saveMasterBundle(ctx, bundle);
      if (!ctx.quiet) process.stderr.write(`rebuilt ${bundle.revision} after ${reason}\n`);
    } finally {
      rebuilding = false;
    }
  }

  if (options.watch) {
    const watchPaths = INCLUDE_ROOTS.map((item) => path.join(ctx.codexDir, item)).filter(existsSync);
    const watcher = chokidar.watch(watchPaths, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 } });
    watcher.on("all", (_event, changedPath) => {
      void rebuild(path.relative(ctx.codexDir, changedPath));
    });
  }

  const server = createServer((req, res) => {
    if (!req.url || req.method !== "GET") {
      res.writeHead(405).end("method not allowed");
      return;
    }
    if (req.url === "/meta") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ version: 1, fingerprint: identity.fingerprint, revision: bundle.revision, fileCount: bundle.files.length }));
      return;
    }
    if (req.url === "/bundle") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(bundle));
      return;
    }
    res.writeHead(404).end("not found");
  });

  server.listen(options.port, options.host, () => {
    if (!ctx.quiet) process.stderr.write(`codexport master serving ${bundle.revision} on http://${options.host}:${options.port}\n`);
  });
}

async function commandFollowerJoin(ctx: CliContext, input: string | undefined, options: { master?: string; fingerprint?: string; apply?: boolean; timeoutMs: number }): Promise<void> {
  const parsed = input ? parseJoinLink(input) : undefined;
  const master = options.master ?? parsed?.masterUrl;
  const fingerprint = options.fingerprint ?? parsed?.fingerprint;
  if (!master || !fingerprint) {
    throw new CliError("follower join requires a join link or both --master and --fingerprint.", 2);
  }
  const meta = await fetchMeta(master, options.timeoutMs);
  if (meta.fingerprint !== fingerprint) {
    throw new CliError(`Master fingerprint mismatch. Expected ${fingerprint}, got ${meta.fingerprint}.`, 1);
  }
  const current = await readLocalConfig(ctx);
  await writeLocalConfig(ctx, { ...current, role: "follower", masterUrl: master, masterFingerprint: fingerprint, codexDir: ctx.codexDir });
  if (options.apply) {
    await commandSync(ctx, { apply: true, timeoutMs: options.timeoutMs });
  }
  print(ctx, { role: "follower", masterUrl: master, masterFingerprint: fingerprint, revision: meta.revision });
}

async function commandSync(ctx: CliContext, options: { apply: boolean; timeoutMs: number }): Promise<void> {
  const local = await readLocalConfig(ctx);
  if (!local.masterUrl || !local.masterFingerprint) {
    throw new CliError("This machine is not enrolled. Run codexport follower join first.", 1);
  }
  const meta = await fetchMeta(local.masterUrl, options.timeoutMs);
  if (meta.fingerprint !== local.masterFingerprint) {
    throw new CliError("Stored master fingerprint does not match the reachable master. Refusing to sync; re-enroll or reset trust explicitly.", 1);
  }
  if (local.lastRevision === meta.revision) {
    if (options.apply) {
      const bundle = await bundleForCurrentRevision(ctx, local, meta, options.timeoutMs);
      await applyBundle(ctx, bundle);
      print(ctx, { status: "applied", revision: bundle.revision, files: bundle.files.length });
      return;
    }
    print(ctx, { status: "current", revision: meta.revision });
    return;
  }
  const bundle = await bundleForCurrentRevision(ctx, local, meta, options.timeoutMs);
  await writeCachedBundle(ctx, bundle);
  if (options.apply) {
    await applyBundle(ctx, bundle);
    print(ctx, { status: "applied", revision: bundle.revision, files: bundle.files.length });
  } else {
    print(ctx, { status: "staged", revision: bundle.revision, files: bundle.files.length });
  }
}

async function commandHookSync(ctx: CliContext, options: { timeoutMs: number }): Promise<void> {
  try {
    await commandSync(ctx, { apply: true, timeoutMs: options.timeoutMs });
  } catch (error) {
    if (!ctx.quiet) {
      process.stderr.write(`codexport hook sync skipped: ${asError(error).message}\n`);
    }
  }
}

async function commandApply(ctx: CliContext): Promise<void> {
  const bundle = await readCachedBundle(ctx);
  await applyBundle(ctx, bundle);
  print(ctx, { status: "applied", revision: bundle.revision, files: bundle.files.length });
}

async function commandStatus(ctx: CliContext, options: { timeoutMs: number }): Promise<void> {
  const local = await readLocalConfig(ctx);
  let remote: Json = null;
  if (local.masterUrl) {
    try {
      remote = await fetchMeta(local.masterUrl, options.timeoutMs) as unknown as Json;
    } catch (error) {
      remote = { reachable: false, error: asError(error).message };
    }
  }
  print(ctx, {
    role: local.role ?? "unknown",
    codexDir: ctx.codexDir,
    stateDir: ctx.stateDir,
    masterUrl: local.masterUrl ?? null,
    masterFingerprint: local.masterFingerprint ?? null,
    lastRevision: local.lastRevision ?? null,
    remote
  });
}

function addGlobalOptions(command: Command): Command {
  return command
    .option("--home <path>", "home directory override for testing")
    .option("--codex-dir <path>", "Codex directory to read or write")
    .option("--json", "write structured JSON output")
    .option("-q, --quiet", "suppress normal success output")
    .option("--no-input", "never prompt for input")
    .addOption(new Option("--no-color", "accepted for CLI convention compatibility"));
}

function contextFromCommand(command: Command): CliContext {
  const options = command.optsWithGlobals<{ home?: string; codexDir?: string; quiet?: boolean; json?: boolean; input?: boolean }>();
  return defaultContext({ home: options.home, codexDir: options.codexDir, quiet: options.quiet, json: options.json, noInput: options.input === false });
}

async function main(argv: string[]): Promise<void> {
  const program = addGlobalOptions(new Command())
    .name("codexport")
    .description("Replicate a canonical Codex setup from a master machine to follower machines.")
    .version(VERSION);

  const master = program.command("master").description("Manage the canonical master export.");
  master.command("init")
    .description("Create or refresh master identity and canonical bundle state.")
    .option("--port <port>", "default serve port", parsePositiveInt, DEFAULT_PORT)
    .action(async (options, command) => commandMasterInit(contextFromCommand(command), options));
  master.command("rebuild")
    .description("Force rebuild the master bundle from the current Codex directory.")
    .action(async (_options, command) => commandMasterRebuild(contextFromCommand(command)));
  master.command("link")
    .description("Print a durable follower join link and copy-paste command.")
    .option("--host <host>", "Tailscale host, IP, or full URL", "master.tailnet.ts.net")
    .option("--port <port>", "master port", parsePositiveInt, DEFAULT_PORT)
    .action(async (options, command) => commandMasterLink(contextFromCommand(command), options));
  master.command("serve")
    .description("Serve the current canonical bundle over HTTP.")
    .option("--host <host>", "bind host", "0.0.0.0")
    .option("--port <port>", "bind port", parsePositiveInt, DEFAULT_PORT)
    .option("--no-watch", "disable automatic bundle rebuilds")
    .action(async (options, command) => commandMasterServe(contextFromCommand(command), options));
  const service = master.command("service").description("Manage the user-level master background service.");
  service.command("install")
    .description("Install and start the user-level master background service.")
    .option("--port <port>", "master port", parsePositiveInt, DEFAULT_PORT)
    .option("-n, --dry-run", "print the install target without changing system service state")
    .action(async (options, command) => {
      const ctx = contextFromCommand(command);
      const target = await installMasterService(ctx, options.port, Boolean(options.dryRun));
      print(ctx, { installed: !options.dryRun, target });
    });

  const follower = program.command("follower").description("Enroll and manage a follower machine.");
  follower.command("join [link]")
    .description("Enroll this follower from a codexport://join link or explicit master URL.")
    .option("--master <url>", "master URL, for example http://master.tailnet.ts.net:17342")
    .option("--fingerprint <hex>", "expected master fingerprint")
    .option("--apply", "download and apply immediately after enrollment")
    .option("--timeout-ms <ms>", "network timeout", parsePositiveInt, DEFAULT_TIMEOUT_MS)
    .action(async (link, options, command) => commandFollowerJoin(contextFromCommand(command), link, options));

  program.command("sync")
    .description("Fetch the latest master bundle and optionally apply it.")
    .option("--apply", "apply the fetched bundle immediately")
    .option("--timeout-ms <ms>", "network timeout", parsePositiveInt, DEFAULT_TIMEOUT_MS)
    .action(async (options, command) => commandSync(contextFromCommand(command), options));
  program.command("apply")
    .description("Apply the last staged bundle.")
    .action(async (_options, command) => commandApply(contextFromCommand(command)));
  const mcp = program.command("mcp").description("Run managed follower MCP launchers.");
  mcp.command("run <name>")
    .description("Run a synced MCP through codexport's managed launcher.")
    .action(async (name, _options, command) => commandMcpRun(contextFromCommand(command), name));
  const hook = program.command("hook").description("Manage follower Codex hooks.");
  hook.command("install")
    .description("Install a follower-only Codex SessionStart sync hook.")
    .option("--timeout-ms <ms>", "hook sync timeout", parsePositiveInt, 3_000)
    .action(async (options, command) => {
      const ctx = contextFromCommand(command);
      await installHook(ctx, options.timeoutMs);
      print(ctx, { installed: true, hook: "SessionStart", command: `codexport hook sync --timeout-ms ${options.timeoutMs} --no-input` });
    });
  hook.command("sync")
    .description("Best-effort follower sync for Codex SessionStart hooks.")
    .option("--timeout-ms <ms>", "hook sync timeout", parsePositiveInt, 3_000)
    .action(async (options, command) => commandHookSync(contextFromCommand(command), options));
  program.command("status")
    .description("Show local enrollment state and remote revision reachability.")
    .option("--timeout-ms <ms>", "network timeout", parsePositiveInt, 1_500)
    .action(async (options, command) => commandStatus(contextFromCommand(command), options));

  await program.parseAsync(argv);
}

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
}

if (isCliEntrypoint()) {
  main(process.argv).catch((error) => {
    const err = asError(error);
    const exitCode = error instanceof CliError ? error.exitCode : 1;
    process.stderr.write(`${err.message}\n`);
    if (!(error instanceof CliError) && process.env.DEBUG) {
      process.stderr.write(`${err.stack ?? ""}\n`);
    }
    process.exit(exitCode);
  });
}

export {
  applyBundle,
  buildBundle,
  buildJoinLink,
  computeRevision,
  defaultContext,
  installHook,
  mergeTomlText,
  parseJoinLink,
  portableMcpLauncher,
  verifyBundle
};
