import { describe, expect, it } from "vitest";

import {
  compileProfile,
  compileProfileJsonc,
} from "../src/profile/compiler.ts";

const profile = `{
  "id": "compiler-fixture",
  "name": "Compiler fixture",
  "resources": [
    {
      "id": "mcp-settings",
      "kind": "config",
      "policy": "merge",
      "target": "~/.config/client/settings.json",
      "spec": {
        "kind": "config",
        "format": "json",
        "keys": [{
          "path": "mcpServers.example",
          "value": {
            "command": "server",
            "args": ["serve", "--stdio"],
            "env": { "MODE": "safe", "RETRIES": 2 },
            "enabled": true
          }
        }]
      },
      "verify": { "method": "digest", "digest": "${"a".repeat(64)}" }
    },
    {
      "id": "portable-tool",
      "kind": "tool",
      "policy": "ensure",
      "target": "portable-tool",
      "spec": {
        "kind": "tool",
        "toolId": "portable-tool",
        "recipes": [
          { "platform": "windows", "method": "winget", "package": "Vendor.Tool", "version": "1.2.3" },
          { "platform": "linux", "method": "npm", "package": "portable-tool", "version": "1.2.3" },
          { "platform": "macos", "method": "homebrew", "package": "portable-tool", "version": "1.2.3" }
        ],
        "login": { "required": false }
      },
      "verify": { "method": "executable-present", "executable": "portable-tool" }
    }
  ]
}`;

describe("public profile compiler", () => {
  it("returns stable publication bytes and explicit platform projections", () => {
    const first = compileProfileJsonc(profile);
    const second = compileProfileJsonc(profile);

    expect(second).toEqual(first);
    expect(first.canonicalBytes).toBe(second.canonicalBytes);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.projections.map((projection) => projection.platform)).toEqual([
      "linux",
      "macos",
      "windows",
    ]);

    for (const projection of first.projections) {
      const config = projection.profile.resources.find((resource) =>
        resource.id === "mcp-settings"
      );
      expect(config).toEqual(first.profile.resources.find((resource) =>
        resource.id === "mcp-settings"
      ));
      const tool = projection.profile.resources.find((resource) =>
        resource.id === "portable-tool"
      );
      expect(tool?.spec.kind).toBe("tool");
      if (tool?.spec.kind === "tool") {
        expect(tool.spec.recipes).toEqual([
          expect.objectContaining({ platform: projection.platform }),
        ]);
      }
    }
  });

  it("rejects ambiguous ownership before emitting a candidate", () => {
    const conflicting = JSON.parse(profile);
    conflicting.resources.push({
      ...conflicting.resources[0],
      id: "nested-owner",
      target: "~/.config/client/settings.json/nested",
    });

    expect(() => compileProfile(conflicting)).toThrow(/conflict|overlap/iu);
  });

  it("deduplicates and sorts selected platforms", () => {
    expect(compileProfileJsonc(profile, {
      platforms: ["windows", "linux", "windows"],
    }).projections.map((projection) => projection.platform)).toEqual([
      "linux",
      "windows",
    ]);
  });
});
