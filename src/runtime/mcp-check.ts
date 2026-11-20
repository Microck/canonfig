import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { open } from "node:fs/promises";

import { Effect, Option, Predicate, Schema } from "effect";

import { redactText } from "../cli/redaction.ts";
import { isSecretField } from "../secrets/credential-policy.ts";
import { terminateProcessTree } from "../machine/linux.layer.ts";
import { adapterFor } from "../projection/adapters/index.ts";
import { detectHarnesses, emptyModel } from "../projection/detect.ts";
import { MAX_CONFIG_BYTES } from "../projection/import.ts";
import { prepareMcpRun } from "./mcp-run.ts";
import type { RootContext } from "../projection/harness.ts";
import type { TargetId } from "../projection/model.ts";
import { getConfigPath, parseConfigDocument } from "../synchronization/config-codec.ts";
import { type ConfigJson, type ConfigObject, isConfigObject } from "../synchronization/config-value.ts";

/**
 * Proves that the MCP servers each installed harness is configured to start
 * actually start and speak MCP on this machine.
 *
 * It reads the harness's own config file, not the Canonical Folder, because
 * preserved harnesses and hand-written entries hold servers Canonfig never
 * wrote, and a stale entry is exactly what this has to catch. Every server is
 * launched at the same time, as a harness does at session start, so limits
 * that only bite under that load (task caps, lock contention) show up here too.
 */

/** Codex's default `startup_timeout_sec`; a slower server fails in Codex anyway. */
export const MCP_STARTUP_TIMEOUT_MILLISECONDS = 10_000;

/**
 * The variables Codex passes to a stdio server besides its `env` and
 * `env_vars` (codex-rs/rmcp-client/src/utils.rs DEFAULT_ENV_VARS). Other
 * harnesses pass their whole environment. Windows uses a longer core list in
 * Codex, so there the whole environment is passed as an approximation.
 */
const CODEX_INHERITED_ENV = [
  "HOME", "LOGNAME", "PATH", "SHELL", "USER", "__CF_USER_TEXT_ENCODING", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ",
] as const;

const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

type Launch =
  | {
    readonly kind: "stdio";
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: Readonly<Record<string, string>>;
    readonly cwd: string | undefined;
    /** Values the entry itself declares, redacted from any stderr the check reports. */
    readonly secrets: ReadonlyArray<string>;
    readonly timeoutMilliseconds: number | undefined;
  }
  | {
    readonly kind: "http";
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly sse: boolean;
    /** Header values, redacted from any server message the check reports. */
    readonly secrets: ReadonlyArray<string>;
    readonly timeoutMilliseconds: number | undefined;
  };

/** One server entry as one harness's config file declares it. */
export interface McpEntry {
  readonly harness: TargetId;
  readonly path: string;
  readonly name: string;
  readonly launch: Launch | { readonly kind: "disabled" } | { readonly kind: "invalid"; readonly reason: string };
}

export type McpCheckStatus = "pass" | "fail" | "skipped";

export interface McpCheckResult {
  readonly name: string;
  /** Every harness whose entry launched exactly this process. */
  readonly harnesses: ReadonlyArray<TargetId>;
  readonly status: McpCheckStatus;
  readonly detail: string;
  readonly tools?: number | undefined;
  readonly milliseconds?: number | undefined;
}

// Reading --------------------------------------------------------------------

const stringList = (value: ConfigJson | undefined): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every(Predicate.isString) ? value : undefined;

const stringTable = (...sources: ReadonlyArray<ConfigJson | undefined>) =>
  Object.fromEntries(sources.flatMap((source) => isConfigObject(source)
    ? Object.entries(source).filter((pair): pair is [string, string] => Predicate.isString(pair[1]))
    : []));

/**
 * The environment references harnesses expand in commands, arguments, env,
 * URLs and headers, including the ones Canonfig projects (shared-mcp.ts):
 * `${VAR}` and `${VAR:-default}` (Claude Code and relatives), `${env:VAR}`
 * (Cursor) and `{env:VAR}` (OpenCode and Kilo). Codex configs use none.
 */
