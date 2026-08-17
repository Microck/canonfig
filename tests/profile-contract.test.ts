import { readFileSync } from "node:fs";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  digestOf,
  parseJsonc,
  sha256Hex,
  stripJsonc,
} from "../src/profile/profile-codec.ts";
import {
  decodeMachineProfileJsonc,
  digestMachineProfile,
  encodeMachineProfile,
  findDependencyCycle,
  ProfileContractError,
  ProfileResourceInputSchema,
  ResourceSpecInputSchema,
  topologicalOrder,
  validateMachineProfile,
  validateProfileResources,
  type ProfileResourceInput,
} from "../src/domain/profile.ts";
import {
  ActionDetailSchema,
  AgentTaskSchema,
  HumanActionRequiredSchema,
  SynchronizationOutcomeSchema,
  SynchronizationPlanSchema,
  validateSynchronizationPlan,
  type ActionDetail,
  type SynchronizationOutcome,
  type SynchronizationPlan,
} from "../src/domain/synchronization.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/profile-contract/${name}`, import.meta.url), "utf8");

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);

const fileResource = (id: string, over: Partial<ProfileResourceInput> = {}): ProfileResourceInput => ({
  id,
  kind: "file",
  target: `~/.codex/${id}.txt`,
  spec: { kind: "file", content: "hello" },
  verify: { method: "digest", digest: sha256Hex("hello") },
  ...over,
});

