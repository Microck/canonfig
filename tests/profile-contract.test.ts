import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  digestOf,
  parseJsonc,
  sha256Hex,
  stripJsonc,
} from "../src/profile/profile-codec.ts";
import {
  ProfileResourceInputSchema,
  PublishedResourceSpecSchema,
  ResourceSpecInputSchema,
  ScheduleDefault,
  validateProfileResources,
  type ProfileResourceInput,
} from "../src/domain/profile.ts";

const digestA = "a".repeat(64);

const fileResource = (id: string, over: Partial<ProfileResourceInput> = {}): ProfileResourceInput => ({
  id,
  kind: "file",
  target: `~/.codex/${id}.txt`,
  spec: { kind: "file", source: `${id}.txt` },
  verify: { method: "digest", digest: sha256Hex("hello") },
  ...over,
});

const skillResource = (
  files: ReadonlyArray<{ readonly path: string; readonly mode?: number }>,
): ProfileResourceInput => ({
  id: "tree",
  kind: "skill",
  target: "~/.canonfig/skills/tree",
  spec: { kind: "skill", name: "tree", files: files.map((file) => ({ ...file, source: `skills/tree/${file.path}` })) },
  verify: { method: "digest", digest: digestA },
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


  it("rejects an unsafe integer that reaches validation without JSON text", () => {
    const errors = validateProfileResources([{
      id: "limits", kind: "config", target: "~/.limits.json",
      spec: { kind: "config", format: "json", keys: [{ path: "limits", value: { big: [2 ** 60] } }] },
      verify: { method: "digest" },
    }]);
    expect(errors).toEqual([expect.objectContaining({
      _tag: "InvalidConfigKeyError",
      id: "limits",
      path: "limits",
      reason: expect.stringContaining("value.big[0] cannot be carried exactly"),
    })]);
  });
});

describe("filesystem mode bounds", () => {
  it.each([-1, 0o10000])(
    "rejects out-of-range mode %i at authoring and publication boundaries",
    (mode) => {
      expect(() => Schema.decodeUnknownSync(ResourceSpecInputSchema)({
        kind: "file",
        source: "hello.txt",
        mode,
      })).toThrow();
      expect(() => Schema.decodeUnknownSync(PublishedResourceSpecSchema)({
        kind: "file",
        blob: sha256Hex("hello"),
        bytes: 5,
        executable: false,
        mode,
      })).toThrow();
    },
  );
});

describe("profile schedule default portability", () => {
  it("accepts a daily default in the follower timezone", () => {
    expect(() => Schema.decodeUnknownSync(ScheduleDefault)({ type: "daily", at: "03:30", timezone: "local" })).not.toThrow();
  });

  it.each([
    [{ type: "custom", expression: "*-*-* 03:30:00", timezone: "local" }, "custom calendar"],
    [{ type: "daily", at: "03:30", timezone: "Europe/Paris" }, "named timezone"],
  ])("rejects a default no follower backend can render: %s", (scheduleDefault) => {
    // launchd and Windows Task Scheduler refuse both at apply time. Accepting
    // them at publication only moved the discovery to a follower that then
    // silently ended up with no scheduled synchronization. A follower that
    // wants either sets it locally with `canonfig schedule set`.
    expect(() => Schema.decodeUnknownSync(ScheduleDefault)(scheduleDefault)).toThrow();
  });
});