const expand = (text: string, environment: NodeJS.ProcessEnv): string =>
  text
    .replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu, (_, name: string, fallback?: string) =>
      environment[name] ?? fallback ?? "")
    .replace(/(?<!\$)\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_, name: string) => environment[name] ?? "");

/** The longest startup budget the check honors, so one entry cannot hold doctor for minutes. */
export const MCP_MAXIMUM_STARTUP_MILLISECONDS = 120_000;

/**
 * The entry's own startup budget in milliseconds, in each harness's spelling
 * (the adapters in src/projection/adapters write the same fields): Codex
 * `startup_timeout_ms`/`startup_timeout_sec`, Kimi `startupTimeoutMs`,
 * Antigravity `timeoutSeconds`, OpenCode, Kilo and Qwen `timeout` in
 * milliseconds, and Pi `timeout` in seconds.
 */
const startupTimeout = (harness: TargetId, entry: ConfigObject): number | undefined => {
  const budget = Predicate.isNumber(entry.startup_timeout_ms) ? entry.startup_timeout_ms
    : Predicate.isNumber(entry.startup_timeout_sec) ? entry.startup_timeout_sec * 1000
    : Predicate.isNumber(entry.startupTimeoutMs) ? entry.startupTimeoutMs
    : Predicate.isNumber(entry.timeoutSeconds) ? entry.timeoutSeconds * 1000
    : !Predicate.isNumber(entry.timeout) ? undefined
    : harness === "pi" ? entry.timeout * 1000
    : harness === "opencode" || harness === "kilo" || harness === "qwen" ? entry.timeout
    : undefined;
  // A zero, negative or non-finite budget is a config mistake; the default applies instead.
  return budget === undefined || !Number.isFinite(budget) || budget <= 0 ? undefined : Math.min(budget, MCP_MAXIMUM_STARTUP_MILLISECONDS);
};

/** The values of every variable a harness substitutes into these texts, in any supported reference syntax. */
const referencedValues = (texts: ReadonlyArray<string>, environment: NodeJS.ProcessEnv): ReadonlyArray<string> =>
  texts.flatMap((text) => [...text.matchAll(/\$?\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/gu)]
    .flatMap((match) => environment[match[1]!] ?? []));

/** Values worth redacting from what a server says back: long enough not to match ordinary text. */
/**
 * Values to redact from what a server says back. A value named like a
 * credential (`API_KEY`, `Authorization`) is kept at any length; any other
 * value only when it is long enough not to match ordinary text, since
 * redacting `1` or `true` would garble every message.
 */
const secretValues = (named: ReadonlyArray<readonly [string, string]>, unnamed: ReadonlyArray<string> = []): ReadonlyArray<string> => {
  const values: Array<string> = [];
  const add = (value: string, minimumLength: number) => {
    for (const text of [value, value.replace(/^Bearer\s+/iu, "")]) if (text.length >= minimumLength) values.push(text);
  };
  for (const [name, value] of named) add(value, isSecretField(name) || /^authorization$/iu.test(name) ? 1 : 8);
  for (const value of unnamed) add(value, 8);
  return values;
};

/**
 * The process or request a harness makes for one native entry. The native
 * spellings are the ones the import reader accepts (`ServerDecoder` in
 * src/projection/import.ts), but values stay literal here because the check
 * has to start exactly what the harness starts.
 */
