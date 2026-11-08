import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, posix } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RootContext } from "../src/projection/harness.ts";
import {
  existingFolderItems,
  type ImportContent,
  ImportChangedError,
  type ImportScan,
  readImportContent,
  scanImports,
  selectImports,
} from "../src/projection/import.ts";

// Assembled at runtime so release:validate's token scanner never sees a literal.
const GITHUB_TOKEN = ["gh", "p_", "a1B2".repeat(9)].join("");
const DOCS_TOKEN = "docs-literal-credential-0123456789";
const LEAKY_KEY = "sk-literal-0123456789abcdef";
const OAUTH_TOKEN = "oauth-literal-credential-9876";
const CREDENTIALS_TOKEN = "credentials-file-token-5555";
const CODEX_AUTH_TOKEN = "codex-auth-token-4444";
const PROVIDER_KEY = "sk-provider-literal-3333";
const LITERALS = [GITHUB_TOKEN, DOCS_TOKEN, LEAKY_KEY, OAUTH_TOKEN, CREDENTIALS_TOKEN, CODEX_AUTH_TOKEN, PROVIDER_KEY];

const homes: Array<string> = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A real temporary HOME; realpath so a linked tmpdir is not mistaken for a linked ancestor. */
function makeHome(): string {
  const home = realpathSync(mkdtempSync(posix.join(tmpdir(), "canonfig-import-")));
  homes.push(home);
  return home;
}

function context(home: string): RootContext {
  return {
    platform: "linux",
    home,
    appData: `${home}/.config`,
    environment: () => undefined,
    join: (...segments) => posix.join(...segments),
  };
}

