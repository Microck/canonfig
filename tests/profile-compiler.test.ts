import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { BlobId } from "../src/domain/brand.ts";
import { normalizeMachineProfile, type MachineProfile, type ProfileResourceInput } from "../src/domain/profile.ts";
import { compileProfileCandidate, type ResolvedSourceFiles } from "../src/profile/compiler.ts";
import { assertProfileMetadataBudget } from "../src/profile/metadata-budget.ts";
import { sha256Hex } from "../src/profile/profile-codec.ts";

const profileWith = (resources: ReadonlyArray<ProfileResourceInput>): MachineProfile =>
  normalizeMachineProfile({ id: "compiler-fixture", version: 2, name: "Compiler fixture", groups: [], resources });

/** Every `source` resolves to the same small file; the compiler never reads it. */
const sourcesFor = (names: ReadonlyArray<string>, bytes = 7): ResolvedSourceFiles =>
  new Map(names.map((name) => [name, {
    path: `/fixture/${name}`,
    blob: Schema.decodeUnknownSync(BlobId)(sha256Hex(name)),
    bytes,
  }]));

const mcpSettings: ProfileResourceInput = {
  id: "mcp-settings",
  kind: "config",
  policy: "merge",
  target: "~/.config/client/settings.json",
  spec: {
    kind: "config",
    format: "json",
    keys: [{
      path: "mcpServers.example",
      value: { command: "server", args: ["serve", "--stdio"], env: { MODE: "safe", RETRIES: 2 }, enabled: true },
    }],
  },
  verify: { method: "digest" },
};

const portableTool: ProfileResourceInput = {
  id: "portable-tool",
  kind: "tool",
  policy: "ensure",
  target: "portable-tool",
  spec: {
    kind: "tool",
    toolId: "portable-tool",
    recipes: [
      { platform: "windows", method: "winget", package: "Vendor.Tool", version: "1.2.3" },
      { platform: "linux", method: "npm", package: "portable-tool", version: "1.2.3" },
      { platform: "macos", method: "homebrew", package: "portable-tool", version: "1.2.3" },
    ],
    login: { required: false },
  },
  verify: { method: "executable-present", executable: "portable-tool" },
};

const skill = (count: number): ProfileResourceInput => ({
  id: "skills:notes",
  kind: "skill",
  target: "skills/notes",
  spec: {
    kind: "skill",
    name: "notes",
    files: Array.from({ length: count }, (_, index) => ({ path: `note-${index}.md`, source: `skills/notes/note-${index}.md` })),
  },
  verify: { method: "digest" },
});

describe("profile compiler", () => {
  it("returns stable publication bytes and computes omitted digests", () => {
    const profile = profileWith([mcpSettings, portableTool]);
    const first = compileProfileCandidate(profile, new Map());
    const second = compileProfileCandidate(profile, new Map());

    expect(second).toEqual(first);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.profile.resources.find((resource) => resource.id === "mcp-settings")?.verify)
      .toEqual({ method: "digest", digest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  });

  it("rejects ambiguous ownership before emitting a candidate", () => {
    const profile = profileWith([
      mcpSettings,
      { ...mcpSettings, id: "nested-owner", target: "~/.config/client/settings.json/nested" },
    ]);
    expect(() => compileProfileCandidate(profile, new Map())).toThrow(/conflict|overlap/iu);
  });

  it("indexes each source file as one content-addressed blob", () => {
    const resource = skill(2);
    const names = resource.spec.kind === "skill" ? resource.spec.files.map((file) => file.source) : [];
    const compiled = compileProfileCandidate(profileWith([resource]), sourcesFor(names));
    expect(compiled.blobs.map((blob) => blob.path).sort()).toEqual(names.map((name) => `/fixture/${name}`).sort());
    expect(compiled.resources[0]?.blobs).toHaveLength(2);
  });
});

describe("transportable revision metadata", () => {
  const compileSkill = (count: number) => {
    const resource = skill(count);
    const names = resource.spec.kind === "skill" ? resource.spec.files.map((file) => file.source) : [];
    return compileProfileCandidate(profileWith([resource]), sourcesFor(names));
  };

  it("refuses expanded skill metadata rather than compiling an unservable revision", () => {
    expect(() => compileSkill(12000)).toThrow(/metadata.*transport limit/i);
  });

  it("continues to compile ordinary skills", () => {
    expect(compileSkill(10).resources).toHaveLength(1);
  });

  it("does not count separately transported file bytes as revision metadata", () => {
    const compiled = compileProfileCandidate(profileWith([{
      id: "instructions", kind: "file", target: "AGENTS.md", spec: { kind: "file", source: "AGENTS.md" }, verify: { method: "digest" },
    }]), sourcesFor(["AGENTS.md"], 2 * 1024 * 1024));
    expect(compiled.resources).toHaveLength(1);
  });

  it("accounts for long actual signing fields and UTF-8 bytes", () => {
    expect(() => assertProfileMetadataBudget({ profileId: "fixture", resources: [], signingKeyId: "x".repeat(1024 * 1024) })).toThrow(/transport limit/);
    expect(() => assertProfileMetadataBudget({ profileId: "fixture", resources: [], sourceSignature: "😀".repeat(300000) })).toThrow(/transport limit/);
  });
});