const launchOf = (
  harness: TargetId,
  entry: ConfigObject,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): McpEntry["launch"] => {
  if (entry.enabled === false || entry.disabled === true) return { kind: "disabled" };
  // Codex launches what its config says literally; the other harnesses expand references.
  const resolve = (text: string) => harness === "codex" ? text : expand(text, environment);
  const resolveTable = (table: Record<string, string>) =>
    Object.fromEntries(Object.entries(table).map(([key, value]) => [key, resolve(value)]));
  const url = [entry.url, entry.httpUrl, entry.serverUrl].find(Predicate.isString);
  if (entry.command !== undefined) {
    // OpenCode and Kilo `local` servers spell the command and its arguments as one array.
    const parts = Predicate.isString(entry.command) ? [entry.command] : stringList(entry.command);
    const args = entry.args === undefined ? [] : stringList(entry.args);
    if (parts?.[0] === undefined || parts[0].trim() === "" || args === undefined) {
      return { kind: "invalid", reason: "its command or arguments are not text" };
    }
    const declared = resolveTable(stringTable(entry.env, entry.environment));
    const forwarded = (stringList(entry.env_vars) ?? []).filter((name) => environment[name] !== undefined);
    const inherited = harness === "codex" && process.platform !== "win32"
      ? Object.fromEntries([...CODEX_INHERITED_ENV, ...forwarded].flatMap((name) => {
        const value = environment[name];
        return value === undefined ? [] : [[name, value] as const];
      }))
      : Object.fromEntries(Object.entries(environment).filter((pair): pair is [string, string] => pair[1] !== undefined));
    return {
      kind: "stdio",
      command: resolve(parts[0]),
      args: [...parts.slice(1), ...args].map(resolve),
      env: { ...inherited, ...declared },
      // Harnesses start servers in the session's folder unless one is configured.
      cwd: Predicate.isString(entry.cwd) && entry.cwd.trim() !== "" ? entry.cwd : cwd,
      // Forwarded variables and values substituted into the command or arguments reach the server too.
      secrets: secretValues(
        [...Object.entries(declared), ...forwarded.flatMap((name) => environment[name] === undefined ? [] : [[name, environment[name]] as const])],
        harness === "codex" ? [] : referencedValues([...parts, ...args], environment),
      ),
      timeoutMilliseconds: startupTimeout(harness, entry),
    };
  }
  if (url !== undefined) {
    const headers = resolveTable(stringTable(entry.headers, entry.http_headers));
    // Codex maps a header to the variable that holds its value.
    for (const [header, variable] of Object.entries(stringTable(entry.env_http_headers))) {
      const value = environment[variable];
      if (value !== undefined) headers[header] = value;
    }
    // Codex `bearer_token_env_var` and Kimi `bearerTokenEnvVar` name the variable holding the token.
    const bearer = [entry.bearer_token_env_var, entry.bearerTokenEnvVar].find(Predicate.isString);
    const token = bearer === undefined ? undefined : environment[bearer];
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    return {
      kind: "http",
      url: resolve(url),
      headers,
      // Qwen spells legacy SSE as a bare `url` and Streamable HTTP as `httpUrl`, with no type field.
      sse: entry.type === "sse" || entry.transport === "sse"
        || (harness === "qwen" && Predicate.isString(entry.url) && entry.httpUrl === undefined),
      secrets: secretValues(Object.entries(headers), harness === "codex" ? [] : referencedValues([url], environment)),
      timeoutMilliseconds: startupTimeout(harness, entry),
    };
  }
  return { kind: "invalid", reason: "it has neither a command nor a URL" };
};

/** Every MCP entry in the config files of the given harnesses. Unreadable files are reported as invalid entries. */
export const readHarnessMcpEntries = async (input: {
  readonly context: RootContext;
  readonly folder: string;
  readonly harnesses: ReadonlyArray<TargetId>;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}): Promise<ReadonlyArray<McpEntry>> => {
  const entries: Array<McpEntry> = [];
  for (const harness of input.harnesses) {
    const layout = adapterFor(harness).layout(input.context, emptyModel(input.folder));
    for (const surface of layout.surfaces) {
      if (surface.kind !== "config") continue;
      const keys = surface.keys.filter((key) => /mcp/iu.test(key));
      if (keys.length === 0) continue;
      for (const path of [surface.target, ...surface.alternatives ?? []]) {
        let text: string;
        try {
          // Check the size before reading, so a huge generated file is refused instead of loaded.
          const handle = await open(path, "r");
          try {
            if ((await handle.stat()).size > MAX_CONFIG_BYTES) throw new Error("too large");
            text = await handle.readFile("utf8");
          } finally { await handle.close(); }
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
          entries.push({ harness, path, name: "*", launch: { kind: "invalid", reason: `${path} could not be read` } });
          break;
        }
        let document;
        try {
          document = parseConfigDocument(surface.format, text);
        } catch {
          // The parser's message can quote the file, so it is not repeated.
          entries.push({ harness, path, name: "*", launch: { kind: "invalid", reason: `${path} is not valid ${surface.format}` } });
          break;
        }
        for (const key of keys) {
          const table = getConfigPath(document, key);
          if (!isConfigObject(table)) continue;
          for (const [name, entry] of Object.entries(table)) {
            entries.push({
              harness,
              path,
              name,
              launch: isConfigObject(entry)
                ? launchOf(harness, entry, input.environment, input.cwd)
                : { kind: "invalid", reason: "it is not a table" },
            });
          }
        }
        // The harness reads the first file that exists; alternatives are not merged.
        break;
      }
    }
  }
  return entries;
};

