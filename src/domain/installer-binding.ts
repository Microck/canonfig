import { posix, win32 } from "node:path";

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

export const normalizeInstallerMethod = (method: string): InstallerMethod => {
  const normalized = method === "homebrew" ? "brew" : method;
  if (!installerMethods.some((candidate) => candidate === normalized)) {
    throw new Error("Unsupported installer method");
  }
  return normalized as InstallerMethod;
};

export const isLocalInstallerPath = (value: string, platform: InstallerPlatform): boolean =>
  value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value)
  && (platform === "windows"
    ? /^(?:[A-Za-z]:[\\/]|\\\\\?\\[A-Za-z]:\\)/u.test(value)
    : posix.isAbsolute(value) && !value.startsWith("//"));

/** No environment, shell expressions, package arguments, or lifecycle flags. */
export const decodeInstallerBinding = (value: unknown): InstallerBinding => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Installer binding must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["schema", "method", "platform", "executable", "arguments"].includes(key))
    || record.schema !== "canonfig.installer/v1"
    || typeof record.method !== "string"
    || !["linux", "macos", "windows"].includes(String(record.platform))
    || typeof record.executable !== "string"
    || !Array.isArray(record.arguments)
    || record.arguments.some((argument) => typeof argument !== "string")) {
    throw new Error("Invalid installer binding fields");
  }
  const method = normalizeInstallerMethod(record.method);
  const platform = record.platform as InstallerPlatform;
  const executable = record.executable;
  const arguments_ = record.arguments as string[];
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
  return { schema: "canonfig.installer/v1", method, platform, executable, arguments: [...arguments_] };
};
