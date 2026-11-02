import { posix, win32 } from "node:path";

import { Schema } from "effect";

export const installerMethods = ["apt", "brew", "bun", "cargo", "npm", "pnpm", "uv", "winget"] as const;
export type InstallerMethod = typeof installerMethods[number];
export type InstallerPlatform = "linux" | "macos" | "windows";

export interface InstallerBinding {
  readonly schema: "canonfig.installer/v1";
  readonly method: InstallerMethod;
  readonly platform: InstallerPlatform;
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
}

/**
 * The persisted document shape. Parsing stops at field types; the local rules
 * that decide whether a document is a usable binding run afterwards, against
 * values that already carry a contract.
 */
const InstallerBindingDocument = Schema.Struct({
  schema: Schema.Literal("canonfig.installer/v1"),
  // `homebrew` is the profile spelling of `brew`, so a document may carry it.
  method: Schema.Literals([...installerMethods, "homebrew"]),
  platform: Schema.Literals(["linux", "macos", "windows"]),
  executable: Schema.String,
  arguments: Schema.Array(Schema.String),
});

type InstallerBindingDocument = Schema.Schema.Type<typeof InstallerBindingDocument>;

// An unexpected key means the document was written against a different
// contract, so reject it instead of silently dropping the key.
const parseDocument = Schema.decodeUnknownSync(InstallerBindingDocument, { onExcessProperty: "error" });

export const normalizeInstallerMethod = (method: string): InstallerMethod => {
  const requested = method === "homebrew" ? "brew" : method;
  const normalized = installerMethods.find((candidate) => candidate === requested);
  if (normalized === undefined) {
    throw new Error("Unsupported installer method");
  }
  return normalized;
};

/** C0 controls (U+0000 to U+001F) and DEL (U+007F). */
const containsControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

export const isLocalInstallerPath = (value: string, platform: InstallerPlatform): boolean =>
  value.length > 0 && value.length <= 4096 && !containsControlCharacter(value)
  && (platform === "windows"
    ? /^(?:[A-Za-z]:[\\/]|\\\\\?\\[A-Za-z]:\\)/u.test(value)
    : posix.isAbsolute(value) && !value.startsWith("//"));

/** The known Corepack pnpm JS entrypoint, not an arbitrary same-named script. */
export const isCorepackPnpmEntrypoint = (path: string, platform: InstallerPlatform): boolean => {
  const paths = platform === "windows" ? win32 : posix;
  const name = (value: string) => platform === "windows" ? paths.basename(value).toLowerCase() : paths.basename(value);
  return name(path) === "pnpm.js" && name(paths.dirname(path)) === "dist"
    && name(paths.dirname(paths.dirname(path))) === "corepack";
};

/** No environment, shell expressions, package arguments, or lifecycle flags. */
const bindingFromDocument = (document: InstallerBindingDocument): InstallerBinding => {
  const method = normalizeInstallerMethod(document.method);
  const platform = document.platform;
  const executable = document.executable;
  const arguments_ = [...document.arguments];
  if (!isLocalInstallerPath(executable, platform)
    || arguments_.some((argument) => !isLocalInstallerPath(argument, platform))) {
    throw new Error("Installer bindings require explicit local absolute paths");
  }
  const basename = (path: string): string => {
    const name = platform === "windows" ? win32.basename(path).toLowerCase() : posix.basename(path);
    return platform === "windows" ? name.replace(/\.exe$/u, "") : name;
  };
  const executableName = basename(executable);
  const nodeEntry = executableName === "node" && arguments_.length === 1
    && (method === "npm" && basename(arguments_[0]!) === "npm-cli.js"
      || method === "pnpm" && (basename(arguments_[0]!) === "pnpm.cjs"
        || isCorepackPnpmEntrypoint(arguments_[0]!, platform)));
  const nativeName = method === "apt" ? "apt-get" : method;
  const direct = arguments_.length === 0 && executableName === nativeName;
  if (!nodeEntry && !direct) {
    throw new Error("Bind a native installer, or Node with the installer's explicit JavaScript entrypoint; shells and command shims are not supported");
  }
  if ((method === "winget" && platform !== "windows") || (method === "apt" && platform !== "linux")) {
    throw new Error("Installer method is incompatible with this platform");
  }
  return { schema: "canonfig.installer/v1", method, platform, executable, arguments: arguments_ };
};

/** Parse one persisted binding. The JSON text is the untrusted I/O boundary. */
export const parseInstallerBinding = (document: string): InstallerBinding =>
  bindingFromDocument(parseDocument(JSON.parse(document)));

/** Build a binding from values this machine chose, under the same local rules. */
export const installerBindingFor = (
  method: string,
  platform: InstallerPlatform,
  executable: string,
  arguments_: ReadonlyArray<string>,
): InstallerBinding => bindingFromDocument(parseDocument({
  schema: "canonfig.installer/v1", method, platform, executable, arguments: arguments_,
}));