describe("canonical JSON", () => {
  it("sorts keys and drops insignificant whitespace", () => {
    const a = { b: 1, a: [2, { d: true, c: null }] };
    const b = { a: [2, { c: null, d: true }], b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":[2,{"c":null,"d":true}],"b":1}');
  });

  it("treats equivalent JSONC authoring layouts as the same digest", () => {
    const messy = `
      // canonfig authoring file
      {
        /* block comment */
        "name": "workstation",   // trailing comment
        "resources": [
          { "id": "b", "kind": "file", "target": "~/b", "spec": { "kind": "file", "content": "x" }, "verify": { "method": "digest", "digest": "00" } },
          { "id": "a", "kind": "file", "target": "~/a", "spec": { "kind": "file", "content": "y" }, "verify": { "method": "digest", "digest": "11" }, },
        ],
      }
    `;
    const tidy = `{
      "name": "workstation",
      "resources": [
        { "id": "b", "kind": "file", "target": "~/b", "spec": { "kind": "file", "content": "x" }, "verify": { "method": "digest", "digest": "00" } },
        { "id": "a", "kind": "file", "target": "~/a", "spec": { "kind": "file", "content": "y" }, "verify": { "method": "digest", "digest": "11" } }
      ]
    }`;
    const messyValue = parseJsonc(messy);
    const tidyValue = parseJsonc(tidy);
    expect(digestOf(messyValue)).toBe(digestOf(tidyValue));
  });
});

describe("JSONC parsing", () => {
  it("preserves comment-like text inside strings", () => {
    expect(stripJsonc(`{"a": "not // a comment"}`)).toBe(`{"a": "not // a comment"}`);
    expect(stripJsonc(`{"a": "keep /* this */"}`)).toBe(`{"a": "keep /* this */"}`);
  });

  it("removes trailing commas", () => {
    expect(parseJsonc(`{"a": 1,}`)).toEqual({ a: 1 });
    expect(parseJsonc(`[1, 2,]`)).toEqual([1, 2]);
  });

  it("rejects invalid JSONC", () => {
    expect(() => parseJsonc(`{"a": `)).toThrow();
  });
});

describe("resource graph validation", () => {
  it("rejects duplicate resource ids precisely", () => {
    const errors = validateProfileResources([fileResource("x"), fileResource("x")]);
    expect(errors.filter((e) => e._tag === "DuplicateResourceError")).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    if (errors[0]?._tag === "DuplicateResourceError") {
      expect(errors[0].id).toBe("x");
    }
  });

  it("rejects missing dependencies with the exact missing id", () => {
    const errors = validateProfileResources([
      fileResource("a", { dependsOn: ["ghost"] }),
    ]);
    expect(errors).toHaveLength(1);
    if (errors[0]?._tag === "MissingDependencyError") {
      expect(errors[0].id).toBe("a");
      expect(errors[0].dependsOn).toBe("ghost");
    }
  });

  it("rejects dependency cycles with a cycle path", () => {
    const errors = validateProfileResources([
      fileResource("a", { dependsOn: ["b"] }),
      fileResource("b", { dependsOn: ["c"] }),
      fileResource("c", { dependsOn: ["a"] }),
    ]);
    const cycle = errors.find((e) => e._tag === "DependencyCycleError");
    expect(cycle).toBeDefined();
    if (cycle?._tag === "DependencyCycleError") {
      expect(cycle.cycle.length).toBeGreaterThanOrEqual(3);
      const [first, ...rest] = cycle.cycle;
      // The cycle closes by repeating its entry node.
      expect(rest[rest.length - 1]).toBe(first);
    }
  });

  it("rejects incompatible policy for a kind", () => {
    const errors = validateProfileResources([
      fileResource("a", { policy: "ensure" }),
    ]);
    expect(errors).toHaveLength(1);
    if (errors[0]?._tag === "PolicyKindMismatchError") {
      expect(errors[0].kind).toBe("file");
      expect(errors[0].policy).toBe("ensure");
    }
  });

  it.each(["mirror-owned", "merge"] as const)(
    "rejects unsupported file policy %s at the authoring schema boundary",
    (policy) => {
      expect(() => Schema.decodeUnknownSync(ProfileResourceInputSchema)({
        ...fileResource("unsupported"),
        policy,
      })).toThrow();
    },
  );

  it.each([
    {
      name: "regular file with symlink verification",
      spec: { kind: "file" as const, content: "hello" },
      verify: { method: "symlink" as const, target: "/tmp/target" },
    },
    {
      name: "regular file with executable verification",
      spec: { kind: "file" as const, content: "hello", executable: true },
      verify: { method: "executable-present" as const, executable: "hello" },
    },
    {
      name: "symlink file with digest verification",
      spec: {
        kind: "file" as const,
        content: "",
        symlinkTo: "/tmp/target",
      },
      verify: { method: "digest" as const, digest: sha256Hex("hello") },
    },
    {
      name: "symlink file with executable verification",
      spec: {
        kind: "file" as const,
        content: "",
        symlinkTo: "/tmp/target",
      },
      verify: { method: "executable-present" as const, executable: "target" },
    },
  ] as const)("rejects $name", ({ spec, verify }) => {
    const errors = validateProfileResources([fileResource("invalid", { spec, verify })]);
    expect(errors.map((error) => error._tag)).toEqual(["VerificationKindMismatchError"]);
  });

  it.each([
    {
      name: "regular",
      spec: { kind: "file" as const, content: "hello", executable: false },
      verify: { method: "digest" as const, digest: sha256Hex("hello") },
    },
    {
      name: "executable",
      spec: { kind: "file" as const, content: "hello", executable: true },
      verify: { method: "digest" as const, digest: sha256Hex("hello") },
    },
    {
      name: "symlink",
      spec: { kind: "file" as const, content: "", symlinkTo: "/tmp/target" },
      verify: { method: "symlink" as const, target: "/tmp/target" },
    },
  ] as const)("accepts valid $name file verification", ({ spec, verify }) => {
    expect(validateProfileResources([fileResource("valid", { spec, verify })])).toEqual([]);
  });

  it("accepts default policies for every kind", () => {
    const resources: Array<ProfileResourceInput> = [
      { id: "f", kind: "file", target: "~/f", spec: { kind: "file", content: "x" }, verify: { method: "digest", digest: sha256Hex("x") } },
      { id: "d", kind: "directory", target: "~/d", spec: { kind: "directory", files: [] }, verify: { method: "digest", digest: "d".repeat(64) } },
      { id: "c", kind: "config", target: "~/c.toml", spec: { kind: "config", format: "toml", keys: [{ path: "a.b", value: 1 }] }, verify: { method: "digest", digest: "d".repeat(64) } },
      { id: "s", kind: "skill", target: "~/skills/s", spec: { kind: "skill", name: "s", files: [] }, verify: { method: "digest", digest: "d".repeat(64) } },
      { id: "t", kind: "tool", target: "~", spec: { kind: "tool", toolId: "rg", recipes: [] }, verify: { method: "executable-present", executable: "rg" } },
      { id: "cr", kind: "credential", target: "~", spec: { kind: "credential", reference: "gh" }, verify: { method: "credential-present", reference: "gh" } },
      { id: "sc", kind: "schedule", target: "~", spec: { kind: "schedule", calendar: { type: "daily", at: "00:00" }, timezone: "UTC" }, verify: { method: "command", command: ["true"] } },
    ];
    expect(validateProfileResources(resources)).toEqual([]);
  });

  it("rejects required build policies without complete reviewed bounds", () => {
    const errors = validateProfileResources([{
      id: "native-tool",
      kind: "tool",
      target: "~/.local/bin/native-tool",
      spec: {
        kind: "tool",
        toolId: "native-tool",
        recipes: [{
          platform: "linux",
          method: "npm",
          package: "native-tool",
          version: "1.0.0",
          buildPolicy: {
            mode: "required",
            reviewedBy: "reviewer",
            reviewedAt: "2026-08-16T00:00:00Z",
            executables: [],
            paths: [],
            origins: [],
            capabilities: [],
            steps: [],
          },
        }],
      },
      verify: { method: "executable-present", executable: "native-tool" },
    }]);
    expect(errors.map((error) => error._tag)).toContain("InvalidBuildPolicyError");
  });

  it("rejects invalid targets", () => {
    const errors = validateProfileResources([
      fileResource("a", { target: "~/../escape" }),
      fileResource("b", { target: "" }),
    ]);
    expect(errors.every((e) => e._tag === "InvalidTargetError")).toBe(true);
    expect(errors).toHaveLength(2);
  });

  it("rejects normalized and parent-child resource target conflicts", () => {
    const errors = validateProfileResources([
      fileResource("file", { target: "~/.config/canonfig" }),
      fileResource("alias", { target: "~/.config/./CANONFIG" }),
      {
        id: "directory",
        kind: "directory",
        target: "~/.config/skills",
        spec: {
          kind: "directory",
          files: [{ path: "SKILL.md", content: "managed" }],
        },
        verify: { method: "digest", digest: digestA },
      },
      fileResource("child", { target: "~/.config/skills/SKILL.md" }),
    ]);

    expect(errors.filter((error) =>
      error._tag === "ConflictingResourceTargetError"
    ).map((error) => [error.id, error.conflictsWith])).toEqual([
      ["alias", "file"],
      ["child", "directory"],
    ]);
  });

  it.each([
    {
      name: "duplicate entries",
      platform: "windows" as const,
      paths: ["a", "a"],
      expected: ["ConflictingResourceTargetError"],
    },
    {
      name: "file and descendant entries",
      platform: "windows" as const,
      paths: ["a", "a/b"],
      expected: ["ConflictingResourceTargetError"],
    },
    {
      name: "normalized aliases",
      platform: "windows" as const,
      paths: ["a/b", "a/./b"],
      expected: ["InvalidTargetError"],
    },
    {
      name: "alternate separators",
      platform: "windows" as const,
      paths: ["a\\b"],
      expected: ["InvalidTargetError"],
    },
    {
      name: "reserved Windows names",
      platform: "windows" as const,
      paths: ["CON.txt"],
      expected: ["InvalidTargetError"],
    },
    {
      name: "valid nested files",
      platform: "windows" as const,
      paths: ["nested/one.txt", "nested/deeper/two.txt"],
      expected: [],
    },
  ])("validates intra-resource $name deterministically", ({
    platform,
    paths,
    expected,
  }) => {
    const errors = validateProfileResources([{
      id: "tree",
      kind: "directory",
      target: "~/.canonfig/tree",
      spec: {
        kind: "directory",
        files: paths.map((path) => ({ path, content: path })),
      },
      verify: { method: "digest", digest: digestA },
    }], undefined, platform);
    expect(errors.map((error) => error._tag)).toEqual(expected);
  });

  it("applies case folding only on case-insensitive targets", () => {
    const resources: Array<ProfileResourceInput> = [{
      id: "tree",
      kind: "directory",
      target: "~/.canonfig/tree",
      spec: {
        kind: "directory",
        files: [
          { path: "Readme.md", content: "one" },
          { path: "README.md", content: "two" },
        ],
      },
      verify: { method: "digest", digest: digestA },
    }];
    expect(validateProfileResources(resources, undefined, "linux")).toEqual([]);
    expect(validateProfileResources(resources, undefined, "windows")
      .map((error) => error._tag)).toEqual(["ConflictingResourceTargetError"]);
  });

  it.each([
    { kind: "file" as const, symlinkTo: undefined },
    { kind: "file" as const, symlinkTo: "/outside/target" },
  ])("rejects a $kind resource parent claim before a descendant", ({ symlinkTo }) => {
    const parent = fileResource("parent", {
      target: "~/.canonfig/tree",
      spec: { kind: "file", content: "parent", symlinkTo },
    });
    const child = fileResource("child", {
      target: "~/.canonfig/tree/nested/file.txt",
    });
    expect(validateProfileResources([parent, child])
      .filter((error) => error._tag === "ConflictingResourceTargetError")
      .map((error) => [error.id, error.conflictsWith])).toEqual([
        ["child", "parent"],
      ]);
  });

  it("rejects invalid schedule times", () => {
    const bad = fileResource("s", {
      kind: "schedule",
      spec: { kind: "schedule", calendar: { type: "daily", at: "25:00" }, timezone: "UTC" },
      verify: { method: "command", command: ["true"] },
    });
    const errors = validateProfileResources([bad]);
    expect(errors).toHaveLength(1);
    if (errors[0]?._tag === "InvalidScheduleError") {
      expect(errors[0].reason).toContain("25:00");
    }
  });
});

describe("installation recipe version boundaries", () => {
  it("rejects unversioned source recipes at the authoring boundary", () => {
    expect(() => Schema.decodeUnknownSync(ResourceSpecInputSchema)({
      kind: "tool",
      toolId: "source-tool",
      recipes: [{
        platform: "linux",
        method: "source",
        package: "https://github.com/example/source-tool",
      }],
      login: { required: false },
    })).toThrow();
  });

  it("preserves an immutable source revision as a reviewed profile recipe", () => {
    const decoded = Schema.decodeUnknownSync(ResourceSpecInputSchema)({
      kind: "tool",
      toolId: "source-tool",
      recipes: [{
        platform: "linux",
        method: "source",
        package: "https://github.com/example/source-tool",
        version: "v7.0.0",
      }],
      login: { required: false },
    });
    expect(decoded).toMatchObject({
      kind: "tool",
      recipes: [{
        method: "source",
        package: "https://github.com/example/source-tool",
        version: "v7.0.0",
      }],
    });
  });

  it("rejects source recipes at the automatic action boundary", () => {
    expect(() => Schema.decodeUnknownSync(ActionDetailSchema)({
      kind: "install-tool",
      toolId: "source-tool",
      method: "source",
      package: "https://github.com/example/source-tool",
      version: "v7.0.0",
    })).toThrow();
  });

  it("retains reviewed source metadata on automatic install actions", () => {
    const decoded = Schema.decodeUnknownSync(ActionDetailSchema)({
      kind: "install-tool",
      toolId: "tool",
      method: "npm",
      package: "tool",
      version: "1.2.3",
      source: {
        source: "https://registry.npmjs.org/tool/-/tool-1.2.3.tgz",
        integrity: "sha512-c2FtcGxl",
      },
    });
    expect(decoded).toMatchObject({
      source: {
        source: "https://registry.npmjs.org/tool/-/tool-1.2.3.tgz",
        integrity: "sha512-c2FtcGxl",
      },
    });
  });

  it("accepts exact npm semver, including scoped prerelease and build metadata", () => {
    const decoded = Schema.decodeUnknownSync(ResourceSpecInputSchema)({
      kind: "tool",
      toolId: "tool",
      recipes: [{
        platform: "linux",
        method: "npm",
        package: "@scope/tool",
        version: "1.2.3-alpha.1+build.7",
      }],
      login: { required: false },
    });
    expect(decoded).toMatchObject({
      kind: "tool",
      recipes: [{
        package: "@scope/tool",
        version: "1.2.3-alpha.1+build.7",
      }],
    });
  });

  it("retains typed reviewed npm artifact metadata at the profile boundary", () => {
    const decoded = Schema.decodeUnknownSync(ResourceSpecInputSchema)({
      kind: "tool",
      toolId: "tool",
      recipes: [{
        platform: "linux",
        method: "npm",
        package: "@scope/tool",
        version: "1.2.3",
        source: {
          source: "https://registry.npmjs.org/@scope/tool/-/tool-1.2.3.tgz",
          integrity: "sha512-c2FtcGxl",
        },
      }],
      login: { required: false },
    });
    expect(decoded).toMatchObject({
      recipes: [{
        source: {
          source: "https://registry.npmjs.org/@scope/tool/-/tool-1.2.3.tgz",
          integrity: "sha512-c2FtcGxl",
        },
      }],
    });
  });

  it.each([
    "https://registry.npmjs.org/@scope/other/-/other-1.2.3.tgz",
    "https://evil.example/@scope/tool/-/tool-1.2.3.tgz",
    "https://registry.npmjs.org/@scope/tool/-/tool-1.2.3.tgz?redirect=evil",
    "HTTPS://registry.npmjs.org/@scope/tool/-/tool-1.2.3.tgz",
    "https://REGISTRY.NPMJS.ORG/@scope/tool/-/tool-1.2.3.tgz",
    "https://registry.npmjs.org:443/@scope/tool/-/tool-1.2.3.tgz",
    "https://registry.npmjs.org/@scope/tool/../tool/-/tool-1.2.3.tgz",
    "https://registry.npmjs.org/@scope/%74ool/-/tool-1.2.3.tgz",
    "https://registry.npmjs.org/@scope/tool/-/tool-1.2.3.tgz#fragment",
    "https://user:password@registry.npmjs.org/@scope/tool/-/tool-1.2.3.tgz",
    "https://user:password@registry.npmjs.org/@scope/tool/-/tool-1.2.3.tgz",
  ])("rejects an unapproved or mismatched reviewed npm source: %s", (source) => {
    expect(() => Schema.decodeUnknownSync(ResourceSpecInputSchema)({
      kind: "tool",
      toolId: "tool",
      recipes: [{
        platform: "linux",
        method: "npm",
        package: "@scope/tool",
        version: "1.2.3",
        source,
      }],
      login: { required: false },
    })).toThrow();
  });

  it.each([
    "HTTPS://registry.npmjs.org/tool/-/tool-1.2.3.tgz",
    "https://registry.npmjs.org:443/tool/-/tool-1.2.3.tgz",
    "https://registry.npmjs.org/tool/-/tool-1.2.3.tgz?redirect=evil",
    "https://registry.npmjs.org/tool/-/tool-1.2.3.tgz#fragment",
  ])("rejects integrity paired with a noncanonical npm source: %s", (source) => {
    expect(() => Schema.decodeUnknownSync(ResourceSpecInputSchema)({
      kind: "tool",
      toolId: "tool",
      recipes: [{
        platform: "linux",
        method: "npm",
        package: "tool",
        version: "1.2.3",
        source: { source, integrity: "sha512-c2FtcGxl" },
      }],
      login: { required: false },
    })).toThrow();
  });

  it.each([
    ["npm", "@scope/tool", "latest"],
    ["pnpm", "@scope/tool", "^1.2.3"],
    ["bun", "@scope/tool", "1.2"],
    ["brew", "tool", "1.2/3"],
    ["homebrew", "tool", "1.2/3"],
    ["winget", "Example.Tool", "1.2/3"],
    ["uv", "tool", "1.2/3"],
    ["cargo", "tool", "latest"],
    ["apt", "tool", "1.2/3"],
    ["source", "tool", "../bad"],
  ] as const)(
    "rejects malformed %s recipe versions at schema boundary",
    (method, packageName, version) => {
      expect(() => Schema.decodeUnknownSync(ResourceSpecInputSchema)({
        kind: "tool",
        toolId: "tool",
        recipes: [{
          platform: "linux",
          method,
          package: packageName,
          version,
        }],
        login: { required: false },
      })).toThrow();
    },
  );

  it.each([undefined, "1.2.3"] as const)(
    "rejects unknown %s recipe methods at the authoring schema boundary",
    (version) => {
      const recipe = {
        platform: "linux",
        method: "unknown-installer",
        package: "tool",
      };
      const candidate = version === undefined
        ? recipe
        : Object.assign(recipe, { version });
      expect(() => Schema.decodeUnknownSync(ResourceSpecInputSchema)({
        kind: "tool",
        toolId: "tool",
        recipes: [candidate],
        login: { required: false },
      })).toThrow();
    },
  );

  it.each([
    ["dist-tag", "@scope/tool", "latest"],
    ["range", "@scope/tool", "^1.2.3"],
    ["URL", "@scope/tool", "https://registry.npmjs.org/tool.tgz"],
    ["Git", "@scope/tool", "git+https://github.com/example/tool.git#v1.2.3"],
    ["GitHub", "@scope/tool", "github:example/tool"],
    ["alias", "alias@npm:real-tool", "1.2.3"],
    ["file", "@scope/tool", "file:../tool"],
    ["workspace", "@scope/tool", "workspace:*"],
    ["link", "@scope/tool", "link:../tool"],
    ["encoded", "@scope/tool", "1.2.3%2Ftool"],
    ["option", "@scope/tool", "--ignore-scripts"],
    ["separator", "@scope/tool", "1.2.3;--ignore-scripts"],
  ])("rejects npm %s recipe at schema boundary", (_name, packageName, version) => {
    expect(() => Schema.decodeUnknownSync(ResourceSpecInputSchema)({
      kind: "tool",
      toolId: "tool",
      recipes: [{
        platform: "linux",
        method: "npm",
        package: packageName,
        version,
      }],
      login: { required: false },
    })).toThrow();
  });

  it.each([undefined, "1.2.3"] as const)(
    "rejects unknown %s install action methods at the action schema boundary",
    (version) => {
      const detail = {
        kind: "install-tool",
        toolId: "tool",
        method: "unknown-installer",
        package: "tool",
      };
      const candidate = version === undefined
        ? detail
        : Object.assign(detail, { version });
      expect(() => Schema.decodeUnknownSync(ActionDetailSchema)(candidate)).toThrow();
    },
  );

  it.each([undefined, "1.2.3"] as const)(
    "rejects unknown %s install action methods at the persisted-plan boundary",
    (version) => {
      const detail = {
        kind: "install-tool",
        toolId: "tool",
        method: "unknown-installer",
        package: "tool",
      };
      const candidate = version === undefined
        ? detail
        : Object.assign(detail, { version });
      expect(() => Schema.decodeUnknownSync(SynchronizationPlanSchema)({
        revision: "revision-1",
        follower: "follower-1",
        encoded: "",
        actions: [{
          id: "a",
          resource: "resource",
          kind: "install-tool",
          detail: candidate,
          before: [],
        }],
      })).toThrow();
    },
  );

  it("reports invalid typed recipes at the profile validation boundary", () => {
    const errors = validateProfileResources([{
      id: "tool",
      kind: "tool",
      target: "tool",
      spec: {
        kind: "tool",
        toolId: "tool",
        recipes: [{
          platform: "linux",
          method: "npm",
          package: "@scope/tool",
          version: "latest",
        }],
      },
      verify: { method: "executable-present", executable: "tool" },
    }]);
    expect(errors.map((error) => error._tag)).toEqual(["InvalidRecipeError"]);
  });
});

describe("topological order", () => {
  it("places dependencies before dependents regardless of input order", () => {
    const resources = [
      fileResource("z", { dependsOn: ["y"] }),
      fileResource("y", { dependsOn: ["x"] }),
      fileResource("x"),
    ];
    const order = topologicalOrder(resources);
    expect(order.indexOf("x")).toBeLessThan(order.indexOf("y"));
    expect(order.indexOf("y")).toBeLessThan(order.indexOf("z"));
  });

  it("is deterministic for the same input", () => {
    const resources = [fileResource("b"), fileResource("a", { dependsOn: ["b"] })];
    expect(topologicalOrder(resources)).toEqual(topologicalOrder(resources));
  });
});

describe("dependency cycle detection", () => {
  it("finds a self-cycle", () => {
    expect(findDependencyCycle([fileResource("a", { dependsOn: ["a"] })])).toEqual(["a", "a"]);
  });

  it("returns null for acyclic graphs", () => {
    expect(findDependencyCycle([fileResource("a"), fileResource("b", { dependsOn: ["a"] })])).toBeNull();
  });
});

describe("v2 profile fixtures", () => {
  it("decodes the forward-conformance fixture and applies deterministic defaults", () => {
    const profile = decodeMachineProfileJsonc(fixture("v2-profile.jsonc"));
    expect(profile.version).toBe(2);
    expect(profile.groups.map((group) => group.name)).toEqual(["base", "work"]);
    expect(profile.resources.map((resource) => resource.id)).toEqual([
      "agent-config",
      "instructions",
      "prompts",
      "review-skill",
      "rg",
      "token",
      "weekly-sync",
    ]);
    expect(profile.scheduleDefault).toEqual({
      type: "daily",
      at: "00:00",
      timezone: "local",
    });
    expect(profile.resources.find((resource) => resource.id === "rg")?.policy).toBe("ensure");
    expect(validateMachineProfile(profile)).toEqual([]);
  });

  it("normalizes equivalent layouts, defaults, and order to identical bytes and digest", () => {
    const implicit = decodeMachineProfileJsonc(fixture("v2-profile.jsonc"));
    const explicit = decodeMachineProfileJsonc(fixture("v2-profile-equivalent.jsonc"));
    expect(encodeMachineProfile(implicit)).toBe(encodeMachineProfile(explicit));
    expect(digestMachineProfile(implicit)).toBe(digestMachineProfile(explicit));
    expect(digestMachineProfile(implicit)).toBe(
      "a98186407a99282f110fec3ca368702078400c754b2a986415e53f3b6001f5c3",
    );
  });

  it("rejects unknown fields at the malformed fixture boundary", () => {
    expect(() => decodeMachineProfileJsonc(fixture("v2-profile-malformed.jsonc"))).toThrow();
  });

  it("rejects invalid references and incompatible discriminants with tagged errors", () => {
    let caught: unknown;
    try {
      decodeMachineProfileJsonc(`{
        "id": "graph-errors",
        "name": "Graph errors",
        "groups": [{ "name": "known" }],
        "resources": [{
          "id": "bad",
          "kind": "file",
          "target": "~/bad",
          "groups": ["missing"],
          "spec": { "kind": "tool", "toolId": "rg", "recipes": [] },
          "verify": { "method": "credential-present", "reference": "token" }
        }]
      }`);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProfileContractError);
    if (caught instanceof ProfileContractError) {
      expect(caught.errors.map((error) => error._tag)).toEqual([
        "ResourceSpecKindMismatchError",
        "MissingGroupReferenceError",
        "VerificationKindMismatchError",
      ]);
    }
  });
});

const actionDetailLabel = (detail: ActionDetail): string => {
  switch (detail.kind) {
    case "no-op": return "no-op";
    case "transfer-blob": return detail.blob;
    case "write-file": return detail.target;
    case "write-config": return detail.target;
    case "mirror-directory": return detail.target;
    case "remove-resource": return detail.target;
    case "install-tool": return detail.toolId;
    case "verify-only": return detail.method;
    case "human-action": return detail.reason;
    case "agent-task": return detail.summary;
    case "drift-conflict": return detail.target;
  }
};

const outcomeLabel = (outcome: SynchronizationOutcome): string => {
  switch (outcome.outcome) {
    case "Converged": return outcome.verified.join(",");
    case "HumanActionRequired": return outcome.actions.map((action) => action.reason).join(",");
    case "FollowerDrift": return outcome.conflicts.map((conflict) => conflict.resource).join(",");
    case "Failed": return outcome.reason;
    case "Interrupted": return outcome.completedActions.join(",");
  }
};

describe("schema-backed synchronization contracts", () => {
  it("decodes and exhaustively matches every action detail tag", () => {
    const fixtures: ReadonlyArray<unknown> = [
      { kind: "no-op" },
      { kind: "transfer-blob", blob: digestA, bytes: 1 },
      { kind: "write-file", target: "~/a", digest: digestA },
      { kind: "write-config", target: "~/a", keys: ["a"] },
      { kind: "mirror-directory", target: "~/a", adds: ["a"], removes: ["b"] },
      {
        kind: "install-tool",
        toolId: "rg",
        method: "apt",
        package: "ripgrep",
        version: "14.1.0",
      },
      { kind: "verify-only", method: "digest" },
      { kind: "human-action", reason: "login", instructions: "Run gh auth login" },
      { kind: "agent-task", taskId: "task-1", summary: "Resolve package" },
      {
        kind: "drift-conflict",
        target: "~/a",
        desiredDigest: digestA,
        observedDigest: digestB,
      },
      {
        kind: "remove-resource",
        target: "~/a",
        paths: ["a"],
        keys: [],
      },
    ];
    const decoded = fixtures.map(Schema.decodeUnknownSync(ActionDetailSchema));
    expect(decoded.map(actionDetailLabel)).toHaveLength(11);
    expect(decoded[5]).toMatchObject({ version: "14.1.0" });
    expect(() => Schema.decodeUnknownSync(ActionDetailSchema)({
      kind: "install-tool",
      toolId: "rg",
      method: "apt",
      package: "ripgrep",
    })).toThrow();
    expect(() => Schema.decodeUnknownSync(ActionDetailSchema)({
      kind: "install-tool",
      toolId: "tool",
      method: "npm",
      package: "@scope/tool",
      version: "latest",
    })).toThrow();
    expect(() => Schema.decodeUnknownSync(ActionDetailSchema)({ kind: "future-action" })).toThrow();
  });

  it("decodes and exhaustively matches every synchronization outcome tag", () => {
    const fixtures: ReadonlyArray<unknown> = [
      { outcome: "Converged", run: "run-1", verified: ["resource"] },
      {
        outcome: "HumanActionRequired",
        run: "run-1",
        actions: [{ reason: "login", instructions: "Authenticate" }],
      },
      {
        outcome: "FollowerDrift",
        run: "run-1",
        conflicts: [{
          resource: "resource",
          target: "~/a",
          desiredDigest: digestA,
          observedDigest: digestB,
          lastAppliedDigest: digestC,
        }],
      },
      { outcome: "Failed", run: "run-1", reason: "network" },
      { outcome: "Interrupted", run: "run-1", completedActions: ["action-1"] },
    ];
    const decoded = fixtures.map(Schema.decodeUnknownSync(SynchronizationOutcomeSchema));
    expect(decoded.map(outcomeLabel)).toHaveLength(5);
    expect(() =>
      Schema.decodeUnknownSync(SynchronizationOutcomeSchema)({
        outcome: "Unknown",
        run: "run-1",
      })
    ).toThrow();
  });

  it("validates action references, cycles, and detail compatibility", () => {
    const plan = Schema.decodeUnknownSync(SynchronizationPlanSchema)({
      revision: "revision-1",
      follower: "follower-1",
      encoded: "",
      actions: [
        {
          id: "a",
          resource: "resource",
          kind: "write-file",
          detail: { kind: "no-op" },
          before: ["b", "missing"],
        },
        {
          id: "b",
          resource: "resource",
          kind: "no-op",
          detail: { kind: "no-op" },
          before: ["a"],
        },
      ],
    }) satisfies SynchronizationPlan;
    expect(validateSynchronizationPlan(plan).map((error) => error._tag)).toEqual([
      "ActionKindMismatchError",
      "MissingActionReferenceError",
      "ActionCycleError",
    ]);
  });

  it("rejects malformed bounded Agent Tasks and accepts Human Action Required", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgentTaskSchema)({
        id: "task-1",
        summary: "Install",
        desiredOutcome: "rg available",
        observedEvidence: [],
        allowedPaths: ["~/.local"],
        allowedExecutables: ["apt"],
        allowedOrigins: ["github.com"],
        forbidden: ["elevation"],
        timeLimitSeconds: -1,
        outputLimitBytes: 1024,
        verification: { command: ["rg", "--version"] },
      })
    ).toThrow();
    expect(Schema.decodeUnknownSync(HumanActionRequiredSchema)({
      outcome: "HumanActionRequired",
      run: "run-1",
      actions: [{
        reason: "login required",
        instructions: "Run gh auth login",
        resource: "token",
      }],
    }).actions[0]?.reason).toBe("login required");
  });
});
