import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  BlobId,
  ContentDigest,
  FollowerId,
  ProfileId,
  ProfileRevisionId,
  ResourceId,
} from "../src/domain/brand.ts";
import type { ProfileRevision, PublishedResource } from "../src/domain/profile.ts";
import type {
  ApplyPolicy,
  RecipeMethod,
  ResourceKind,
} from "../src/domain/resource.ts";
import type {
  AppliedResourceRecord,
  ObservedResourceState,
} from "../src/domain/synchronization.ts";
import { sha256Hex } from "../src/profile/profile-codec.ts";
import {
  getConfigPath,
  parseConfigDocument,
  serializeConfigDocument,
  setConfigPath,
} from "../src/synchronization/config-codec.ts";
import { planSynchronization } from "../src/synchronization/planner.ts";
import { detectSkillDrift } from "../src/synchronization/resource-plans.ts";
import type {
  DesiredResource,
  SynchronizationPlannerInput,
} from "../src/synchronization/synchronization.types.ts";

const decode = Schema.decodeUnknownSync;
const digestA = decode(ContentDigest)("a".repeat(64));
const digestB = decode(ContentDigest)("b".repeat(64));
const digestC = decode(ContentDigest)("c".repeat(64));
const blobA = decode(BlobId)("d".repeat(64));
const blobB = decode(BlobId)("e".repeat(64));
const follower = decode(FollowerId)("follower-1");

const desiredForKind = (kind: ResourceKind): DesiredResource => {
  switch (kind) {
    case "file":
      return { kind, digest: digestA, executable: false };
    case "directory":
      return {
        kind,
        files: [{ path: "one.txt", digest: digestA, executable: false }],
      };
    case "config":
      return {
        kind,
        digest: digestA,
        format: "json",
        keys: ["editor.theme", "mcp.github"],
      };
    case "skill":
      return {
        kind,
        digest: digestA,
        files: [{ path: "SKILL.md", digest: digestA, executable: false }],
      };
    case "tool":
      return {
        kind,
        toolId: "ripgrep",
        recipes: [{ platform: "linux", method: "apt", package: "ripgrep" }],
        loginRequired: false,
      };
    case "credential":
      return {
        kind,
        reference: "github-token",
        instructions: "Run canonfig credential set github-token, then retry.",
      };
    case "schedule":
      return { kind, digest: digestA };
  }
};

const verificationFor = (
  desired: DesiredResource,
) => {
  switch (desired.kind) {
    case "file":
    case "config":
      return { method: "digest" as const, digest: digestA };
    case "directory":
    case "skill":
      return { method: "digest" as const, digest: digestA };
    case "tool":
      return { method: "executable-present" as const, executable: desired.toolId };
    case "credential":
      return { method: "credential-present" as const, reference: desired.reference };
    case "schedule":
      return { method: "command" as const, command: ["true"] };
  }
};

const resource = (
  id: string,
  kind: ResourceKind,
  policy: ApplyPolicy,
  dependencies: ReadonlyArray<string> = [],
  blobs: ReadonlyArray<string> = [],
): PublishedResource => ({
  id: decode(ResourceId)(id),
  kind,
  policy,
  target: `~/.canonfig/${id}`,
  dependsOn: dependencies.map((dependency) => decode(ResourceId)(dependency)),
  blobs: blobs.map((blob) => decode(BlobId)(blob)),
});

describe("configuration codecs", () => {
  it.each([
    ["json", "{\n  \"local\": true\n}\n"],
    ["toml", "local = true\n"],
    ["yaml", "local: true\n"],
  ] as const)("preserves local keys and applies dotted paths in %s", (format, source) => {
    const document = parseConfigDocument(format, source);
    setConfigPath(document, "agent.model", "review-model");
    const encoded = serializeConfigDocument(format, document);
    const decoded = parseConfigDocument(format, encoded);

    expect(getConfigPath(decoded, "local")).toBe(true);
    expect(getConfigPath(decoded, "agent.model")).toBe("review-model");
    expect(Object.hasOwn(decoded, "agent.model")).toBe(false);
  });
});

const revision = (resources: ReadonlyArray<PublishedResource>): ProfileRevision => ({
  id: decode(ProfileRevisionId)("revision-1"),
  profileId: decode(ProfileId)("profile-1"),
  sequence: 1,
  canonicalBytes: "{}",
  digest: digestA,
  signature: "test-signature",
  publishedAt: "2026-08-15T00:00:00Z",
  resources,
  groups: [],
});

