import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { evaluateCli } from "../../src/cli/cli.ts";
import { parseHarnessArguments } from "../../src/harness-configuration/cli-arguments.ts";

const projectRoot = resolve(import.meta.dirname, "../..");
export const defaultDocumentationRoots: ReadonlyArray<string> = [
  resolve(projectRoot, "README.md"),
  resolve(projectRoot, "docs"),
  resolve(projectRoot, "skills"),
  resolve(projectRoot, "website/content/docs"),
];

const invitation = Buffer.from(JSON.stringify({
  code: "docs-invitation",
  nonce: "docs-nonce",
  endpoint: "https://127.0.0.1:17342",
  sourceFingerprint: "docs-source-fingerprint",
  tlsFingerprint: "docs-tls-fingerprint",
  groups: ["developers"],
  expiresAt: "2030-01-01T00:00:00.000Z",
})).toString("base64url");

const markdownFiles = async (path: string): Promise<ReadonlyArray<string>> => {
  const pathStatus = await stat(path);
  if (pathStatus.isFile()) return /\.(?:md|mdx)$/u.test(path) ? [path] : [];
  const entries = await readdir(path, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const childPath = join(path, entry.name);
    if (entry.isDirectory()) return markdownFiles(childPath);
    return entry.isFile() && /\.(?:md|mdx)$/u.test(entry.name)
      ? [childPath]
      : [];
  }));
  return paths.flat().sort();
};

export const commandLines = (text: string): ReadonlyArray<string> => {
  const commands: Array<string> = [];
  for (const block of text.matchAll(/```[^\n]*\n(?<body>[\s\S]*?)```/gu)) {
    const body = block.groups?.body ?? "";
    for (const line of body.split(/\r?\n/u)) {
      const candidate = line.trim();
      const start = candidate.search(/\bcanonfig(?:\s|$)/u);
      if (start >= 0) commands.push(candidate.slice(start));
    }
  }
  return commands;
};

const tokenize = (command: string): ReadonlyArray<string> => {
  const tokens: Array<string> = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const emit = (): void => {
    if (current.length > 0) tokens.push(current);
    current = "";
  };
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      emit();
      continue;
    }
    current += character;
  }
  if (quote !== undefined || escaped) throw new Error(`unterminated command: ${command}`);
  emit();
  return tokens;
};

const validSecretsCommand = (arguments_: ReadonlyArray<string>): boolean => {
  const positionals = arguments_.filter((argument) => argument !== "--json");
  const [area, action, ...rest] = positionals;
  if (area !== "secrets") return false;
  if (
    action === undefined
    || action === "help"
    || action === "--help"
    || action === "-h"
  ) return rest.length === 0;
  if (action === "list" || action === "sync") return rest.length === 0;
  if (action === "set" || action === "remove") return rest.length === 1;
  return false;
};

const validHarnessCommand = (arguments_: ReadonlyArray<string>): boolean => {
  try {
    parseHarnessArguments(arguments_.slice(1));
    return true;
  } catch {
    return false;
  }
};

export interface DocumentationValidationResult {
  readonly checked: number;
  readonly files: ReadonlyArray<string>;
}

export const validateDocumentation = async (
  roots: ReadonlyArray<string> = defaultDocumentationRoots,
): Promise<DocumentationValidationResult> => {
  const files = (await Promise.all(roots.map(markdownFiles))).flat().sort();
  let checked = 0;
  for (const path of files) {
    const text = await readFile(path, "utf8");
    const legacyProductName = ["cod", "export"].join("");
    for (const forbidden of [legacyProductName, "--insecure", "--no-verify", "--trust-reset"]) {
      if (text.toLowerCase().includes(forbidden)) {
        throw new Error(`${path} contains forbidden compatibility or insecure text: ${forbidden}`);
      }
    }
    for (const example of commandLines(text)) {
      const [program, ...arguments_] = tokenize(example).map((value) =>
        value === "$INVITE" ? invitation : value
      );
      if (program !== "canonfig") throw new Error(`${path} uses an unexpected executable`);
      if (arguments_[0] === "secrets") {
        if (!validSecretsCommand(arguments_)) {
          throw new Error(`${path} contains an invalid CLI example: ${example}`);
        }
      } else if (arguments_[0] === "harness") {
        if (!validHarnessCommand(arguments_)) {
          throw new Error(`${path} contains an invalid CLI example: ${example}`);
        }
      } else {
        const outcome = evaluateCli(arguments_);
        if (outcome._tag === "InvalidInput") {
          throw new Error(`${path} contains an invalid CLI example: ${example}\n${outcome.message}`);
        }
      }
      checked += 1;
    }
  }

  if (checked === 0) throw new Error("no Canonfig command examples were found");
  return { checked, files };
};

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined
  && import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  const result = await validateDocumentation();
  process.stdout.write(
    `Validated ${result.checked} Canonfig command examples across ${result.files.length} documentation files.\n`,
  );
}
