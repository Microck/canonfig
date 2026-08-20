import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, open, realpath } from "node:fs/promises";

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
  PipRequirementFileAuthorization,
} from "./agent-resolution.types.ts";

const decoder = new TextDecoder();

const sameRequirementIdentity = (
  left: PipRequirementFileAuthorization["identity"],
  right: PipRequirementFileAuthorization["identity"],
): boolean =>
  left.dev === right.dev
  && left.ino === right.ino
  && left.size === right.size;

const pipRequirementFilesUnchanged = async (
  files: ReadonlyArray<PipRequirementFileAuthorization>,
): Promise<boolean> => {
  for (const expected of files) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const before = await lstat(expected.path);
      if (!before.isFile() || !sameRequirementIdentity(before, expected.identity)) {
        return false;
      }
      if (await realpath(expected.path) !== expected.canonicalPath) return false;
      handle = await open(expected.path, "r");
      const opened = await handle.stat();
      if (!sameRequirementIdentity(opened, expected.identity)) return false;
      const buffer = Buffer.alloc(expected.identity.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
      if (bytesRead !== expected.identity.size) return false;
      const after = await lstat(expected.path);
      if (!sameRequirementIdentity(after, expected.identity)) return false;
      if (
        createHash("sha256")
          .update(buffer.subarray(0, bytesRead))
          .digest("hex") !== expected.digest
      ) return false;
    } catch {
      return false;
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
    }
  }
  return true;
};

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

const packageManagerName = (value: string): string => {
  const name = value
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    ?.toLowerCase()
    .replace(/\.(?:cmd|exe|bat|com|ps1)$/u, "")
    .replace(/^(?:npm)-cli\.js$/u, "npm")
    .replace(/^(?:pnpm)\.(?:cjs|js)$/u, "pnpm")
    .replace(/^(?:yarn)\.js$/u, "yarn")
    ?? "";
  return /^pip(?:3(?:\.\d+(?:\.\d+)*)?|-3(?:\.\d+(?:\.\d+)*)?)?$/u.test(name)
    ? "pip"
    : name;
};

const isRegistryPackageManager = (manager: string): boolean =>
  manager === "npm"
  || manager === "pnpm"
  || manager === "yarn"
  || manager === "bun"
  || manager === "pip"
  || manager === "uv";

const canonicalRegistryOrigin = (value: string): string | undefined => {
  return canonicalRegistryUrl(value)?.origin;
};

const hasUnsafeUrlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x20
      || (code >= 0x7f && code <= 0x9f)
      || "\"'<>\\ ".includes(character);
  });

const hasExplicitUrlCredentialOrFragment = (value: string): boolean => {
  if (value.includes("#")) return true;
  const authority = /^https?:\/\/([^/?#]*)/iu.exec(value)?.[1];
  return authority?.includes("@") ?? false;
};

const canonicalRegistryUrl = (
  value: string,
): { readonly url: string; readonly origin: string } | undefined => {
  if (
    value.trim() !== value
    || hasUnsafeUrlCharacter(value)
    || hasExplicitUrlCredentialOrFragment(value)
  ) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username.length > 0
      || url.password.length > 0
      || url.hash.length > 0
      || url.hostname.length === 0
    ) return undefined;
    return {
      url: url.pathname === "/" && url.search.length === 0
        ? url.origin
        : url.href,
      origin: url.origin,
    };
  } catch {
    return undefined;
  }
};

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
      "-f",
      "--find-links",
      "--index",
      "--index-url",
      "--project",
    ])
    : manager === "pip"
    ? new Set([
      "--cache-dir",
      "--cert",
      "--client-cert",
      "--config-settings",
      "--config-setting",
      "--constraint",
      "-c",
      "--extra-index-url",
      "--find-links",
      "-f",
      "-i",
      "--index-url",
      "--proxy",
      "--requirement",
      "-r",
      "--trusted-host",
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
    if (
      !argument.includes("=")
      && optionsWithValues.has(argument.split("=", 1)[0]!.toLowerCase())
    ) index += 1;
  }
  if (manager === "uv") {
    return (
      (command === "tool" || command === "pip")
      && arguments_[commandIndex + 1]?.toLowerCase() === "install"
    );
  }
  if (manager === "pip") return command === "install";
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

const isUvFindLinksOption = (argument: string): boolean => {
  const lower = argument.toLowerCase();
  return lower === "--find-links"
    || lower.startsWith("--find-links=")
    || (
      lower.startsWith("-")
      && !lower.startsWith("--")
      && lower.slice(1).includes("f")
    );
};

const packageRegistryInvocationIsSafe = (
  executable: string,
  arguments_: ReadonlyArray<string>,
  packageRegistryOrigin: string,
): boolean => {
  const manager = packageManagerName(executable);
  const registry = canonicalRegistryOrigin(packageRegistryOrigin);
  if (registry === undefined) return false;
  if (arguments_.includes("--")) return false;
  const indexOptions = manager === "uv"
    ? new Set([
      "--default-index",
      "--index-url",
      "--extra-index-url",
      "-f",
      "--find-links",
      "--index",
    ])
    : manager === "pip"
    ? new Set(["-i", "--index-url", "--extra-index-url", "-f", "--find-links"])
    : new Set<string>();
  const unsafeOptions = manager === "uv"
    ? new Set(["--config-file"])
    : manager === "pip"
    ? new Set([
      "--cert",
      "--client-cert",
      "--config-setting",
      "--config-settings",
      "--proxy",
      "--trusted-host",
    ])
    : new Set<string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    const separator = argument.indexOf("=");
    const name = (separator > 0 ? argument.slice(0, separator) : argument)
      .toLowerCase();
    if (unsafeOptions.has(name)) return false;
    if (
      manager === "uv"
      && (
        isUvFindLinksOption(argument)
        || ["--extra-index-url", "--index"].includes(name)
      )
    ) return false;
    if (
      (manager === "uv" && name === "--no-config")
      || (manager === "pip" && name === "--isolated")
    ) {
      if (separator > 0 && argument.slice(separator + 1).toLowerCase() !== "true") {
        return false;
      }
    }
    if (!indexOptions.has(name)) continue;
    const value = separator > 0
      ? argument.slice(separator + 1)
      : arguments_[index + 1];
    if (separator === -1) index += 1;
    if (value === undefined || canonicalRegistryOrigin(value) !== registry) {
      return false;
    }
  }
  return true;
};