const plannerInput = (
  resources: ReadonlyArray<PublishedResource>,
  options: {
    readonly desired?: ReadonlyArray<DesiredResource> | undefined;
    readonly observed?: ReadonlyArray<ObservedResourceState> | undefined;
    readonly applied?: ReadonlyArray<AppliedResourceRecord> | undefined;
    readonly availableBlobs?: ReadonlyArray<string> | undefined;
  } = {},
): SynchronizationPlannerInput => ({
  revision: {
    ...revision(resources),
    desired: resources.map((entry, index) => ({
      resource: entry.id,
      desired: options.desired?.[index] ?? desiredForKind(entry.kind),
      verification: verificationFor(options.desired?.[index] ?? desiredForKind(entry.kind)),
    })),
    blobs: [
      { id: blobA, bytes: 100 },
      { id: blobB, bytes: 200 },
    ],
  },
  follower,
  observedState: {
    platform: "linux",
    resources: resources.map((entry, index) => ({
      resource: entry.id,
      observed: options.observed?.[index] ?? { state: "absent" },
    })),
    availableBlobs: (options.availableBlobs ?? []).map((blob) => decode(BlobId)(blob)),
  },
  localOverlay: [],
  appliedResources: options.applied ?? [],
});

const runPlan = (input: SynchronizationPlannerInput) =>
  Effect.runSync(planSynchronization(input));