// Probing --------------------------------------------------------------------

interface RpcMessage {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly id?: number;
  readonly params?: Readonly<Record<string, ConfigJson>>;
}
const initializeRequest: RpcMessage = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "canonfig-doctor", version: "1" } },
};
const initializedNotification: RpcMessage = { jsonrpc: "2.0", method: "notifications/initialized" };
const toolsRequest: RpcMessage = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

/** The parts of a JSON-RPC reply the check reads; other fields are ignored. */
const RpcReply = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String, Schema.Null])),
  // Present on requests and notifications the server sends; a reply to the check has none.
  method: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Struct({
    tools: Schema.optionalKey(Schema.Array(Schema.Json)),
    protocolVersion: Schema.optionalKey(Schema.String),
    capabilities: Schema.optionalKey(Schema.Struct({ tools: Schema.optionalKey(Schema.Json) })),
  })),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) })),
});
type RpcReply = typeof RpcReply.Type;

/**
 * The answer to a server's `ping` request, which a server may send during the
 * handshake and wait on; any other server request or notification is ignored.
 */
const pingAnswer = (message: RpcReply): string | undefined =>
  message.method === "ping" && message.id !== undefined && message.id !== null
    ? JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })
    : undefined;

/** The reply to request `id`: server-initiated requests (such as `ping`) and notifications are skipped. */
const isReplyTo = (reply: RpcReply, id: number): boolean => reply.id === id && reply.method === undefined;

/** A server that answered initialize without a tools capability offers only resources or prompts; it is healthy. */
const NO_TOOLS: ProbeOutcome = { status: "pass", detail: "no tools (the server offers resources or prompts)", tools: 0 };
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(RpcReply));

interface ProbeOutcome {
  readonly status: McpCheckStatus;
  readonly detail: string;
  readonly tools?: number | undefined;
}

/** A server's error message can echo what it was sent, so the entry's secrets are redacted from it. */
const rpcError = (reply: RpcReply, secrets: ReadonlyArray<string>): string =>
  redactText(reply.error?.message ?? "unknown error", secrets).slice(0, 400);

/** Starts the server, completes initialize and tools/list, then stops its whole process group. */
const CANCELLED: ProbeOutcome = { status: "skipped", detail: "not checked: the doctor run was cancelled" };