const hasPipRequirementFileOption = (
  arguments_: ReadonlyArray<string>,
): boolean => arguments_.some((argument) => {
  const name = argument.split("=", 1)[0]!.toLowerCase();
  return name === "-r"
    || name === "-c"
    || name === "--requirement"
    || name === "--constraint"
    || (argument.length > 2
      && (argument.startsWith("-r") || argument.startsWith("-c")));
});

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
    || lower === "ftp_proxy"
    || lower === "all_proxy"
    || lower === "no_proxy"
    || lower === "netrc"
    || lower === "requests_ca_bundle"
    || lower === "curl_ca_bundle"
    || lower === "ssl_cert_file"
    || lower === "ssl_cert_dir"
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
  if (manager === "pip") {
    return [{ name: "PIP_CONFIG_FILE", value: emptyConfiguration }];
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
  const registry = packageRegistryOrigin === undefined
    ? undefined
    : canonicalRegistryUrl(packageRegistryOrigin)?.url;
  return [
    ...environment.filter((entry) => !protectedPackageEnvironment(entry.name)),
    ...packageManagerConfigurationEnvironment(executable),
    ...(registry === undefined
      ? []
      : manager === "npm" || manager === "pnpm"
      ? [
        { name: "NPM_CONFIG_REGISTRY", value: registry },
        ...(manager === "pnpm"
          ? [{ name: "PNPM_CONFIG_REGISTRY", value: registry }]
          : []),
        ...packageRegistryScopes.map((scope) => ({
          name: `npm_config_${scope}:registry`,
          value: registry,
        })),
        ...(manager === "pnpm"
          ? packageRegistryScopes.map((scope) => ({
            name: `pnpm_config_${scope}:registry`,
            value: registry,
          }))
          : []),
      ]
      : manager === "bun"
      ? [{ name: "BUN_CONFIG_REGISTRY", value: registry }]
      : manager === "uv"
      ? [
        { name: "UV_DEFAULT_INDEX", value: registry },
        { name: "UV_INDEX_URL", value: registry },
        { name: "PIP_INDEX_URL", value: registry },
      ]
      : manager === "pip"
      ? [{ name: "PIP_INDEX_URL", value: registry }]
      : manager === "yarn"
      ? [{ name: "YARN_NPM_REGISTRY_SERVER", value: registry }]
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
    isRegistryPackageManager(packageManagerName(input.executable))
    && input.arguments.includes("--")
  ) {
    return Effect.fail(new AgentProcessError({
      executable: input.executable,
      message: "package-manager separator form is not authorized",
    }));
  }
  if (
    packageManagerName(input.executable) === "pip"
      && hasPipRequirementFileOption(input.arguments)
      && input.pipRequirementFiles === undefined
  ) {
    return Effect.fail(new AgentProcessError({
      executable: input.executable,
      message: "pip requirement files are not authorized by the resolution boundary",
    }));
  }
  if (
    packageManagerName(input.executable) === "pip"
      && hasPipRequirementFileOption(input.arguments)
      && input.pipRequirementFiles !== undefined
      && input.pipRequirementFiles.length === 0
  ) {
    return Effect.fail(new AgentProcessError({
      executable: input.executable,
      message: "pip requirement files are not authorized by the resolution boundary",
    }));
  }
  if (
    packageOperationRequiresRegistry(input.executable, input.arguments)
    && (
      input.packageRegistryOrigin === undefined
      || !packageRegistryInvocationIsSafe(
        input.executable,
        input.arguments,
        input.packageRegistryOrigin,
      )
    )
  ) {
    return Effect.fail(new AgentProcessError({
      executable: input.executable,
      message: "package-manager registry origin is not explicitly authorized",
    }));
  }

  return Effect.tryPromise({
    try: async (effectSignal) => {
      if (
        packageManagerName(input.executable) === "pip"
        && input.pipRequirementFiles !== undefined
        && !(await pipRequirementFilesUnchanged(input.pipRequirementFiles))
      ) {
        throw new AgentProcessError({
          executable: input.executable,
          message: "pip requirement or constraint input changed after authorization",
        });
      }
      return new Promise<CapturedProcess>((resolve, reject) => {
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
          outputBytes: capturedBytes,
          stdout: redactText(decoder.decode(Buffer.concat(output)), input.secrets),
          stderr: redactText(decoder.decode(Buffer.concat(errors)), input.secrets),
        });
      });
      if (input.standardInput === undefined) child.stdin.end();
      else child.stdin.end(input.standardInput);
      });
    },
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
