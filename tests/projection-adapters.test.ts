import { stripTypeScriptTypes } from "node:module";
import path from "node:path";

import { Predicate } from "effect";
import { describe, expect, it } from "vitest";

import { configPathSegments, configPathsOverlap } from "../src/domain/config-path.ts";
import type { ConfigValue } from "../src/domain/resource.ts";
import { adapterFor, BUILTIN_ADAPTERS } from "../src/projection/adapters/index.ts";
import type {
  HarnessAdapter,
  HarnessLayout,
  HarnessProjection,
  ProjectionRuntime,
  RootContext,
} from "../src/projection/harness.ts";
import { type CanonicalModel, TARGET_IDS, type TargetId } from "../src/projection/model.ts";
import { ampPluginSource } from "../src/projection/templates/runtime.ts";

// Goldens and invariants for every harness adapter. Adapters are pure, so
// these tests run them against a fixed model and fixed machine directories.

const HOME = "/home/user";
const FOLDER = `${HOME}/.canonfig`;
const text = (value: string) => new TextEncoder().encode(value);

const model: CanonicalModel = {
  folder: FOLDER,
  harnesses: [...TARGET_IDS],
  instructions: "# Instructions\n\nRun the tests before you finish.",
  rules: [
    {
      id: "source", description: "Source rules", paths: ["src/**"], activation: "path",
      content: "Keep changes scoped.", source: `${FOLDER}/rules/source.md`,
    },
    { id: "style", paths: [], activation: "always", content: "Prefer small functions.", source: `${FOLDER}/rules/style.md` },
  ],
  skills: [
    {
      name: "repository-checks",
      description: "Run repository checks.",
      files: [
        { path: "SKILL.md", content: text("---\nname: repository-checks\ndescription: Run repository checks.\n---\nRun the checks.\n"), executable: false },
        { path: "references/notes.md", content: text("Notes.\n"), executable: false },
        { path: "scripts/check.sh", content: text("#!/bin/sh\nexit 0\n"), executable: true },
      ],
    },
    {
      name: "release-notes",
      description: "Write release notes.",
      files: [{ path: "SKILL.md", content: text("---\nname: release-notes\ndescription: Write release notes.\n---\nWrite them.\n"), executable: false }],
    },
  ],
  agents: [{
    id: "reviewer", description: "Review changes", model: "inherit",
    tools: ["read", "search", "mcp"], writable: false, content: "Return severity-ranked findings.",
  }],
  commands: [{ id: "release-check", description: "Check release readiness", argumentHint: "[scope]", content: "Inspect the current release." }],
  hooks: [
    {
      id: "guard-shell", event: "before_tool",
      matcher: { capabilities: ["shell"], tools: [], inputRegex: "git\\s+push" },
      run: ["node", `${FOLDER}/hooks/guard.mjs`], timeoutMs: 5_000, onFailure: "block",
    },
    {
      id: "greet", event: "session_start", matcher: { capabilities: [], tools: [] },
      run: [`${FOLDER}/hooks/greet.sh`], timeoutMs: 2_000, onFailure: "warn",
    },
  ],
  mcp: [
    ["docs", { transport: "streamable-http", url: "https://example.invalid/mcp", headers: { Authorization: { fromEnv: "DOCS_MCP_TOKEN" } } }],
    ["local", { transport: "stdio", command: "node", args: ["server.mjs"], env: { API_KEY: { fromEnv: "API_KEY" } } }],
  ],
  settings: {
    codex: [{ path: "model_reasoning_effort", value: "high" }],
    "claude-code": [{ path: "model", value: "opus" }],
  },
};

const runtime: ProjectionRuntime = { folder: FOLDER, hookRunner: `${FOLDER}/.runtime/hook-runner.mjs`, platform: "linux" };

function posixContext(environment: Readonly<Record<string, string>>): RootContext {
  return {
    platform: "linux",
    home: HOME,
    appData: environment.XDG_CONFIG_HOME ?? `${HOME}/.config`,
    environment: (name) => environment[name],
    join: (...segments) => path.posix.join(...segments),
  };
}

it("loads distinct Amp agents whose IDs differ by hyphens and underscores", async () => {
  const ids = ["review-fast", "review_fast", "review_hfast"];
  const source = ampPluginSource(runtime.hookRunner, [], ids.map((id) => ({
    agent: { ...model.agents[0]!, id }, tools: [],
  })), []);
  const javascript = stripTypeScriptTypes(source);
  // The generated module exists only at runtime; load it to catch syntax collisions.
  const plugin = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  const tools = new Map<string, { execute: (input: { request: string }, context: { thread: { id: string } }) => Promise<string> }>();
  plugin.default({
    createAgent: ({ name }: { name: string }) => ({ run: async () => ({ text: name }) }),
    registerTool: (tool: { name: string; execute: (input: { request: string }, context: { thread: { id: string } }) => Promise<string> }) => {
      expect(tools.has(tool.name)).toBe(false);
      tools.set(tool.name, tool);
    },
  });
  expect(await Promise.all([...tools.values()].map((tool) => tool.execute({ request: "Review" }, { thread: { id: "review-thread" } }))))
    .toEqual(ids);
});

const plain = posixContext({});
const overridden = posixContext({
  CODEX_HOME: `${HOME}/alt/codex`,
  CLAUDE_CONFIG_DIR: `${HOME}/alt/claude`,
  XDG_CONFIG_HOME: `${HOME}/alt/xdg`,
  XDG_DATA_HOME: `${HOME}/alt/data`,
  PI_CONFIG_DIR: ".omp-work",
  OMP_PROFILE: "work",
  PI_CODING_AGENT_DIR: `${HOME}/alt/pi`,
  CURSOR_CONFIG_DIR: `${HOME}/alt/cursor`,
  GROK_HOME: `${HOME}/alt/grok`,
  COPILOT_HOME: `${HOME}/alt/copilot`,
  KIMI_CODE_HOME: `${HOME}/alt/kimi`,
  KILO_CONFIG_DIR: `${HOME}/alt/kilo`,
  HERMES_HOME: `${HOME}/alt/hermes`,
  QWEN_HOME: `${HOME}/alt/qwen`,
});

const SHARED_SKILLS: ReadonlyArray<TargetId> = ["codex", "amp", "cursor", "devin", "grok-build", "kimi", "kilo", "qwen"];
const SURFACE_ID = /^[A-Za-z0-9._-]+$/u;

interface AdapterRun {
  readonly layout: HarnessLayout;
  readonly projection: HarnessProjection;
}

function run(adapter: HarnessAdapter, context: RootContext): AdapterRun {
  const layout = adapter.layout(context, model);
  return { layout, projection: adapter.project(model, layout, runtime) };
}

const relative = (target: string) => (target.startsWith(`${HOME}/`) ? `~/${target.slice(HOME.length + 1)}` : target);
const indent = (value: string, prefix: string) =>
  value.trimEnd().split("\n").map((line) => (line ? `${prefix}${line}` : "")).join("\n");
const decode = (content: string | Uint8Array) => (content instanceof Uint8Array ? new TextDecoder().decode(content) : content);