function put(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

function skill(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nUse ${name}.\n`;
}

function contentText(content: ImportContent): string {
  if (content.kind === "text") return content.content;
  if (content.kind === "mcp") return JSON.stringify(content.server);
  return content.files.map((file) => new TextDecoder().decode(file.content)).join("\n");
}

function expectNoLiterals(text: string): void {
  for (const literal of LITERALS) expect(text).not.toContain(literal);
}

function candidate(scan: ImportScan, id: string) {
  const found = scan.candidates.find((entry) => entry.id === id);
  expect(found, id).toBeDefined();
  return found!;
}

function claudeHome(home: string): void {
  put(`${home}/.claude/CLAUDE.md`, "Be terse.\n");
  put(`${home}/.claude/skills/deploy/SKILL.md`, skill("deploy", "Deploys the app"));
  put(`${home}/.claude/skills/deploy/scripts/run.sh`, "#!/bin/sh\necho deploy\n", 0o755);
  put(`${home}/.claude/agents/reviewer.md`, "---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep\nmodel: inherit\n---\nReview carefully.\n");
  put(`${home}/.claude/commands/ship.md`, "Ship the current branch.\n\nRun the tests first.\n");
  put(`${home}/.claude/rules/style.md`, "---\npaths:\n  - \"src/**/*.ts\"\n---\nUse tabs.\n");
  put(`${home}/.claude.json`, JSON.stringify({
    oauthAccount: { accessToken: OAUTH_TOKEN },
    mcpServers: {
      github: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN } },
      docs: { type: "http", url: "https://docs.example.com/mcp", headers: { Authorization: `Bearer ${DOCS_TOKEN}` } },
      leaky: { command: "leaky-mcp", args: ["--api-key", LEAKY_KEY] },
    },
  }));
  put(`${home}/.claude/.credentials.json`, JSON.stringify({ token: CREDENTIALS_TOKEN }), 0o000);
}

describe("scanImports", () => {
  it("keeps every item when a machine has more than 256 candidates", async () => {
    const home = makeHome();
    for (let index = 0; index < 320; index++) {
      const name = `skill-${index}`;
      put(`${home}/.claude/skills/${name}/SKILL.md`, skill(name, `Skill ${index}`));
    }
    const scan = await scanImports({ context: context(home), harnesses: ["claude-code"], folder: `${home}/.canonfig` });
    expect(scan.candidates).toHaveLength(320);
    expect(scan.skipped).toEqual([]);
  });

  it("imports a Claude Code home, redacting MCP credentials and refusing leaky servers", async () => {
    const home = makeHome();
    claudeHome(home);
    const scan = await scanImports({ context: context(home), harnesses: ["claude-code"], folder: `${home}/.canonfig` });

    expect(scan.candidates.map((entry) => [entry.id, entry.target])).toEqual([
      ["claude-code/agents/reviewer", "agents/reviewer.md"],
      ["claude-code/commands/ship", "commands/ship.md"],
      ["claude-code/instructions/AGENTS.md", "AGENTS.md"],
      ["claude-code/mcp/docs", "canonfig.jsonc#mcp.docs"],
      ["claude-code/mcp/github", "canonfig.jsonc#mcp.github"],
      ["claude-code/rules/style", "rules/style.md"],
      ["claude-code/skills/deploy", "skills/deploy"],
    ]);
    expect(scan.skipped).toEqual([{
      source: "claude-code",
      path: `${home}/.claude.json`,
      reason: "MCP server leaky passes a literal credential in its command, arguments or URL; move it to an environment variable and scan again",
    }]);
    expectNoLiterals(JSON.stringify(scan));

    const github = candidate(scan, "claude-code/mcp/github");
    expect(github.secrets).toEqual([{ field: "env.GITHUB_TOKEN", fromEnv: "GITHUB_TOKEN" }]);
    const docs = candidate(scan, "claude-code/mcp/docs");
    expect(docs.secrets).toEqual([{ field: "headers.Authorization", fromEnv: "DOCS_AUTHORIZATION" }]);

    const ctx = context(home);
    expect(await readImportContent(github, ctx)).toEqual({
      kind: "mcp",
      server: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: { fromEnv: "GITHUB_TOKEN" } },
      },
    });
    expect(await readImportContent(docs, ctx)).toEqual({
      kind: "mcp",
      server: {
        transport: "streamable-http",
        url: "https://docs.example.com/mcp",
        headers: { Authorization: { fromEnv: "DOCS_AUTHORIZATION" } },
      },
    });

    const reviewer = candidate(scan, "claude-code/agents/reviewer");
    expect(reviewer.notes).toEqual([
      "The metadata field name is not copied",
      "The metadata field tools is not copied because this tool's permission names differ from Canonfig's; review the imported agent's permissions before use.",
    ]);
    expect(await readImportContent(reviewer, ctx)).toEqual({
      kind: "text", content: "---\ndescription: Reviews code\n---\nReview carefully.\n",
    });
    const ship = candidate(scan, "claude-code/commands/ship");
    expect(ship.notes).toEqual(["description taken from the first body line"]);
    expect(await readImportContent(ship, ctx)).toEqual({
      kind: "text", content: "---\ndescription: Ship the current branch.\n---\nShip the current branch.\n\nRun the tests first.\n",
    });
    expect(await readImportContent(candidate(scan, "claude-code/rules/style"), ctx)).toEqual({
      kind: "text", content: "---\npaths:\n  - src/**/*.ts\n---\nUse tabs.\n",
    });
    expect(await readImportContent(candidate(scan, "claude-code/instructions/AGENTS.md"), ctx)).toEqual({
      kind: "text", content: "Be terse.\n",
    });
    const deploy = await readImportContent(candidate(scan, "claude-code/skills/deploy"), ctx);
    expect(deploy.kind === "tree" ? deploy.files.map((file) => [file.path, file.executable]) : deploy).toEqual([
      ["SKILL.md", false],
      ["scripts/run.sh", true],
    ]);

    for (const entry of scan.candidates) expectNoLiterals(contentText(await readImportContent(entry, ctx)));
  });

  it("reads Codex MCP forwarding, never touches auth.json, and attributes shared skills to agents", async () => {
    const home = makeHome();
    put(`${home}/.codex/config.toml`, [
      "model = \"gpt-5\"",
      "",
      "[mcp_servers.x]",
      "command = \"x-mcp\"",
      "env_vars = [\"X_TOKEN\"]",
      "",
      "[mcp_servers.web]",
      "url = \"https://web.example.com/mcp\"",
      "env_http_headers = { Authorization = \"WEB_AUTH\" }",
      "startup_timeout_sec = 20",
      "",
    ].join("\n"));
    put(`${home}/.codex/auth.json`, JSON.stringify({ OPENAI_API_KEY: CODEX_AUTH_TOKEN }), 0o000);
    put(`${home}/.agents/skills/lint/SKILL.md`, skill("lint", "Lints the code"));
    const ctx = context(home);
    const scan = await scanImports({ context: ctx, harnesses: ["codex", "qwen"], folder: `${home}/.canonfig` });

    expect(scan.candidates.map((entry) => [entry.id, entry.source, entry.harnesses])).toEqual([
      ["agents/skills/lint", "agents", ["codex", "qwen"]],
      ["codex/mcp/web", "codex", ["codex"]],
      ["codex/mcp/x", "codex", ["codex"]],
    ]);
    expect(scan.skipped).toEqual([]);
    expectNoLiterals(JSON.stringify(scan));
    const web = candidate(scan, "codex/mcp/web");
    expect(web.notes).toEqual(["dropped startup_timeout_sec"]);
    expect(await readImportContent(web, ctx)).toEqual({
      kind: "mcp",
      server: { transport: "streamable-http", url: "https://web.example.com/mcp", headers: { Authorization: { fromEnv: "WEB_AUTH" } } },
    });
    expect(await readImportContent(candidate(scan, "codex/mcp/x"), ctx)).toEqual({
      kind: "mcp",
      server: { transport: "stdio", command: "x-mcp", env: { X_TOKEN: { fromEnv: "X_TOKEN" } } },
    });
  });

  it("decodes OpenCode command arrays and {env:VAR} references without reading provider keys", async () => {
    const home = makeHome();
    put(`${home}/.config/opencode/opencode.json`, JSON.stringify({
      provider: { openai: { options: { apiKey: PROVIDER_KEY } } },
      mcp: {
        thing: { type: "local", command: ["bunx", "mcp-thing", "--verbose"], environment: { API_KEY: "{env:THING_KEY}" }, enabled: false },
        remote: { type: "remote", url: "https://r.example.com/mcp", headers: { "X-Api-Key": "{env:R_KEY}" }, timeout: 5000 },
      },
    }));
    const ctx = context(home);
    const scan = await scanImports({ context: ctx, harnesses: ["opencode"], folder: `${home}/.canonfig` });

    expect(scan.candidates.map((entry) => entry.id)).toEqual(["opencode/mcp/remote", "opencode/mcp/thing"]);
    expectNoLiterals(JSON.stringify(scan));
    const thing = candidate(scan, "opencode/mcp/thing");
    expect(thing.secrets).toEqual([]);
    expect(await readImportContent(thing, ctx)).toEqual({
      kind: "mcp",
      server: { transport: "stdio", command: "bunx", args: ["mcp-thing", "--verbose"], env: { API_KEY: { fromEnv: "THING_KEY" } }, enabled: false },
    });
    const remote = candidate(scan, "opencode/mcp/remote");
    expect(remote.notes).toEqual(["dropped timeout"]);
    expect(await readImportContent(remote, ctx)).toEqual({
      kind: "mcp",
      server: { transport: "streamable-http", url: "https://r.example.com/mcp", headers: { "X-Api-Key": { fromEnv: "R_KEY" } } },
    });
  });

  it("skips a symlinked skill without following it", async () => {
    const home = makeHome();
    put(`${home}/elsewhere/linked/SKILL.md`, skill("linked", "Lives elsewhere"));
    mkdirSync(`${home}/.claude/skills`, { recursive: true });
    symlinkSync(`${home}/elsewhere/linked`, `${home}/.claude/skills/linked`);
    const scan = await scanImports({ context: context(home), harnesses: ["claude-code"], folder: `${home}/.canonfig` });

    expect(scan.candidates).toEqual([]);
    expect(scan.skipped).toEqual([{
      source: "claude-code", path: `${home}/.claude/skills/linked`, reason: "is a link; links are not followed",
    }]);
  });
});

describe("selectImports", () => {
  it("separates present items, folder collisions and cross-harness collisions", async () => {
    const home = makeHome();
    const folder = `${home}/.canonfig`;
    put(`${home}/.claude/CLAUDE.md`, "Same.\n");
    put(`${home}/.claude/skills/deploy/SKILL.md`, skill("deploy", "Deploys with Claude"));
    put(`${home}/.claude/rules/style.md`, "Use tabs.\n");
    put(`${home}/.claude/commands/ship.md`, "---\ndescription: Ship it\n---\nShip.\n");
    put(`${home}/.omp/agent/AGENTS.md`, "Same.\n");
    put(`${home}/.omp/agent/skills/deploy/SKILL.md`, skill("deploy", "Deploys with omp"));
    const ctx = context(home);
    const scan = await scanImports({ context: ctx, harnesses: ["claude-code", "oh-my-pi"], folder });

    const style = await readImportContent(candidate(scan, "claude-code/rules/style"), ctx);
    put(`${folder}/rules/style.md`, contentText(style));
    put(`${folder}/commands/ship.md`, "---\ndescription: Ship it\n---\nShip differently.\n");
    const existing = await existingFolderItems(folder);
    expect([...existing.keys()].sort()).toEqual(["commands/ship.md", "rules/style.md"]);

    const all = selectImports(scan, existing, { kind: "all" });
    expect(all.chosen.map((entry) => entry.id)).toEqual(["claude-code/instructions/AGENTS.md"]);
    expect(all.present).toEqual(["claude-code/rules/style"]);
    expect(all.collisions).toEqual([
      { target: "commands/ship.md", candidates: ["claude-code/commands/ship"], folder: true },
      { target: "skills/deploy", candidates: ["claude-code/skills/deploy", "oh-my-pi/skills/deploy"], folder: false },
    ]);
    expect(all.unknown).toEqual([]);

    const some = selectImports(scan, existing, {
      kind: "some",
      sources: ["claude-code", "cursor"],
      items: ["oh-my-pi/skills/deploy", "nope/skills/missing"],
    });
    expect(some.chosen.map((entry) => entry.id)).toEqual(["claude-code/instructions/AGENTS.md", "oh-my-pi/skills/deploy"]);
    expect(some.collisions).toEqual([{ target: "commands/ship.md", candidates: ["claude-code/commands/ship"], folder: true }]);
    expect(some.unknown).toEqual(["cursor", "nope/skills/missing"]);

    expect(selectImports(scan, existing, { kind: "none" })).toEqual({ chosen: [], present: [], collisions: [], unknown: [] });
  });

  it("reads an imported skill and MCP server back as present", async () => {
    const home = makeHome();
    const folder = `${home}/.canonfig`;
    put(`${home}/.claude/skills/deploy/SKILL.md`, skill("deploy", "Deploys"));
    put(`${home}/.claude.json`, JSON.stringify({ mcpServers: { github: { command: "npx", env: { GITHUB_TOKEN } } } }));
    const ctx = context(home);
    const scan = await scanImports({ context: ctx, harnesses: ["claude-code"], folder });
    const deploy = await readImportContent(candidate(scan, "claude-code/skills/deploy"), ctx);
    const github = await readImportContent(candidate(scan, "claude-code/mcp/github"), ctx);
    if (deploy.kind !== "tree" || github.kind !== "mcp") throw new Error("unexpected content kinds");
    for (const file of deploy.files) put(`${folder}/skills/deploy/${file.path}`, new TextDecoder().decode(file.content));
    put(`${folder}/canonfig.jsonc`, `// imported\n{ "version": 1, "harnesses": [], "mcp": { "github": ${JSON.stringify(github.server)} } }\n`);

    const choice = selectImports(scan, await existingFolderItems(folder), { kind: "all" });
    expect(choice.present).toEqual(["claude-code/mcp/github", "claude-code/skills/deploy"]);
    expect(choice.chosen).toEqual([]);
  });
});

describe("readImportContent", () => {
  it("throws ImportChangedError when the source changed after the scan", async () => {
    const home = makeHome();
    put(`${home}/.claude/CLAUDE.md`, "Before.\n");
    const ctx = context(home);
    const scan = await scanImports({ context: ctx, harnesses: ["claude-code"], folder: `${home}/.canonfig` });
    put(`${home}/.claude/CLAUDE.md`, "After.\n");

    await expect(readImportContent(candidate(scan, "claude-code/instructions/AGENTS.md"), ctx)).rejects.toBeInstanceOf(ImportChangedError);
  });
});