describe("resource and Apply Policy coverage", () => {
  const cases: ReadonlyArray<{
    readonly kind: ResourceKind;
    readonly policy: ApplyPolicy;
    readonly action: string;
  }> = [
    { kind: "file", policy: "replace", action: "write-file" },
    { kind: "file", policy: "replace-if-unmodified", action: "write-file" },
    { kind: "directory", policy: "mirror-owned", action: "mirror-directory" },
    { kind: "directory", policy: "replace", action: "mirror-directory" },
    { kind: "config", policy: "merge", action: "write-config" },
    { kind: "config", policy: "replace", action: "write-file" },
    { kind: "skill", policy: "replace-if-unmodified", action: "mirror-directory" },
    { kind: "skill", policy: "replace", action: "mirror-directory" },
    { kind: "tool", policy: "ensure", action: "install-tool" },
    { kind: "credential", policy: "require-local", action: "human-action" },
    { kind: "schedule", policy: "replace", action: "write-file" },
  ];

  for (const entry of cases) {
    it(`plans ${entry.kind}/${entry.policy}`, () => {
      const plan = runPlan(plannerInput([
        resource("subject", entry.kind, entry.policy),
      ]));
      expect(plan.actions.map((action) => action.kind)).toEqual([entry.action]);
    });
  }

  it.each(["mirror-owned", "merge"] as const)(
    "rejects unsupported file policy %s before planning",
    (policy) => {
      const error = Effect.runSync(Effect.flip(planSynchronization(
        plannerInput([resource("file", "file", policy)]),
      )));
      expect(error._tag).toBe("PlannerPolicyKindMismatchError");
    },
  );

  it("produces an explicit no-op when desired state is already present", () => {
    const plan = runPlan(plannerInput(
      [resource("file", "file", "replace")],
      { observed: [{ state: "present", digest: digestA, executable: false }] },
    ));
    expect(plan.actions[0]?.detail).toEqual({ kind: "no-op" });
  });

  it("observes empty directory roots directly", () => {
    const desired: DesiredResource = { kind: "directory", files: [] };
    const observed = {
      state: "directory" as const,
      objectKind: "directory" as const,
      files: [],
    };
    const existing = runPlan(plannerInput(
      [resource("empty", "directory", "replace")],
      { desired: [desired], observed: [observed] },
    ));
    expect(existing.actions.map((action) => action.kind)).toEqual(["no-op"]);

    const missing = runPlan(plannerInput(
      [resource("empty", "directory", "replace")],
      { desired: [desired] },
    ));
    expect(missing.actions.map((action) => action.kind)).toEqual(["mirror-directory"]);
  });

  it("plans a non-directory root as drift instead of applying a mirror", () => {
    const desired: DesiredResource = { kind: "directory", files: [] };
    const plan = runPlan(plannerInput(
      [resource("root-conflict", "directory", "replace")],
      {
        desired: [desired],
        observed: [{
          state: "present",
          objectKind: "regular",
          digest: digestA,
          executable: false,
        }],
      },
    ));
    expect(plan.actions.map((action) => action.kind)).toEqual(["drift-conflict"]);
  });

  it.each([
    {
      name: "regular to executable",
      desiredExecutable: true,
      observedExecutable: false,
      appliedExecutable: false,
      action: "write-file",
    },
    {
      name: "executable to regular",
      desiredExecutable: false,
      observedExecutable: true,
      appliedExecutable: true,
      action: "write-file",
    },
    {
      name: "local executable drift",
      desiredExecutable: false,
      observedExecutable: true,
      appliedExecutable: false,
      action: "drift-conflict",
    },
    {
      name: "matching executable intent",
      desiredExecutable: true,
      observedExecutable: true,
      appliedExecutable: true,
      action: "no-op",
    },
  ] as const)("plans same-byte executable mode state: $name", ({
    desiredExecutable,
    observedExecutable,
    appliedExecutable,
    action,
  }) => {
    const subject = resource("file", "file", "replace-if-unmodified");
    const desired = {
      kind: "file" as const,
      digest: digestA,
      executable: desiredExecutable,
    };
    const planned = runPlan(plannerInput([subject], {
      desired: [desired],
      observed: [{
        state: "present",
        digest: digestA,
        executable: observedExecutable,
      }],
      applied: [{
        resource: subject.id,
        revision: "previous",
        digest: digestA,
        appliedAt: "2026-08-15T00:00:00Z",
        kind: "file",
        policy: "replace-if-unmodified",
        target: subject.target,
        executable: appliedExecutable,
      }],
    }));
    expect(planned.actions[0]?.kind).toBe(action);
    if (action === "write-file") {
      expect(planned.actions[0]?.detail).toMatchObject({
        executable: desiredExecutable,
      });
    }
    if (action === "drift-conflict") {
      expect(planned.actions[0]?.detail).toMatchObject({
        desiredExecutable,
        observedExecutable,
      });
    }
  });

  it.each([
    ["file", "file"],
    ["skill", "skill"],
  ] as const)(
    "reports a missing previously applied %s as local intent under replace-if-unmodified",
    (_name, kind) => {
      const subject = resource(kind, kind, "replace-if-unmodified");
      const plan = runPlan(plannerInput([subject], {
        desired: [desiredForKind(kind)],
        observed: [{ state: "absent" }],
        applied: [{
          resource: subject.id,
          revision: "previous",
          digest: digestA,
          appliedAt: "2026-08-15T00:00:00Z",
          kind,
          policy: "replace-if-unmodified",
          target: subject.target,
        }],
      }));
      expect(plan.actions.map((action) => action.kind)).toEqual(["human-action"]);
      expect(plan.actions.some((action) =>
        action.kind === "write-file" || action.kind === "mirror-directory"
      )).toBe(false);
    },
  );

  it("reports a missing applied skill member as drift without rewriting the skill", () => {
    const subject = resource("skill", "skill", "replace-if-unmodified");
    const desired = {
      kind: "skill" as const,
      digest: digestA,
      files: [{ path: "SKILL.md", digest: digestA, executable: false }],
    };
    const plan = runPlan(plannerInput([subject], {
      desired: [desired],
      observed: [{ state: "directory", files: [] }],
      applied: [{
        resource: subject.id,
        revision: "previous",
        digest: desired.digest,
        appliedAt: "2026-08-15T00:00:00Z",
        kind: "skill",
        policy: "replace-if-unmodified",
        target: subject.target,
        ownedFiles: desired.files,
      }],
    }));
    expect(plan.actions.map((action) => action.kind)).toEqual(["drift-conflict"]);
    expect(plan.actions.some((action) => action.kind === "mirror-directory")).toBe(false);
  });

  it.each([
    ["symlink", "replace"],
    ["directory", "replace"],
    ["special", "replace"],
    ["symlink", "replace-if-unmodified"],
  ] as const)(
    "does not converge a %s at a regular-file target under %s",
    (objectKind, policy) => {
      const subject = resource("file", "file", policy);
      const plan = runPlan(plannerInput([subject], {
        observed: [{
          state: "present",
          digest: digestA,
          executable: false,
          objectKind,
          symlinkTo: objectKind === "symlink" ? "/outside" : undefined,
        }],
        applied: policy === "replace-if-unmodified"
          ? [{
            resource: subject.id,
            revision: "previous",
            digest: digestA,
            appliedAt: "2026-08-15T00:00:00Z",
            kind: "file",
            policy,
            target: subject.target,
            executable: false,
          }]
          : [],
      }));
      expect(plan.actions[0]?.kind).not.toBe("no-op");
      expect(plan.actions[0]?.kind).toBe(
        policy === "replace-if-unmodified" ? "drift-conflict" : "write-file",
      );
    },
  );

  it("preserves non-conflicting Local Overlay keys and reports conflicts", () => {
    const base = plannerInput([resource("config", "config", "merge")]);
    const preserved = runPlan({
      ...base,
      localOverlay: [{ resource: decode(ResourceId)("config"), keys: ["local.theme"] }],
    });
    expect(preserved.actions[0]?.kind).toBe("write-config");

    const conflict = runPlan({
      ...base,
      localOverlay: [{ resource: decode(ResourceId)("config"), keys: ["mcp.github"] }],
    });
    expect(conflict.actions[0]?.kind).toBe("human-action");
  });

  it("removes unchanged files recorded as owned by the previous revision", () => {
    const subject = resource("directory", "directory", "mirror-owned");
    const desired = {
      kind: "directory" as const,
      files: [{ path: "kept.txt", digest: digestA, executable: false }],
    };
    const previouslyOwned = [
      { path: "kept.txt", digest: digestA, executable: false },
      { path: "removed.txt", digest: digestB, executable: false },
    ];
    const previousDigest = decode(ContentDigest)(sha256Hex(
      previouslyOwned
        .map((file) => `${file.path}\0${file.digest}\0-`)
        .join("\n"),
    ));
    const input = plannerInput([subject], {
      desired: [desired],
      observed: [{ state: "directory", files: previouslyOwned }],
      applied: [{
        resource: subject.id,
        revision: "revision-previous",
        digest: previousDigest,
        appliedAt: "2026-08-15T00:00:00Z",
        ownedFiles: previouslyOwned.map(({ path, digest }) => ({ path, digest })),
      }],
    });

    const plan = runPlan(input);
    expect(plan.actions[0]?.detail).toEqual({
      kind: "mirror-directory",
      target: subject.target,
      adds: [],
      removes: ["removed.txt"],
    });
  });

  it("evaluates mirror removal ownership and drift per file", () => {
    const subject = resource("directory", "directory", "mirror-owned");
    const desired = {
      kind: "directory" as const,
      files: [{ path: "kept.txt", digest: digestA, executable: false }],
    };
    const observed = [
      { path: "kept.txt", digest: digestA, executable: false },
      { path: "clean.txt", digest: digestB, executable: false },
      { path: "modified.txt", digest: digestC, executable: false },
      { path: "unowned.txt", digest: digestC, executable: false },
    ];
    const input = plannerInput([subject], {
      desired: [desired],
      observed: [{ state: "directory", files: observed }],
      applied: [{
        resource: subject.id,
        revision: "revision-previous",
        digest: digestA,
        appliedAt: "2026-08-15T00:00:00Z",
        ownedFiles: [
          { path: "kept.txt", digest: digestA },
          { path: "clean.txt", digest: digestB },
          { path: "modified.txt", digest: digestB },
        ],
      }],
    });

    expect(runPlan(input).actions[0]?.detail).toEqual({
      kind: "mirror-directory",
      target: subject.target,
      adds: [],
      removes: ["clean.txt"],
    });
  });
});

