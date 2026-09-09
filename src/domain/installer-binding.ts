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

export const isLocalInstallerPath = (value: string, platform: InstallerPlatform): boolean =>
  value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value)
  && (platform === "windows"
    ? /^(?:[A-Za-z]:[\\/]|\\\\\?\\[A-Za-z]:\\)/u.test(value)
    : posix.isAbsolute(value) && !value.startsWith("//"));

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
  const javascriptEntry = method === "npm" ? "npm-cli.js" : method === "pnpm" ? "pnpm.cjs" : undefined;
  const nodeEntry = executableName === "node" && javascriptEntry !== undefined
    && arguments_.length === 1 && basename(arguments_[0]!) === javascriptEntry;
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
