import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, posix } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RootContext } from "../src/projection/harness.ts";
import { markdownWithFrontmatter, parseMarkdownDocument } from "../src/projection/frontmatter.ts";
import { SkillReader } from "../src/projection/import-skills.ts";
import {
  existingFolderItems,
  type ImportContent,
  ImportChangedError,
  type ImportScan,
  ImportSizeLimitError,
  readImportContent,
  scanImports,
  selectImports,
} from "../src/projection/import.ts";
import type { TargetId } from "../src/projection/model.ts";

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
    expect(await readImportContent(github, ctx, `${home}/.canonfig`)).toEqual({
      kind: "mcp",
      server: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: { fromEnv: "GITHUB_TOKEN" } },
      },
    });
    expect(await readImportContent(docs, ctx, `${home}/.canonfig`)).toEqual({
      kind: "mcp",
      server: {
        transport: "streamable-http",
        url: "https://docs.example.com/mcp",
        headers: { Authorization: { fromEnv: "DOCS_AUTHORIZATION" } },
      },
    });

    const reviewer = candidate(scan, "claude-code/agents/reviewer");
    expect(reviewer.notes).toEqual([
      "Canonfig does not copy the metadata field name",
      "Canonfig does not copy the metadata field tools because this tool names permissions differently. Review the imported agent's permissions before use.",
    ]);
    expect(await readImportContent(reviewer, ctx, `${home}/.canonfig`)).toEqual({
      kind: "text", content: "---\ndescription: Reviews code\n---\nReview carefully.\n",
    });
    const ship = candidate(scan, "claude-code/commands/ship");
    expect(ship.notes).toEqual(["description taken from the first body line"]);
    expect(await readImportContent(ship, ctx, `${home}/.canonfig`)).toEqual({
      kind: "text", content: "---\ndescription: Ship the current branch.\n---\nShip the current branch.\n\nRun the tests first.\n",
    });
    expect(await readImportContent(candidate(scan, "claude-code/rules/style"), ctx, `${home}/.canonfig`)).toEqual({
      kind: "text", content: "---\npaths:\n  - src/**/*.ts\n---\nUse tabs.\n",
    });
    expect(await readImportContent(candidate(scan, "claude-code/instructions/AGENTS.md"), ctx, `${home}/.canonfig`)).toEqual({
      kind: "text", content: "Be terse.\n",
    });
    const deploy = await readImportContent(candidate(scan, "claude-code/skills/deploy"), ctx, `${home}/.canonfig`);
    expect(deploy.kind === "tree" ? deploy.files.map((file) => [file.path, file.executable]) : deploy).toEqual([
      ["SKILL.md", false],
      ["scripts/run.sh", true],
    ]);

    for (const entry of scan.candidates) expectNoLiterals(contentText(await readImportContent(entry, ctx, `${home}/.canonfig`)));
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
    expect(await readImportContent(web, ctx, `${home}/.canonfig`)).toEqual({
      kind: "mcp",
      server: { transport: "streamable-http", url: "https://web.example.com/mcp", headers: { Authorization: { fromEnv: "WEB_AUTH" } } },
    });
    expect(await readImportContent(candidate(scan, "codex/mcp/x"), ctx, `${home}/.canonfig`)).toEqual({
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
    expect(await readImportContent(thing, ctx, `${home}/.canonfig`)).toEqual({
      kind: "mcp",
      server: { transport: "stdio", command: "bunx", args: ["mcp-thing", "--verbose"], env: { API_KEY: { fromEnv: "THING_KEY" } }, enabled: false },
    });
    const remote = candidate(scan, "opencode/mcp/remote");
    expect(remote.notes).toEqual(["dropped timeout"]);
    expect(await readImportContent(remote, ctx, `${home}/.canonfig`)).toEqual({
      kind: "mcp",
      server: { transport: "streamable-http", url: "https://r.example.com/mcp", headers: { "X-Api-Key": { fromEnv: "R_KEY" } } },
    });
  });

  it("follows a home-confined skill link and its resource links without changing provenance", async () => {
    const home = makeHome();
    const manifest = skill("linked", "Lives in a linked library");
    put(`${home}/library/linked/SKILL.md`, manifest);
    put(`${home}/library/resources/guide.md`, "Read this guide.\n");
    put(`${home}/library/scripts/run.sh`, "#!/bin/sh\necho linked\n", 0o755);
    symlinkSync("../resources/guide.md", `${home}/library/linked/guide.md`);
    symlinkSync("../scripts", `${home}/library/linked/scripts`);
    mkdirSync(`${home}/.claude/skills`, { recursive: true });
    symlinkSync(`${home}/library/linked`, `${home}/.claude/skills/linked`);
    const ctx = context(home);
    const scan = await scanImports({ context: ctx, harnesses: ["claude-code"], folder: `${home}/.canonfig` });

    const linked = candidate(scan, "claude-code/skills/linked");
    expect(linked.path).toBe(`${home}/.claude/skills/linked`);
    expect(scan.skipped).toEqual([]);
    const content = await readImportContent(linked, ctx, `${home}/.canonfig`);
    expect(content.kind === "tree" ? content.files.map((file) => [file.path, new TextDecoder().decode(file.content), file.executable]) : content).toEqual([
      ["SKILL.md", manifest, false],
      ["guide.md", "Read this guide.\n", false],
      ["scripts/run.sh", "#!/bin/sh\necho linked\n", true],
    ]);
  });

  it("finds private Codex skills and linked OMP and Factory libraries independently of write ownership", async () => {
    const home = makeHome();
    put(`${home}/.codex/skills/lint/SKILL.md`, skill("lint", "Lints code"));
    mkdirSync(`${home}/.omp/agent`, { recursive: true });
    mkdirSync(`${home}/.factory`, { recursive: true });
    symlinkSync(`${home}/.codex/skills`, `${home}/.omp/agent/skills`);
    symlinkSync(`${home}/.codex/skills`, `${home}/.factory/skills`);
    const ctx = context(home);
    const scan = await scanImports({ context: ctx, harnesses: ["codex", "oh-my-pi", "factory-droid"], folder: `${home}/.canonfig` });
    expect(scan.candidates.map((entry) => [entry.id, entry.path, entry.harnesses])).toEqual([
      ["codex/skills/lint", `${home}/.codex/skills/lint`, ["codex"]],
      ["factory-droid/skills/lint", `${home}/.factory/skills/lint`, ["factory-droid"]],
      ["oh-my-pi/skills/lint", `${home}/.omp/agent/skills/lint`, ["oh-my-pi"]],
    ]);
    expect(scan.skipped).toEqual([]);
    for (const entry of scan.candidates) {
      expect(contentText(await readImportContent(entry, ctx, `${home}/.canonfig`))).toBe(skill("lint", "Lints code"));
    }
  });

  it("honors relocated Codex and Hermes homes for native skill discovery", async () => {
    const home = makeHome();
    put(`${home}/codex-profile/skills/lint/SKILL.md`, skill("lint", "Profile lint"));
    put(`${home}/hermes-profile/skills/Quality checks/review/SKILL.md`, skill("review", "Profile review"));
    put(`${home}/.codex/skills/ignored/SKILL.md`, skill("ignored", "Inactive profile"));
    const ctx: RootContext = {
      ...context(home),
      environment: (name) => name === "CODEX_HOME" ? `${home}/codex-profile` : name === "HERMES_HOME" ? `${home}/hermes-profile` : undefined,
    };
    const scan = await scanImports({ context: ctx, harnesses: ["codex", "hermes"], folder: `${home}/.canonfig` });
    expect(scan.candidates.map((entry) => [entry.source, entry.name, entry.path])).toEqual([
      ["codex", "lint", `${home}/codex-profile/skills/lint`],
      ["hermes", "review", `${home}/hermes-profile/skills/Quality checks/review`],
    ]);
  });

  it("discovers nested Hermes categories and child skills but not support directories or excluded caches", async () => {
    const home = makeHome();
    const root = `${home}/.hermes/skills`;
    put(`${root}/direct/SKILL.md`, skill("direct", "Direct skill"));
    put(`${root}/Team skills/deep/review/SKILL.md`, skill("review", "Nested skill"));
    put(`${root}/scripts/build/SKILL.md`, skill("build", "A category named scripts"));
    put(`${root}/direct/extra/child/SKILL.md`, skill("child", "Nested below a skill"));
    put(`${root}/direct/references/example/SKILL.md`, skill("example", "Only a resource"));
    put(`${root}/direct/prompts/example.md`, "A resource inside the skill, not another skill.\n");
    put(`${root}/node_modules/ignored/SKILL.md`, skill("ignored", "Dependency"));
    put(`${root}/.archive/ignored/SKILL.md`, skill("ignored", "Archived"));
    put(`${root}/.private/hidden/SKILL.md`, skill("hidden", "Not an excluded directory"));
    const scan = await scanImports({ context: context(home), harnesses: ["hermes"], folder: `${home}/.canonfig` });
    expect(scan.candidates.map((entry) => entry.name)).toEqual(["build", "child", "direct", "hidden", "review"]);
    expect(candidate(scan, "hermes/skills/review").path).toBe(`${root}/Team skills/deep/review`);
    expect(scan.skipped).toEqual([]);
  });

  it("scans shared agents skills once and attributes direct, nested and flat skills only to supported readers", async () => {
    const home = makeHome();
    put(`${home}/.agents/skills/lint/SKILL.md`, skill("lint", "Shared lint"));
    put(`${home}/.agents/skills/team/review/SKILL.md`, skill("review", "Shared nested review"));
    put(`${home}/.agents/skills/flat.md`, skill("flat", "Shared flat skill"));
    put(`${home}/.agent/skills/not-an-alias/SKILL.md`, skill("not-an-alias", "Not the shared root"));
    const scan = await scanImports({
      context: context(home),
      harnesses: ["codex", "qwen", "opencode", "factory-droid", "copilot-cli", "oh-my-pi", "claude-code", "pi", "hermes"],
      folder: `${home}/.canonfig`,
    });
    expect(scan.candidates.map((entry) => [entry.id, entry.harnesses])).toEqual([
      ["agents/skills/flat", ["opencode"]],
      ["agents/skills/lint", ["codex", "qwen", "opencode", "factory-droid", "copilot-cli", "oh-my-pi"]],
      ["agents/skills/review", ["codex", "opencode", "factory-droid", "oh-my-pi"]],
    ]);
    expect(scan.skipped).toEqual([]);
    const flat = await readImportContent(candidate(scan, "agents/skills/flat"), context(home), `${home}/.canonfig`);
    if (flat.kind !== "tree") throw new Error("Expected a portable flat-skill tree");
    expect(flat.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    const document = parseMarkdownDocument(new TextDecoder().decode(flat.files[0]!.content));
    expect(document.data).toMatchObject({ name: "flat", description: "Shared flat skill" });
    expect(document.content).toBe("Use flat.");
    expect(selectImports(scan, new Map(), { kind: "some", sources: ["qwen"], items: [] }).chosen.map((entry) => entry.name)).toEqual(["lint"]);
  });

  it("refuses a flat skill whose generated SKILL.md exceeds 1 MiB in UTF-8", async () => {
    const home = makeHome();
    const path = `${home}/.agents/skills/flat.md`;
    const maximum = 1024 * 1024;
    const framingBytes = Buffer.byteLength(markdownWithFrontmatter({ description: "Boundary", name: "flat" }, ""), "utf8");
    // The added name and final newline push the output one byte over the cap.
    // A two-byte character makes its UTF-16 length fit while its UTF-8 bytes do not.
    const body = `é${"x".repeat(maximum - framingBytes - 1)}`;
    const source = `---\ndescription: Boundary\n---\n${body}\n`;
    expect(Buffer.byteLength(source, "utf8")).toBeLessThanOrEqual(maximum);
    put(path, source);
    const scan = await scanImports({ context: context(home), harnesses: ["opencode"], folder: `${home}/.canonfig` });
    expect(scan.candidates).toEqual([]);
    expect(scan.skipped.map((entry) => entry.path)).toEqual([path]);
  });

  it("keeps the 1 MiB raw flat-skill limit before normalization", async () => {
    const home = makeHome();
    const path = `${home}/.agents/skills/flat.md`;
    put(path, `${skill("flat", "Small converted payload")}${" ".repeat(1024 * 1024)}`);
    const scan = await scanImports({ context: context(home), harnesses: ["opencode"], folder: `${home}/.canonfig` });
    expect(scan.candidates).toEqual([]);
    expect(scan.skipped.map((entry) => entry.path)).toEqual([path]);
  });

  it.each<[TargetId, string]>([
    ["cursor", ".cursor/skills"],
    ["amp", ".config/agents/skills"],
    ["devin", ".config/devin/skills"],
    ["grok-build", ".grok/skills"],
    ["kimi", ".kimi-code/skills"],
    ["qwen", ".qwen/skills"],
    ["kilo", ".kilo/skills"],
    ["opencode", ".config/opencode/skills"],
  ])("imports native private skills read by %s", async (harness, root) => {
    const home = makeHome();
    put(`${home}/${root}/lint/SKILL.md`, skill("lint", "Native lint"));
    const scan = await scanImports({ context: context(home), harnesses: [harness], folder: `${home}/.canonfig` });
    expect(scan.candidates.map((entry) => [entry.source, entry.name, entry.path])).toEqual([
      [harness, "lint", `${home}/${root}/lint`],
    ]);
    expect(scan.skipped).toEqual([]);
  });

  it.each([
    [undefined, undefined, ["claude", "cursor", "native", "shared"]],
    ["GROK_CLAUDE_SKILLS_ENABLED", "0", ["cursor", "native", "shared"]],
    ["GROK_CLAUDE_SKILLS_ENABLED", "false", ["cursor", "native", "shared"]],
    ["GROK_CURSOR_SKILLS_ENABLED", "0", ["claude", "native", "shared"]],
    ["GROK_CURSOR_SKILLS_ENABLED", "false", ["claude", "native", "shared"]],
  ] as const)("Grok compatibility roots respect %s=%s", async (flag, value, names) => {
    const home = makeHome();
    put(`${home}/.grok/skills/native/SKILL.md`, skill("native", "Native skill"));
    put(`${home}/.claude/skills/claude/SKILL.md`, skill("claude", "Claude compatibility skill"));
    put(`${home}/.cursor/skills/cursor/SKILL.md`, skill("cursor", "Cursor compatibility skill"));
    put(`${home}/.agents/skills/shared/SKILL.md`, skill("shared", "Generic shared skill"));
    const ctx: RootContext = { ...context(home), environment: (name) => name === flag ? value : undefined };
    const scan = await scanImports({ context: ctx, harnesses: ["grok-build"], folder: `${home}/.canonfig` });
    expect(scan.candidates.map((entry) => entry.name).sort()).toEqual([...names].sort());
    expect(candidate(scan, "agents/skills/shared").harnesses).toEqual(["grok-build"]);
    expect(scan.skipped).toEqual([]);
  });

  it("retains every distinct same-source Antigravity copy and deduplicates identical content", async () => {
    const home = makeHome();
    const roots = [".gemini/antigravity-cli/skills", ".gemini/skills", ".gemini/config/skills"];
    for (const [index, root] of roots.entries()) {
      put(`${home}/${root}/deploy/SKILL.md`, skill("deploy", `Deploy version ${index}`));
      put(`${home}/${root}/same/SKILL.md`, skill("same", "Identical copy"));
    }
    const ctx = context(home);
    const input = { context: ctx, harnesses: ["antigravity"] as const, folder: `${home}/.canonfig` };
    const scan = await scanImports(input);
    const competing = scan.candidates.filter((entry) => entry.name === "deploy");
    expect(competing.map((entry) => entry.path).sort()).toEqual(roots.map((root) => `${home}/${root}/deploy`).sort());
    expect(new Set(competing.map((entry) => entry.id)).size).toBe(3);
    for (const entry of competing) expect(entry.id).toMatch(/^antigravity\/skills\/deploy\/[a-f0-9]{64}$/u);
    expect(scan.candidates.filter((entry) => entry.name === "same")).toHaveLength(1);
    expect(scan.skipped).toEqual([]);
    expect((await scanImports(input)).candidates).toEqual(scan.candidates);
    expect(selectImports(scan, new Map(), { kind: "all" }).collisions).toEqual([
      { target: "skills/deploy", candidates: competing.map((entry) => entry.id), folder: false },
    ]);
    const explicit = competing.find((entry) => entry.path.includes("/config/"))!;
    const selected = selectImports(scan, new Map(), { kind: "some", sources: ["antigravity"], items: [explicit.id] });
    expect(selected.collisions).toEqual([]);
    expect(selected.unknown).toEqual([]);
    expect(selected.chosen.find((entry) => entry.name === "deploy")?.id).toBe(explicit.id);
    expect(contentText(await readImportContent(explicit, ctx, input.folder))).toBe(skill("deploy", "Deploy version 2"));
  });

  it("reports broken roots, skill entries, resource links and directory cycles instead of calling them empty", async () => {
    const home = makeHome();
    mkdirSync(`${home}/.pi/agent`, { recursive: true });
    symlinkSync(`${home}/missing-library`, `${home}/.pi/agent/skills`);
    mkdirSync(`${home}/.claude/skills`, { recursive: true });
    symlinkSync(`${home}/missing-skill`, `${home}/.claude/skills/broken`);
    symlinkSync("cycle-b", `${home}/.claude/skills/cycle-a`);
    symlinkSync("cycle-a", `${home}/.claude/skills/cycle-b`);
    put(`${home}/.claude/skills/resource/SKILL.md`, skill("resource", "Has a missing resource"));
    symlinkSync("missing.md", `${home}/.claude/skills/resource/guide.md`);
    put(`${home}/.claude/skills/loop/SKILL.md`, skill("loop", "Has a directory loop"));
    symlinkSync(".", `${home}/.claude/skills/loop/again`);
    const scan = await scanImports({ context: context(home), harnesses: ["pi", "claude-code"], folder: `${home}/.canonfig` });
    expect(scan.candidates).toEqual([]);
    expect(scan.skipped.map((entry) => [entry.path.replace(`${home}/`, ""), entry.reason])).toEqual([
      [".pi/agent/skills", "is a broken link"],
      [".claude/skills/broken", "is a broken link"],
      [".claude/skills/cycle-a", "contains a link cycle or too many links"],
      [".claude/skills/cycle-b", "contains a link cycle or too many links"],
      [".claude/skills/loop", "again/ contains a directory link cycle"],
      [".claude/skills/resource", "guide.md is a broken link"],
    ]);
  });

  it("refuses outside-home skill roots, entries and resources", async () => {
    const home = makeHome();
    const outside = makeHome();
    put(`${outside}/library/linked/SKILL.md`, skill("linked", "Outside this home"));
    mkdirSync(`${home}/.factory`, { recursive: true });
    symlinkSync(`${outside}/library`, `${home}/.factory/skills`);
    mkdirSync(`${home}/.claude/skills`, { recursive: true });
    symlinkSync(`${outside}/library/linked`, `${home}/.claude/skills/linked`);
    put(`${home}/.codex/skills/resource/SKILL.md`, skill("resource", "Outside resource"));
    symlinkSync(`${outside}/library/linked/SKILL.md`, `${home}/.codex/skills/resource/guide.md`);
    const scan = await scanImports({ context: context(home), harnesses: ["factory-droid", "claude-code", "codex"], folder: `${home}/.canonfig` });
    expect(scan.candidates).toEqual([]);
    expect(scan.skipped.map((entry) => entry.reason)).toEqual([
      "resolves outside the home directory", "resolves outside the home directory", "guide.md resolves outside the home directory",
    ]);
  });

  it("protects state and Canonical Folder aliases even when their harness is not selected", async () => {
    const home = makeHome();
    const folder = `${home}/canonical`;
    put(`${home}/state-store/secret.md`, "Private state.\n");
    mkdirSync(`${home}/.codex`, { recursive: true });
    symlinkSync(`${home}/state-store`, `${home}/.codex/sessions`);
    put(`${home}/canonical-store/linked/SKILL.md`, skill("linked", "Canonical item"));
    symlinkSync(`${home}/canonical-store`, folder);
    mkdirSync(`${home}/.claude/skills`, { recursive: true });
    symlinkSync(`${home}/canonical-store/linked`, `${home}/.claude/skills/linked`);
    put(`${home}/.claude/skills/state/SKILL.md`, skill("state", "Has a protected resource"));
    symlinkSync(`${home}/state-store/secret.md`, `${home}/.claude/skills/state/guide.md`);
    const scan = await scanImports({ context: context(home), harnesses: ["claude-code"], folder });
    expect(scan.candidates).toEqual([]);
    expect(scan.skipped.map((entry) => entry.reason)).toEqual([
      "inside the Canonical Folder", "guide.md never-touch path",
    ]);
  });

  it("excludes key-scoped config files from skill resources without blocking MCP imports", async () => {
    const home = makeHome();
    put(`${home}/.claude.json`, JSON.stringify({
      oauthAccount: { accessToken: OAUTH_TOKEN },
      mcpServers: { allowed: { command: "allowed-mcp" } },
    }));
    put(`${home}/.codex/skills/linked/SKILL.md`, skill("linked", "Has a config resource"));
    symlinkSync(`${home}/.claude.json`, `${home}/.codex/skills/linked/config.json`);
    const ctx = context(home);
    const folder = `${home}/.canonfig`;
    const scan = await scanImports({ context: ctx, harnesses: ["codex", "claude-code"], folder });
    expect(scan.candidates.map((entry) => entry.id)).toEqual(["claude-code/mcp/allowed"]);
    expect(scan.skipped.some((entry) => entry.reason.includes("protected config"))).toBe(true);
    expect(await readImportContent(candidate(scan, "claude-code/mcp/allowed"), ctx, folder)).toEqual({
      kind: "mcp", server: { transport: "stdio", command: "allowed-mcp" },
    });
    expectNoLiterals(JSON.stringify(scan));
  });

  it.each([".claude.json", ".config/opencode/opencode.jsonc"])("protects an unselected key-scoped config alias at %s", async (configPath) => {
    const home = makeHome();
    put(`${home}/mixed-state.json`, JSON.stringify({ accessToken: OAUTH_TOKEN }));
    mkdirSync(dirname(`${home}/${configPath}`), { recursive: true });
    symlinkSync(`${home}/mixed-state.json`, `${home}/${configPath}`);
    put(`${home}/.codex/skills/linked/SKILL.md`, skill("linked", "Has a config alias resource"));
    symlinkSync(`${home}/mixed-state.json`, `${home}/.codex/skills/linked/config.json`);
    const scan = await scanImports({ context: context(home), harnesses: ["codex"], folder: `${home}/.canonfig` });
    expect(scan.candidates).toEqual([]);
    expect(scan.skipped.some((entry) => entry.reason.includes("protected config"))).toBe(true);
    expectNoLiterals(JSON.stringify(scan));
  });

  it("accepts a finite repeated-link path without treating it as a cycle", async () => {
    const home = makeHome();
    put(`${home}/library/version/guide.md`, "A safe guide.\n");
    symlinkSync("version", `${home}/library/current`);
    put(`${home}/.codex/skills/linked/SKILL.md`, skill("linked", "Uses the same link twice"));
    symlinkSync(`${home}/library/current/../current/guide.md`, `${home}/.codex/skills/linked/guide.md`);
    const ctx = context(home);
    const folder = `${home}/.canonfig`;
    const scan = await scanImports({ context: ctx, harnesses: ["codex"], folder });
    expect(scan.skipped).toEqual([]);
    const content = await readImportContent(candidate(scan, "codex/skills/linked"), ctx, folder);
    expect(content.kind === "tree" ? content.files.map((file) => [file.path, new TextDecoder().decode(file.content)]) : content).toContainEqual([
      "guide.md", "A safe guide.\n",
    ]);
  });

  it("respects a case-sensitive filesystem even when the platform is macOS", async (test) => {
    const home = makeHome();
    put(`${home}/Libraries/private.md`, "Protected fixture.\n");
    mkdirSync(`${home}/libraries`, { recursive: true });
    if (realpathSync(`${home}/Libraries`) === realpathSync(`${home}/libraries`)) {
      test.skip();
      return;
    }
    put(`${home}/libraries/guide.md`, "A safe lowercase library.\n");
    mkdirSync(`${home}/.codex`, { recursive: true });
    symlinkSync(`${home}/Libraries`, `${home}/.codex/sessions`);
    put(`${home}/.claude/skills/linked/SKILL.md`, skill("linked", "A distinct lowercase library"));
    symlinkSync(`${home}/libraries/guide.md`, `${home}/.claude/skills/linked/guide.md`);
    const ctx: RootContext = { ...context(home), platform: "macos" };
    const folder = `${home}/.canonfig`;
    const scan = await scanImports({ context: ctx, harnesses: ["claude-code"], folder });
    expect(scan.skipped).toEqual([]);
    const content = await readImportContent(candidate(scan, "claude-code/skills/linked"), ctx, folder);
    expect(content.kind === "tree" ? content.files.map((file) => [file.path, new TextDecoder().decode(file.content)]) : content).toContainEqual([
      "guide.md", "A safe lowercase library.\n",
    ]);
  });

  it("bounds total UTF-8 skill bytes and refuses over-budget content before opening it", async () => {
    const home = makeHome();
    const root = `${home}/.claude/skills/budget`;
    const manifest = skill("budget", "A bounded skill");
    const guide = "é🚀\n";
    put(`${root}/SKILL.md`, manifest);
    put(`${root}/guide.md`, guide);
    const encoder = new TextEncoder();
    const total = encoder.encode(manifest).byteLength + encoder.encode(guide).byteLength;
    const reader = await SkillReader.create(context(home), [], `${home}/.canonfig`, []);
    const exact = await reader.tree(root, total);
    expect(exact.kind === "tree" ? exact.files.map((file) => [file.path, new TextDecoder().decode(file.content)]) : exact).toEqual([
      ["SKILL.md", manifest], ["guide.md", guide],
    ]);
    // An attempted read would fail on POSIX; quota rejection must happen first.
    if (process.platform !== "win32" && process.getuid?.() !== 0) chmodSync(`${root}/guide.md`, 0o000);
    expect(await reader.tree(root, total - 1)).toMatchObject({
      kind: "limit", path: root, maximumBytes: total - 1,
    });
  });

  it("preserves skill byte and file-count bounds through links", async () => {
    const home = makeHome();
    const root = `${home}/.claude/skills`;
    put(`${root}/large/SKILL.md`, skill("large", "Large linked resource"));
    put(`${home}/resources/large.bin`, "x".repeat(1024 * 1024 + 1));
    symlinkSync(`${home}/resources/large.bin`, `${root}/large/large.bin`);
    put(`${root}/many/SKILL.md`, skill("many", "Too many resources"));
    for (let index = 0; index < 512; index++) put(`${root}/many/files/${index}.txt`, "resource");
    const scan = await scanImports({ context: context(home), harnesses: ["claude-code"], folder: `${home}/.canonfig` });
    expect(scan.candidates).toEqual([]);
    expect(scan.skipped.map((entry) => entry.reason)).toEqual([
      "large.bin is larger than 1 MiB", "has more than 512 files",
    ]);
  });

  it.skipIf(process.platform === "win32")("refuses a linked filesystem socket from a short disposable home", async () => {
    const home = realpathSync(mkdtempSync("/tmp/cf-sock-"));
    homes.push(home);
    const root = `${home}/.claude/skills/socket`;
    put(`${root}/SKILL.md`, skill("socket", "Special resource"));
    symlinkSync(`${home}/s`, `${root}/special.sock`);
    const server = createServer();
    const started = Promise.withResolvers<void>();
    server.once("error", started.reject);
    try {
      server.listen(`${home}/s`, started.resolve);
      await started.promise;
      const scan = await scanImports({ context: context(home), harnesses: ["claude-code"], folder: `${home}/.canonfig` });
      expect(scan.candidates).toEqual([]);
      expect(scan.skipped).toEqual([{
        source: "claude-code", path: root, reason: "special.sock is not a regular file or directory",
      }]);
    } finally {
      if (server.listening) {
        const closed = Promise.withResolvers<void>();
        server.close((error) => error === undefined ? closed.resolve() : closed.reject(error));
        await closed.promise;
      }
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("refuses discovery when protected aliases cannot be verified", async () => {
    const home = makeHome();
    put(`${home}/private-store/guide.md`, "Protected fixture.\n");
    mkdirSync(`${home}/.codex`, { recursive: true });
    symlinkSync(`${home}/private-store`, `${home}/.codex/sessions`);
    put(`${home}/.claude/skills/linked/SKILL.md`, skill("linked", "Has a protected resource"));
    symlinkSync(`${home}/private-store/guide.md`, `${home}/.claude/skills/linked/guide.md`);
    chmodSync(`${home}/.codex`, 0o000);
    try {
      await expect(scanImports({ context: context(home), harnesses: ["claude-code"], folder: `${home}/.canonfig` }))
        .rejects.toThrow(/Cannot verify protected import path.*permissions/u);
    } finally {
      chmodSync(`${home}/.codex`, 0o700);
    }
  });

  it("does not enable link following for configs or instructions", async () => {
    const home = makeHome();
    put(`${home}/library/instructions.md`, "Linked instructions.\n");
    put(`${home}/library/config.toml`, "[mcp_servers.x]\ncommand = \"x-mcp\"\n");
    mkdirSync(`${home}/.codex`, { recursive: true });
    symlinkSync(`${home}/library/instructions.md`, `${home}/.codex/AGENTS.md`);
    symlinkSync(`${home}/library/config.toml`, `${home}/.codex/config.toml`);
    const scan = await scanImports({ context: context(home), harnesses: ["codex"], folder: `${home}/.canonfig` });
    expect(scan.candidates).toEqual([]);
    expect(scan.skipped.map((entry) => entry.reason)).toEqual([
      "is a link; links are not followed", "is a link; links are not followed",
    ]);
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

    const style = await readImportContent(candidate(scan, "claude-code/rules/style"), ctx, folder);
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
    const deploy = await readImportContent(candidate(scan, "claude-code/skills/deploy"), ctx, folder);
    const github = await readImportContent(candidate(scan, "claude-code/mcp/github"), ctx, folder);
    if (deploy.kind !== "tree" || github.kind !== "mcp") throw new Error("unexpected content kinds");
    for (const file of deploy.files) put(`${folder}/skills/deploy/${file.path}`, new TextDecoder().decode(file.content));
    put(`${folder}/canonfig.jsonc`, `// imported\n{ "version": 1, "harnesses": [], "mcp": { "github": ${JSON.stringify(github.server)} } }\n`);

    const choice = selectImports(scan, await existingFolderItems(folder), { kind: "all" });
    expect(choice.present).toEqual(["claude-code/mcp/github", "claude-code/skills/deploy"]);
    expect(choice.chosen).toEqual([]);
  });

  it("roundtrips a flat skill whose generated SKILL.md is exactly 1 MiB", async () => {
    const home = makeHome();
    const folder = `${home}/.canonfig`;
    const maximum = 1024 * 1024;
    const framingBytes = Buffer.byteLength(markdownWithFrontmatter({ description: "Boundary", name: "flat" }, ""), "utf8");
    const body = `é${"x".repeat(maximum - framingBytes - 2)}`;
    put(`${home}/.agents/skills/flat.md`, `---\ndescription: Boundary\n---\n${body}\n`);
    const ctx = context(home);
    const scan = await scanImports({ context: ctx, harnesses: ["opencode"], folder });
    expect(scan.skipped).toEqual([]);
    const flat = await readImportContent(candidate(scan, "agents/skills/flat"), ctx, folder, maximum);
    if (flat.kind !== "tree") throw new Error("Expected a portable flat-skill tree");
    expect(flat.files.map((file) => [file.path, file.content.byteLength])).toEqual([["SKILL.md", maximum]]);
    for (const file of flat.files) {
      put(`${folder}/skills/flat/${file.path}`, new TextDecoder().decode(file.content));
    }
    const choice = selectImports(scan, await existingFolderItems(folder), { kind: "all" });
    expect(choice).toEqual({ chosen: [], present: ["agents/skills/flat"], collisions: [], unknown: [] });
  });
});

describe("readImportContent", () => {
  it("budgets a flat skill's normalized UTF-8 payload instead of its larger source", async () => {
    const home = makeHome();
    const path = `${home}/.agents/skills/flat.md`;
    const folder = `${home}/.canonfig`;
    const normalized = "---\nname: flat\ndescription: Normalized flat skill\n---\nUse é🚀.\n";
    const source = `${normalized}${" \r\n".repeat(1024)}`;
    const quota = Buffer.byteLength(normalized, "utf8");
    put(path, source);
    const input = { context: context(home), harnesses: ["opencode"] as const, folder };
    const scan = await scanImports(input);
    expect(scan.skipped).toEqual([]);
    const flat = candidate(scan, "agents/skills/flat");
    expect(Buffer.byteLength(source, "utf8")).toBeGreaterThan(quota);
    const content = await readImportContent(flat, input.context, folder, quota);
    expect(content).toEqual({
      kind: "tree",
      files: [{ path: "SKILL.md", content: new TextEncoder().encode(normalized), executable: false }],
    });

    // Keep the reviewed source and digest unchanged so a changed-source error cannot pass.
    const overQuota = readImportContent(flat, input.context, folder, quota - 1);
    await expect(overQuota).rejects.toBeInstanceOf(ImportSizeLimitError);
    await expect(overQuota).rejects.toMatchObject({ path, maximumBytes: quota - 1 });
    expect(readFileSync(path, "utf8")).toBe(source);
    expect(candidate(await scanImports(input), flat.id).digest).toBe(flat.digest);
  });

  it("throws ImportChangedError when the source changed after the scan", async () => {
    const home = makeHome();
    put(`${home}/.claude/CLAUDE.md`, "Before.\n");
    const ctx = context(home);
    const scan = await scanImports({ context: ctx, harnesses: ["claude-code"], folder: `${home}/.canonfig` });
    put(`${home}/.claude/CLAUDE.md`, "After.\n");

    await expect(readImportContent(candidate(scan, "claude-code/instructions/AGENTS.md"), ctx, `${home}/.canonfig`)).rejects.toBeInstanceOf(ImportChangedError);
  });

  it("checks linked resource bytes against the approved digest", async () => {
    const home = makeHome();
    const folder = `${home}/.canonfig`;
    const root = `${home}/.claude/skills/linked`;
    put(`${root}/SKILL.md`, skill("linked", "Linked resource"));
    put(`${home}/resources/guide.md`, "Before.\n");
    symlinkSync(`${home}/resources/guide.md`, `${root}/guide.md`);
    const ctx = context(home);
    const scan = await scanImports({ context: ctx, harnesses: ["claude-code"], folder });
    put(`${home}/resources/guide.md`, "After.\n");
    await expect(readImportContent(candidate(scan, "claude-code/skills/linked"), ctx, folder)).rejects.toMatchObject({
      _tag: "ImportChangedError", message: expect.stringContaining("changed since the scan"),
    });
  });

  it("refuses a resource retargeted to protected state despite identical bytes and an unselected owner", async () => {
    const home = makeHome();
    const folder = `${home}/.canonfig`;
    const root = `${home}/.claude/skills/linked`;
    const identical = "Identical content.\n";
    put(`${root}/SKILL.md`, skill("linked", "Linked resource"));
    put(`${home}/resources/guide.md`, identical);
    put(`${home}/.codex/auth.json`, identical);
    symlinkSync(`${home}/resources/guide.md`, `${root}/guide.md`);
    const ctx = context(home);
    const scan = await scanImports({ context: ctx, harnesses: ["claude-code"], folder });
    rmSync(`${root}/guide.md`);
    symlinkSync(`${home}/.codex/auth.json`, `${root}/guide.md`);
    await expect(readImportContent(candidate(scan, "claude-code/skills/linked"), ctx, folder)).rejects.toMatchObject({
      _tag: "ImportChangedError", message: expect.stringContaining("never-touch path"),
    });
  });

  it.each(["root", "resource"] as const)("refuses a %s link retargeted to a custom Canonical Folder after approval", async (link) => {
    const home = makeHome();
    const folder = `${home}/custom/canonical`;
    const manifest = skill("linked", "Identical content at a different location");
    put(`${home}/library/linked/SKILL.md`, manifest);
    put(`${folder}/skills/linked/SKILL.md`, manifest);
    put(`${home}/resources/guide.md`, "Identical resource.\n");
    put(`${folder}/guide.md`, "Identical resource.\n");
    symlinkSync(`${home}/resources/guide.md`, `${home}/library/linked/guide.md`);
    mkdirSync(`${home}/.factory`, { recursive: true });
    symlinkSync(`${home}/library`, `${home}/.factory/skills`);
    const ctx = context(home);
    const scan = await scanImports({ context: ctx, harnesses: ["factory-droid"], folder });
    if (link === "root") {
      unlinkSync(`${home}/.factory/skills`);
      symlinkSync(`${folder}/skills`, `${home}/.factory/skills`);
    } else {
      rmSync(`${home}/library/linked/guide.md`);
      symlinkSync(`${folder}/guide.md`, `${home}/library/linked/guide.md`);
    }
    await expect(readImportContent(candidate(scan, "factory-droid/skills/linked"), ctx, folder)).rejects.toMatchObject({
      _tag: "ImportChangedError", message: expect.stringContaining("inside the Canonical Folder"),
    });
  });

  it("does not normalize away a protected symlink ancestor before processing '..'", async () => {
    const home = makeHome();
    const folder = `${home}/.canonfig`;
    const root = `${home}/.claude/skills/linked`;
    put(`${root}/SKILL.md`, skill("linked", "Protected traversal"));
    put(`${home}/public.md`, "Lexically safe, but not the link's actual destination.\n");
    put(`${home}/.codex/sessions/log.txt`, "Protected state.\n");
    symlinkSync(`${home}/.codex/sessions`, `${home}/bridge`);
    symlinkSync(`${home}/bridge/../public.md`, `${root}/guide.md`);
    const scan = await scanImports({ context: context(home), harnesses: ["claude-code"], folder });
    expect(scan.candidates).toEqual([]);
    expect(scan.skipped).toEqual([{
      source: "claude-code", path: root, reason: "guide.md never-touch path",
    }]);
  });
});