describe("transfer and apply separation", () => {
  it("requires each missing blob once even when multiple resources reuse it", () => {
    const resources = [
      resource("a", "file", "replace", [], [blobA]),
      resource("b", "file", "replace", [], [blobA, blobB]),
    ];
    const plan = runPlan(plannerInput(resources));
    expect(plan.requiredBlobs).toEqual([blobA, blobB]);
    expect(plan.actions.filter((action) => action.kind === "transfer-blob")).toHaveLength(2);
    expect(plan.actions.filter((action) => action.kind === "write-file")).toHaveLength(2);
  });

  it("reuses cached blobs without changing Apply Policy behavior", () => {
    const subject = resource("file", "file", "replace", [], [blobA]);
    const plan = runPlan(plannerInput(
      [subject],
      {
        observed: [{ state: "present", digest: digestA, executable: false }],
        availableBlobs: [blobA],
      },
    ));
    expect(plan.requiredBlobs).toEqual([]);
    expect(plan.actions.map((action) => action.kind)).toEqual(["no-op"]);
  });

  it("still transfers a missing blob when apply is a no-op", () => {
    const subject = resource("file", "file", "replace", [], [blobA]);
    const plan = runPlan(plannerInput(
      [subject],
      { observed: [{ state: "present", digest: digestA, executable: false }] },
    ));
    expect(plan.actions.map((action) => action.kind)).toEqual([
      "transfer-blob",
      "no-op",
    ]);
    expect(plan.actions[1]?.before).toEqual([`transfer:${blobA}`]);
  });

  it.each([
    ["duplicate", ["a", "a"], "PlannerConflictingResourcePathError"],
    ["file-parent", ["a", "a/b"], "PlannerConflictingResourcePathError"],
    ["normalized-alias", ["a/./b"], "PlannerInvalidResourcePathError"],
  ] as const)("rejects an intra-resource %s before creating actions", (
    _name,
    paths,
    expectedTag,
  ) => {
    const subject = resource("tree", "directory", "mirror-owned", [], [blobA]);
    const base = plannerInput([subject], {
      desired: [{
        kind: "directory",
        files: paths.map((path) => ({ path, digest: digestA, executable: false })),
      }],
    });
    const error = Effect.runSync(Effect.flip(planSynchronization(base)));
    expect(error._tag).toBe(expectedTag);
  });

  it("uses the follower platform case rules before planning a mirror", () => {
    const subject = resource("tree", "directory", "mirror-owned", [], [blobA]);
    const desired = {
      kind: "directory" as const,
      files: [
        { path: "Readme.md", digest: digestA, executable: false },
        { path: "README.md", digest: digestB, executable: false },
      ],
    };
    const linuxInput = plannerInput([subject], { desired: [desired] });
    expect(runPlan(linuxInput).actions.map((action) => action.kind))
      .toEqual(["transfer-blob", "mirror-directory"]);
    const windowsInput = {
      ...linuxInput,
      observedState: { ...linuxInput.observedState, platform: "windows" as const },
    };
    const error = Effect.runSync(Effect.flip(planSynchronization(windowsInput)));
    expect(error._tag).toBe("PlannerConflictingResourcePathError");
    expect(error).toMatchObject({ resource: "tree", conflictsWith: "tree" });
  });

  it("rejects missing metadata for a required blob", () => {
    const input = plannerInput([
      resource("file", "file", "replace", [], [digestC]),
    ]);
    const error = Effect.runSync(Effect.flip(planSynchronization(input)));
    expect(error._tag).toBe("MissingBlobMetadataError");
  });
});

