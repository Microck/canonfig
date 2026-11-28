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

/**
 * Order two digit strings without converting them, so a component wider than
 * a safe integer still compares correctly.
 */
const compareDigits = (left: string, right: string): number => {
  const a = left.replace(/^0+(?=\d)/u, "");
  const b = right.replace(/^0+(?=\d)/u, "");
  return a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;
};

const semver = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

/**
 * SemVer 2.0 precedence: numeric core, then a release above any of its
 * pre-releases, then pre-release identifiers left to right (numeric below
 * alphanumeric, a shorter list below a longer one). Build metadata is ignored.
 */
const compareSemver = (left: string, right: string): number | undefined => {
  const a = semver.exec(left);
  const b = semver.exec(right);
  if (a === null || b === null) return undefined;
  for (const index of [1, 2, 3]) {
    const order = compareDigits(a[index]!, b[index]!);
    if (order !== 0) return order;
  }
  if (a[4] === undefined || b[4] === undefined) return (a[4] === undefined ? 1 : 0) - (b[4] === undefined ? 1 : 0);
  const leftIds = a[4].split(".");
  const rightIds = b[4].split(".");
  for (let index = 0; index < Math.min(leftIds.length, rightIds.length); index += 1) {
    const x = leftIds[index]!;
    const y = rightIds[index]!;
    const xNumeric = /^\d+$/u.test(x);
    const yNumeric = /^\d+$/u.test(y);
    const order = xNumeric && yNumeric ? compareDigits(x, y)
      : xNumeric !== yNumeric ? (xNumeric ? -1 : 1)
      : x < y ? -1 : x > y ? 1 : 0;
    if (order !== 0) return order;
  }
  return leftIds.length - rightIds.length;
};

/** dpkg's character order: `~` before everything, then the end, then letters, then other symbols. */
const debianCharacterOrder = (character: string | undefined): number =>
  character === undefined || /\d/u.test(character) ? 0
  : /[A-Za-z]/u.test(character) ? character.charCodeAt(0)
  : character === "~" ? -1
  : character.charCodeAt(0) + 256;

/** dpkg's `verrevcmp`: alternate non-digit runs (by the order above) and digit runs (numerically). */
const compareDebianPart = (left: string, right: string): number => {
  let i = 0;
  let j = 0;
  const digit = (value: string, index: number) => index < value.length && /\d/u.test(value[index]!);
  while (i < left.length || j < right.length) {
    while ((i < left.length && !digit(left, i)) || (j < right.length && !digit(right, j))) {
      const order = debianCharacterOrder(left[i]) - debianCharacterOrder(right[j]);
      if (order !== 0) return order;
      i += 1;
      j += 1;
    }
    let leftEnd = i;
    while (digit(left, leftEnd)) leftEnd += 1;
    let rightEnd = j;
    while (digit(right, rightEnd)) rightEnd += 1;
    const order = compareDigits(left.slice(i, leftEnd) || "0", right.slice(j, rightEnd) || "0");
    if (order !== 0) return order;
    i = leftEnd;
    j = rightEnd;
  }
  return 0;
};

const debianVersion = /^(?:(\d+):)?([0-9][0-9A-Za-z.+~:-]*?)(?:-([0-9A-Za-z.+~]+))?$/u;

/** Debian policy order: epoch, then upstream version, then Debian revision. */
const compareDebian = (left: string, right: string): number | undefined => {
  const a = debianVersion.exec(left);
  const b = debianVersion.exec(right);
  if (a === null || b === null) return undefined;
  return compareDigits(a[1] ?? "0", b[1] ?? "0")
    || compareDebianPart(a[2]!, b[2]!)
    || compareDebianPart(a[3] ?? "", b[3] ?? "");
};

/**
 * Dot-separated numbers, as uv and winget report most releases. A missing
 * component is zero, so `1.2` equals `1.2.0`.
 */
const compareNumericDotted = (left: string, right: string): number | undefined => {
  const pattern = /^\d+(?:\.\d+)*$/u;
  if (!pattern.test(left) || !pattern.test(right)) return undefined;
  const a = left.split(".");
  const b = right.split(".");
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const order = compareDigits(a[index] ?? "0", b[index] ?? "0");
    if (order !== 0) return order;
  }
  return 0;
};

const homebrewVersion = /^(\d+(?:\.\d+)*)(?:_(\d+))?$/u;

/**
 * Homebrew versions carry an optional `_<revision>` formula revision after the
 * upstream dotted version (for example `1.2_3`). Compare the upstream dotted
 * version first and use the revision only to break ties so `1.2_3` stays below
 * `1.2.1`.
 */
const compareHomebrew = (left: string, right: string): number | undefined => {
  const a = homebrewVersion.exec(left);
  const b = homebrewVersion.exec(right);
  if (a === null || b === null) return undefined;
  const upstream = compareNumericDotted(a[1]!, b[1]!);
  if (upstream === undefined || upstream !== 0) return upstream;
  return compareDigits(a[2] ?? "0", b[2] ?? "0");
};

/**
 * Order an installed version against a recipe's pin with the installer's own
 * version rules: negative when older, zero when equivalent, positive when
 * newer. Undefined when either version is outside the grammar Canonfig can
 * order for that installer (for example a PEP 440 pre-release such as
 * `6.0.0rc1`); the planner then treats the tool as not satisfying the pin
 * and installs it, as an exact pin would.
 */
export const compareInstalledVersion = (method: string, installed: string, pinned: string): number | undefined => {
  switch (method) {
    case "npm":
    case "pnpm":
    case "bun":
    case "cargo":
      return compareSemver(installed, pinned);
    case "apt":
      return compareDebian(installed, pinned);
    case "uv":
    case "winget":
      return compareNumericDotted(installed, pinned);
    case "brew":
    case "homebrew":
      return compareHomebrew(installed, pinned);
    default:
      return undefined;
  }
};

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

const BrewInstalledInfo = Schema.fromJsonString(Schema.Struct({
  formulae: Schema.Array(Schema.Struct({
    installed: Schema.Array(Schema.Struct({ version: Schema.NonEmptyString })),
    linked_keg: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  })),
}));

/** A linked Homebrew keg wins over older installed kegs; ambiguous unlinked versions stay unknown. */
export const parseBrewInstalledInfo = (output: string): string | undefined => {
  const decoded = Schema.decodeUnknownOption(BrewInstalledInfo)(output);
  if (Option.isNone(decoded) || decoded.value.formulae.length !== 1) return undefined;
  const formula = decoded.value.formulae[0];
  if (formula === undefined) return undefined;
  if (formula.linked_keg) {
    return formula.installed.find((keg) => keg.version === formula.linked_keg)?.version;
  }
  return formula.installed.length === 1 ? formula.installed[0]?.version : undefined;
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
 * Homebrew reports installed keg versions separately from its available
 * formula version. Never use the latter as evidence of installation.
 */
export const installedToolVersion = (
  query: InstalledVersionQuery,
): Effect.Effect<string | undefined, never, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    switch (query.method) {
      case "brew":
      case "homebrew": {
        const installer = yield* resolveInstallerInvocation(query.method);
        const output = yield* run(query, installer.executable, [
          ...installer.arguments, "info", "--json=v2", "--formula", "--", query.package,
        ], {
          environment: [{ name: "HOMEBREW_NO_AUTO_UPDATE", value: "1" }],
        });
        return output === undefined ? undefined : parseBrewInstalledInfo(output);
      }
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
