import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalFolderError,
  decodeFolderConfig,
  loadCanonicalFolder,
  LocalItemCollisionError,
} from "../src/projection/folder.ts";
import { nativeTools } from "../src/projection/adapters/tools.ts";
import { ampPluginSource } from "../src/projection/templates/runtime.ts";

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const folder = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-folder-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};

const minimal = "{ \"version\": 1, \"harnesses\": [\"claude-code\"] }";

describe("Canonical Folder loader", () => {
  it("loads the authoring allowlist into the Canonical Model", async () => {
    const root = folder({
      "canonfig.jsonc": `{
        // comments and trailing commas are fine
        "version": 1,
        "harnesses": ["claude-code", "codex"],
        "mcp": { "git": { "transport": "stdio", "command": "uvx", "args": ["mcp-server-git"] },
                 "off": { "transport": "stdio", "command": "x", "enabled": false } },
        "hooks": [{ "id": "format", "event": "after_tool", "run": ["hooks/format.sh", "--fix"] }],
        "settings": { "codex": { "model_reasoning_effort": "high" } },
      }`,
      "AGENTS.md": "Be brief.\n",
      "rules/style.md": "---\npaths: [\"**/*.ts\"]\n---\nTwo spaces.\n",
      "skills/deploy/SKILL.md": "---\nname: deploy\ndescription: Deploys\nlicense: MIT\n---\nBody.\n",
      "agents/reviewer.md": "---\ndescription: Reviews\n---\nReview.\n",
      "commands/ship.md": "---\ndescription: Ships\nargumentHint: \"<branch>\"\n---\nShip.\n",
      "hooks/format.sh": "#!/bin/sh\n",
      "state.sqlite": "not authoring input",
    });
    const loaded = await loadCanonicalFolder(root);
    expect(loaded.model.harnesses).toEqual(["claude-code", "codex"]);
    expect(loaded.model.instructions).toBe("Be brief.\n");
    expect(loaded.model.rules).toEqual([expect.objectContaining({ id: "style", paths: ["**/*.ts"], content: "Two spaces." })]);
    expect(loaded.model.skills.map((skill) => [skill.name, skill.files.map((file) => file.path)])).toEqual([["deploy", ["SKILL.md"]]]);
    expect(loaded.model.agents).toEqual([expect.objectContaining({ id: "reviewer", model: "inherit", tools: ["read", "search"], writable: false })]);
    expect(loaded.model.commands).toEqual([expect.objectContaining({ id: "ship", argumentHint: "<branch>" })]);
    expect(loaded.model.mcp.map(([name]) => name)).toEqual(["git"]);
    expect(loaded.model.hooks[0]?.run).toEqual([join(root, "hooks", "format.sh"), "--fix"]);
    expect(loaded.model.settings).toEqual({ codex: [{ path: "model_reasoning_effort", value: "high" }] });
    expect(loaded.local).toEqual({ excludeHarnesses: [], excludeResources: [], backups: true });
    expect((await loadCanonicalFolder(root)).digest).toBe(loaded.digest);
  });

  it.each([
    ["omitted", "", ["read", "grep", "glob"]],
    ["empty", "tools: []\n", []],
  ] as const)("keeps %s agent tools restricted in the executable Amp plugin", async (_name, tools, expected) => {
    const root = folder({
      "canonfig.jsonc": minimal,
      "agents/reviewer.md": `---\ndescription: Reviews\n${tools}---\nReview the change.\n`,
    });
    const { model } = await loadCanonicalFolder(root);
    const source = ampPluginSource("", [], model.agents.map((agent) => ({ agent, tools: nativeTools("amp", agent) })), []);
    // Execute the generated module to inspect the permissions passed to Amp.
    const javascript = stripTypeScriptTypes(source);
    const plugin = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
    const agents: Array<{ tools: string[] | "all" }> = [];
    const registered: Array<{ name: string }> = [];
    plugin.default({
      createAgent: (options: { tools: string[] | "all" }) => { agents.push(options); return {}; },
      registerTool: (tool: { name: string }) => { registered.push(tool); },
    });
    expect(agents.map((agent) => agent.tools)).toEqual([expected]);
  });

  it.each([
    ["an unknown key", "{ \"version\": 1, \"harnesses\": [], \"profile\": {} }"],
    ["an unknown harness", "{ \"version\": 1, \"harnesses\": [\"vim\"] }"],
    ["a null setting", "{ \"version\": 1, \"harnesses\": [], \"settings\": { \"codex\": { \"model\": null } } }"],
    ["an invalid key path", "{ \"version\": 1, \"harnesses\": [], \"settings\": { \"codex\": { \"a..b\": 1 } } }"],
    ["a hook script outside hooks/", "{ \"version\": 1, \"harnesses\": [], \"hooks\": [{ \"id\": \"x\", \"event\": \"stop\", \"run\": [\"../x.sh\"] }] }"],
  ])("rejects %s in canonfig.jsonc", async (_, content) => {
    await expect(loadCanonicalFolder(folder({ "canonfig.jsonc": content }))).rejects.toBeInstanceOf(CanonicalFolderError);
  });

  it("refuses a link that leaves the folder", async () => {
    const outside = folder({ "secret.md": "---\ndescription: x\n---\nsecret\n" });
    const root = folder({ "canonfig.jsonc": minimal });
    mkdirSync(join(root, "agents"));
    symlinkSync(join(outside, "secret.md"), join(root, "agents", "leak.md"));
    await expect(loadCanonicalFolder(root)).rejects.toBeInstanceOf(CanonicalFolderError);
  });

  it("loads a folder reached through a linked parent directory", async () => {
    // macOS temp and home paths can pass through a link (/var is /private/var).
    const root = folder({ "canonfig.jsonc": minimal, "AGENTS.md": "Be brief.\n" });
    const linkParent = mkdtempSync(join(tmpdir(), "canonfig-folder-link-"));
    roots.push(linkParent);
    symlinkSync(root, join(linkParent, "via"));
    const loaded = await loadCanonicalFolder(join(linkParent, "via"));
    expect(loaded.model.instructions).toBe("Be brief.\n");
  });

  it("adds allowed local items, ignores the rest, and stops on a name collision", async () => {
    const root = folder({
      "canonfig.jsonc": "{ \"version\": 1, \"harnesses\": [\"codex\", \"qwen\"], \"local\": { \"allow\": [\"skills\"] } }",
      "local/skills/mine/SKILL.md": "---\nname: mine\ndescription: Mine\n---\nMine.\n",
      "local/commands/extra.md": "---\ndescription: Extra\n---\nExtra.\n",
      "local/local.jsonc": "{ \"excludeHarnesses\": [\"qwen\"], \"backups\": false }",
    });
    const loaded = await loadCanonicalFolder(root);
    expect(loaded.model.skills.map((skill) => skill.name)).toEqual(["mine"]);
    expect(loaded.model.commands).toEqual([]);
    expect(loaded.ignoredLocal).toEqual(["local/commands/"]);
    expect(loaded.model.harnesses).toEqual(["codex"]);
    expect(loaded.local).toEqual({ excludeHarnesses: ["qwen"], excludeResources: [], backups: false });

    mkdirSync(join(root, "skills", "mine"), { recursive: true });
    writeFileSync(join(root, "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: Published\n---\nP.\n");
    await expect(loadCanonicalFolder(root)).rejects.toBeInstanceOf(LocalItemCollisionError);
  });

  it("only warns about a local category that is not allowed, whatever it holds", async () => {
    const root = folder({
      "canonfig.jsonc": minimal,
      "local/skills/example/notes.txt": "no SKILL.md here\n",
      "local/rules/Not A Rule.txt": "not a document\n",
    });
    const outside = folder({ "secret.md": "---\ndescription: x\n---\nsecret\n" });
    mkdirSync(join(root, "local", "agents"), { recursive: true });
    symlinkSync(join(outside, "secret.md"), join(root, "local", "agents", "leak.md"));
    mkdirSync(join(root, "local", "commands"));
    const loaded = await loadCanonicalFolder(root);
    expect(loaded.model.skills).toEqual([]);
    expect(loaded.model.rules).toEqual([]);
    expect(loaded.model.agents).toEqual([]);
    expect(loaded.ignoredLocal).toEqual(["local/rules/", "local/skills/", "local/agents/"]);

    writeFileSync(join(root, "canonfig.jsonc"), "{ \"version\": 1, \"harnesses\": [], \"local\": { \"allow\": [\"skills\"] } }");
    await expect(loadCanonicalFolder(root)).rejects.toThrow("has no SKILL.md");
  });

  it("keeps the executable bit of skill files", async () => {
    const root = folder({
      "canonfig.jsonc": minimal,
      "skills/run/SKILL.md": "---\nname: run\ndescription: Runs\n---\nRun.\n",
      "skills/run/bin/go.sh": "#!/bin/sh\n",
    });
    chmodSync(join(root, "skills", "run", "bin", "go.sh"), 0o755);
    const loaded = await loadCanonicalFolder(root);
    expect(loaded.model.skills[0]?.files.map((file) => [file.path, file.executable])).toEqual([
      ["SKILL.md", false],
      ["bin/go.sh", true],
    ]);
  });
});

/**
 * canonfig.jsonc diagnostics reach the terminal, the command log and
 * --json envelopes, so they name the field and the reason but never echo
 * the rejected value: an author may have pasted a credential there.
 */
describe("canonfig.jsonc validation detail", () => {
  const failureOf = (text: string): string => {
    try {
      decodeFolderConfig("/home/operator/.canonfig/canonfig.jsonc", text);
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalFolderError);
      return error instanceof CanonicalFolderError ? error.message : "";
    }
    throw new Error("canonfig.jsonc decoded");
  };

  it("never echoes parser excerpts from the file", () => {
    const message = failureOf("{ \"version\": unquoted-secret-value }");
    expect(message).toContain("is not valid JSONC");
    expect(message).not.toContain("unquoted-secret-value");
  });

  it("drops rejected values from decoder failures", () => {
    const message = failureOf(JSON.stringify({
      version: 1,
      harnesses: [],
      mcp: { git: { transport: "stdio", command: { secret_marker: "MARKER-ABC-123" } } },
    }));
    expect(message).toContain("[\"mcp\"][\"git\"][\"command\"]");
    expect(message).not.toContain("MARKER-ABC-123");
  });

  it.each([
    {
      name: "index URL user information",
      fields: { indexPolicy: { url: "https://operator:profile-disposable-value@example.test/simple", reviewedBy: "reviewer", reviewedAt: "2026-09-30T00:00:00Z" } },
      field: "[\"indexPolicy\"][\"url\"]",
      reason: "recipe index policy must be a credential-free HTTPS simple-index URL",
    },
    {
      name: "index URL query credential",
      fields: { indexPolicy: { url: "https://example.test/simple?token=profile-disposable-value", reviewedBy: "reviewer", reviewedAt: "2026-09-30T00:00:00Z" } },
      field: "[\"indexPolicy\"][\"url\"]",
      reason: "recipe index policy must be a credential-free HTTPS simple-index URL",
    },
    {
      name: "symbolic index URL query credential",
      fields: { indexPolicy: { url: "https://example.test/simple?token=${API_TOKEN}", reviewedBy: "reviewer", reviewedAt: "2026-09-30T00:00:00Z" } },
      field: "[\"indexPolicy\"][\"url\"]",
      reason: "recipe index policy must be a credential-free HTTPS simple-index URL",
    },
    {
      name: "empty index URL query credential",
      fields: { indexPolicy: { url: "https://example.test/simple?token=", reviewedBy: "reviewer", reviewedAt: "2026-09-30T00:00:00Z" } },
      field: "[\"indexPolicy\"][\"url\"]",
      reason: "recipe index policy must be a credential-free HTTPS simple-index URL",
    },
    {
      name: "unsupported version",
      fields: { version: "profile-disposable-value/invalid" },
      field: "[\"version\"]",
      reason: "installer uv cannot honor requested version",
    },
    {
      name: "unsafe registry package",
      fields: { method: "npm", package: "https://operator:profile-disposable-value@example.test/tool.tgz" },
      field: "[\"package\"]",
      reason: "npm-family package must be an exact registry name",
    },
    {
      name: "missing build executable bounds",
      fields: {
        buildPolicy: {
          mode: "required", reviewedBy: "profile-disposable-value", reviewedAt: "2026-09-30T00:00:00Z",
          paths: [], origins: [], capabilities: ["execute"], steps: [],
        },
      },
      field: "[\"buildPolicy\"][\"executables\"]",
      reason: "Missing key",
    },
  ])("reports the field and an actionable reason for $name without the rejected value", ({ fields, field, reason }) => {
    const message = failureOf(JSON.stringify({
      version: 1,
      harnesses: [],
      tools: { tool: { executable: "tool", recipes: [{ platform: "linux", method: "uv", package: "tool", version: "1.2.3", ...fields }] } },
    }));
    expect(message).toContain(`["tools"]["tool"]["recipes"][0]${field}`);
    expect(message).toContain(reason);
    expect(message).not.toContain("profile-disposable-value");
  });
});