/** A readable golden of one adapter's layout and projection. */
function golden(harness: TargetId): string {
  const { layout, projection } = run(adapterFor(harness), plain);
  const lines = [`root ${relative(layout.root)}${layout.sharedSkills ? " (shared skills)" : ""}`];
  for (const surface of layout.surfaces) {
    const details = surface.kind === "config"
      ? ` ${surface.format} [${surface.keys.join(", ")}]${surface.settings ? ` settings reserved [${surface.settings.reserved.join(", ")}]` : ""}${surface.alternatives ? ` or ${surface.alternatives.map(relative).join(", ")}` : ""}`
      : "";
    lines.push(`${surface.kind} ${surface.id} ${relative(surface.target)}${details}`);
  }
  lines.push(`never ${layout.neverTouch.map(relative).join(", ")}`);
  for (const entry of projection.contents) {
    lines.push(`== ${entry.kind} ${entry.surface}`);
    if (entry.kind === "file") lines.push(indent(decode(entry.content), "  "));
    if (entry.kind === "directory") {
      for (const file of entry.files) {
        lines.push(`  -- ${file.path}${file.executable ? " (executable)" : ""}`, indent(decode(file.content), "    "));
      }
    }
    if (entry.kind === "config") {
      for (const key of entry.keys) lines.push(`  ${key.path} = ${indent(JSON.stringify(key.value, null, 2), "  ").trimStart()}`);
    }
  }
  for (const diagnostic of projection.diagnostics) lines.push(`! ${diagnostic.level} ${diagnostic.code}: ${diagnostic.message}`);
  return `\n${lines.join("\n")}\n`;
}

/** Fails on null, undefined or a non-finite number anywhere in a config value; TOML has none of them. */
function assertPortable(value: ConfigValue, where: string): void {
  expect(value, where).not.toBeNull();
  expect(value, where).toBeDefined();
  if (Predicate.isNumber(value)) expect(Number.isFinite(value), where).toBe(true);
  if (Predicate.isObject(value)) {
    for (const [key, item] of Object.entries(value)) assertPortable(item, `${where}.${key}`);
  }
}

