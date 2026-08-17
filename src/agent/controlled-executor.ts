import { spawn } from "node:child_process";

import { Effect } from "effect";

import {
  AgentExecutionCancelledError,
  AgentExecutionTimeoutError,
  AgentInputLimitError,
  AgentOutputLimitError,
  AgentProcessError,
  type AgentResolutionError,
} from "./agent-resolution.errors.ts";
import type {
  CapturedProcess,
  ControlledProcessInput,
} from "./agent-resolution.types.ts";

const decoder = new TextDecoder();

export const redactText = (
  value: string,
  secrets: ReadonlyArray<string>,
): string => {
  let redacted = value;
  const ordered = [...new Set(secrets)]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const secret of ordered) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return redacted;
};

const packageManagerName = (value: string): string =>
  value
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    ?.toLowerCase()
    .replace(/\.(?:cmd|exe|bat|com|ps1)$/u, "")
    .replace(/^(?:npm)-cli\.js$/u, "npm")
    .replace(/^(?:pnpm)\.(?:cjs|js)$/u, "pnpm")
    .replace(/^(?:yarn)\.js$/u, "yarn")
    ?? "";

const isRegistryPackageManager = (manager: string): boolean =>
  manager === "npm"
  || manager === "pnpm"
  || manager === "yarn"
  || manager === "bun"
  || manager === "uv";

const packageOperationRequiresRegistry = (
  executable: string,
  arguments_: ReadonlyArray<string>,
): boolean => {
  const manager = packageManagerName(executable);
  if (!isRegistryPackageManager(manager)) return false;
  const optionsWithValues = manager === "uv"
    ? new Set([
      "--cache-dir",
      "--config-file",
      "--default-index",
      "--directory",
      "--extra-index-url",
      "--index",
      "--index-url",
      "--project",
    ])
    : manager === "bun"
    ? new Set(["--config", "--cwd", "--filter", "--registry"])
    : new Set([
      "-C",
      "--cache",
      "--config-dir",
      "--dir",
      "--global-bin-dir",
      "--global-dir",
      "--prefix",
      "--registry",
      "--store-dir",
      "--userconfig",
      "--virtual-store-dir",
      "--workspace-dir",
    ]);
  let command: string | undefined;
  let commandIndex = -1;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--") return false;
    if (!argument.startsWith("-") || argument === "-") {
      command = argument.toLowerCase();
      commandIndex = index;
      break;
    }
    if (!argument.includes("=") && optionsWithValues.has(argument)) index += 1;
  }
  if (manager === "uv") {
    return (
      (command === "tool" || command === "pip")
      && arguments_[commandIndex + 1]?.toLowerCase() === "install"
    );
  }
  if (manager === "bun") {
    return command !== undefined && ["add", "i", "install", "update"].includes(command);
  }
  return command !== undefined && [
    "add",
    "ci",
    "i",
    "in",
    "ins",
    "inst",
    "insta",
    "instal",
    "install",
    "info",
    "list",
    "ls",
    "outdated",
    "prefix",
    "root",
    "search",
    "view",
    "why",
  ].includes(command);
};

const protectedPackageEnvironment = (name: string): boolean => {
  const lower = name.toLowerCase();
  return lower.startsWith("npm_config_")
    || lower.startsWith("pnpm_config_")
    || lower.startsWith("bun_config_")
    || lower.startsWith("yarn_")
    || lower.startsWith("uv_")
    || lower.startsWith("pip_")
    || lower === "http_proxy"
    || lower === "https_proxy"
    || lower === "all_proxy"
    || lower === "no_proxy"
    || lower === "node_tls_reject_unauthorized"
    || lower === "node_extra_ca_certs";
};