describe("dependency ordering", () => {
  it("topologically orders resources and action prerequisites deterministically", () => {
    const resources = [
      resource("leaf", "file", "replace", ["middle"]),
      resource("root", "file", "replace"),
      resource("middle", "file", "replace", ["root"]),
    ];
    const plan = runPlan(plannerInput(resources));
    expect(plan.actions.map((action) => action.resource)).toEqual([
      "root",
      "middle",
      "leaf",
    ]);
    expect(plan.actions[1]?.before).toEqual([plan.actions[0]?.id]);
    expect(plan.actions[2]?.before).toEqual([plan.actions[1]?.id]);
  });

  it("rejects missing resource dependencies", () => {
    const input = plannerInput([
      resource("leaf", "file", "replace", ["missing"]),
    ]);
    const error = Effect.runSync(Effect.flip(planSynchronization(input)));
    expect(error._tag).toBe("PlannerMissingDependencyError");
  });

  it("rejects resource dependency cycles", () => {
    const input = plannerInput([
      resource("a", "file", "replace", ["b"]),
      resource("b", "file", "replace", ["a"]),
    ]);
    const error = Effect.runSync(Effect.flip(planSynchronization(input)));
    expect(error._tag).toBe("PlannerDependencyCycleError");
    if (error._tag === "PlannerDependencyCycleError") {
      expect(error.cycle).toEqual(["a", "b", "a"]);
    }
  });
});