const probeStdio = (launch: Extract<Launch, { kind: "stdio" }>, timeoutMilliseconds: number, cancel: AbortSignal) =>
  new Promise<ProbeOutcome>((resolve) => {
    let stage: "initialize" | "tools/list" = "initialize";
    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    // A process group lets the check stop wrappers (uv, npx, shell scripts) and their children together.
    const detached = process.platform !== "win32";
    // The configured command, not its expansion, appears in messages: an expanded reference may be a secret.
    const shownCommand = redactText(launch.command, launch.secrets);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.command, [...launch.args], {
        env: launch.env, cwd: launch.cwd, stdio: "pipe", detached, windowsHide: true,
      });
    } catch (error) {
      // Invalid arguments (such as a NUL byte) throw before the child exists.
      return resolve({ status: "fail", detail: `could not start ${shownCommand}: ${error instanceof Error && "code" in error ? String(error.code) : "invalid command"}` });
    }
    const finish = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancel.removeEventListener("abort", onCancel);
      terminateProcessTree(child);
      resolve(outcome);
    };
    // The servers run in their own process groups, so an interrupted doctor run must stop them itself.
    const onCancel = () => finish(CANCELLED);
    cancel.addEventListener("abort", onCancel, { once: true });
    // The last two lines, because launchers such as canonfig print the cause and then an exit summary.
    const lastStderrLine = () => {
      const lines = stderr.split(/\r?\n/u).map((text) => text.trim()).filter((text) => text !== "").slice(-2);
      // eslint-disable-next-line no-control-regex -- strips terminal colour codes from server logs
      return lines.length === 0 ? "" : `: ${redactText(lines.join(" | ").replace(/\u001b\[[0-9;]*m/gu, ""), launch.secrets).slice(0, 400)}`;
    };
    const timer = setTimeout(
      () => finish({ status: "fail", detail: `no ${stage} reply within ${timeoutMilliseconds} ms${lastStderrLine()}` }),
      timeoutMilliseconds,
    );
    child.once("error", (error) => {
      const code = "code" in error ? String(error.code) : "";
      finish({
        status: "fail",
        detail: code === "ENOENT"
          ? `command not found: ${shownCommand}`
          : code === "EAGAIN"
          ? "the system refused to start another process (EAGAIN); a process or task limit is exhausted"
          : `could not start (${code || error.message})`,
      });
    });
    child.once("close", (code, signal) =>
      finish({
        status: "fail",
        detail: `exited ${signal === null ? `with code ${code}` : `on ${signal}`} before the ${stage} reply${lastStderrLine()}`,
      }));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    child.stdin.on("error", () => { /* The close handler reports the exit. */ });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_STDOUT_BYTES) return finish({ status: "fail", detail: `wrote over ${MAX_STDOUT_BYTES} bytes before the ${stage} reply` });
      stdout += chunk;
      for (let newline = stdout.indexOf("\n"); newline >= 0; newline = stdout.indexOf("\n")) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        const decoded = decodeReply(line);
        if (Option.isNone(decoded)) continue;
        const message = decoded.value;
        const answer = pingAnswer(message);
        if (answer !== undefined) child.stdin.write(`${answer}\n`);
        if (isReplyTo(message, 1)) {
          if (message.result === undefined) return finish({ status: "fail", detail: `initialize failed: ${rpcError(message, launch.secrets)}` });
          if (message.result.protocolVersion === undefined) return finish({ status: "fail", detail: "initialize reply has no protocolVersion" });
          if (message.result.capabilities?.tools === undefined) return finish(NO_TOOLS);
          stage = "tools/list";
          child.stdin.write(`${JSON.stringify(initializedNotification)}\n${JSON.stringify(toolsRequest)}\n`);
        } else if (isReplyTo(message, 2)) {
          if (message.result === undefined) return finish({ status: "fail", detail: `tools/list failed: ${rpcError(message, launch.secrets)}` });
          if (message.result.tools === undefined) return finish({ status: "fail", detail: "tools/list reply has no tools list" });
          const tools = message.result.tools.length;
          return finish({ status: "pass", detail: `${tools} tools`, tools });
        }
      }
    });
    child.stdin.write(`${JSON.stringify(initializeRequest)}\n`);
  });

/** The most a single HTTP response may send before the check gives up on it. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

type HttpEvent = { event: string | undefined; data: string };

function isEventStream(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
}

/** Read one bounded response, preserving SSE event boundaries across chunks. */
export async function* responseEvents(response: Response): AsyncGenerator<HttpEvent> {
  if (response.body === null) return;
  const sse = isEventStream(response);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let received = 0;
  let buffered = "";
  let event = "message";
  let eventData: Array<string> = [];
  let skipLf = false;
  let failed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        if (!sse) yield { event: undefined, data: buffered };
        return;
      }
      received += Buffer.byteLength(value);
      if (received > MAX_RESPONSE_BYTES) return;
      if (!sse) {
        buffered += value;
        continue;
      }
      // A CR already ended its line, even when the LF arrives in the next chunk.
      if (value.length === 0) continue;
      const chunk: string = skipLf && value.startsWith("\n") ? value.slice(1) : value;
      skipLf = chunk.endsWith("\r");
      if (chunk.length === 0) continue;
      // Split only the new chunk so long lines are not scanned again on each read.
      const lines = chunk.split(/\r\n|[\r\n]/u);
      if (lines.length === 1) {
        buffered += chunk;
        continue;
      }
      lines[0] = buffered + lines[0];
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const separator = line.indexOf(":");
        const field = separator < 0 ? line : line.slice(0, separator);
        const text = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /u, "");
        if (field === "event") event = text || "message";
        else if (field === "data") eventData.push(text);
        else if (line === "") {
          if (eventData.length) yield { event, data: eventData.join("\n") };
          event = "message";
          eventData = [];
        }
      }
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // An errored response can also reject cancellation. Preserve the read failure.
    const cancelled = reader.cancel();
    await (failed ? cancelled.catch(() => undefined) : cancelled);
  }
}

