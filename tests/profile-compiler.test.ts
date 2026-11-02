import { describe, expect, it } from "vitest";
import { decodeMachineProfileJsonc } from "../src/domain/profile.ts";
import { assertProfileMetadataBudget } from "../src/profile/metadata-budget.ts";

import {
  compileProfile,
  compileProfileJsonc,
  profileContentDigests,
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
      "verify": { "method": "digest" }
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

describe("transportable revision metadata", () => {
  const directoryProfile = (count: number) => ({ version: 2, id: "metadata-fixture", name: "Metadata fixture", groups: [], resources: [{
    id: "notes", kind: "directory", target: "~/notes", spec: { kind: "directory", files: Array.from({ length: count }, (_, index) => ({ path: `note-${index}.txt`, content: "fixture" })) },
    verify: { method: "digest" },
  }] });

  it("refuses expanded directory metadata rather than compiling an unservable revision", () => {
    expect(() => compileProfileJsonc(JSON.stringify(directoryProfile(12000))))
      .toThrow(/metadata.*transport limit/i);
  });

  it("continues to compile ordinary directory resources", () => {
    expect(compileProfileJsonc(JSON.stringify(directoryProfile(10))).resources).toHaveLength(1);
  });
});


it("applies the metadata limit to digest inspection too", () => {
  const input = decodeMachineProfileJsonc(JSON.stringify({ version: 2, id: "digest-metadata", name: "Digest metadata", resources: [{
    id: "notes", kind: "directory", target: "~/notes", spec: { kind: "directory", files: Array.from({ length: 12000 }, (_, index) => ({ path: `note-${index}.txt`, content: "fixture" })) }, verify: { method: "digest" },
  }] }));
  expect(() => profileContentDigests(input)).toThrow(/metadata.*transport limit/i);
});

it("does not count separately transported file bytes as revision metadata", () => {
  const compiled = compileProfileJsonc(JSON.stringify({ version: 2, id: "large-blob", name: "Large blob", resources: [{
    id: "file", kind: "file", target: "~/large-file", spec: { kind: "file", content: "x".repeat(2 * 1024 * 1024) }, verify: { method: "digest" },
  }] }));
  expect(compiled.resources).toHaveLength(1);
});

it("accounts for long actual signing fields and UTF-8 bytes", () => {
  expect(() => assertProfileMetadataBudget({ profileId: "fixture", resources: [], signingKeyId: "x".repeat(1024 * 1024) })).toThrow(/transport limit/);
  expect(() => assertProfileMetadataBudget({ profileId: "fixture", resources: [], sourceSignature: "😀".repeat(300000) })).toThrow(/transport limit/);
});