const packageManagerConfigurationEnvironment = (
  executable: string,
): ReadonlyArray<{ readonly name: string; readonly value: string }> => {
  const manager = packageManagerName(executable);
  const emptyConfiguration = process.platform === "win32" ? "NUL" : "/dev/null";
  if (manager === "npm" || manager === "pnpm") {
    return [
      { name: "NPM_CONFIG_USERCONFIG", value: emptyConfiguration },
      { name: "NPM_CONFIG_GLOBALCONFIG", value: emptyConfiguration },
      { name: "NPM_CONFIG_LOCATION", value: "global" },
    ];
  }
  if (manager === "bun") {
    return [{ name: "BUN_CONFIG_FILE", value: emptyConfiguration }];
  }
  if (manager === "uv") {
    return [
      { name: "UV_CONFIG_FILE", value: emptyConfiguration },
      { name: "PIP_CONFIG_FILE", value: emptyConfiguration },
    ];
  }
  if (manager === "yarn") {
    return [{ name: "YARN_RC_FILENAME", value: emptyConfiguration }];
  }
  return [];
};

export const sanitizedPackageManagerEnvironment = (
  executable: string,
  environment: ReadonlyArray<{ readonly name: string; readonly value: string }> = [],
  packageRegistryOrigin?: string,
  packageRegistryScopes: ReadonlyArray<string> = [],
): ReadonlyArray<{ readonly name: string; readonly value: string }> => {
  const manager = packageManagerName(executable);
  if (!isRegistryPackageManager(manager)) return environment;
  return [
    ...environment.filter((entry) => !protectedPackageEnvironment(entry.name)),
    ...packageManagerConfigurationEnvironment(executable),
    ...(packageRegistryOrigin === undefined
      ? []
      : manager === "npm" || manager === "pnpm"
      ? [
        { name: "NPM_CONFIG_REGISTRY", value: packageRegistryOrigin },
        ...(manager === "pnpm"
          ? [{ name: "PNPM_CONFIG_REGISTRY", value: packageRegistryOrigin }]
          : []),
        ...packageRegistryScopes.map((scope) => ({
          name: `npm_config_${scope}:registry`,
          value: packageRegistryOrigin,
        })),
        ...(manager === "pnpm"
          ? packageRegistryScopes.map((scope) => ({
            name: `pnpm_config_${scope}:registry`,
            value: packageRegistryOrigin,
          }))
          : []),
      ]
      : manager === "bun"
      ? [{ name: "BUN_CONFIG_REGISTRY", value: packageRegistryOrigin }]
      : manager === "uv"
      ? [
        { name: "UV_DEFAULT_INDEX", value: packageRegistryOrigin },
        { name: "UV_INDEX_URL", value: packageRegistryOrigin },
        { name: "PIP_INDEX_URL", value: packageRegistryOrigin },
      ]
      : manager === "yarn"
      ? [{ name: "YARN_NPM_REGISTRY_SERVER", value: packageRegistryOrigin }]
      : []),
  ];
};

export const controlledEnvironment = (
  entries: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  unset: ReadonlyArray<string> = [],
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  const blocked = new Set(unset.map((name) => name.toLowerCase()));
  for (const name of Object.keys(environment)) {
    if (blocked.has(name.toLowerCase())) delete environment[name];
  }
  for (const entry of entries) {
    if (entry.name.includes("=") || entry.name.length === 0) continue;
    if (process.platform === "win32") {
      const existing = Object.keys(environment).find(
        (name) => name.toLowerCase() === entry.name.toLowerCase(),
      );
      if (existing !== undefined) delete environment[existing];
    }
    environment[entry.name] = entry.value;
  }
  return environment;
};

const cancelled = (input: ControlledProcessInput): AgentExecutionCancelledError =>
  new AgentExecutionCancelledError({ executable: input.executable });

