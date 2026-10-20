import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, posix, win32 } from "node:path";

export interface InstalledSchedulerCommand {
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
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
  return commandFrom(words);
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
  return words.some((word) => word === undefined) ? undefined : commandFrom(words.filter((word): word is string => word !== undefined));
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

/** File readiness only. Does not execute either the installed runtime or the CLI. */
export const installedBindingProblem = async (command: InstalledSchedulerCommand | undefined): Promise<string | undefined> => {
  if (command === undefined || !absolute(command.executable)) return "the installed scheduler command cannot be verified";
  if (!await usableFile(command.executable, constants.X_OK)) return "the installed scheduler runtime is missing or not executable";
  const entrypoint = command.arguments[0];
  if (entrypoint !== undefined && absolute(entrypoint)) {
    if (!await usableFile(entrypoint, constants.R_OK)) return "the installed Canonfig entrypoint is missing or unreadable";
  } else if (/^node(?:\.exe)?$/iu.test(basename(command.executable))) {
    return "the installed Node entrypoint cannot be verified";
  }
  return undefined;
};