const nested = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`);

describe("adapter invariants", () => {
  it("registers one adapter per harness, in TARGET_IDS order", () => {
    expect(BUILTIN_ADAPTERS.map((adapter) => adapter.descriptor.id)).toEqual([...TARGET_IDS]);
    for (const adapter of BUILTIN_ADAPTERS) {
      expect(adapter.descriptor.verifiedAt).toBe("2026-11-03");
      expect(adapter.descriptor.docs.length).toBeGreaterThan(0);
    }
  });

  describe.each([["default roots", plain], ["environment overrides", overridden]] as const)("%s", (_label, context) => {
    it.each(TARGET_IDS.map((id) => [id]))("%s keeps its contract", (harness) => {
      const adapter = adapterFor(harness);
      const { layout, projection } = run(adapter, context);
      const targets = [layout.root, ...layout.surfaces.map((surface) => surface.target)];

      expect(layout.sharedSkills).toBe(SHARED_SKILLS.includes(harness));
      for (const target of [...targets, ...layout.neverTouch]) expect(target.startsWith(`${HOME}/`), target).toBe(true);
      for (const surface of layout.surfaces) {
        expect(surface.id).toMatch(SURFACE_ID);
        for (const state of layout.neverTouch) {
          expect(nested(surface.target, state) || nested(state, surface.target), `${surface.target} / ${state}`).toBe(false);
        }
      }
      expect(new Set(layout.surfaces.map((surface) => surface.id)).size).toBe(layout.surfaces.length);

      const settings = layout.surfaces.filter((surface) => surface.kind === "config" && surface.settings !== undefined);
      expect(settings).toHaveLength(harness === "hermes" ? 0 : 1);
      for (const surface of settings) {
        if (surface.kind !== "config") continue;
        for (const key of surface.keys) {
          for (const reserved of surface.settings?.reserved ?? []) expect(configPathsOverlap(key, reserved)).toBe(false);
        }
      }

      for (const entry of projection.contents) {
        const surface = layout.surfaces.find((candidate) => candidate.id === entry.surface);
        expect(surface?.kind, entry.surface).toBe(entry.kind);
        if (entry.kind === "directory") {
          for (const file of entry.files) {
            expect(file.path.startsWith("/") || file.path.includes("\\") || file.path.split("/").includes(".."), file.path).toBe(false);
          }
        }
        if (entry.kind === "config" && surface?.kind === "config") {
          for (const key of entry.keys) {
            expect(surface.keys, key.path).toContain(key.path);
            configPathSegments(key.path);
            assertPortable(key.value, `${harness}:${entry.surface}:${key.path}`);
          }
        }
      }
      for (const diagnostic of projection.diagnostics) expect(diagnostic.harness).toBe(harness);
    });
  });

  it("reserves the never-touch keys the ADR lists inside settings files", () => {
    const reserved = (harness: TargetId) =>
      adapterFor(harness).layout(plain, model).surfaces.flatMap((surface) =>
        surface.kind === "config" ? surface.settings?.reserved ?? [] : []);
    expect(reserved("opencode")).toContain("provider");
    expect(reserved("kilo")).toContain("provider");
    expect(reserved("grok-build")).toContain("model.*.api_key");
    expect(reserved("antigravity")).toEqual(expect.arrayContaining(["trustedWorkspaces", "gcp"]));
    expect(reserved("kimi")).toContain("providers");
  });

  it("resolves environment overrides", () => {
    const roots = Object.fromEntries(TARGET_IDS.map((id) => [id, relative(adapterFor(id).layout(overridden, model).root)]));
    expect(roots).toMatchInlineSnapshot(`
      {
        "amp": "~/.config/amp",
        "antigravity": "~/.gemini",
        "claude-code": "~/alt/claude",
        "codex": "~/alt/codex",
        "copilot-cli": "~/alt/copilot",
        "cursor": "~/alt/cursor",
        "devin": "~/.config/devin",
        "factory-droid": "~/.factory",
        "grok-build": "~/alt/grok",
        "hermes": "~/alt/hermes",
        "kilo": "~/alt/kilo",
        "kimi": "~/alt/kimi",
        "oh-my-pi": "~/.omp-work/profiles/work/agent",
        "opencode": "~/alt/xdg/opencode",
        "pi": "~/alt/pi",
        "qwen": "~/alt/qwen",
      }
    `);
    const target = (harness: TargetId, id: string) =>
      relative(adapterFor(harness).layout(overridden, model).surfaces.find((surface) => surface.id === id)!.target);
    expect([target("claude-code", "mcp"), target("amp", "plugin"), target("cursor", "settings")]).toMatchInlineSnapshot(`
      [
        "~/alt/claude/.claude.json",
        "~/alt/xdg/amp/plugins/canonfig.ts",
        "~/alt/cursor/cli-config.json",
      ]
    `);
  });

  it("uses Windows directories for Devin", () => {
    const windows: RootContext = {
      platform: "windows",
      home: "C:\\Users\\operator",
      appData: "C:\\Users\\operator\\AppData\\Roaming",
      environment: () => undefined,
      join: (...segments) => path.win32.join(...segments),
    };
    const layout = adapterFor("devin").layout(windows, model);
    expect(layout.root).toBe("C:\\Users\\operator\\AppData\\Roaming\\devin");
    expect(layout.neverTouch).toContain("C:\\Users\\operator\\AppData\\Roaming\\devin\\credentials.toml");
    expect(layout.surfaces.find((surface) => surface.id === "rules")?.target).toBe("C:\\Users\\operator\\.devin\\rules");
  });
});

describe("adapter goldens", () => {
  it("codex", () => expect(golden("codex")).toMatchInlineSnapshot(`
    "
    root ~/.codex (shared skills)
    file instructions ~/.codex/AGENTS.md
    directory agents ~/.codex/agents
    file hooks ~/.codex/hooks.json
    config config ~/.codex/config.toml toml [mcp_servers] settings reserved []
    never ~/.codex/auth.json, ~/.codex/history.jsonl, ~/.codex/log, ~/.codex/sessions, ~/.codex/rules
    == file instructions
      # Instructions

      Run the tests before you finish.

      ## Canonfig rules

      Read a rule file before doing work it covers:

      - \`/home/user/.canonfig/rules/source.md\` (applies to \`src/**\`): Source rules
      - \`/home/user/.canonfig/rules/style.md\` (always applies)
    == directory agents
      -- reviewer.toml
        name = "reviewer"
        description = "Review changes"
        developer_instructions = "Return severity-ranked findings."
    == file hooks
      {
        "hooks": {
          "PreToolUse": [
            {
              "matcher": ".*",
              "hooks": [
                {
                  "type": "command",
                  "command": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook guard-shell --target codex --event before_tool",
                  "timeout": 5
                }
              ]
            }
          ],
          "SessionStart": [
            {
              "matcher": ".*",
              "hooks": [
                {
                  "type": "command",
                  "command": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook greet --target codex --event session_start",
                  "timeout": 2
                }
              ]
            }
          ]
        }
      }
    == config config
      mcp_servers = {
        "docs": {
          "url": "https://example.invalid/mcp",
          "env_http_headers": {
            "Authorization": "DOCS_MCP_TOKEN"
          }
        },
        "local": {
          "command": "node",
          "args": [
            "server.mjs"
          ],
          "env_vars": [
            "API_KEY"
          ]
        }
      }
    ! warning FEATURE_UNSUPPORTED: codex has no global commands surface: Codex has no global slash-command directory. The commands were not projected.
    ! warning AGENT_OPTION_UNSUPPORTED: Codex custom agents inherit the parent sandbox, so read-only agent reviewer can still write.
    "
  `));
  it("claude-code", () => expect(golden("claude-code")).toMatchInlineSnapshot(`
    "
    root ~/.claude
    file instructions ~/.claude/CLAUDE.md
    directory rules ~/.claude/rules
    directory skills ~/.claude/skills
    directory agents ~/.claude/agents
    directory commands ~/.claude/commands
    config settings ~/.claude/settings.json json [hooks] settings reserved []
    config mcp ~/.claude.json json [mcpServers]
    never ~/.claude/.credentials.json, ~/.claude/projects, ~/.claude/sessions, ~/.claude/history.jsonl, ~/.claude/file-history, ~/.claude/cache
    == file instructions
      # Instructions

      Run the tests before you finish.
    == directory rules
      -- source.md
        ---
        paths:
          - src/**
        ---
        Keep changes scoped.
      -- style.md
        Prefer small functions.
    == directory skills
      -- repository-checks/SKILL.md
        ---
        name: repository-checks
        description: Run repository checks.
        ---
        Run the checks.
      -- repository-checks/references/notes.md
        Notes.
      -- repository-checks/scripts/check.sh (executable)
        #!/bin/sh
        exit 0
      -- release-notes/SKILL.md
        ---
        name: release-notes
        description: Write release notes.
        ---
        Write them.
    == directory agents
      -- reviewer.md
        ---
        name: reviewer
        description: Review changes
        tools:
          - Read
          - Grep
          - Glob
          - mcp__docs
          - mcp__local
        ---
        Return severity-ranked findings.
    == directory commands
      -- release-check.md
        ---
        description: Check release readiness
        argument-hint: "[scope]"
        ---
        Inspect the current release.
    == config settings
      hooks = {
        "PreToolUse": [
          {
            "matcher": ".*",
            "hooks": [
              {
                "type": "command",
                "command": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook guard-shell --target claude-code --event before_tool",
                "timeout": 5
              }
            ]
          }
        ],
        "SessionStart": [
          {
            "matcher": ".*",
            "hooks": [
              {
                "type": "command",
                "command": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook greet --target claude-code --event session_start",
                "timeout": 2
              }
            ]
          }
        ]
      }
    == config mcp
      mcpServers = {
        "docs": {
          "type": "http",
          "url": "https://example.invalid/mcp",
          "headers": {
            "Authorization": "\${DOCS_MCP_TOKEN}"
          }
        },
        "local": {
          "type": "stdio",
          "command": "node",
          "args": [
            "server.mjs"
          ],
          "env": {
            "API_KEY": "\${API_KEY}"
          }
        }
      }
    "
  `));
  it("amp", () => expect(golden("amp")).toMatchInlineSnapshot(`
    "
    root ~/.config/amp (shared skills)
    file instructions ~/.config/amp/AGENTS.md
    file plugin ~/.config/amp/plugins/canonfig.ts
    config settings ~/.config/amp/settings.json json [amp\\.mcpServers] settings reserved [] or ~/.config/amp/settings.jsonc
    never ~/.local/share/amp/secrets.json, ~/.local/share/amp/threads, ~/.cache/amp
    == file instructions
      # Instructions

      Run the tests before you finish.

      ## Canonfig rules

      Read a rule file before doing work it covers:

      - \`/home/user/.canonfig/rules/source.md\` (applies to \`src/**\`): Source rules
      - \`/home/user/.canonfig/rules/style.md\` (always applies)
    == file plugin
      // Generated by Canonfig. Edit hooks in ~/.canonfig/canonfig.jsonc instead.
      import { execFile } from "node:child_process";
      import type { PluginAPI } from "@ampcode/plugin";

      const runner = "/home/user/.canonfig/.runtime/hook-runner.mjs";
      function runCanonfig(hookId, event, payload, timeoutMs) {
        return new Promise((resolve) => {
          const child = execFile(
            "node",
            [runner, "--hook", hookId, "--target", "amp", "--event", event],
            {
              cwd: process.cwd(),
              encoding: "utf8",
              timeout: Math.max(1, timeoutMs + 1000),
              maxBuffer: 16 * 1024 * 1024,
            },
            (error, stdout, stderr) => {
              const reason = String(stderr || stdout || error?.message || "Blocked by Canonfig hook").trim();
              resolve({ blocked: error !== null, reason });
            },
          );
          child.stdin?.on("error", () => {});
          child.stdin?.end(JSON.stringify(payload ?? {}));
        });
      }

      export default function canonfig(amp: PluginAPI) {
        amp.on("tool.call", async (payload) => { const result = await runCanonfig("guard-shell", "before_tool", payload, 5000); if (result.blocked) return { action: "reject-and-continue", message: result.reason }; });
        amp.on("session.start", async (payload) => { const result = await runCanonfig("greet", "session_start", payload, 2000); if (result.blocked) throw new Error(result.reason); });
        const canonfigAgent_reviewer = amp.createAgent({
          name: "reviewer",
          instructions: "Return severity-ranked findings.",
          tools: ["read","grep","glob","mcp"],
        });
        amp.registerTool({
          name: "canonfig_reviewer_subagent",
          description: "Review changes",
          inputSchema: { type: "object", properties: { request: { type: "string" } }, required: ["request"] },
          async execute(input, ctx) {
            const request = typeof input.request === "string" ? input.request : "";
            if (!request.trim()) return "Missing subagent request.";
            const result = await canonfigAgent_reviewer.run(request, { parentThreadID: ctx.thread.id, timeoutMs: 10 * 60 * 1000 });
            return result.text;
          },
        });
        {
          const prompt = "Inspect the current release.";
          amp.registerCommand("release-check", { title: "release-check", description: "Check release readiness" }, async (ctx) => {
            if (!ctx.thread) { await ctx.ui.notify("Open a thread first, then run this command again."); return; }
            const input = await ctx.ui.input({ title: "[scope]" });
            if (input === undefined || input === null) return;
            const content = input.trim() ? \`\${prompt}\\n\\nArguments: \${input.trim()}\` : prompt;
            await ctx.thread.append([{ type: "user-message", content }]);
          });
        }
      }
    == config settings
      amp\\.mcpServers = {
        "docs": {
          "url": "https://example.invalid/mcp",
          "headers": {
            "Authorization": "\${DOCS_MCP_TOKEN}"
          }
        },
        "local": {
          "command": "node",
          "args": [
            "server.mjs"
          ],
          "env": {
            "API_KEY": "\${API_KEY}"
          }
        }
      }
    "
  `));
  it("oh-my-pi", () => expect(golden("oh-my-pi")).toMatchInlineSnapshot(`
    "
    root ~/.omp/agent
    file instructions ~/.omp/agent/AGENTS.md
    directory rules ~/.omp/agent/rules
    directory skills ~/.omp/agent/skills
    directory agents ~/.omp/agent/agents
    directory commands ~/.omp/agent/commands
    file extension ~/.omp/agent/extensions/canonfig.ts
    config mcp ~/.omp/agent/mcp.json json [mcpServers]
    config settings ~/.omp/agent/config.yml yaml [] settings reserved [] or ~/.omp/agent/config.yaml
    never ~/.omp/agent/agent.db, ~/.omp/agent/history.db, ~/.omp/agent/models.db, ~/.omp/agent/sessions, ~/.omp/agent/blobs, ~/.omp/agent/memories, ~/.omp/logs, ~/.omp/install-id
    == file instructions
      # Instructions

      Run the tests before you finish.
    == directory rules
      -- source.md
        ---
        description: Source rules
        globs:
          - src/**
        alwaysApply: false
        ---
        Keep changes scoped.
      -- style.md
        ---
        description: "Canonfig rule: style"
        alwaysApply: true
        ---
        Prefer small functions.
    == directory skills
      -- repository-checks/SKILL.md
        ---
        name: repository-checks
        description: Run repository checks.
        ---
        Run the checks.
      -- repository-checks/references/notes.md
        Notes.
      -- repository-checks/scripts/check.sh (executable)
        #!/bin/sh
        exit 0
      -- release-notes/SKILL.md
        ---
        name: release-notes
        description: Write release notes.
        ---
        Write them.
    == directory agents
      -- reviewer.md
        ---
        name: reviewer
        description: Review changes
        tools:
          - read
          - search
          - find
          - mcp
        ---
        Return severity-ranked findings.
    == directory commands
      -- release-check.md
        ---
        description: Check release readiness
        argument-hint: "[scope]"
        ---
        Inspect the current release.
    == file extension
      // Generated by Canonfig. Edit hooks in ~/.canonfig/canonfig.jsonc instead.
      import { execFile } from "node:child_process";
      import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

      const runner = "/home/user/.canonfig/.runtime/hook-runner.mjs";
      function runCanonfig(hookId, event, payload, timeoutMs) {
        return new Promise((resolve) => {
          const child = execFile(
            "node",
            [runner, "--hook", hookId, "--target", "oh-my-pi", "--event", event],
            {
              cwd: process.cwd(),
              encoding: "utf8",
              timeout: Math.max(1, timeoutMs + 1000),
              maxBuffer: 16 * 1024 * 1024,
            },
            (error, stdout, stderr) => {
              const reason = String(stderr || stdout || error?.message || "Blocked by Canonfig hook").trim();
              resolve({ blocked: error !== null, reason });
            },
          );
          child.stdin?.on("error", () => {});
          child.stdin?.end(JSON.stringify(payload ?? {}));
        });
      }

      export default function canonfig(pi: ExtensionAPI) {
        pi.on("tool_call", async (payload) => { const result = await runCanonfig("guard-shell", "before_tool", payload, 5000); if (result.blocked) return { block: true, reason: result.reason }; });
        pi.on("session_start", async (payload) => { const result = await runCanonfig("greet", "session_start", payload, 2000); if (result.blocked) throw new Error(result.reason); });
      }
    == config mcp
      mcpServers = {
        "docs": {
          "type": "http",
          "url": "https://example.invalid/mcp",
          "headers": {
            "Authorization": "\${DOCS_MCP_TOKEN}"
          }
        },
        "local": {
          "type": "stdio",
          "command": "node",
          "args": [
            "server.mjs"
          ],
          "env": {
            "API_KEY": "\${API_KEY}"
          }
        }
      }
    "
  `));
  it("pi", () => expect(golden("pi")).toMatchInlineSnapshot(`
    "
    root ~/.pi/agent
    file instructions ~/.pi/agent/AGENTS.md
    directory skills ~/.pi/agent/skills
    directory prompts ~/.pi/agent/prompts
    file extension ~/.pi/agent/extensions/canonfig.ts
    config mcp ~/.pi/agent/mcp.json json [mcpServers]
    config settings ~/.pi/agent/settings.json json [] settings reserved []
    never ~/.pi/agent/auth.json, ~/.pi/agent/mcp-auth.json, ~/.pi/agent/models.json, ~/.pi/agent/sessions, ~/.pi/agent/logs
    == file instructions
      # Instructions

      Run the tests before you finish.

      ## Canonfig rules

      Read a rule file before doing work it covers:

      - \`/home/user/.canonfig/rules/source.md\` (applies to \`src/**\`): Source rules
      - \`/home/user/.canonfig/rules/style.md\` (always applies)
    == directory skills
      -- repository-checks/SKILL.md
        ---
        name: repository-checks
        description: Run repository checks.
        ---
        Run the checks.
      -- repository-checks/references/notes.md
        Notes.
      -- repository-checks/scripts/check.sh (executable)
        #!/bin/sh
        exit 0
      -- release-notes/SKILL.md
        ---
        name: release-notes
        description: Write release notes.
        ---
        Write them.
    == directory prompts
      -- release-check.md
        ---
        description: Check release readiness
        argument-hint: "[scope]"
        ---
        Inspect the current release.
    == file extension
      // Generated by Canonfig. Edit hooks in ~/.canonfig/canonfig.jsonc instead.
      import { execFile } from "node:child_process";
      import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

      const runner = "/home/user/.canonfig/.runtime/hook-runner.mjs";
      function runCanonfig(hookId, event, payload, timeoutMs) {
        return new Promise((resolve) => {
          const child = execFile(
            "node",
            [runner, "--hook", hookId, "--target", "pi", "--event", event],
            {
              cwd: process.cwd(),
              encoding: "utf8",
              timeout: Math.max(1, timeoutMs + 1000),
              maxBuffer: 16 * 1024 * 1024,
            },
            (error, stdout, stderr) => {
              const reason = String(stderr || stdout || error?.message || "Blocked by Canonfig hook").trim();
              resolve({ blocked: error !== null, reason });
            },
          );
          child.stdin?.on("error", () => {});
          child.stdin?.end(JSON.stringify(payload ?? {}));
        });
      }

      export default function canonfig(pi: ExtensionAPI) {
        pi.on("tool_call", async (payload) => { const result = await runCanonfig("guard-shell", "before_tool", payload, 5000); if (result.blocked) return { block: true, reason: result.reason }; });
        pi.on("session_start", async (payload) => { const result = await runCanonfig("greet", "session_start", payload, 2000); if (result.blocked) throw new Error(result.reason); });
      }
    == config mcp
      mcpServers = {
        "docs": {
          "url": "https://example.invalid/mcp",
          "headers": {
            "Authorization": "\${DOCS_MCP_TOKEN}"
          }
        },
        "local": {
          "command": "node",
          "args": [
            "server.mjs"
          ],
          "env": {
            "API_KEY": "\${API_KEY}"
          }
        }
      }
    ! warning FEATURE_UNSUPPORTED: pi has no global agents surface: Pi has no subagent definitions. The agents were not projected.
    "
  `));
  it("factory-droid", () => expect(golden("factory-droid")).toMatchInlineSnapshot(`
    "
    root ~/.factory
    file instructions ~/.factory/AGENTS.md
    directory skills ~/.factory/skills
    directory droids ~/.factory/droids
    directory commands ~/.factory/commands
    file hooks ~/.factory/hooks.json
    config mcp ~/.factory/mcp.json json [mcpServers]
    config settings ~/.factory/settings.json json [] settings reserved []
    never ~/.factory/projects, ~/.factory/sessions, ~/.factory/logs
    == file instructions
      # Instructions

      Run the tests before you finish.

      ## Canonfig rules

      Read a rule file before doing work it covers:

      - \`/home/user/.canonfig/rules/source.md\` (applies to \`src/**\`): Source rules
      - \`/home/user/.canonfig/rules/style.md\` (always applies)
    == directory skills
      -- repository-checks/SKILL.md
        ---
        name: repository-checks
        description: Run repository checks.
        ---
        Run the checks.
      -- repository-checks/references/notes.md
        Notes.
      -- repository-checks/scripts/check.sh (executable)
        #!/bin/sh
        exit 0
      -- release-notes/SKILL.md
        ---
        name: release-notes
        description: Write release notes.
        ---
        Write them.
    == directory droids
      -- reviewer.md
        ---
        name: reviewer
        description: Review changes
        tools:
          - Read
          - Grep
          - Glob
          - LS
          - mcp__.*
        ---
        Return severity-ranked findings.
    == directory commands
      -- release-check.md
        ---
        description: Check release readiness
        argument-hint: "[scope]"
        ---
        Inspect the current release.
    == file hooks
      {
        "PreToolUse": [
          {
            "matcher": ".*",
            "hooks": [
              {
                "type": "command",
                "command": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook guard-shell --target factory-droid --event before_tool",
                "timeout": 5
              }
            ]
          }
        ],
        "SessionStart": [
          {
            "matcher": ".*",
            "hooks": [
              {
                "type": "command",
                "command": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook greet --target factory-droid --event session_start",
                "timeout": 2
              }
            ]
          }
        ]
      }
    == config mcp
      mcpServers = {
        "docs": {
          "type": "http",
          "url": "https://example.invalid/mcp",
          "headers": {
            "Authorization": "\${DOCS_MCP_TOKEN}"
          }
        },
        "local": {
          "type": "stdio",
          "command": "node",
          "args": [
            "server.mjs"
          ],
          "env": {
            "API_KEY": "\${API_KEY}"
          }
        }
      }
    "
  `));
  it("cursor", () => expect(golden("cursor")).toMatchInlineSnapshot(`
    "
    root ~/.cursor (shared skills)
    directory agents ~/.cursor/agents
    file hooks ~/.cursor/hooks.json
    config mcp ~/.cursor/mcp.json json [mcpServers]
    config settings ~/.cursor/cli-config.json json [] settings reserved []
    never ~/.cursor/chats, ~/.cursor/worktrees, ~/.cursor/extensions
    == directory agents
      -- reviewer.md
        ---
        name: reviewer
        description: Review changes
        tools:
          - Read
          - Grep
          - Glob
          - MCP
        ---
        Return severity-ranked findings.
    == file hooks
      {
        "version": 1,
        "hooks": {
          "preToolUse": [
            {
              "command": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook guard-shell --target cursor --event before_tool",
              "timeout": 5,
              "matcher": ".*"
            }
          ],
          "sessionStart": [
            {
              "command": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook greet --target cursor --event session_start",
              "timeout": 2
            }
          ]
        }
      }
    == config mcp
      mcpServers = {
        "docs": {
          "type": "http",
          "url": "https://example.invalid/mcp",
          "headers": {
            "Authorization": "\${env:DOCS_MCP_TOKEN}"
          }
        },
        "local": {
          "type": "stdio",
          "command": "node",
          "args": [
            "server.mjs"
          ],
          "env": {
            "API_KEY": "\${env:API_KEY}"
          }
        }
      }
    ! warning FEATURE_UNSUPPORTED: cursor has no global instructions surface: Cursor keeps user rules in its settings, outside the filesystem. The instructions were not projected.
    ! warning FEATURE_UNSUPPORTED: cursor has no global rules surface: Cursor keeps user rules in its settings, outside the filesystem. The rules were not projected.
    ! warning FEATURE_UNSUPPORTED: cursor has no global commands surface: Cursor has no global command directory. The commands were not projected.
    "
  `));
  it("devin", () => expect(golden("devin")).toMatchInlineSnapshot(`
    "
    root ~/.config/devin (shared skills)
    file instructions ~/.config/devin/AGENTS.md
    directory agents ~/.config/devin/agents
    directory rules ~/.devin/rules
    config config ~/.config/devin/config.json json [hooks] settings reserved []
    config mcp ~/.config/devin/mcp_config.json json [mcpServers]
    never ~/.local/share/devin, ~/.config/devin/cli/logs, ~/.config/devin/sessions
    == file instructions
      # Instructions

      Run the tests before you finish.
    == directory rules
      -- source.md
        ---
        trigger: glob
        description: Source rules
        globs: src/**
        ---
        Keep changes scoped.
      -- style.md
        ---
        trigger: always_on
        ---
        Prefer small functions.
    == directory agents
      -- reviewer.md
        ---
        name: reviewer
        description: Review changes
        tools:
          - read
          - grep
          - glob
          - mcp
        ---
        Return severity-ranked findings.
    == config config
      hooks = {
        "PreToolUse": [
          {
            "matcher": ".*",
            "hooks": [
              {
                "type": "command",
                "command": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook guard-shell --target devin --event before_tool",
                "timeout": 5
              }
            ]
          }
        ],
        "SessionStart": [
          {
            "matcher": ".*",
            "hooks": [
              {
                "type": "command",
                "command": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook greet --target devin --event session_start",
                "timeout": 2
              }
            ]
          }
        ]
      }
    == config mcp
      mcpServers = {
        "docs": {
          "url": "https://example.invalid/mcp",
          "transport": "http",
          "headers": {
            "Authorization": "\${DOCS_MCP_TOKEN}"
          }
        },
        "local": {
          "command": "node",
          "args": [
            "server.mjs"
          ],
          "env": {
            "API_KEY": "\${API_KEY}"
          }
        }
      }
    ! warning FEATURE_UNSUPPORTED: devin has no global commands surface: Devin has no global command directory. The commands were not projected.
    "
  `));
  it("opencode", () => expect(golden("opencode")).toMatchInlineSnapshot(`
    "
    root ~/.config/opencode
    file instructions ~/.config/opencode/AGENTS.md
    directory skills ~/.config/opencode/skills
    directory agents ~/.config/opencode/agents
    directory commands ~/.config/opencode/commands
    file plugin ~/.config/opencode/plugins/canonfig.ts
    config config ~/.config/opencode/opencode.json json [mcp] settings reserved [provider] or ~/.config/opencode/opencode.jsonc
    never ~/.local/share/opencode, ~/.cache/opencode
    == file instructions
      # Instructions

      Run the tests before you finish.

      ## Canonfig rules

      Read a rule file before doing work it covers:

      - \`/home/user/.canonfig/rules/source.md\` (applies to \`src/**\`): Source rules
      - \`/home/user/.canonfig/rules/style.md\` (always applies)
    == directory skills
      -- repository-checks/SKILL.md
        ---
        name: repository-checks
        description: Run repository checks.
        ---
        Run the checks.
      -- repository-checks/references/notes.md
        Notes.
      -- repository-checks/scripts/check.sh (executable)
        #!/bin/sh
        exit 0
      -- release-notes/SKILL.md
        ---
        name: release-notes
        description: Write release notes.
        ---
        Write them.
    == directory agents
      -- reviewer.md
        ---
        description: Review changes
        mode: subagent
        permission:
          read: allow
          grep: allow
          glob: allow
          docs_*: allow
          local_*: allow
        ---
        Return severity-ranked findings.
    == directory commands
      -- release-check.md
        ---
        description: Check release readiness
        argument-hint: "[scope]"
        ---
        Inspect the current release.
    == file plugin
      // Generated by Canonfig. Edit hooks in ~/.canonfig/canonfig.jsonc instead.
      import { execFile } from "node:child_process";

      const runner = "/home/user/.canonfig/.runtime/hook-runner.mjs";
      function runCanonfig(hookId, event, payload, timeoutMs) {
        return new Promise((resolve) => {
          const child = execFile(
            "node",
            [runner, "--hook", hookId, "--target", "opencode", "--event", event],
            {
              cwd: process.cwd(),
              encoding: "utf8",
              timeout: Math.max(1, timeoutMs + 1000),
              maxBuffer: 16 * 1024 * 1024,
            },
            (error, stdout, stderr) => {
              const reason = String(stderr || stdout || error?.message || "Blocked by Canonfig hook").trim();
              resolve({ blocked: error !== null, reason });
            },
          );
          child.stdin?.on("error", () => {});
          child.stdin?.end(JSON.stringify(payload ?? {}));
        });
      }

      export const CanonfigPlugin = async () => ({
        "tool.execute.before": async (input, output) => {
            { const payload = { ...input, ...output }; const result = await runCanonfig("guard-shell", "before_tool", payload, 5000); if (result.blocked) throw new Error(result.reason); }
        },
        "tool.execute.after": async (input, output) => {

        },
      });
    == config config
      mcp = {
        "docs": {
          "type": "remote",
          "url": "https://example.invalid/mcp",
          "enabled": true,
          "headers": {
            "Authorization": "{env:DOCS_MCP_TOKEN}"
          }
        },
        "local": {
          "type": "local",
          "command": [
            "node",
            "server.mjs"
          ],
          "enabled": true,
          "environment": {
            "API_KEY": "{env:API_KEY}"
          }
        }
      }
    ! warning HOOK_EVENT_UNSUPPORTED: opencode has no hook event for session_start, so hook greet was skipped.
    "
  `));
  it("grok-build", () => expect(golden("grok-build")).toMatchInlineSnapshot(`
    "
    root ~/.grok (shared skills)
    file instructions ~/.grok/AGENTS.md
    directory agents ~/.grok/agents
    file hooks ~/.grok/hooks/canonfig.json
    config config ~/.grok/config.toml toml [mcp_servers] settings reserved [model.*.api_key]
    never ~/.grok/sessions, ~/.grok/logs, ~/.grok/crash, ~/.grok/mcp_credentials.json, ~/.grok/trusted_folders.toml
    == file instructions
      # Instructions

      Run the tests before you finish.

      ## Canonfig rules

      Read a rule file before doing work it covers:

      - \`/home/user/.canonfig/rules/source.md\` (applies to \`src/**\`): Source rules
      - \`/home/user/.canonfig/rules/style.md\` (always applies)
    == directory agents
      -- reviewer.md
        ---
        name: reviewer
        description: Review changes
        tools:
          - Read
          - Grep
          - Glob
          - mcp__.*
        ---
        Return severity-ranked findings.
    == file hooks
      {
        "hooks": {
          "PreToolUse": [
            {
              "matcher": ".*",
              "hooks": [
                {
                  "type": "command",
                  "command": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook guard-shell --target grok-build --event before_tool",
                  "timeout": 5
                }
              ]
            }
          ],
          "SessionStart": [
            {
              "matcher": ".*",
              "hooks": [
                {
                  "type": "command",
                  "command": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook greet --target grok-build --event session_start",
                  "timeout": 2
                }
              ]
            }
          ]
        }
      }
    == config config
      mcp_servers = {
        "docs": {
          "url": "https://example.invalid/mcp",
          "headers": {
            "Authorization": "\${DOCS_MCP_TOKEN}"
          }
        },
        "local": {
          "command": "node",
          "args": [
            "server.mjs"
          ],
          "env": {
            "API_KEY": "\${API_KEY}"
          }
        }
      }
    ! warning FEATURE_UNSUPPORTED: grok-build has no global commands surface: Grok has no global command directory. The commands were not projected.
    "
  `));
  it("antigravity", () => expect(golden("antigravity")).toMatchInlineSnapshot(`
    "
    root ~/.gemini
    file instructions ~/.gemini/AGENTS.md
    directory rules ~/.gemini/config/rules
    directory skills ~/.gemini/config/skills
    directory agents ~/.gemini/config/agents
    file hooks ~/.gemini/config/hooks.json
    config mcp ~/.gemini/config/mcp_config.json json [mcpServers]
    config settings ~/.gemini/antigravity-cli/settings.json json [] settings reserved [trustedWorkspaces, gcp]
    never ~/.gemini/antigravity-cli/brain, ~/.gemini/antigravity, ~/.gemini/antigravity-ide
    == file instructions
      # Instructions

      Run the tests before you finish.
    == directory rules
      -- source.md
        ---
        trigger: glob
        description: Source rules
        globs: src/**
        ---
        Keep changes scoped.
      -- style.md
        ---
        trigger: always_on
        ---
        Prefer small functions.
    == directory skills
      -- repository-checks/SKILL.md
        ---
        name: repository-checks
        description: Run repository checks.
        ---
        Run the checks.
      -- repository-checks/references/notes.md
        Notes.
      -- repository-checks/scripts/check.sh (executable)
        #!/bin/sh
        exit 0
      -- release-notes/SKILL.md
        ---
        name: release-notes
        description: Write release notes.
        ---
        Write them.
    == directory agents
      -- reviewer.md
        ---
        name: reviewer
        description: Review changes
        tools:
          - view_file
          - grep_search
          - find_by_name
          - list_dir
          - mcp_*
        ---
        Return severity-ranked findings.
    == file hooks
      {
        "canonfig-guard-shell": {
          "enabled": true,
          "PreToolUse": [
            {
              "matcher": ".*",
              "hooks": [
                {
                  "type": "command",
                  "command": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook guard-shell --target antigravity --event before_tool",
                  "timeout": 5
                }
              ]
            }
          ]
        },
        "canonfig-greet": {
          "enabled": true,
          "SessionStart": [
            {
              "type": "command",
              "command": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook greet --target antigravity --event session_start",
              "timeout": 2
            }
          ]
        }
      }
    == config mcp
      mcpServers = {
        "docs": {
          "serverUrl": "https://example.invalid/mcp",
          "headers": {
            "Authorization": "\${DOCS_MCP_TOKEN}"
          }
        },
        "local": {
          "command": "node",
          "args": [
            "server.mjs"
          ],
          "env": {
            "API_KEY": "\${API_KEY}"
          }
        }
      }
    ! warning FEATURE_UNSUPPORTED: antigravity has no global commands surface: Antigravity has no global command directory. The commands were not projected.
    "
  `));
  it("copilot-cli", () => expect(golden("copilot-cli")).toMatchInlineSnapshot(`
    "
    root ~/.copilot
    file instructions ~/.copilot/copilot-instructions.md
    directory rules ~/.copilot/instructions
    directory skills ~/.copilot/skills
    directory agents ~/.copilot/agents
    file hooks ~/.copilot/hooks/canonfig.json
    config mcp ~/.copilot/mcp-config.json json [mcpServers]
    config settings ~/.copilot/settings.json json [] settings reserved []
    never ~/.copilot/config.json, ~/.copilot/mcp-oauth-config, ~/.copilot/mcp-secrets, ~/.copilot/session-state, ~/.copilot/session-store.db, ~/.copilot/command-history-state, ~/.copilot/logs, ~/.copilot/ide, ~/.copilot/plugin-data, ~/.copilot/permissions-config.json, ~/.copilot/providers.json
    == file instructions
      # Instructions

      Run the tests before you finish.
    == directory rules
      -- source.instructions.md
        ---
        description: Source rules
        applyTo: src/**
        ---
        Keep changes scoped.
      -- style.instructions.md
        ---
        description: "Canonfig rule: style"
        applyTo: "**"
        ---
        Prefer small functions.
    == directory skills
      -- repository-checks/SKILL.md
        ---
        name: repository-checks
        description: Run repository checks.
        ---
        Run the checks.
      -- repository-checks/references/notes.md
        Notes.
      -- repository-checks/scripts/check.sh (executable)
        #!/bin/sh
        exit 0
      -- release-notes/SKILL.md
        ---
        name: release-notes
        description: Write release notes.
        ---
        Write them.
    == directory agents
      -- reviewer.agent.md
        ---
        name: reviewer
        description: Review changes
        tools:
          - Read
          - Grep
          - Glob
          - mcp__*
        ---
        Return severity-ranked findings.
    == file hooks
      {
        "version": 1,
        "hooks": {
          "preToolUse": [
            {
              "type": "command",
              "bash": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook guard-shell --target copilot-cli --event before_tool",
              "powershell": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook guard-shell --target copilot-cli --event before_tool",
              "timeoutSec": 5,
              "matcher": ".*"
            }
          ],
          "sessionStart": [
            {
              "type": "command",
              "bash": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook greet --target copilot-cli --event session_start",
              "powershell": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook greet --target copilot-cli --event session_start",
              "timeoutSec": 2
            }
          ]
        }
      }
    == config mcp
      mcpServers = {
        "docs": {
          "type": "http",
          "url": "https://example.invalid/mcp",
          "headers": {
            "Authorization": "\${DOCS_MCP_TOKEN}"
          },
          "tools": [
            "*"
          ]
        },
        "local": {
          "type": "local",
          "command": "node",
          "args": [
            "server.mjs"
          ],
          "env": {
            "API_KEY": "\${API_KEY}"
          },
          "tools": [
            "*"
          ]
        }
      }
    ! warning FEATURE_UNSUPPORTED: copilot-cli has no global commands surface: Copilot CLI has no global command directory. The commands were not projected.
    "
  `));
  it("kimi", () => expect(golden("kimi")).toMatchInlineSnapshot(`
    "
    root ~/.kimi-code (shared skills)
    file instructions ~/.kimi-code/AGENTS.md
    directory agents ~/.kimi-code/agents
    config mcp ~/.kimi-code/mcp.json json [mcpServers]
    config config ~/.kimi-code/config.toml toml [hooks] settings reserved [providers, services.*.api_key]
    never ~/.kimi-code/credentials, ~/.kimi-code/sessions, ~/.kimi-code/session_index.jsonl, ~/.kimi-code/user-history, ~/.kimi-code/logs, ~/.kimi-code/bin
    == file instructions
      # Instructions

      Run the tests before you finish.

      ## Canonfig rules

      Read a rule file before doing work it covers:

      - \`/home/user/.canonfig/rules/source.md\` (applies to \`src/**\`): Source rules
      - \`/home/user/.canonfig/rules/style.md\` (always applies)
    == directory agents
      -- reviewer.md
        ---
        name: reviewer
        description: Review changes
        tools:
          - Read
          - Grep
          - Glob
          - mcp__*
        ---
        Return severity-ranked findings.
    == config config
      hooks = [
        {
          "event": "PreToolUse",
          "command": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook guard-shell --target kimi --event before_tool",
          "timeout": 5
        },
        {
          "event": "SessionStart",
          "command": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook greet --target kimi --event session_start",
          "timeout": 2
        }
      ]
    == config mcp
      mcpServers = {
        "docs": {
          "transport": "http",
          "url": "https://example.invalid/mcp",
          "bearerTokenEnvVar": "DOCS_MCP_TOKEN"
        },
        "local": {
          "transport": "stdio",
          "command": "node",
          "args": [
            "server.mjs"
          ],
          "env": {
            "API_KEY": "\${API_KEY}"
          }
        }
      }
    ! warning FEATURE_UNSUPPORTED: kimi has no global commands surface: Kimi has no global command directory. The commands were not projected.
    "
  `));
  it("kilo", () => expect(golden("kilo")).toMatchInlineSnapshot(`
    "
    root ~/.config/kilo (shared skills)
    file instructions ~/.config/kilo/AGENTS.md
    directory agents ~/.config/kilo/agent
    directory commands ~/.config/kilo/commands
    file plugin ~/.config/kilo/plugin/canonfig.ts
    config config ~/.config/kilo/kilo.jsonc json [mcp] settings reserved [provider] or ~/.config/kilo/kilo.json
    never ~/.local/share/kilo, ~/.local/state/kilo/daemon.json, ~/.cache/kilo
    == file instructions
      # Instructions

      Run the tests before you finish.

      ## Canonfig rules

      Read a rule file before doing work it covers:

      - \`/home/user/.canonfig/rules/source.md\` (applies to \`src/**\`): Source rules
      - \`/home/user/.canonfig/rules/style.md\` (always applies)
    == directory agents
      -- reviewer.md
        ---
        description: Review changes
        mode: subagent
        permission:
          read: allow
          grep: allow
          glob: allow
          docs_*: allow
          local_*: allow
        ---
        Return severity-ranked findings.
    == directory commands
      -- release-check.md
        ---
        description: Check release readiness
        argument-hint: "[scope]"
        ---
        Inspect the current release.
    == file plugin
      // Generated by Canonfig. Edit hooks in ~/.canonfig/canonfig.jsonc instead.
      import { execFile } from "node:child_process";

      const runner = "/home/user/.canonfig/.runtime/hook-runner.mjs";
      function runCanonfig(hookId, event, payload, timeoutMs) {
        return new Promise((resolve) => {
          const child = execFile(
            "node",
            [runner, "--hook", hookId, "--target", "kilo", "--event", event],
            {
              cwd: process.cwd(),
              encoding: "utf8",
              timeout: Math.max(1, timeoutMs + 1000),
              maxBuffer: 16 * 1024 * 1024,
            },
            (error, stdout, stderr) => {
              const reason = String(stderr || stdout || error?.message || "Blocked by Canonfig hook").trim();
              resolve({ blocked: error !== null, reason });
            },
          );
          child.stdin?.on("error", () => {});
          child.stdin?.end(JSON.stringify(payload ?? {}));
        });
      }

      export const CanonfigPlugin = async () => ({
        "tool.execute.before": async (input, output) => {
            { const payload = { ...input, ...output }; const result = await runCanonfig("guard-shell", "before_tool", payload, 5000); if (result.blocked) throw new Error(result.reason); }
        },
        "tool.execute.after": async (input, output) => {

        },
      });
    == config config
      mcp = {
        "docs": {
          "type": "remote",
          "url": "https://example.invalid/mcp",
          "enabled": true,
          "headers": {
            "Authorization": "{env:DOCS_MCP_TOKEN}"
          }
        },
        "local": {
          "type": "local",
          "command": [
            "node",
            "server.mjs"
          ],
          "enabled": true,
          "environment": {
            "API_KEY": "{env:API_KEY}"
          }
        }
      }
    ! warning HOOK_EVENT_UNSUPPORTED: kilo has no hook event for session_start, so hook greet was skipped.
    "
  `));
  it("hermes", () => expect(golden("hermes")).toMatchInlineSnapshot(`
    "
    root ~/.hermes
    directory skill.repository-checks ~/.hermes/skills/repository-checks
    directory skill.release-notes ~/.hermes/skills/release-notes
    config config ~/.hermes/config.yaml yaml [mcp_servers, hooks]
    never ~/.hermes/SOUL.md, ~/.hermes/.env, ~/.hermes/auth.json, ~/.hermes/sessions, ~/.hermes/state.db, ~/.hermes/logs, ~/.hermes/cache, ~/.hermes/memories, ~/.hermes/skills/.hub, ~/.hermes/skills/.bundled_manifest
    == directory skill.repository-checks
      -- SKILL.md
        ---
        name: repository-checks
        description: Run repository checks.
        ---
        Run the checks.
      -- references/notes.md
        Notes.
      -- scripts/check.sh (executable)
        #!/bin/sh
        exit 0
    == directory skill.release-notes
      -- SKILL.md
        ---
        name: release-notes
        description: Write release notes.
        ---
        Write them.
    == config config
      mcp_servers = {
        "docs": {
          "url": "https://example.invalid/mcp",
          "headers": {
            "Authorization": "\${DOCS_MCP_TOKEN}"
          }
        },
        "local": {
          "command": "node",
          "args": [
            "server.mjs"
          ],
          "env": {
            "API_KEY": "\${API_KEY}"
          }
        }
      }
      hooks = {
        "pre_tool_call": [
          {
            "command": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook guard-shell --target hermes --event before_tool",
            "timeout": 5,
            "fail_closed": true
          }
        ],
        "on_session_start": [
          {
            "command": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook greet --target hermes --event session_start",
            "timeout": 2
          }
        ]
      }
    ! warning FEATURE_UNSUPPORTED: hermes has no global instructions surface: SOUL.md is an identity, not an instruction file. The instructions were not projected.
    ! warning FEATURE_UNSUPPORTED: hermes has no global rules surface: Hermes has no global rules location. The rules were not projected.
    ! warning FEATURE_UNSUPPORTED: hermes has no global agents surface: Hermes has no subagent definitions. The agents were not projected.
    ! warning FEATURE_UNSUPPORTED: hermes has no global commands surface: Hermes has no command directory. The commands were not projected.
    "
  `));
  it("qwen", () => expect(golden("qwen")).toMatchInlineSnapshot(`
    "
    root ~/.qwen (shared skills)
    file instructions ~/.qwen/QWEN.md
    directory agents ~/.qwen/agents
    directory commands ~/.qwen/commands
    config settings ~/.qwen/settings.json json [mcpServers, hooks] settings reserved []
    never ~/.qwen/oauth_creds.json, ~/.qwen/mcp-oauth-tokens.json, ~/.qwen/google_accounts.json, ~/.qwen/.env, ~/.qwen/installation_id, ~/.qwen/projects, ~/.qwen/tmp, ~/.qwen/memory.md, ~/.qwen/file-history, ~/.qwen/ide
    == file instructions
      # Instructions

      Run the tests before you finish.

      ## Canonfig rules

      Read a rule file before doing work it covers:

      - \`/home/user/.canonfig/rules/source.md\` (applies to \`src/**\`): Source rules
      - \`/home/user/.canonfig/rules/style.md\` (always applies)
    == directory agents
      -- reviewer.md
        ---
        name: reviewer
        description: Review changes
        tools:
          - read_file
          - grep_search
          - glob
          - list_directory
          - mcp__*
        disallowedTools:
          - edit
          - write_file
        ---
        Return severity-ranked findings.
    == directory commands
      -- release-check.md
        ---
        description: Check release readiness
        ---
        Inspect the current release.
    == config settings
      mcpServers = {
        "docs": {
          "httpUrl": "https://example.invalid/mcp",
          "headers": {
            "Authorization": "\${DOCS_MCP_TOKEN}"
          }
        },
        "local": {
          "command": "node",
          "args": [
            "server.mjs"
          ],
          "env": {
            "API_KEY": "\${API_KEY}"
          }
        }
      }
      hooks = {
        "PreToolUse": [
          {
            "matcher": "*",
            "hooks": [
              {
                "type": "command",
                "command": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook guard-shell --target qwen --event before_tool",
                "timeout": 5000
              }
            ]
          }
        ],
        "SessionStart": [
          {
            "matcher": "*",
            "hooks": [
              {
                "type": "command",
                "command": "node \\"/home/user/.canonfig/.runtime/hook-runner.mjs\\" --hook greet --target qwen --event session_start",
                "timeout": 2000
              }
            ]
          }
        ]
      }
    "
  `));
});
