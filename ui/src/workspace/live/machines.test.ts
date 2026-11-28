/// <reference types="node" />
import assert from "node:assert/strict";
import { it } from "node:test";
import { healthView } from "./machines";

it("keeps only the checks that need attention and the items that failed", () => {
  const view = healthView({
    recordedAt: "2026-11-18T10:00:00.000Z", version: "7.8.0", status: "unhealthy",
    probes: [
      { name: "runtime", status: "pass", message: "runtime is supported" },
      { name: "scheduler", status: "warning", message: "the last unattended run failed" },
      { name: "mcp", status: "fail", message: "1 of 2 MCP server(s) failed", details: {
        github: "pass · codex · 49 tools · 800 ms",
        stale: "fail · codex · command not found: /old/wrapper.mjs · 10 ms",
      } },
      { name: "mcp-config", status: "warning", message: "1 MCP configuration warning (MCP_PRESERVE_ACTIVE)", details: {
        MCP_PRESERVE_ACTIVE: "warning · preserveMcp is active for codex in local/local.jsonc",
      } },
    ],
  });
  assert.deepEqual(view.problems, [
    { check: "scheduler", status: "warning", message: "the last unattended run failed", items: [] },
    { check: "mcp", status: "fail", message: "1 of 2 MCP server(s) failed", items: ["stale: codex · command not found: /old/wrapper.mjs · 10 ms"] },
    { check: "mcp-config", status: "warning", message: "1 MCP configuration warning (MCP_PRESERVE_ACTIVE)", items: ["MCP_PRESERVE_ACTIVE: preserveMcp is active for codex in local/local.jsonc"] },
  ]);
});
