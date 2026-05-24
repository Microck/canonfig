import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  applyBundle,
  buildBundle,
  buildJoinLink,
  computeRevision,
  defaultContext,
  installHook,
  mergeTomlText,
  parseJoinLink,
  portableMcpLauncher,
  verifyBundle
} from "../src/index.js";

async function tempDir(name: string): Promise<string> {
  const root = path.join(tmpdir(), `codexport-${name}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

describe("join links", () => {
  it("round-trips durable join metadata", () => {
    const link = buildJoinLink("http://master.tailnet.ts.net:17342", "abc123");
    expect(parseJoinLink(link)).toEqual({
      masterUrl: "http://master.tailnet.ts.net:17342",
      fingerprint: "abc123"
    });
  });
});

describe("bundle building", () => {
  it("includes canonical files and excludes runtime state", async () => {
    const root = await tempDir("bundle");
    const codex = path.join(root, ".codex");
    await mkdir(path.join(codex, "skills", "portable"), { recursive: true });
    await mkdir(path.join(codex, "sessions"), { recursive: true });
    await writeFile(path.join(codex, "AGENTS.md"), "rules\n");
    await writeFile(path.join(codex, "auth.json"), "{\"token\":\"secret\"}\n");
    await writeFile(path.join(codex, "config.toml"), "[mcp_servers.github]\ncommand = \"github\"\n");
    await writeFile(path.join(codex, "skills", "portable", "SKILL.md"), "skill\n");
    await writeFile(path.join(codex, "sessions", "history.jsonl"), "runtime\n");

    const bundle = await buildBundle(codex);

    expect(bundle.files.map((file) => file.path)).toEqual([
      "AGENTS.md",
      "auth.json",
      "config.toml",
      "skills/portable/SKILL.md"
    ]);
    expect(bundle.revision).toBe(computeRevision(bundle.files, bundle.sourceEnv));
    expect(() => verifyBundle(bundle)).not.toThrow();
  });
});

describe("overlay application", () => {
  it("fails same-name MCP overlays unless explicitly allowed", () => {
    const canonical = "[mcp_servers.github]\ncommand = \"canonical\"\n";
    const local = "[mcp_servers.github]\ncommand = \"local\"\n";
    expect(() => mergeTomlText(canonical, local, {})).toThrow(/Local MCP conflicts/);
    expect(mergeTomlText(canonical, local, { allowMcpOverrides: ["github"] })).toContain("command = \"local\"");
  });

  it("expands explicit path variables before writing generated config", () => {
    const canonical = "workspace = \"${workspaceRoot}\"\nunknown = \"${keepMe}\"\n";
    const merged = mergeTomlText(canonical, undefined, { pathVariables: { workspaceRoot: "C:\\\\work" } });
    expect(merged).toContain('workspace = "C:\\\\\\\\work"');
    expect(merged).toContain('unknown = "${keepMe}"');
  });

  it("keeps remote MCP servers unchanged", () => {
    const canonical = [
      "[mcp_servers.github]",
      'url = "https://api.githubcopilot.com/mcp/"',
      "",
      "[mcp_servers.github.headers]",
      'Authorization = "Bearer token"',
      ""
    ].join("\n");

    const merged = mergeTomlText(canonical, undefined, {});

    expect(merged).toContain('url = "https://api.githubcopilot.com/mcp/"');
    expect(merged).toContain('Authorization = "Bearer token"');
  });

  it("rewrites loopback MCP URLs to the enrolled master host", () => {
    const canonical = [
      "[mcp_servers.paper]",
      'url = "http://127.0.0.1:29979/mcp"',
      "",
      "[mcp_servers.browser.env]",
      'CAMOFOX_BASE_URL = "http://localhost:8080"',
      ""
    ].join("\n");

    const merged = mergeTomlText(canonical, undefined, { masterUrl: "http://master.tailnet.ts.net:17342" });

    expect(merged).toContain('url = "http://master.tailnet.ts.net:29979/mcp"');
    expect(merged).toContain('CAMOFOX_BASE_URL = "http://master.tailnet.ts.net:8080/"');
  });

  it("uses the quiet local runner for managed MCP commands", () => {
    const canonical = [
      "[mcp_servers.kagi-mcp]",
      'command = "/home/alice/.local/bin/kagi-mcp"',
      'args = ["--index", "/home/alice/.codex/indexes/search.db"]',
      "",
      "[mcp_servers.kagi-mcp.env]",
      'KAGI_API_KEY = "api-key"',
      'SEARCH_CONFIG = "/home/alice/.codex/search/config.json"',
      'SEARCH_CACHE = "/home/alice/.cache/search"',
      ""
    ].join("\n");

    const merged = mergeTomlText(
      canonical,
      undefined,
      { codexDir: "C:\\\\Users\\\\bob\\\\.codex" },
      "/home/alice/.codex"
    );

    expect(merged).toContain('command = "${node}"');
    expect(merged).toContain('args = [ "${codexportMcpRunner}", "mcp", "run", "kagi-mcp" ]');
    expect(merged).toContain('SEARCH_CONFIG = "C:\\\\\\\\Users\\\\\\\\bob\\\\\\\\.codex/search/config.json"');
    expect(merged).toContain('SEARCH_CACHE = "C:\\\\\\\\Users\\\\\\\\bob\\\\/.cache/search"');
  });

  it("uses kagi-cli mcp when only session-token auth is available", () => {
    const canonical = [
      "[mcp_servers.kagi-mcp]",
      'command = "/home/alice/.local/bin/kagi-mcp"',
      "",
      "[mcp_servers.kagi-mcp.env]",
      'KAGI_SESSION_TOKEN = "session-token"',
      ""
    ].join("\n");

    const merged = mergeTomlText(canonical, undefined, {}, "/home/alice/.codex");

    expect(merged).toContain('command = "${node}"');
    expect(merged).toContain('args = [ "${codexportMcpRunner}", "mcp", "run", "kagi-mcp" ]');
    expect(merged).toContain('KAGI_SESSION_TOKEN = "session-token"');
  });

  it("exports master Kagi env into generated follower MCP config", () => {
    const canonical = [
      "[mcp_servers.kagi-mcp]",
      'command = "/home/alice/.local/bin/kagi-mcp"',
      ""
    ].join("\n");

    const merged = mergeTomlText(canonical, undefined, {}, "/home/alice/.codex", { KAGI_API_KEY: "api-key" });

    expect(merged).toContain('command = "${node}"');
    expect(merged).toContain('args = [ "${codexportMcpRunner}", "mcp", "run", "kagi-mcp" ]');
    expect(merged).toContain('KAGI_API_KEY = "api-key"');
  });

  it("routes master-local MCP commands through the managed launcher", () => {
    const canonical = [
      "[mcp_servers.search]",
      'command = "/home/alice/.local/bin/search-mcp"',
      'args = ["--index", "/home/alice/.codex/indexes/search.db"]',
      ""
    ].join("\n");

    const merged = mergeTomlText(
      canonical,
      undefined,
      { codexDir: "C:\\\\Users\\\\bob\\\\.codex" },
      "/home/alice/.codex"
    );

    expect(merged).toContain('command = "${node}"');
    expect(merged).toContain('args = [ "${codexportMcpRunner}", "mcp", "run", "search" ]');
  });

  it("routes already portable MCP commands through the managed launcher", () => {
    const canonical = [
      "[mcp_servers.package]",
      'command = "npx"',
      'args = ["-y", "some-mcp"]',
      ""
    ].join("\n");

    const merged = mergeTomlText(canonical, undefined, {});

    expect(merged).toContain('command = "${node}"');
    expect(merged).toContain('args = [ "${codexportMcpRunner}", "mcp", "run", "package" ]');
  });

  it("adds common follower user-bin directories to command MCP PATH", () => {
    const canonical = [
      "[mcp_servers.dora]",
      'command = "/home/alice/.bun/bin/dora"',
      'args = ["mcp"]',
      ""
    ].join("\n");

    const merged = mergeTomlText(canonical, undefined, {}, "/home/alice/.codex");

    expect(merged).toContain('command = "${node}"');
    expect(merged).toContain('args = [ "${codexportMcpRunner}", "mcp", "run", "dora" ]');
    expect(merged).toContain('PATH = "');
    expect(merged).toContain(".bun/bin");
    expect(merged).toContain(".local/bin");
  });

  it("routes Kagi MCP through the managed launcher when no portable Kagi auth is available", () => {
    const canonical = [
      "[mcp_servers.kagi-mcp]",
      'command = "/home/alice/.local/bin/kagi-mcp"',
      ""
    ].join("\n");

    const merged = mergeTomlText(canonical, undefined, {}, "/home/alice/.codex");

    expect(merged).toContain('command = "${node}"');
    expect(merged).toContain('args = [ "${codexportMcpRunner}", "mcp", "run", "kagi-mcp" ]');
  });

  it("rewrites master-local project trust paths to follower paths", () => {
    const canonical = [
      "[projects.\"/home/alice/workspace/app\"]",
      'trust_level = "trusted"',
      "",
      "[projects.\"/home/alice/.codex\"]",
      'trust_level = "trusted"',
      "",
      "[hooks.state.\"/home/alice/.codex/hooks.json:stop:0:0\"]",
      'last_exit = 0',
      ""
    ].join("\n");

    const merged = mergeTomlText(
      canonical,
      undefined,
      { codexDir: "C:\\\\Users\\\\bob\\\\.codex" },
      "/home/alice/.codex"
    );

    expect(merged).toContain('[projects."C:\\\\\\\\Users\\\\\\\\bob\\\\/workspace/app"]');
    expect(merged).toContain('[projects."C:\\\\\\\\Users\\\\\\\\bob\\\\\\\\.codex"]');
    expect(merged).toContain('[hooks.state."C:\\\\\\\\Users\\\\\\\\bob\\\\\\\\.codex/hooks.json:stop:0:0"]');
  });

  it("rewrites node_modules MCP entrypoints to npx packages", () => {
    const canonical = [
      "[mcp_servers.web]",
      'command = "/home/alice/.nvm/versions/node/v24.0.0/bin/node"',
      'args = ["/home/alice/.nvm/versions/node/v24.0.0/lib/node_modules/@scope/web-mcp/dist/index.js", "--port", "3000"]',
      ""
    ].join("\n");

    const merged = mergeTomlText(canonical, undefined, {});

    expect(merged).toContain('command = "${node}"');
    expect(merged).toContain('args = [ "${codexportMcpRunner}", "mcp", "run", "web" ]');
  });

  it("rewrites workspace-local node MCP entrypoints to npx packages", () => {
    const canonical = [
      "[mcp_servers.reddit-mcp-buddy]",
      'command = "node"',
      'args = ["/home/alice/workspace/reddit-mcp-buddy/dist/cli.js"]',
      ""
    ].join("\n");

    const merged = mergeTomlText(canonical, undefined, {}, "/home/alice/.codex");

    expect(merged).toContain('command = "${node}"');
    expect(merged).toContain('args = [ "${codexportMcpRunner}", "mcp", "run", "reddit-mcp-buddy" ]');
  });

  it("backs up and generates config.toml with follower-local MCPs", async () => {
    const root = await tempDir("apply");
    const home = path.join(root, "home");
    const codex = path.join(home, ".codex");
    const state = path.join(home, ".codexport");
    await mkdir(codex, { recursive: true });
    await mkdir(state, { recursive: true });
    await writeFile(path.join(codex, "config.toml"), "old = true\n");
    await writeFile(path.join(state, "mcps.local.toml"), "[mcp_servers.local]\ncommand = \"local\"\n");
    const bundle = {
      version: 1 as const,
      builtAt: new Date().toISOString(),
      sourceRoot: codex,
      revision: "",
      files: [
        { path: "config.toml", mode: 0o644, kind: "file" as const, content: Buffer.from("[mcp_servers.github]\ncommand = \"github\"\n").toString("base64") },
        { path: "AGENTS.md", mode: 0o644, kind: "file" as const, content: Buffer.from("rules\n").toString("base64") }
      ]
    };
    bundle.revision = computeRevision(bundle.files);
    const ctx = defaultContext({ home, codexDir: codex });

    await applyBundle(ctx, bundle);

    const config = await readFile(path.join(codex, "config.toml"), "utf8");
    expect(config).toContain("[mcp_servers.github]");
    expect(config).toContain("[mcp_servers.local]");
    expect(await readFile(path.join(codex, "AGENTS.md"), "utf8")).toBe("rules\n");
  });

  it("copies transitive dependencies for the managed runner", async () => {
    const root = await tempDir("runner-deps");
    const home = path.join(root, "home");
    const codex = path.join(home, ".codex");
    const state = path.join(home, ".codexport");
    await mkdir(codex, { recursive: true });
    await mkdir(state, { recursive: true });
    const bundle = {
      version: 1 as const,
      builtAt: new Date().toISOString(),
      sourceRoot: codex,
      revision: "",
      files: [
        { path: "config.toml", mode: 0o644, kind: "file" as const, content: Buffer.from("[mcp_servers.github]\ncommand = \"github\"\n").toString("base64") }
      ]
    };
    bundle.revision = computeRevision(bundle.files);
    const ctx = defaultContext({ home, codexDir: codex });

    await applyBundle(ctx, bundle);

    await expect(readFile(path.join(state, "bin", "node_modules", "chokidar", "package.json"), "utf8")).resolves.toContain('"name": "chokidar"');
    await expect(readFile(path.join(state, "bin", "node_modules", "readdirp", "package.json"), "utf8")).resolves.toContain('"name": "readdirp"');
  });

  it("removes stale files only when a prior apply owned them", async () => {
    const root = await tempDir("stale");
    const home = path.join(root, "home");
    const codex = path.join(home, ".codex");
    const ctx = defaultContext({ home, codexDir: codex });
    const first = {
      version: 1 as const,
      builtAt: new Date().toISOString(),
      sourceRoot: codex,
      revision: "",
      files: [
        { path: "AGENTS.md", mode: 0o644, kind: "file" as const, content: Buffer.from("rules\n").toString("base64") },
        { path: "skills/old/SKILL.md", mode: 0o644, kind: "file" as const, content: Buffer.from("old\n").toString("base64") }
      ]
    };
    first.revision = computeRevision(first.files);
    const second = {
      ...first,
      revision: "",
      files: [
        { path: "AGENTS.md", mode: 0o644, kind: "file" as const, content: Buffer.from("rules\n").toString("base64") }
      ]
    };
    second.revision = computeRevision(second.files);

    await applyBundle(ctx, first);
    await writeFile(path.join(codex, "local-only.md"), "keep\n");
    await applyBundle(ctx, second);

    await expect(readFile(path.join(codex, "skills/old/SKILL.md"), "utf8")).rejects.toThrow();
    expect(await readFile(path.join(codex, "local-only.md"), "utf8")).toBe("keep\n");
  });

  it("replaces existing owned files that are not directly writable", async () => {
    const root = await tempDir("readonly");
    const home = path.join(root, "home");
    const codex = path.join(home, ".codex");
    const ctx = defaultContext({ home, codexDir: codex });
    const first = {
      version: 1 as const,
      builtAt: new Date().toISOString(),
      sourceRoot: codex,
      revision: "",
      files: [
        { path: "skill-libraries/code-review/repo.git/objects/pack/pack-example.idx", mode: 0o444, kind: "file" as const, content: Buffer.from("old\n").toString("base64") }
      ]
    };
    first.revision = computeRevision(first.files);
    const second = {
      ...first,
      revision: "",
      files: [
        { path: "skill-libraries/code-review/repo.git/objects/pack/pack-example.idx", mode: 0o444, kind: "file" as const, content: Buffer.from("new\n").toString("base64") }
      ]
    };
    second.revision = computeRevision(second.files);

    await applyBundle(ctx, first);
    const target = path.join(codex, "skill-libraries/code-review/repo.git/objects/pack/pack-example.idx");
    await chmod(target, 0o444);
    await applyBundle(ctx, second);

    expect(await readFile(target, "utf8")).toBe("new\n");
  });
});

describe("managed MCP launcher repair", () => {
  it("maps npm-backed MCP binaries to package launchers", () => {
    expect(portableMcpLauncher("grep-app", "/home/alice/.bun/bin/mcp-grep", [], undefined, {})).toEqual({
      command: "npx",
      args: ["-y", "@247arjun/mcp-grep"]
    });
    expect(portableMcpLauncher("mcp-vnc", "/home/alice/.nvm/bin/mcp-vnc", [], undefined, {})).toEqual({
      command: "npx",
      args: ["-y", "-p", "node-addon-api", "-p", "node-gyp", "-p", "@hrrrsn/mcp-vnc", "mcp-vnc"]
    });
    expect(portableMcpLauncher("qmd", "/home/alice/.nvm/bin/qmd", ["mcp"], undefined, {})).toEqual({
      command: "npx",
      args: ["-y", "-p", "@tobilu/qmd", "qmd", "mcp"]
    });
  });

  it("maps Python MCP binaries to uvx launchers with uv repair", () => {
    expect(portableMcpLauncher("discord-py-self", "/home/alice/.local/bin/discord-py-self-mcp", [], undefined, {})).toMatchObject({
      command: "uvx",
      args: ["--from", "git+https://github.com/Microck/discord.py-self-mcp.git", "discord-py-self-mcp"],
      repair: { whenMissing: "uvx", command: "__codexport_install_uv" }
    });
    expect(portableMcpLauncher("markitdown-mcp", "/home/alice/.local/bin/markitdown-mcp", [], undefined, {})).toMatchObject({
      command: "uvx",
      args: ["--from", "markitdown-mcp", "markitdown-mcp"],
      repair: { whenMissing: "uvx", command: "__codexport_install_uv" }
    });
  });

  it("maps local Rust MCP binaries to repairable launchers", () => {
    expect(portableMcpLauncher("fff", "/home/alice/.local/bin/fff-mcp", [], undefined, {})).toMatchObject({
      command: "fff-mcp",
      args: [],
      repair: { whenMissing: "fff-mcp" }
    });
    expect(portableMcpLauncher("gitquarry-mcp", "/home/alice/workspace/gitquarry-mcp/target/release/gitquarry-mcp", [], undefined, {})).toMatchObject({
      command: "gitquarry-mcp",
      args: [],
      repair: { whenMissing: "gitquarry-mcp" }
    });
  });
});

describe("hooks", () => {
  it("installs an idempotent SessionStart sync hook", async () => {
    const root = await tempDir("hook");
    const home = path.join(root, "home");
    const codex = path.join(home, ".codex");
    const ctx = defaultContext({ home, codexDir: codex });

    await installHook(ctx, 3000);
    await installHook(ctx, 3000);

    const hooks = JSON.parse(await readFile(path.join(codex, "hooks.json"), "utf8"));
    expect(hooks.SessionStart).toHaveLength(1);
    expect(hooks.SessionStart[0]).toMatchObject({
      name: "codexport-sync"
    });
    expect(hooks.SessionStart[0].command).toContain("codexport-mcp-run.mjs");
    expect(hooks.SessionStart[0].command).toContain("hook sync --timeout-ms 3000 --no-input");
  });

  it("replaces stale codexport hook commands regardless of name", async () => {
    const root = await tempDir("hook-stale");
    const home = path.join(root, "home");
    const codex = path.join(home, ".codex");
    const ctx = defaultContext({ home, codexDir: codex });
    await mkdir(codex, { recursive: true });
    await writeFile(path.join(codex, "hooks.json"), JSON.stringify({
      SessionStart: [
        { name: "old", command: "codexport sync --apply --timeout-ms 3000 --no-input" },
        { name: "keep", command: "echo keep" }
      ]
    }));

    await installHook(ctx, 3000);

    const hooks = JSON.parse(await readFile(path.join(codex, "hooks.json"), "utf8"));
    expect(hooks.SessionStart).toHaveLength(2);
    expect(hooks.SessionStart.map((hook: { name: string }) => hook.name).sort()).toEqual(["codexport-sync", "keep"]);
  });
});
