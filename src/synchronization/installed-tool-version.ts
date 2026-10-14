import { join } from "node:path";

import { Effect, Option, Schema } from "effect";

import { MachineState } from "../machine/machine-state.service.ts";
import type { MachinePath, ProcessEnvironmentEntry } from "../machine/machine-state.types.ts";
import { resolveInstallerInvocation } from "./installer-bindings.ts";

/**
 * Asking an installer what it has installed. Presence of the executable says
 * nothing about the version: a tool installed at 6.0.1 used to satisfy a
 * profile that had since pinned 5.13.2, so the plan was a no-op and the old
 * version stayed. Every query here only reads installer state; none resolves,
 * downloads, or changes a package.
 */
export interface InstalledVersionQuery {
  readonly method: string;
  readonly package: string;
  readonly timeoutMilliseconds: number;
  readonly maximumOutputBytes: number;
}

const decoder = new TextDecoder();

/** PEP 503 name normalization; uv lists normalized distribution names. */
const pythonPackageName = (name: string): string => name.toLowerCase().replace(/[-_.]+/gu, "-");

/** Whether an installer's reported version is the version a recipe pins. */
export const installedVersionMatches = (method: string, installed: string, pinned: string): boolean =>
  method === "uv" || method === "winget"
    ? installed.toLowerCase() === pinned.toLowerCase()
    : installed === pinned;

/** `uv tool list`: one `<name> v<version>` line per tool, then its entrypoints. */
export const parseUvToolList = (output: string, packageName: string): string | undefined => {
  const wanted = pythonPackageName(packageName);
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(\S+) v(\S+)/u.exec(line);
    if (match !== null && pythonPackageName(match[1]!) === wanted) return match[2];
  }
  return undefined;
};

const NodeGlobalRoot = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.Struct({ version: Schema.optional(Schema.String) }))),
});
const NodeGlobalList = Schema.fromJsonString(Schema.Union([NodeGlobalRoot, Schema.Array(NodeGlobalRoot)]));

/** `npm ls --global --json` (an object) or `pnpm ls --global --json` (an array of them). */
export const parseNodeGlobalList = (output: string, packageName: string): string | undefined => {
  const parsed = Schema.decodeUnknownOption(NodeGlobalList)(output);
  if (Option.isNone(parsed)) return undefined;
  const root = Array.isArray(parsed.value) ? parsed.value[0] : parsed.value;
  const dependencies = root?.dependencies;
  if (dependencies === undefined || !Object.hasOwn(dependencies, packageName)) return undefined;
  const version = dependencies[packageName]?.version;
  return version === undefined || version.length === 0 ? undefined : version;
};

/** `bun pm ls --global`: a tree of `<name>@<version>` lines. */
export const parseBunGlobalList = (output: string, packageName: string): string | undefined => {
  for (const line of output.split(/\r?\n/u)) {
    const entry = line.trim().split(/\s+/u).at(-1) ?? "";
    const separator = entry.lastIndexOf("@");
    if (separator > 0 && entry.slice(0, separator) === packageName) {
      return entry.slice(separator + 1) || undefined;
    }
  }
  return undefined;
};

const CargoInstalls = Schema.fromJsonString(Schema.Struct({
  installs: Schema.Record(Schema.String, Schema.Unknown),
}));

/** Cargo's install metadata: `installs` keys are `<name> <version> (<source>)`. */
export const parseCargoInstalls = (text: string, packageName: string): string | undefined => {
  const parsed = Schema.decodeUnknownOption(CargoInstalls)(text);
  if (Option.isNone(parsed)) return undefined;
  for (const key of Object.keys(parsed.value.installs)) {
    const [name, version] = key.split(" ");
    if (name === packageName && version !== undefined && version.length > 0) return version;
  }
  return undefined;
};

/**
 * `winget list --id <id> --exact`: a table whose row holds the package ID
 * followed by its installed version. A version winget cannot determine is
 * shown as `Unknown` or with a `<`/`>` prefix and is not reported.
 */
export const parseWingetList = (output: string, packageId: string): string | undefined => {
  const wanted = packageId.toLowerCase();
  for (const rawLine of output.split("\n")) {
    // Progress spinners are overwritten in place with carriage returns.
    const line = rawLine.split("\r").at(-1) ?? "";
    const tokens = line.trim().split(/\s+/u);
    const index = tokens.findIndex((token) => token.toLowerCase() === wanted);
    const version = index < 0 ? undefined : tokens[index + 1];
    if (version !== undefined && /^[0-9A-Za-z][0-9A-Za-z.+_~-]*$/u.test(version) && version !== "Unknown") {
      return version;
    }
  }
  return undefined;
};

/** `dpkg-query -W -f='${db:Status-Abbrev}|${Version}'`: only an installed (`ii`) package counts. */
export const parseDpkgQuery = (output: string): string | undefined => {
  const [status, version] = output.trim().split("|");
  return status?.startsWith("ii") === true && version !== undefined && version.length > 0
    ? version
    : undefined;
};

const corepackEnvironment: ReadonlyArray<ProcessEnvironmentEntry> = [
  { name: "COREPACK_ENABLE_NETWORK", value: "0" },
  { name: "COREPACK_ENABLE_AUTO_PIN", value: "0" },
  { name: "COREPACK_ENABLE_DOWNLOAD_PROMPT", value: "0" },
];