async function responseMessage(
  events: AsyncGenerator<HttpEvent>, id: number, answer: (body: string) => Promise<void>, legacySse = false,
): Promise<RpcReply | undefined> {
  for (;;) {
    const event = await events.next();
    if (event.done) return undefined;
    if (legacySse && event.value.event !== "message") continue;
    const reply = decodeReply(event.value.data);
    if (Option.isNone(reply)) continue;
    const pong = event.value.event === undefined ? undefined : pingAnswer(reply.value);
    if (pong !== undefined) await answer(pong);
    if (isReplyTo(reply.value, id)) return reply.value;
  }
}

async function streamableReply(response: Response, id: number, answer: (body: string) => Promise<void>) {
  const events = responseEvents(response);
  let reply: RpcReply | undefined;
  try {
    reply = await responseMessage(events, id, answer);
  } catch (error) {
    // An aborted stream can reject closure too. Keep the original reply failure.
    await events.return(undefined).catch(() => undefined);
    throw error;
  }
  await events.return(undefined);
  return reply;
}

async function sseMessageEndpoint(events: AsyncGenerator<HttpEvent>, streamUrl: string): Promise<URL | undefined> {
  for (;;) {
    const event = await events.next();
    if (event.done) return undefined;
    if (event.value.event !== "endpoint") continue;
    const endpoint = URL.parse(event.value.data, streamUrl);
    // The advertised URL is server input. Keep configured headers within the stream origin.
    if (endpoint === null || !["http:", "https:"].includes(endpoint.protocol)
      || endpoint.origin !== new URL(streamUrl).origin || endpoint.username || endpoint.password) return undefined;
    return endpoint;
  }
}

const OAUTH_REQUIRED: ProbeOutcome = {
  status: "skipped",
  detail: "the server asks for OAuth sign-in, which only the harness holds; not checked",
};

class ServerReplyFailure extends Error {}