describe("agent install bounds", () => {
  interface CandidateBounds {
    readonly paths: ReadonlyArray<string>;
    readonly origins?: ReadonlyArray<string> | undefined;
  }

  /** Builds decoder input, including shapes the decoder must reject. */
  const toolWith = (agentInstall: CandidateBounds) => ({
    kind: "tool",
    toolId: "example",
    recipes: [],
    agentInstall,
  });

  it("accepts exact HTTPS origins", () => {
    const decoded = Schema.decodeUnknownOption(ResourceSpecInputSchema)(
      toolWith({
        paths: ["~/.local/share/canonfig/tools/example"],
        origins: ["https://registry.npmjs.org"],
      }),
    );
    expect(Option.isSome(decoded)).toBe(true);
  });

  it.each([
    ["http://registry.npmjs.org", "cleartext"],
    ["https://registry.npmjs.org/", "trailing slash"],
    ["https://registry.npmjs.org/path", "path"],
    ["https://user:pass@registry.npmjs.org", "credentials"],
    ["registry.npmjs.org", "no scheme"],
  ])("rejects %s (%s)", (origin) => {
    // An origin the harness would filter out before execution cannot
    // authorize anything, so accepting it at publication only defers the
    // discovery to a follower that then reports bounds it does not have.
    const decoded = Schema.decodeUnknownOption(ResourceSpecInputSchema)(
      toolWith({ paths: ["~/.local/bin/example"], origins: [origin] }),
    );
    expect(Option.isNone(decoded)).toBe(true);
  });

  it("requires at least one path", () => {
    const decoded = Schema.decodeUnknownOption(ResourceSpecInputSchema)(
      toolWith({ paths: [] }),
    );
    expect(Option.isNone(decoded)).toBe(true);
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
      verify: { method: "symlink" as const, target: "/tmp/target" },
    },
    {
      name: "regular file with executable verification",
      verify: { method: "executable-present" as const, executable: "hello" },
    },
  ] as const)("rejects $name", ({ verify }) => {
    const errors = validateProfileResources([fileResource("invalid", { verify })]);
    expect(errors.map((error) => error._tag)).toEqual(["VerificationKindMismatchError"]);
  });

  it.each([
    { name: "regular", spec: { kind: "file" as const, source: "valid.txt", executable: false } },
    { name: "executable", spec: { kind: "file" as const, source: "valid.txt", executable: true } },
  ] as const)("accepts valid $name file verification", ({ spec }) => {
    expect(validateProfileResources([fileResource("valid", { spec })])).toEqual([]);
  });

  it("accepts default policies for every kind", () => {
    const resources: Array<ProfileResourceInput> = [
      { id: "f", kind: "file", target: "~/f", spec: { kind: "file", source: "f" }, verify: { method: "digest", digest: sha256Hex("x") } },
      { id: "c", kind: "config", target: "~/c.toml", spec: { kind: "config", format: "toml", keys: [{ path: "a.b", value: 1 }] }, verify: { method: "digest", digest: "d".repeat(64) } },
      { id: "s", kind: "skill", target: "~/skills/s", spec: { kind: "skill", name: "s", files: [] }, verify: { method: "digest", digest: "d".repeat(64) } },
      { id: "t", kind: "tool", target: "~", spec: { kind: "tool", toolId: "rg", recipes: [] }, verify: { method: "executable-present", executable: "rg" } },
      { id: "cr", kind: "credential", target: "~", spec: { kind: "credential", reference: "gh" }, verify: { method: "credential-present", reference: "gh" } },
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
      { ...skillResource([{ path: "SKILL.md" }]), id: "directory", target: "~/.config/skills" },
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
    const errors = validateProfileResources([skillResource(paths.map((path) => ({ path })))], undefined, platform);
    expect(errors.map((error) => error._tag)).toEqual(expected);
  });

  it("rejects filesystem modes that prevent deterministic verification", () => {
    const errors = validateProfileResources([
      {
        id: "file",
        kind: "file",
        target: "~/.canonfig/file",
        spec: { kind: "file", source: "file", mode: 0o200 },
        verify: { method: "digest", digest: digestA },
      },
      skillResource([{ path: "write-only.txt", mode: 0o200 }]),
    ]);

    expect(errors.filter((error) => error._tag === "UnmanageableFilesystemModeError"))
      .toMatchObject([
        { id: "file", path: "~/.canonfig/file", mode: 0o200 },
        { id: "tree", path: "write-only.txt", mode: 0o200 },
      ]);
  });

  it("applies case folding only on case-insensitive targets", () => {
    const resources = [skillResource([{ path: "Readme.md" }, { path: "README.md" }])];
    expect(validateProfileResources(resources, undefined, "linux")).toEqual([]);
    expect(validateProfileResources(resources, undefined, "windows")
      .map((error) => error._tag)).toEqual(["ConflictingResourceTargetError"]);
  });

  it("rejects a file resource parent claim before a descendant", () => {
    const parent = fileResource("parent", { target: "~/.canonfig/tree" });
    const child = fileResource("child", {
      target: "~/.canonfig/tree/nested/file.txt",
    });
    expect(validateProfileResources([parent, child])
      .filter((error) => error._tag === "ConflictingResourceTargetError")
      .map((error) => [error.id, error.conflictsWith])).toEqual([
        ["child", "parent"],
      ]);
  });
});
