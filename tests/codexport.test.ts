import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    expect(bundle.revision).toBe(computeRevision(bundle.files));
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
      name: "codexport-sync",
      command: "codexport sync --apply --timeout-ms 3000 --no-input"
    });
  });
});