describe("three-way skill drift", () => {
  const cases = [
    {
      name: "unchanged",
      desired: digestA,
      observed: digestA,
      applied: digestA,
      expected: "unchanged",
      action: "no-op",
    },
    {
      name: "local-only",
      desired: digestA,
      observed: digestB,
      applied: digestA,
      expected: "local-only",
      action: "drift-conflict",
    },
    {
      name: "remote-only",
      desired: digestB,
      observed: digestA,
      applied: digestA,
      expected: "remote-only",
      action: "mirror-directory",
    },
    {
      name: "converged",
      desired: digestB,
      observed: digestB,
      applied: digestA,
      expected: "converged",
      action: "no-op",
    },
    {
      name: "conflicting",
      desired: digestC,
      observed: digestB,
      applied: digestA,
      expected: "conflicting",
      action: "drift-conflict",
    },
  ] as const;

  for (const entry of cases) {
    it(`distinguishes ${entry.name} skill state`, () => {
      expect(detectSkillDrift({
        desiredDigest: entry.desired,
        observedDigest: entry.observed,
        lastAppliedDigest: entry.applied,
      })).toBe(entry.expected);
      const subject = resource("skill", "skill", "replace-if-unmodified");
      const plan = runPlan(plannerInput(
        [subject],
        {
          desired: [{
            kind: "skill",
            digest: entry.desired,
            files: [{ path: "SKILL.md", digest: entry.desired }],
          }],
          observed: [{
            state: "present",
            digest: entry.observed,
            executable: false,
          }],
          applied: [{
            resource: subject.id,
            revision: "previous",
            digest: entry.applied,
            appliedAt: "2026-08-14T00:00:00Z",
          }],
        },
      ));
      expect(plan.actions.map((action) => action.kind)).toEqual([entry.action]);
      if (entry.action === "drift-conflict") {
        expect(plan.actions.some((action) => action.kind === "write-file")).toBe(false);
      }
    });
  }
});

