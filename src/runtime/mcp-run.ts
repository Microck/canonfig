import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { constants } from "node:os";
import { delimiter, dirname, join, posix, win32 } from "node:path";

import { Effect, Predicate, Redacted } from "effect";

import { MachineState } from "../machine/machine-state.service.ts";
import { loadCanonicalFolder } from "../projection/folder.ts";
import type { McpServer, SecretValue } from "../projection/model.ts";
import { findSecretReference } from "../secrets/secret-store.ts";
import { runtimeMachineLayer } from "./layers.ts";
import { validMcpRunArguments } from "./command-routing.ts";

export const MCP_REMOTE_VERSION = "0.16.6";
export const MCP_RUN_EXIT = { configuration: 2, missingSecret: 20, storage: 21, launch: 22 } as const;

export class McpRunError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
    this.name = "McpRunError";
  }
}

export interface McpInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string | undefined;
}

const resolveValue = (value: SecretValue, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function*() {
    if (Predicate.isString(value)) return value;
    if ("fromEnv" in value) {
      const resolved = environment[value.fromEnv] ?? value.default;
      if (resolved === undefined) return yield* Effect.fail(new McpRunError(
        `Environment variable ${value.fromEnv} is missing. Set it before starting this MCP server.`,
        MCP_RUN_EXIT.configuration,
      ));
      return resolved;
    }
    const storageFailure = () => new McpRunError(
      `Secret ${value.fromSecret} could not be read. Unlock the native credential store in this session and retry canonfig secrets sync.`,
      MCP_RUN_EXIT.storage,
    );
    const reference = yield* findSecretReference(value.fromSecret).pipe(Effect.mapError(storageFailure));
    if (reference === undefined) return yield* Effect.fail(new McpRunError(
      `Secret ${value.fromSecret} is missing. Run canonfig secrets sync on an enrolled follower in canonfig:secrets, or canonfig secrets set ${value.fromSecret}, then restart this MCP server.`,
      MCP_RUN_EXIT.missingSecret,
    ));
    const machine = yield* MachineState;
    const loaded = yield* machine.loadCredential({ reference }).pipe(Effect.mapError(storageFailure));
    return Redacted.value(loaded);
  });

const missingNpxError = () => new McpRunError(
  "Cannot find npm's npx-cli.js. Install npm for the running Node executable or put the installed npx on PATH, then restart this MCP server.",
  MCP_RUN_EXIT.launch,
);

/** Resolve npm's JS entrypoint, not a shell wrapper, across Node installations. */
export const npxCliPath = (
  node: string, platform: NodeJS.Platform = process.platform, searchPath: string = process.env.PATH ?? "",
): string => {
  const paths = platform === "win32" ? win32 : posix;
  const bin = paths.dirname(node);
  const npmEntry = ["node_modules", "npm", "bin", "npx-cli.js"];
  const candidates = [
    platform === "win32" ? paths.join(bin, ...npmEntry) : paths.join(bin, "..", "lib", ...npmEntry),
    paths.join(bin, "npx"),
    paths.join(bin, "..", "libexec", "lib", ...npmEntry),
    ...searchPath.split(paths.delimiter).filter(Boolean).flatMap((directory) =>
      platform === "win32" ? [paths.join(directory, ...npmEntry)] : [paths.join(directory, "npx")]),
  ];
  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(candidate);
      if (paths.basename(resolved) === "npx-cli.js" && statSync(resolved).isFile()) return resolved;
    } catch {
      // Try the next installation location when this one is absent or unreadable.
    }
  }
  throw missingNpxError();
};

/** The returned invocation is private process input, never a plan or log payload. */
export const resolveMcpInvocation = (
  server: McpServer,
  environment: NodeJS.ProcessEnv = process.env,
  node: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
) => Effect.gen(function*() {
  const env = { ...environment };
  if (server.transport === "stdio") {
    for (const [name, value] of Object.entries(server.env)) {
      const resolved = yield* resolveValue(value, environment);
      if (platform === "win32") {
        const folded = name.toUpperCase();
        for (const key of Object.keys(env)) if (key.toUpperCase() === folded) delete env[key];
      }
      env[name] = resolved;
    }
    return { command: server.command, args: server.args, cwd: server.cwd, env } satisfies McpInvocation;
  }
  // npm invokes package bins through their shebang. Pin that lookup to the
  // same Node even when a GUI-launched harness has no interactive shell PATH.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = `${dirname(node)}${delimiter}${env[pathKey] ?? ""}`;
  const npx = yield* Effect.try({
    try: () => npxCliPath(node, platform, env[pathKey]),
    catch: missingNpxError,
  });
  const args = [npx, "-y", "--silent", `mcp-remote@${MCP_REMOTE_VERSION}`, server.url,
    "--silent", "--transport", server.transport === "sse" ? "sse-only" : "http-only"];
  let index = 0;
  for (const [name, value] of Object.entries(server.headers)) {
    const variable = `CANONFIG_MCP_HEADER_${index++}`;
    env[variable] = yield* resolveValue(value, environment);
    args.push("--header", `${name}:\${${variable}}`);
  }
  return { command: node, args, env } satisfies McpInvocation;
});

