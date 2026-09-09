import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scanDiscovery } from "../../src/profile/discovery.ts";

/** Synthetic configuration only: disabled fields must never reach evidence. */
describe("discovery enablement and executable identity", () => {
  let root = "";
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "canonfig-scope-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const scan = async (name: string, text: string) => {
    const path = join(root, name);
    await writeFile(path, text);
    return Effect.runPromise(scanDiscovery({ files: [{ path }], path: "" }));
  };

  it("excludes disabled MCP records before collecting commands and nested credentials", async () => {
    const result = await scan("mcp.json", JSON.stringify({ mcpServers: {
      active: { command: "visible-mcp", args: ["--stdio"] },
      first: { enabled: false, command: "hidden-first", args: ["--password=disabled-sentinel"] },
      second: { disabled: true, nested: { command: "hidden-second" } },
      conflicting: { enabled: true, disabled: true, command: "hidden-conflicting" },
    } }));
    expect(result.evidence.map((entry) => entry.invocation[0])).toEqual(["visible-mcp"]);
    expect(JSON.stringify(result)).not.toContain("hidden-");
    expect(JSON.stringify(result)).not.toContain("disabled-sentinel");
  });

  it("inherits disabled scope without allowing a descendant to reenable itself", async () => {
    const result = await scan("hooks.json", JSON.stringify({ enabled: false,
      hooks: [{ enabled: true, command: "hidden-hook --password=disabled-sentinel" }],
    }));
    expect(result.evidence).toEqual([]);
    expect(result.tools).toEqual([]);
    expect(result.agentTasks).toEqual([]);
  });

  it("keeps active hook array entries without reviving disabled siblings", async () => {
    const result = await scan("hooks.json", JSON.stringify({ hooks: [
      { command: "visible-hook --flag" },
      { enabled: false, command: "hidden-hook" },
      { disabled: true, hooks: [{ command: "hidden-child" }] },
    ] }));
    expect(result.evidence.map((entry) => entry.invocation)).toEqual([["visible-hook", "--flag"]]);
  });

  it("applies identical enablement rules to TOML MCP configuration", async () => {
    const result = await scan("config.toml", [
      "[mcp_servers.active]", 'command = "visible-mcp"', "enabled = true",
      "[mcp_servers.hidden]", 'command = "hidden-mcp"', "enabled = false",
      "[mcp_servers.other]", 'command = "hidden-other"', "disabled = true",
    ].join("\n"));
    expect(result.evidence.map((entry) => entry.invocation[0])).toEqual(["visible-mcp"]);
  });

  it("excludes disabled explicit package metadata before proposing recipes", async () => {
    const result = await scan("package.json", JSON.stringify({ canonfig: { tools: [
      { ecosystem: "npm", name: "visible-cli", version: "1.2.3", upstream: "https://example.com/visible" },
      { ecosystem: "npm", name: "hidden-cli", version: "1.2.3", disabled: true, upstream: "https://example.com/hidden" },
    ] } }));
    expect(result.evidence.map((entry) => entry.invocation[0])).toEqual(["visible-cli"]);
    expect(JSON.stringify(result)).not.toContain("hidden-cli");
  });

  it.each(["enabled", "disabled"])("rejects nonboolean %s without reflecting its value", async (key) => {
    const failure = await scan("mcp.json", JSON.stringify({ mcpServers: {
      invalid: { [key]: "private-sentinel", command: "hidden-mcp" },
    } })).catch((error) => error);
    expect(failure).toMatchObject({
      _tag: "DiscoveryParseError",
      reason: "Error: enabled and disabled fields must be booleans",
    });
    expect(JSON.stringify(failure)).not.toContain("private-sentinel");
    expect(JSON.stringify(failure)).not.toContain("hidden-mcp");
  });

  it("keeps an MCP executable path as data rather than applying shell tokenization", async () => {
    const executable = "C:\\Program Files\\Example Tool\\server.exe";
    const result = await scan("mcp.json", JSON.stringify({ mcpServers: {
      active: { command: executable, args: ["--stdio", "project with spaces"] },
    } }));
    expect(result.evidence[0]?.invocation).toEqual([executable, "--stdio", "project with spaces"]);
    expect(result.evidence[0]?.resolvedExecutable).toBeUndefined();
  });
});