const probeHttp = async (launch: Extract<Launch, { kind: "http" }>, timeoutMilliseconds: number, cancel: AbortSignal): Promise<ProbeOutcome> => {
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMilliseconds), cancel]);
  // With no configured headers, a 401 means the harness signs in with OAuth.
  const authorized = Object.keys(launch.headers).length > 0;
  // After initialize, requests carry the session and the negotiated protocol version, as the transport requires.
  let session: string | undefined;
  let protocolVersion: string | undefined;
  let pushUrl = launch.url;
  let events: AsyncGenerator<HttpEvent> | undefined;
  const requestHeaders = () => {
    const headers = new Headers(launch.headers);
    if (session !== undefined) headers.set("Mcp-Session-Id", session);
    if (protocolVersion !== undefined) headers.set("MCP-Protocol-Version", protocolVersion);
    return headers;
  };
  // Every POST, including answers to server requests, carries the headers the transport requires.
  const send = (body: string, redirect: RequestInit["redirect"] = "follow") => {
    const headers = requestHeaders();
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json, text/event-stream");
    return fetch(pushUrl, { method: "POST", headers, body, signal, redirect: launch.sse ? "manual" : redirect });
  };
  const post = (body: RpcMessage) => send(JSON.stringify(body));
  const answer = async (body: string) => {
    try {
      // A redirect to a login page is not an acknowledgement of the reply.
      const sent = await send(body, "manual");
      await sent.body?.cancel();
      if (!sent.ok) throw new ServerReplyFailure(`reply to server ping returned HTTP ${sent.status}`);
    } catch (error) {
      if (error instanceof ServerReplyFailure) throw error;
      throw new ServerReplyFailure(signal.aborted
        ? `no acknowledgement for the reply to server ping within ${timeoutMilliseconds} ms`
        : "could not send the reply to server ping");
    }
  };
  const close = async (): Promise<string | undefined> => {
    if (events) {
      try {
        await events.return(undefined);
      } catch {
        if (!signal.aborted) return "SSE stream cleanup failed";
      }
      return undefined;
    }
    // Session termination has its own deadline and the server may decline with HTTP 405.
    if (session === undefined) return undefined;
    const closeMilliseconds = 2_000;
    const closing = AbortSignal.timeout(closeMilliseconds);
    try {
      const closed = await fetch(launch.url, { method: "DELETE", headers: requestHeaders(), signal: closing, redirect: "manual" });
      await closed.body?.cancel();
      if (!closed.ok && closed.status !== 405) return `session cleanup failed: DELETE returned HTTP ${closed.status}`;
    } catch {
      return closing.aborted
        ? `session cleanup timed out after ${closeMilliseconds} ms`
        : "session cleanup failed: could not complete DELETE";
    }
    return undefined;
  };
  const run = async (): Promise<ProbeOutcome> => {
    try {
      if (launch.sse) {
        const headers = requestHeaders();
        headers.set("Accept", "text/event-stream");
        const response = await fetch(launch.url, { headers, signal, redirect: "manual" });
        if (response.status === 401 && !authorized) {
          await response.body?.cancel();
          return OAUTH_REQUIRED;
        }
        if (!response.ok || !isEventStream(response)) {
          await response.body?.cancel();
          return { status: "fail", detail: !response.ok ? "HTTP " + response.status + " opening the SSE stream" : "SSE endpoint did not return an event stream" };
        }
        events = responseEvents(response);
        const endpoint = await sseMessageEndpoint(events, response.url);
        if (endpoint === undefined) return { status: "fail", detail: "SSE stream did not advertise a usable same-origin message endpoint" };
        pushUrl = endpoint.href;
      }
      const readReply = async (response: Response, id: number) => {
        if (!events) return streamableReply(response, id, answer);
        await response.body?.cancel();
        return responseMessage(events, id, answer, true);
      };
      const initialized = await post(launch.sse
        ? { ...initializeRequest, params: { ...initializeRequest.params, protocolVersion: "2024-11-05" } }
        : initializeRequest);
      if (initialized.status === 401 && !authorized) {
        await initialized.body?.cancel();
        return OAUTH_REQUIRED;
      }
      if (!initialized.ok) {
        await initialized.body?.cancel();
        return { status: "fail", detail: `initialize returned HTTP ${initialized.status}` };
      }
      // Recorded before the body is read, so the session is closed even if the body stalls or is invalid.
      if (!launch.sse) session = initialized.headers.get("mcp-session-id") ?? undefined;
      const reply = await readReply(initialized, 1);
      if (reply?.result === undefined) return { status: "fail", detail: `initialize failed: ${reply === undefined ? "no JSON-RPC reply" : rpcError(reply, launch.secrets)}` };
      if (reply.result.protocolVersion === undefined) return { status: "fail", detail: "initialize reply has no protocolVersion" };
      protocolVersion = reply.result.protocolVersion;
      const acknowledged = await post(initializedNotification);
      await acknowledged.body?.cancel();
      if (!acknowledged.ok) return { status: "fail", detail: `notifications/initialized returned HTTP ${acknowledged.status}` };
      if (reply.result.capabilities?.tools === undefined) return NO_TOOLS;
      const listed = await post(toolsRequest);
      if (!listed.ok) {
        await listed.body?.cancel();
        return { status: "fail", detail: `tools/list returned HTTP ${listed.status}` };
      }
      const tools = await readReply(listed, 2);
      if (tools?.result === undefined) return { status: "fail", detail: `tools/list failed: ${tools === undefined ? "no JSON-RPC reply" : rpcError(tools, launch.secrets)}` };
      if (tools.result.tools === undefined) return { status: "fail", detail: "tools/list reply has no tools list" };
      const count = tools.result.tools.length;
      return { status: "pass", detail: `${count} tools`, tools: count };
    } catch (error) {
      if (cancel.aborted) return CANCELLED;
      if (error instanceof ServerReplyFailure) return { status: "fail", detail: error.message };
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "network error";
      return {
        status: "fail",
        detail: signal.aborted ? "no reply within " + timeoutMilliseconds + " ms" : "request failed: " + redactText(cause, launch.secrets),
      };
    }
  };

  const result = await run();
  const cleanup = await close();
  return cleanup === undefined ? result : { ...result, detail: `${result.detail}; ${cleanup}` };
};

