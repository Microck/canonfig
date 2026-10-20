import { access, open, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join, posix, win32 } from "node:path";

export interface InstalledSchedulerCommand {
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
  readonly searchPath?: ReadonlyArray<string> | undefined;
}

const commandFrom = (words: ReadonlyArray<string>): InstalledSchedulerCommand | undefined =>
  words[0] === undefined || words[0].length === 0 ? undefined
    : { executable: words[0], arguments: words.slice(1) };

/** Decode the literal quoting emitted by our systemd renderer, never expand variables. */
export const installedSystemdCommand = (service: string): InstalledSchedulerCommand | undefined => {
  const lines = service.split(/\r?\n/u).filter((line) => line.startsWith("ExecStart="));
  if (lines.length !== 1) return undefined;
  const source = lines[0]!.slice("ExecStart=".length);
  const words: string[] = [];
  let index = 0;
  while (index < source.length) {
    while (/\s/u.test(source[index] ?? "")) index++;
    if (index === source.length) break;
    if (source[index++] !== '"') return undefined;
    let word = "", closed = false;
    while (index < source.length) {
      const character = source[index++]!;
      if (character === '"') { closed = true; break; }
      if (character === "\\") {
        const escaped = source[index++];
        if (escaped !== "\\" && escaped !== '"') return undefined;
        word += escaped;
      } else if (character === "%" || character === "$" && words.length > 0) {
        if (source[index++] !== character) return undefined;
        word += character;
      } else word += character;
    }
    if (!closed || index < source.length && !/\s/u.test(source[index]!)) return undefined;
    words.push(word);
  }
  const command = commandFrom(words);
  const path = /^Environment="PATH=([^"\r\n]*)"$/mu.exec(service)?.[1];
  if (command === undefined || path === undefined || path.includes("\\") || path.replaceAll("%%", "").includes("%")) return command;
  return { ...command, searchPath: path.replaceAll("%%", "%").split(":") };
};

const decodeXmlText = (text: string): string | undefined => {
  if (/&(?!(?:amp|lt|gt|quot|apos);)/u.test(text)) return undefined;
  return text.replaceAll("&quot;", '"').replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
};

export const installedLaunchdCommand = (plist: string): InstalledSchedulerCommand | undefined => {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(plist)?.[1];
  if (array === undefined) return undefined;
  const strings = [...array.matchAll(/<string>([^<]*)<\/string>/gu)];
  if (array.replace(/<string>[^<]*<\/string>/gu, "").trim() !== "") return undefined;
  const words = strings.map((match) => decodeXmlText(match[1]!));
  const command = words.some((word) => word === undefined) ? undefined : commandFrom(words.filter((word): word is string => word !== undefined));
  const environment = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/u.exec(plist)?.[1];
  const rawPath = environment === undefined ? undefined : /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/u.exec(environment)?.[1];
  const path = rawPath === undefined ? undefined : decodeXmlText(rawPath);
  return command === undefined || path === undefined ? command : { ...command, searchPath: path.split(":") };
};

/** Windows CRT quoting, inverse of windowsCommandLineArgument. */
export const installedWindowsCommand = (executable: string | undefined, arguments_: string | undefined): InstalledSchedulerCommand | undefined => {
  if (executable === undefined || arguments_ === undefined) return undefined;
  const words: string[] = [];
  let index = 0;
  while (index < arguments_.length) {
    while (/\s/u.test(arguments_[index] ?? "")) index++;
    if (index === arguments_.length) break;
    let word = "", quoted = false;
    while (index < arguments_.length && (quoted || !/\s/u.test(arguments_[index]!))) {
      let slashes = 0;
      while (arguments_[index] === "\\") { slashes++; index++; }
      if (arguments_[index] === '"') {
        word += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) word += '"'; else quoted = !quoted;
        index++;
      } else {
        word += "\\".repeat(slashes);
        if (index < arguments_.length && (quoted || !/\s/u.test(arguments_[index]!))) word += arguments_[index++]!;
      }
    }
    if (quoted) return undefined;
    words.push(word);
  }
  return commandFrom([executable, ...words]);
};

const absolute = (path: string) => posix.isAbsolute(path) || win32.isAbsolute(path);
const usableFile = async (path: string, mode: number): Promise<boolean> => {
  try { await access(path, mode); return (await stat(path)).isFile(); }
  catch { return false; }
};

const interpreterProblem = async (executable: string, searchPath: ReadonlyArray<string> | undefined,
  seen = new Set<string>()): Promise<string | undefined> => {
  if (seen.has(executable) || seen.size >= 8) return "the scheduler wrapper interpreter chain cannot be verified";
  seen.add(executable);
  if (!await usableFile(executable, constants.X_OK)) return "the scheduler wrapper interpreter is missing or not executable";
  let header: string;
  try {
    const file = await open(executable, "r");
    try {
      const buffer = Buffer.alloc(1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      header = buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await file.close(); }
  } catch { return "the scheduler wrapper interpreter cannot be inspected"; }
  if (!header.startsWith("#!")) return undefined;
  const newline = header.indexOf("\n");
  if (newline < 0 || header.slice(0, newline).includes("\r")) return "the scheduler wrapper interpreter cannot be verified";
  const words = header.slice(2, newline).trim().split(/\s+/u);
  const interpreter = words[0];
  if (interpreter === undefined || !absolute(interpreter)) return "the scheduler wrapper interpreter cannot be verified";
  if (basename(interpreter) !== "env") return interpreterProblem(interpreter, searchPath, seen);
  if (!await usableFile(interpreter, constants.X_OK)) return "the scheduler wrapper env interpreter is missing or not executable";
  const split = words[1] === "-S";
  const name = words[split ? 2 : 1];
  // env without -S receives one kernel argument, not shell-split flags.
  // Accept simple -S syntax, but never guess complex quoting or assignments.
  if ((!split && words.length !== 2) || split && /['"\\]/u.test(words.slice(2).join(" "))
    || name === undefined || name.startsWith("-") || name.includes("=")) return "the scheduler wrapper env interpreter cannot be verified";
  if (absolute(name)) return interpreterProblem(name, searchPath, seen);
  if (name.includes("/") || searchPath === undefined) return "the scheduler wrapper PATH interpreter cannot be verified";
  for (const directory of searchPath) {
    if (!absolute(directory)) return "the scheduler wrapper PATH interpreter cannot be verified";
    const candidate = join(directory, name);
    if (await usableFile(candidate, constants.X_OK)) return interpreterProblem(candidate, searchPath, seen);
  }
  return "the scheduler wrapper PATH interpreter is missing or not executable";
};

/** File readiness only. Does not execute either the installed runtime or the CLI. */
export const installedBindingProblem = async (command: InstalledSchedulerCommand | undefined): Promise<string | undefined> => {
  if (command === undefined || !absolute(command.executable)) return "the installed scheduler command cannot be verified";
  if (!await usableFile(command.executable, constants.X_OK)) return "the installed scheduler runtime is missing or not executable";
  const interpreter = await interpreterProblem(command.executable, command.searchPath);
  if (interpreter !== undefined) return interpreter;
  const entrypoint = command.arguments[0];
  if (entrypoint !== undefined && absolute(entrypoint)) {
    if (!await usableFile(entrypoint, constants.R_OK)) return "the installed Canonfig entrypoint is missing or unreadable";
  } else if (/^node(?:\.exe)?$/iu.test(basename(command.executable))) {
    return "the installed Node entrypoint cannot be verified";
  }
  return undefined;
};
