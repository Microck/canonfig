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

/** Conservative header check, not proof of launchability or scheduler firing. */
const nativeExecutableHeader = (header: Buffer, size: number): boolean => {
  if (process.platform === "linux") {
    if (header.length < 64 || header.subarray(0, 4).toString("hex") !== "7f454c46"
      || header[4] !== 2 || header[5] !== 1 || header[6] !== 1) return false;
    const kind = header.readUInt16LE(16);
    const tableOffset = header.readBigUInt64LE(32);
    const entrySize = header.readUInt16LE(54), count = header.readUInt16LE(56);
    return (kind === 2 || kind === 3) && header.readUInt16LE(52) === 64
      && entrySize === 56 && count > 0 && tableOffset >= 64n
      && tableOffset + BigInt(entrySize * count) <= BigInt(size);
  }
  if (process.platform === "darwin") {
    if (header.length < 32) return false;
    const magic = header.readUInt32LE(0);
    if (magic === 0xfeedfacf) return header.readUInt32LE(12) === 2
      && header.readUInt32LE(16) > 0 && header.readUInt32LE(20) >= 8
      && 32 + header.readUInt32LE(20) <= size;
    // Universal binaries contain a bounded architecture table and file slices.
    const fat = header.readUInt32BE(0);
    if (fat !== 0xcafebabe && fat !== 0xcafebabf) return false;
    const count = header.readUInt32BE(4), stride = fat === 0xcafebabe ? 20 : 32;
    if (count === 0 || count > 32 || 8 + count * stride > header.length) return false;
    for (let i = 0; i < count; i++) {
      const at = 8 + i * stride;
      const offset = stride === 20 ? BigInt(header.readUInt32BE(at + 8)) : header.readBigUInt64BE(at + 8);
      const length = stride === 20 ? BigInt(header.readUInt32BE(at + 12)) : header.readBigUInt64BE(at + 16);
      if (length < 32n || offset < BigInt(8 + count * stride) || offset + length > BigInt(size)) return false;
    }
    return true;
  }
  if (process.platform === "win32") {
    if (header.length < 64 || header[0] !== 0x4d || header[1] !== 0x5a) return false;
    const offset = header.readUInt32LE(60);
    return offset >= 64 && offset + 26 <= header.length
      && header.readUInt32LE(offset) === 0x00004550
      && header.readUInt16LE(offset + 6) > 0
      && (header.readUInt16LE(offset + 22) & 0x0002) !== 0
      && (header.readUInt16LE(offset + 22) & 0x2000) === 0
      && [0x10b, 0x20b].includes(header.readUInt16LE(offset + 24))
      && offset + 24 + header.readUInt16LE(offset + 20) <= size;
  }
  return false;
};

const interpreterProblem = async (executable: string, searchPath: ReadonlyArray<string> | undefined,
  seen = new Set<string>()): Promise<{ message: string; retryPath?: boolean } | undefined> => {
  if (seen.has(executable) || seen.size >= 8) return { message: "the scheduler wrapper interpreter chain cannot be verified" };
  seen.add(executable);
  if (!await usableFile(executable, constants.X_OK)) return { message: "the scheduler wrapper interpreter is missing or not executable", retryPath: true };
  let header: string;
  let bytes: Buffer;
  let fileSize: number;
  try {
    const file = await open(executable, "r");
    try {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      bytes = buffer.subarray(0, bytesRead);
      header = bytes.toString("utf8");
      fileSize = (await file.stat()).size;
    } finally { await file.close(); }
  } catch { return { message: "the scheduler wrapper interpreter cannot be inspected" }; }
  if (!header.startsWith("#!")) return nativeExecutableHeader(bytes, fileSize) ? undefined
    : { message: "the scheduler executable format cannot be verified" };
  const newline = header.indexOf("\n");
  if (newline < 0 || header.slice(0, newline).includes("\r")) return { message: "the scheduler wrapper interpreter cannot be verified" };
  const words = header.slice(2, newline).trim().split(/\s+/u);
  const interpreter = words[0];
  if (interpreter === undefined || !absolute(interpreter)) return { message: "the scheduler wrapper interpreter cannot be verified" };
  if (basename(interpreter) !== "env") return interpreterProblem(interpreter, searchPath, seen);
  if (!await usableFile(interpreter, constants.X_OK)) return { message: "the scheduler wrapper env interpreter is missing or not executable", retryPath: true };
  const split = words[1] === "-S";
  const name = words[split ? 2 : 1];
  // env without -S receives one kernel argument, not shell-split flags.
  // Accept simple -S syntax, but never guess complex quoting or assignments.
  if ((!split && words.length !== 2) || split && /['"\\]/u.test(words.slice(2).join(" "))
    || name === undefined || name.startsWith("-") || name.includes("=")) return { message: "the scheduler wrapper env interpreter cannot be verified" };
  // Once env itself starts, a failure of its child is an exit status, not
  // an exec failure that the outer PATH search may skip.
  const childProblem = async (candidate: string) => {
    const problem = await interpreterProblem(candidate, searchPath, new Set(seen));
    return problem === undefined ? undefined : { message: problem.message };
  };
  if (absolute(name)) return childProblem(name);
  if (name.includes("/") || searchPath === undefined) return { message: "the scheduler wrapper PATH interpreter cannot be verified" };
  for (const directory of searchPath) {
    if (!absolute(directory)) return { message: "the scheduler wrapper PATH interpreter cannot be verified" };
    const candidate = join(directory, name);
    if (await usableFile(candidate, constants.X_OK)) {
      const problem = await interpreterProblem(candidate, searchPath, new Set(seen));
      if (problem?.retryPath) continue;
      return problem === undefined ? undefined : { message: problem.message };
    }
  }
  return { message: "the scheduler wrapper PATH interpreter is missing or not executable" };
};

/** File readiness only. Does not execute either the installed runtime or the CLI. */
export const installedBindingProblem = async (command: InstalledSchedulerCommand | undefined): Promise<string | undefined> => {
  if (command === undefined || !absolute(command.executable)) return "the installed scheduler command cannot be verified";
  if (!await usableFile(command.executable, constants.X_OK)) return "the installed scheduler runtime is missing or not executable";
  const interpreter = await interpreterProblem(command.executable, command.searchPath);
  if (interpreter !== undefined) return interpreter.message;
  const entrypoint = command.arguments[0];
  if (entrypoint !== undefined && absolute(entrypoint)) {
    if (!await usableFile(entrypoint, constants.R_OK)) return "the installed Canonfig entrypoint is missing or unreadable";
  } else if (/^node(?:\.exe)?$/iu.test(basename(command.executable))) {
    return "the installed Node entrypoint cannot be verified";
  }
  return undefined;
};