/**
 * Probes one harness at a time, each with all of its servers at once, because
 * that is the load a harness puts on the machine at session start. A launch
 * identical to one already probed for another harness reuses that result and
 * is reported with every harness that declares it.
 */
export const checkMcpEntries = async (
  entries: ReadonlyArray<McpEntry>,
  timeoutMilliseconds: number,
  cancel: AbortSignal = AbortSignal.any([]),
): Promise<ReadonlyArray<McpCheckResult>> => {
  const groups = new Map<string, {
    readonly entry: McpEntry;
    readonly harnesses: Array<TargetId>;
    outcome?: Omit<McpCheckResult, "name" | "harnesses">;
  }>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.name, entry.launch]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { entry, harnesses: [entry.harness] });
    else if (!group.harnesses.includes(entry.harness)) group.harnesses.push(entry.harness);
  }
  const probe = async ({ launch, path }: McpEntry): Promise<Omit<McpCheckResult, "name" | "harnesses">> => {
    if (launch.kind === "disabled") return { status: "skipped", detail: "disabled" };
    if (launch.kind === "invalid") return { status: "fail", detail: `${path}: ${launch.reason}` };
    const started = performance.now();
    const budget = launch.timeoutMilliseconds ?? timeoutMilliseconds;
    const outcome = launch.kind === "stdio" ? await probeStdio(launch, budget, cancel) : await probeHttp(launch, budget, cancel);
    return { ...outcome, milliseconds: Math.round(performance.now() - started) };
  };
  for (const harness of new Set(entries.map((entry) => entry.harness))) {
    if (cancel.aborted) break;
    await Promise.all([...groups.values()]
      .filter((group) => group.outcome === undefined && group.entry.harness === harness)
      .map(async (group) => { group.outcome = await probe(group.entry); }));
  }
  return [...groups.values()].map(({ entry, harnesses, outcome }) => ({ name: entry.name, harnesses, ...outcome ?? CANCELLED }));
};

/** Detects installed harnesses, reads their MCP entries and probes them. */
export const checkInstalledHarnessMcp = (input: {
  readonly context: RootContext;
  readonly folder: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly timeoutMilliseconds: number;
}) =>
  Effect.gen(function*() {
    const detection = yield* detectHarnesses(input.context, input.folder);
    const harnesses = detection.filter((row) => row.installed).map((row) => row.harness);
    const entries = yield* Effect.promise(() => readHarnessMcpEntries({ ...input, harnesses }));
    const guarded = yield* Effect.forEach(entries, withLauncherSecrets);
    return yield* Effect.promise((signal) => checkMcpEntries(guarded, input.timeoutMilliseconds, signal));
  });

/**
 * An entry that starts `canonfig mcp run <name>` gets its credentials inside
 * that launcher, so they are not in the entry. They are resolved here the
 * same way, only to be redacted from what the server prints. If resolution
 * fails, the launcher fails the same way and prints only its own safe message.
 */
export const withLauncherSecrets = (entry: McpEntry) =>
  Effect.gen(function*() {
    const { launch } = entry;
    if (launch.kind !== "stdio") return entry;
    const run = launch.args.length >= 3 ? launch.args.slice(-3) : [];
    if (run[0] !== "mcp" || run[1] !== "run" || run[2] === undefined) return entry;
    const invocation = yield* prepareMcpRun(run[2], launch.env).pipe(Effect.option);
    if (Option.isNone(invocation)) return entry;
    const resolved = Object.entries(invocation.value.env)
      // Values the launcher adds or changes, plus credential-named ones even when the inherited
      // environment already holds them (a `fromEnv` credential resolves to the same value).
      .filter((pair): pair is [string, string] => pair[1] !== undefined && (pair[1] !== launch.env[pair[0]] || isSecretField(pair[0])));
    return { ...entry, launch: { ...launch, secrets: [...launch.secrets, ...secretValues(resolved)] } };
  });