describe("stable planning and bounded resolution", () => {
  it("is invariant to every unordered input collection", () => {
    const resources = [
      resource("b", "config", "merge", ["a"], [blobB]),
      resource("a", "file", "replace", [], [blobA]),
    ];
    const input = plannerInput(resources);
    const first = runPlan(input);
    const second = runPlan({
      ...input,
      revision: {
        ...input.revision,
        resources: [...input.revision.resources].reverse(),
        desired: [...input.revision.desired].reverse(),
        blobs: [...input.revision.blobs].reverse(),
      },
      observedState: {
        ...input.observedState,
        resources: [...input.observedState.resources].reverse(),
        availableBlobs: [...input.observedState.availableBlobs].reverse(),
      },
      appliedResources: [...input.appliedResources].reverse(),
    });
    expect(second).toEqual(first);
    expect(first.digest).toBe(sha256Hex(first.encoded));
  });

  it("creates a stable bounded Agent Task only when deterministic installation is unavailable", () => {
    const subject = resource("tool", "tool", "ensure");
    const input = plannerInput(
      [subject],
      {
        desired: [{
          kind: "tool",
          toolId: "custom-tool",
          recipes: [],
          loginRequired: false,
        }],
      },
    );
    const plan = runPlan(input);
    expect(plan.actions[0]?.kind).toBe("agent-task");
    expect(plan.agentTasks).toEqual([{
      id: "agent:tool:0",
      resource: "tool",
      summary: "Find an installation recipe for custom-tool",
      desiredOutcome: "Converge tool tool",
      observedEvidence: ["Observed state: absent"],
      allowedPaths: ["~/.canonfig/tool"],
      allowedExecutables: ["custom-tool"],
      executableAuthorizations: [{
        executable: "custom-tool",
        behavior: "leaf",
      }],
      allowedOrigins: [],
      forbidden: ["elevation", "login", "restart", "reboot"],
      timeLimitSeconds: 300,
      outputLimitBytes: 65_536,
      verification: { command: ["custom-tool", "--version"] },
    }]);
  });

  it("carries optional recipe versions into canonical install actions", () => {
    const subject = resource("tool", "tool", "ensure");
    const versioned = runPlan(plannerInput(
      [subject],
      {
        desired: [{
          kind: "tool",
          toolId: "ripgrep",
          recipes: [{
            platform: "linux",
            method: "apt",
            package: "ripgrep",
            version: "14.1.0",
            source: "package-lock.json",
          }],
          loginRequired: false,
        }],
      },
    ));
    const unversioned = runPlan(plannerInput([subject]));

    expect(versioned.actions[0]?.detail).toEqual({
      kind: "install-tool",
      toolId: "ripgrep",
      method: "apt",
      package: "ripgrep",
      version: "14.1.0",
      source: "package-lock.json",
    });
    expect(JSON.parse(versioned.encoded).actions[0].detail.version).toBe("14.1.0");
    expect(unversioned.actions[0]?.detail).toEqual({
      kind: "install-tool",
      toolId: "ripgrep",
      method: "apt",
      package: "ripgrep",
    });
    expect(JSON.parse(unversioned.encoded).actions[0].detail).not.toHaveProperty("version");
  });

  it("routes remote npm-family artifacts without integrity to Human Action Required", () => {
    const subject = resource("tool", "tool", "ensure");
    const plan = runPlan(plannerInput(
      [subject],
      {
        desired: [{
          kind: "tool",
          toolId: "tool",
          recipes: [{
            platform: "linux",
            method: "npm",
            package: "tool",
            version: "1.2.3",
            source: "https://registry.npmjs.org/tool/-/tool-1.2.3.tgz",
          }],
          loginRequired: false,
        }],
      },
    ));
    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: "human-action",
        detail: expect.objectContaining({
          reason: "Installing tool requires a reviewed npm artifact integrity",
        }),
      }),
    ]);
    expect(plan.actions.some((action) => action.kind === "install-tool")).toBe(false);
  });

  it("routes reviewed source recipes to Human Action Required", () => {
    const subject = resource("tool", "tool", "ensure");
    const plan = runPlan(plannerInput(
      [subject],
      {
        desired: [{
          kind: "tool",
          toolId: "source-tool",
          recipes: [{
            platform: "linux",
            method: "source",
            package: "https://github.com/example/source-tool",
            version: "v7.0.0",
          }],
          loginRequired: false,
        }],
      },
    ));
    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: "human-action",
        detail: expect.objectContaining({
          kind: "human-action",
          reason: "Installing source-tool from source requires Human Action Required",
        }),
      }),
    ]);
    expect(plan.actions.some((action) => action.kind === "install-tool")).toBe(false);
  });

  it.each([
    "HTTPS://registry.npmjs.org/tool/-/tool-1.2.3.tgz",
    "https://REGISTRY.NPMJS.ORG/tool/-/tool-1.2.3.tgz",
    "https://registry.npmjs.org:443/tool/-/tool-1.2.3.tgz",
    "https://registry.npmjs.org/tool/../tool/-/tool-1.2.3.tgz",
    "https://registry.npmjs.org/tool/-/tool-1.2.3.tgz%23fragment",
    "https://registry.npmjs.org/tool/-/tool-1.2.3.tgz#fragment",
    "https://user:password@registry.npmjs.org/tool/-/tool-1.2.3.tgz",
  ])("rejects noncanonical npm artifact sources before planning: %s", (source) => {
    const subject = resource("tool", "tool", "ensure");
    expect(() => runPlan(plannerInput(
      [subject],
      {
        desired: [{
          kind: "tool",
          toolId: "tool",
          recipes: [{
            platform: "linux",
            method: "npm",
            package: "tool",
            version: "1.2.3",
            source: { source, integrity: "sha512-c2FtcGxl" },
          }],
          loginRequired: false,
        }],
      },
    ))).toThrow();
  });

  it("routes Cargo scripts-disabled recipes to Human Action Required", () => {
    const subject = resource("tool", "tool", "ensure");
    const plan = runPlan(plannerInput(
      [subject],
      {
        desired: [{
          kind: "tool",
          toolId: "cargo-tool",
          recipes: [{
            platform: "linux",
            method: "cargo",
            package: "cargo-tool",
            version: "1.2.3",
          }],
          loginRequired: false,
        }],
      },
    ));
    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: "human-action",
        detail: expect.objectContaining({
          kind: "human-action",
          reason: "Installing cargo-tool with Cargo requires Human Action Required",
        }),
      }),
    ]);
    expect(plan.actions.some((action) => action.kind === "install-tool")).toBe(false);
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
    "rejects malformed %s recipe versions before creating an install action",
    (method, packageName, version) => {
      const subject = resource("tool", "tool", "ensure");
      const error = Effect.runSync(Effect.flip(planSynchronization(plannerInput(
        [subject],
        {
          desired: [{
            kind: "tool",
            toolId: "tool",
            recipes: [{
              platform: "linux",
              method,
              package: packageName,
              version,
            }],
            loginRequired: false,
          }],
        },
      ))));
      expect(error._tag).toBe("PlannerInvalidRecipeError");
    },
  );

  it.each([undefined, "1.2.3"] as const)(
    "rejects unknown %s recipe methods before creating an install action",
    (version) => {
      const subject = resource("tool", "tool", "ensure");
      const recipe = {
        platform: "linux",
        method: "apt" satisfies RecipeMethod,
        package: "tool",
      };
      // SAFETY: Deliberately mutates a valid recipe to verify hostile planner
      // input is rejected at runtime.
      Object.assign(recipe, {
        method: "unknown-installer",
      });
      const candidate = version === undefined
        ? recipe
        : Object.assign(recipe, { version });
      const error = Effect.runSync(Effect.flip(planSynchronization(plannerInput(
        [subject],
        {
          desired: [{
            kind: "tool",
            toolId: "tool",
            recipes: [candidate],
            loginRequired: false,
          }],
        },
      ))));
      expect(error._tag).toBe("PlannerInvalidRecipeError");
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
  ])("rejects npm %s recipe before creating an install action", (_name, packageName, version) => {
    const subject = resource("tool", "tool", "ensure");
    const error = Effect.runSync(Effect.flip(planSynchronization(plannerInput(
      [subject],
      {
        desired: [{
          kind: "tool",
          toolId: "tool",
          recipes: [{
            platform: "linux",
            method: "npm",
            package: packageName,
            version,
          }],
          loginRequired: false,
        }],
      },
    ))));
    expect(error._tag).toBe("PlannerInvalidRecipeError");
  });
  it("escalates reviewed build-hook recipes when descendants cannot be sandboxed", () => {
    const subject = resource("tool", "tool", "ensure");
    const plan = runPlan(plannerInput(
      [subject],
      {
        desired: [{
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
              executables: ["node-gyp"],
              paths: ["/tmp/native-tool"],
              origins: ["https://registry.npmjs.org"],
              capabilities: ["execute", "read-files", "write-files"],
              steps: [{
                executable: "node-gyp",
                arguments: ["rebuild"],
              }],
            },
          }],
          loginRequired: false,
        }],
      },
    ));
    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: "human-action",
        detail: expect.objectContaining({
          kind: "human-action",
          reason: "Installing native-tool requires reviewed build hooks",
        }),
      }),
    ]);
  });

  it("routes a reviewed uv sdist recipe to Human Action Required before execution", () => {
    const subject = resource("tool", "tool", "ensure");
    const plan = runPlan(plannerInput(
      [subject],
      {
        desired: [{
          kind: "tool",
          toolId: "sdist-tool",
          recipes: [{
            platform: "linux",
            method: "uv",
            package: "sdist-tool",
            version: "2.0.0",
            buildPolicy: {
              mode: "required",
              reviewedBy: "reviewer",
              reviewedAt: "2026-08-16T00:00:00Z",
              executables: ["python"],
              paths: ["/tmp/sdist-tool"],
              origins: ["https://pypi.org"],
              capabilities: ["execute", "read-files", "write-files"],
              steps: [{
                executable: "python",
                arguments: ["-m", "build"],
              }],
            },
          }],
          loginRequired: false,
        }],
      },
    ));
    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: "human-action",
        detail: expect.objectContaining({
          kind: "human-action",
          reason: "Installing sdist-tool requires reviewed build hooks",
        }),
      }),
    ]);
    expect(plan.actions.some((action) => action.kind === "install-tool")).toBe(false);
  });

  it("rejects duplicate planner evidence rather than depending on input order", () => {
    const input = plannerInput([resource("file", "file", "replace")]);
    const duplicate = {
      ...input,
      observedState: {
        ...input.observedState,
        resources: [
          input.observedState.resources[0],
          input.observedState.resources[0],
        ],
      },
    };
    const error = Effect.runSync(Effect.flip(planSynchronization(duplicate)));
    expect(error._tag).toBe("DuplicatePlannerInputError");
  });
});
