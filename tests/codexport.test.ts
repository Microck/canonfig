import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  sanitizeHooksJson,
  verifyBundle
} from "../src/index.js";

async function tempDir(name: string): Promise<string> {
  const root = path.join(tmpdir(), `codexport-${name}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

describe("join links", () => {
  it("round-trips durable join metadata", () => {
    const link = buildJoinLink("http://master.example.ts.net:17342", "abc123");
    expect(parseJoinLink(link)).toEqual({
      masterUrl: "http://master.example.ts.net:17342",
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

  it("exports generic npm and source MCP artifacts from command shapes", async () => {
    const root = await tempDir("mcp-artifacts");
    const home = path.join(root, "home");
    const codex = path.join(home, ".codex");
    const npmPackage = path.join(home, ".bun", "install", "global", "node_modules", "@scope", "tool");
    const npmBin = path.join(home, ".bun", "bin");
    const sourcePackage = path.join(home, "workspace", "local-mcp");
    await mkdir(path.join(npmPackage, "dist"), { recursive: true });
    await mkdir(npmBin, { recursive: true });
    await mkdir(path.join(sourcePackage, "dist"), { recursive: true });
    await mkdir(codex, { recursive: true });
    await writeFile(path.join(npmPackage, "package.json"), JSON.stringify({ name: "@scope/tool", bin: { "tool": "dist/index.js" } }));
    await writeFile(path.join(npmPackage, "dist", "index.js"), "#!/usr/bin/env node\n");
    await writeFile(path.join(npmBin, "tool"), "#!/usr/bin/env node\n");
    await chmod(path.join(npmBin, "tool"), 0o755);
    await writeFile(path.join(sourcePackage, "package.json"), JSON.stringify({ name: "local-mcp", dependencies: {} }));
    await writeFile(path.join(sourcePackage, "dist", "cli.js"), "console.log('ok')\n");
    await writeFile(path.join(codex, "config.toml"), [
      "[mcp_servers.npm_tool]",
      `command = "${path.join(npmBin, "tool")}"`,
      "",
      "[mcp_servers.source_tool]",
      'command = "node"',
      `args = ["${path.join(sourcePackage, "dist", "cli.js")}", "--stdio"]`,
      ""
    ].join("\n"));

    await rm(path.join(npmBin, "tool"), { force: true });
    await symlink(path.relative(npmBin, path.join(npmPackage, "dist", "index.js")), path.join(npmBin, "tool"));

    const bundle = await buildBundle(codex);

    expect(bundle.mcpArtifacts?.npm_tool).toMatchObject({
      kind: "npm",
      packages: ["@scope/tool"],
      binary: "tool",
      args: []
    });
    expect(bundle.mcpArtifacts?.source_tool).toMatchObject({
      kind: "node-source",
      command: "node",
      entrypoint: "dist/cli.js",
      args: ["--stdio"]
    });
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
      "",
      "[mcp_servers.github.env]",
      'IGNORED_TOKEN = "token"',
      ""
    ].join("\n");

    const merged = mergeTomlText(canonical, undefined, {}, undefined, { EXPORTED_TOKEN: "token" });

    expect(merged).toContain('url = "https://api.githubcopilot.com/mcp/"');
    expect(merged).toContain('Authorization = "Bearer token"');
    expect(merged).not.toContain("[mcp_servers.github.env]");
    expect(merged).not.toContain("IGNORED_TOKEN");
    expect(merged).not.toContain("EXPORTED_TOKEN");
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

    const merged = mergeTomlText(canonical, undefined, { masterUrl: "http://master.example.ts.net:17342" });

    expect(merged).toContain('url = "http://master.example.ts.net:29979/mcp"');
    expect(merged).toContain('CAMOFOX_BASE_URL = "http://master.example.ts.net:8080/"');
  });

  it("uses the quiet local runner for managed MCP commands", () => {
    const canonical = [
      "[mcp_servers.search]",
      'command = "/home/alice/.local/bin/search-mcp"',
      'args = ["--index", "/home/alice/.codex/indexes/search.db"]',
      "",
      "[mcp_servers.search.env]",
      'SEARCH_API_KEY = "api-key"',
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
    expect(merged).toContain('args = [ "${codexportMcpRunner}", "mcp", "run", "search" ]');
    expect(merged).toContain('SEARCH_CONFIG = "C:\\\\\\\\Users\\\\\\\\bob\\\\\\\\.codex/search/config.json"');
    expect(merged).toContain('SEARCH_CACHE = "C:\\\\\\\\Users\\\\\\\\bob\\\\/.cache/search"');
  });

  it("preserves explicit MCP env values", () => {
    const canonical = [
      "[mcp_servers.search]",
      'command = "/home/alice/.local/bin/search-mcp"',
      "",
      "[mcp_servers.search.env]",
      'SESSION_TOKEN = "session-token"',
      ""
    ].join("\n");

    const merged = mergeTomlText(canonical, undefined, {}, "/home/alice/.codex");

    expect(merged).toContain('command = "${node}"');
    expect(merged).toContain('args = [ "${codexportMcpRunner}", "mcp", "run", "search" ]');
    expect(merged).toContain('SESSION_TOKEN = "session-token"');
  });

  it("exports configured master env into generated follower MCP config", () => {
    const canonical = [
      "[mcp_servers.search]",
      'command = "/home/alice/.local/bin/search-mcp"',
      ""
    ].join("\n");

    const merged = mergeTomlText(canonical, undefined, {}, "/home/alice/.codex", { SEARCH_API_KEY: "api-key" });

    expect(merged).toContain('command = "${node}"');
    expect(merged).toContain('args = [ "${codexportMcpRunner}", "mcp", "run", "search" ]');
    expect(merged).toContain('SEARCH_API_KEY = "api-key"');
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
      "[mcp_servers.local-tool]",
      'command = "/home/alice/.bun/bin/local-tool"',
      'args = ["mcp"]',
      ""
    ].join("\n");

    const merged = mergeTomlText(canonical, undefined, {}, "/home/alice/.codex");

    expect(merged).toContain('command = "${node}"');
    expect(merged).toContain('args = [ "${codexportMcpRunner}", "mcp", "run", "local-tool" ]');
    expect(merged).toContain('PATH = "');
    expect(merged).toContain(".bun/bin");
    expect(merged).toContain(".local/bin");
  });

  it("routes command MCPs through the managed launcher when env is empty", () => {
    const canonical = [
      "[mcp_servers.search]",
      'command = "/home/alice/.local/bin/search-mcp"',
      ""
    ].join("\n");

    const merged = mergeTomlText(canonical, undefined, {}, "/home/alice/.codex");

    expect(merged).toContain('command = "${node}"');
    expect(merged).toContain('args = [ "${codexportMcpRunner}", "mcp", "run", "search" ]');
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
      "[mcp_servers.local-package]",
      'command = "node"',
      'args = ["/home/alice/workspace/local-package/dist/cli.js"]',
      ""
    ].join("\n");

    const merged = mergeTomlText(canonical, undefined, {}, "/home/alice/.codex");

    expect(merged).toContain('command = "${node}"');
    expect(merged).toContain('args = [ "${codexportMcpRunner}", "mcp", "run", "local-package" ]');
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
  it("preserves already portable package launchers", () => {
    expect(portableMcpLauncher("package", "npx", ["-y", "some-mcp"], undefined, {})).toEqual({
      command: "npx",
      args: ["-y", "some-mcp"]
    });
    expect(portableMcpLauncher("package", "bunx", ["some-mcp", "--stdio"], undefined, {})).toEqual({
      command: "bunx",
      args: ["some-mcp", "--stdio"]
    });
  });

  it("maps node_modules entrypoints to their owning package", () => {
    expect(portableMcpLauncher(
      "web",
      "node",
      ["/home/alice/.nvm/versions/node/v24.0.0/lib/node_modules/@scope/web-mcp/dist/index.js", "--port", "3000"],
      undefined,
      {}
    )).toEqual({
      command: "npx",
      args: ["-y", "@scope/web-mcp", "--port", "3000"]
    });
  });

  it("does not infer packages from MCP names or binary names", () => {
    expect(portableMcpLauncher("search", "/home/alice/.local/bin/search-mcp", [], undefined, {})).toBeUndefined();
  });
});

describe("hooks", () => {
  it("removes Windows-incompatible nested command hooks", () => {
    const sanitized = JSON.parse(sanitizeHooksJson(JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: "bash ~/.codex/hooks/setup.sh", timeout: 10 },
              { type: "command", command: "node C:/Users/Alice/.codexport/bin/hook.mjs", timeout: 10 }
            ]
          }
        ],
        Stop: [
          {
            hooks: [
              { type: "command", command: "python3 ~/.codex/hooks/stop.py", timeout: 10 }
            ]
          }
        ]
      },
      SessionStart: [
        { name: "codexport-sync", command: "node hook.mjs hook sync", timeoutMs: 3000 },
        { name: "other", command: "node other.mjs", timeoutMs: 3000 }
      ]
    }), "win32"));

    expect(sanitized.hooks.SessionStart).toEqual([
      {
        hooks: [
          { type: "command", command: "node C:/Users/Alice/.codexport/bin/hook.mjs", timeout: 10 }
        ]
      }
    ]);
    expect(sanitized.hooks.Stop).toEqual([]);
    expect(sanitized.SessionStart).toEqual([
      { name: "other", command: "node other.mjs", timeoutMs: 3000 }
    ]);
  });

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
    expect(hooks.SessionStart[0].command).toContain("--quiet hook sync --timeout-ms 3000 --no-input");
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
      ],
      Stop: [
        { name: "old-stop", command: "node ~/.codexport/bin/codexport-mcp-run.mjs hook sync" }
      ]
    }));

    await installHook(ctx, 3000);

    const hooks = JSON.parse(await readFile(path.join(codex, "hooks.json"), "utf8"));
    expect(hooks.SessionStart).toHaveLength(2);
    expect(hooks.SessionStart.map((hook: { name: string }) => hook.name).sort()).toEqual(["codexport-sync", "keep"]);
    expect(hooks.Stop).toEqual([]);
  });
});