const run = (
  query: InstalledVersionQuery,
  executable: MachinePath,
  arguments_: ReadonlyArray<string>,
  options: {
    readonly environment?: ReadonlyArray<ProcessEnvironmentEntry>;
    readonly environmentUnsetPrefixes?: ReadonlyArray<string>;
    readonly acceptExitCodes?: ReadonlyArray<number>;
  } = {},
) => Effect.gen(function*() {
  const machine = yield* MachineState;
  const result = yield* machine.runProcess({
    executable,
    arguments: arguments_,
    environment: options.environment,
    environmentUnsetPrefixes: options.environmentUnsetPrefixes,
    timeoutMilliseconds: query.timeoutMilliseconds,
    maximumOutputBytes: query.maximumOutputBytes,
  });
  return result.exitCode === 0 || (options.acceptExitCodes ?? []).includes(result.exitCode ?? -1)
    ? decoder.decode(result.standardOutput)
    : undefined;
});

/**
 * The version of `package` that the recipe's installer reports as installed,
 * or undefined when it does not list the package or cannot say. Undefined is
 * not evidence of absence: the executable may come from somewhere else, and
 * `ensure` leaves such an installation alone.
 *
 * Homebrew is not queried: a versioned recipe installs the `<formula>@<version>`
 * formula, whose name already carries the version.
 */
export const installedToolVersion = (
  query: InstalledVersionQuery,
): Effect.Effect<string | undefined, never, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    switch (query.method) {
      case "uv": {
        const installer = yield* resolveInstallerInvocation("uv");
        // The same UV_/PIP_-free environment the install uses, so uv reads
        // the same tool directory it installs into.
        const output = yield* run(query, installer.executable, [
          ...installer.arguments,
          "tool", "list", "--no-config", "--offline", "--no-cache", "--no-python-downloads", "--color", "never",
        ], {
          environment: [{ name: "UV_PYTHON_DOWNLOADS", value: "never" }],
          environmentUnsetPrefixes: ["UV_", "PIP_"],
        });
        return output === undefined ? undefined : parseUvToolList(output, query.package);
      }
      case "npm": {
        const installer = yield* resolveInstallerInvocation("npm");
        const directories = yield* machine.userDirectories();
        const configDirectory = join(directories.cache.absolute, "canonfig", "npm-config");
        // npm exits 1 when the named package is not installed globally.
        const output = yield* run(query, installer.executable, [
          ...installer.arguments, "ls", "--global", "--depth=0", "--json", query.package,
        ], {
          environment: [
            // The install's own config paths; a missing file reads as empty.
            { name: "NPM_CONFIG_USERCONFIG", value: join(configDirectory, "user.npmrc") },
            { name: "NPM_CONFIG_GLOBALCONFIG", value: join(configDirectory, "global.npmrc") },
            { name: "NPM_CONFIG_LOCATION", value: "global" },
            { name: "NPM_CONFIG_OFFLINE", value: "true" },
            { name: "NPM_CONFIG_UPDATE_NOTIFIER", value: "false" },
            { name: "NPM_CONFIG_LOGS_MAX", value: "0" },
          ],
          environmentUnsetPrefixes: ["NPM_CONFIG_", "PNPM_CONFIG_", "BUN_CONFIG_"],
          acceptExitCodes: [1],
        });
        return output === undefined ? undefined : parseNodeGlobalList(output, query.package);
      }
      case "pnpm": {
        const installer = yield* resolveInstallerInvocation("pnpm");
        const output = yield* run(query, installer.executable, [
          ...installer.arguments, "ls", "--global", "--depth=0", "--json",
        ], {
          environment: [...corepackEnvironment, { name: "PNPM_CONFIG_OFFLINE", value: "true" }],
          environmentUnsetPrefixes: ["NPM_CONFIG_", "PNPM_CONFIG_", "BUN_CONFIG_"],
        });
        return output === undefined ? undefined : parseNodeGlobalList(output, query.package);
      }
      case "bun": {
        const installer = yield* resolveInstallerInvocation("bun");
        const output = yield* run(query, installer.executable, [
          ...installer.arguments, "pm", "ls", "--global",
        ], {
          environment: [{ name: "BUN_CONFIG_FILE", value: process.platform === "win32" ? "NUL" : "/dev/null" }],
          environmentUnsetPrefixes: ["NPM_CONFIG_", "PNPM_CONFIG_", "BUN_CONFIG_"],
        });
        return output === undefined ? undefined : parseBunGlobalList(output, query.package);
      }
      case "cargo": {
        // Read Cargo's metadata file rather than run `cargo`, which may be a
        // rustup proxy that writes rustup settings on first use.
        const home = (yield* machine.userDirectories()).home.absolute;
        const root = process.env["CARGO_INSTALL_ROOT"] || process.env["CARGO_HOME"] || join(home, ".cargo");
        const path = yield* machine.normalizePath({ path: join(root, ".crates2.json") });
        const bytes = yield* machine.readFile({ path, maximumBytes: 8 * 1024 * 1024 });
        return parseCargoInstalls(decoder.decode(bytes), query.package);
      }
      case "winget": {
        const installer = yield* resolveInstallerInvocation("winget");
        const output = yield* run(query, installer.executable, [
          ...installer.arguments, "list", "--id", query.package, "--exact", "--disable-interactivity",
        ]);
        return output === undefined ? undefined : parseWingetList(output, query.package);
      }
      case "apt": {
        const dpkgQuery = yield* machine.findExecutable({ name: "dpkg-query" });
        const output = yield* run(query, dpkgQuery.path, [
          "-W", "-f=${db:Status-Abbrev}|${Version}", query.package,
        ]);
        return output === undefined ? undefined : parseDpkgQuery(output);
      }
      default:
        return undefined;
    }
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
