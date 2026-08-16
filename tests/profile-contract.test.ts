import { readFileSync } from "node:fs";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  digestOf,
  parseJsonc,
  stripJsonc,
} from "../src/profile/profile-codec.ts";
import {
  decodeMachineProfileJsonc,
  digestMachineProfile,
  encodeMachineProfile,
  findDependencyCycle,
  ProfileContractError,
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
  verify: { method: "digest", digest: "a".repeat(64) },
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

  it("accepts default policies for every kind", () => {
    const resources: Array<ProfileResourceInput> = [
      { id: "f", kind: "file", target: "~/f", spec: { kind: "file", content: "x" }, verify: { method: "digest", digest: "d".repeat(64) } },
      { id: "d", kind: "directory", target: "~/d", spec: { kind: "directory", files: [] }, verify: { method: "digest", digest: "d".repeat(64) } },
      { id: "c", kind: "config", target: "~/c.toml", spec: { kind: "config", format: "toml", keys: [{ path: "a.b", value: 1 }] }, verify: { method: "digest", digest: "d".repeat(64) } },
      { id: "s", kind: "skill", target: "~/skills/s", spec: { kind: "skill", name: "s", files: [] }, verify: { method: "digest", digest: "d".repeat(64) } },
      { id: "t", kind: "tool", target: "~", spec: { kind: "tool", toolId: "rg", recipes: [] }, verify: { method: "executable-present", executable: "rg" } },
      { id: "cr", kind: "credential", target: "~", spec: { kind: "credential", reference: "gh" }, verify: { method: "credential-present", reference: "gh" } },
      { id: "sc", kind: "schedule", target: "~", spec: { kind: "schedule", calendar: { type: "daily", at: "00:00" }, timezone: "UTC" }, verify: { method: "command", command: ["true"] } },
    ];
    expect(validateProfileResources(resources)).toEqual([]);
  });

  it("rejects invalid targets", () => {
    const errors = validateProfileResources([
      fileResource("a", { target: "~/../escape" }),
      fileResource("b", { target: "" }),
    ]);
    expect(errors.every((e) => e._tag === "InvalidTargetError")).toBe(true);
    expect(errors).toHaveLength(2);
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
      "b31f793a10e3c6e04a77be65e29eeb23641f2f88c19496a2a4d594cf3d67bca7",
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
    expect(Schema.decodeUnknownSync(ActionDetailSchema)({
      kind: "install-tool",
      toolId: "rg",
      method: "apt",
      package: "ripgrep",
    })).not.toHaveProperty("version");
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