/** Uses the same folder loader, allowlist and explicit overlays as projection. */
export const prepareMcpRun = (name: string, environment: NodeJS.ProcessEnv = process.env) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const directories = yield* machine.userDirectories().pipe(Effect.mapError(() =>
      new McpRunError("Home directory is unavailable. Check this session's home directory.", MCP_RUN_EXIT.configuration)));
    const folder = join(directories.home.absolute, ".canonfig");
    const loaded = yield* Effect.tryPromise({
      try: () => loadCanonicalFolder(folder),
      // Schema failures can include authored literals. Do not print their payload.
      catch: () => new McpRunError(`Cannot load ${folder}. Check canonfig.jsonc and local/local.jsonc with canonfig sync before retrying.`, MCP_RUN_EXIT.configuration),
    });
    const server = loaded.model.mcp.find(([candidate]) => candidate === name)?.[1];
    if (server === undefined) return yield* Effect.fail(new McpRunError(
      `Unknown or disabled MCP server ${name}. Check the applied ~/.canonfig/canonfig.jsonc and allowed local overlays.`,
      MCP_RUN_EXIT.configuration,
    ));
    return yield* resolveMcpInvocation(server, environment);
  });

/** Inherited descriptors carry MCP frames directly, without capture or logging. */
export const launchMcp = (
  invocation: McpInvocation, platform: NodeJS.Platform = process.platform,
): Promise<number> => new Promise((resolve, reject) => {
  // CRT argument quoting does not protect cmd.exe expansion (%VAR%, !VAR!)
  // or batch-file reparsing. Keep arbitrary server arguments out of a shell.
  if (platform === "win32" && /\.(?:cmd|bat)$/iu.test(invocation.command)) {
    reject(new McpRunError(
      "Windows MCP batch commands (.cmd/.bat) are not supported without a shell. Configure the native executable instead; for JavaScript servers, use node.exe with the server's JavaScript entrypoint as the first argument.",
      MCP_RUN_EXIT.launch,
    ));
    return;
  }
  const child = spawn(invocation.command, [...invocation.args], {
    env: invocation.env, cwd: invocation.cwd, stdio: "inherit", windowsHide: true,
  });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = signals.map((signal) => {
    const handler = () => { child.kill(signal); };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  const cleanup = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
  child.once("error", () => {
    cleanup();
    reject(new McpRunError("MCP child could not start. Check the server command and working directory.", MCP_RUN_EXIT.launch));
  });
  child.once("exit", (code, signal) => {
    cleanup();
    resolve(code ?? (signal === null ? MCP_RUN_EXIT.launch : 128 + constants.signals[signal]));
  });
});

export const runMcpCli = async (args: ReadonlyArray<string>): Promise<number> => {
  if (!validMcpRunArguments(args)) {
    process.stderr.write("Usage: canonfig mcp run <name>\n");
    return MCP_RUN_EXIT.configuration;
  }
  try {
    // Match expected errors into plain values so Effect never formats a cause
    // containing private process input into stderr or command logs.
    const prepared = await Effect.runPromise(prepareMcpRun(args[1]!).pipe(
      Effect.provide(runtimeMachineLayer()),
      Effect.match({ onFailure: (error) => error, onSuccess: (invocation) => invocation }),
    ));
    if (prepared instanceof McpRunError) throw prepared;
    return await launchMcp(prepared);
  } catch (error) {
    const safe = error instanceof McpRunError ? error
      : new McpRunError("MCP launcher failed. Check the applied folder and credential-store availability in this session.", MCP_RUN_EXIT.launch);
    process.stderr.write(`${safe.message}\n`);
    return safe.exitCode;
  }
};
