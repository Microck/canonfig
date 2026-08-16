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
import type { ApplyPolicy, ResourceKind } from "../src/domain/resource.ts";
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
    { kind: "file", policy: "mirror-owned", action: "mirror-directory" },
    { kind: "file", policy: "merge", action: "write-config" },
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

  it("produces an explicit no-op when desired state is already present", () => {
    const plan = runPlan(plannerInput(
      [resource("file", "file", "replace")],
      { observed: [{ state: "present", digest: digestA, executable: false }] },
    ));
    expect(plan.actions[0]?.detail).toEqual({ kind: "no-op" });
  });

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