export const executeControlledProcess = (
  input: ControlledProcessInput,
): Effect.Effect<CapturedProcess, AgentResolutionError> => {
  const inputBytes = input.standardInput?.byteLength ?? 0;
  if (inputBytes > input.maximumInputBytes) {
    return Effect.fail(new AgentInputLimitError({
      actualBytes: inputBytes,
      maximumBytes: input.maximumInputBytes,
    }));
  }
  if (input.signal?.aborted === true) return Effect.fail(cancelled(input));
  if (
    packageOperationRequiresRegistry(input.executable, input.arguments)
    && input.packageRegistryOrigin === undefined
  ) {
    return Effect.fail(new AgentProcessError({
      executable: input.executable,
      message: "package-manager registry origin is not explicitly authorized",
    }));
  }

  return Effect.tryPromise({
    try: (effectSignal) => new Promise<CapturedProcess>((resolve, reject) => {
      const output: Array<Buffer> = [];
      const errors: Array<Buffer> = [];
      let capturedBytes = 0;
      let settled = false;
      let limitExceeded = false;
      let timedOut = false;
      let wasCancelled = false;
      const child = spawn(input.executable, [...input.arguments], {
        cwd: input.workingDirectory,
        env: (() => {
          const manager = packageManagerName(input.executable);
          const packageManager = isRegistryPackageManager(manager);
          const inherited = input.environment ?? [];
          const protectedInput = inherited
            .filter((entry) => protectedPackageEnvironment(entry.name))
            .map((entry) => entry.name);
          const environment = sanitizedPackageManagerEnvironment(
            input.executable,
            inherited,
            input.packageRegistryOrigin,
            input.packageRegistryScopes,
          );
          return controlledEnvironment(
            environment,
            [
              ...(input.environmentUnset ?? []),
              ...protectedInput,
              ...(input.environmentUnsetPrefixes ?? []).flatMap((prefix) =>
                Object.keys(process.env).filter((name) =>
                  name.toLowerCase().startsWith(prefix.toLowerCase())
                )
              ),
              ...(packageManager
                ? Object.keys(process.env).filter(protectedPackageEnvironment)
                : []),
            ],
          );
        })(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const finishWith = (cause: AgentResolutionError): void => {
        if (settled) return;
        settled = true;
        reject(cause);
      };
      const terminate = (): void => {
        if (!child.killed) child.kill("SIGKILL");
      };
      const capture = (target: Array<Buffer>) => (chunk: Buffer): void => {
        capturedBytes += chunk.byteLength;
        if (capturedBytes > input.maximumOutputBytes) {
          limitExceeded = true;
          terminate();
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", capture(output));
      child.stderr.on("data", capture(errors));
      child.once("error", (cause) => {
        finishWith(new AgentProcessError({
          executable: input.executable,
          message: redactText(String(cause), input.secrets),
        }));
      });
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, input.timeoutMilliseconds);
      const abort = (): void => {
        wasCancelled = true;
        terminate();
      };
      effectSignal.addEventListener("abort", abort, { once: true });
      input.signal?.addEventListener("abort", abort, { once: true });
      child.once("close", (exitCode, signal) => {
        clearTimeout(timer);
        effectSignal.removeEventListener("abort", abort);
        input.signal?.removeEventListener("abort", abort);
        if (settled) return;
        if (wasCancelled) {
          finishWith(cancelled(input));
          return;
        }
        if (timedOut) {
          finishWith(new AgentExecutionTimeoutError({
            executable: input.executable,
            timeoutMilliseconds: input.timeoutMilliseconds,
          }));
          return;
        }
        if (limitExceeded) {
          finishWith(new AgentOutputLimitError({
            executable: input.executable,
            maximumBytes: input.maximumOutputBytes,
          }));
          return;
        }
        settled = true;
        resolve({
          executable: input.executable,
          arguments: input.arguments,
          exitCode,
          signal,
          stdout: redactText(decoder.decode(Buffer.concat(output)), input.secrets),
          stderr: redactText(decoder.decode(Buffer.concat(errors)), input.secrets),
        });
      });
      if (input.standardInput === undefined) child.stdin.end();
      else child.stdin.end(input.standardInput);
    }),
    catch: (cause) => cause instanceof AgentInputLimitError
      || cause instanceof AgentExecutionCancelledError
      || cause instanceof AgentExecutionTimeoutError
      || cause instanceof AgentOutputLimitError
      || cause instanceof AgentProcessError
      ? cause
      : new AgentProcessError({
        executable: input.executable,
        message: redactText(String(cause), input.secrets),
      }),
  });
};
