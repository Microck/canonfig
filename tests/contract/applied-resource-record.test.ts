import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ContentDigest, ResourceId, RunId } from "../../src/domain/brand.ts";
import type { PublishedResource } from "../../src/domain/profile.ts";
import {
  AppliedResourceRecordSchema,
  createAppliedResourceRecord,
} from "../../src/domain/synchronization.ts";
import { removedResourceState, removedResourceVerification } from "../../src/synchronization/observation.ts";
import { planRemoved } from "../../src/synchronization/resource-plans.ts";
import type { DesiredResource } from "../../src/synchronization/synchronization.types.ts";
import { actionProgressOutcome, reduceActionResult, type ActionResult } from "../../src/synchronization/executor.ts";

describe("Action result transitions", () => {
  const run = Schema.decodeUnknownSync(RunId)("action-result-contract");
  const resource = Schema.decodeUnknownSync(ResourceId)("action-resource");
  it.each([
    [{ kind: "human", human: { reason: "human step", instructions: "finish the step" } }, "HumanActionRequired"],
    [{ kind: "drift", drift: { resource, target: "/disposable/target", desiredDigest: "a".repeat(64), observedDigest: "b".repeat(64), lastAppliedDigest: "c".repeat(64) } }, "FollowerDrift"],
    [{ kind: "failed", reason: "write failed", rollbackState: { _tag: "NotRequired" } }, "Failed"],
  ] satisfies ReadonlyArray<readonly [ActionResult, string]>)("never reports convergence after %j", (result, outcome) => {
    const progress = Effect.runSync(reduceActionResult({ _tag: "Running", verified: new Set() }, result));
    expect(actionProgressOutcome(run, progress).outcome).toBe(outcome);
    expect(Effect.runSync(Effect.flip(reduceActionResult(progress, { kind: "verified", resource })))).toMatchObject({
      _tag: "InvalidExecutionPlanError",
    });
  });

  it("adds only verified resource results to convergence", () => {
    let progress = Effect.runSync(reduceActionResult({ _tag: "Running", verified: new Set() }, { kind: "verified" }));
    progress = Effect.runSync(reduceActionResult(progress, { kind: "verified", resource }));
    expect(actionProgressOutcome(run, progress)).toEqual({ outcome: "Converged", run, verified: [resource] });
  });
});

const decode = Schema.decodeUnknownSync;
const digest = decode(ContentDigest)("a".repeat(64));
const fingerprint = decode(ContentDigest)("b".repeat(64));
const resourceId = decode(ResourceId)("harness:codex:instructions");
const common = {
  resource: resourceId,
  revision: "local:ownership-test",
  digest,
  appliedAt: "2026-11-06T00:00:00Z",
  target: "/disposable/ownership-test",
};
const provenance = {
  schema: "canonfig.recipe-provenance/v1",
  upstream: "https://example.invalid/tool",
  version: "1.0.0",
  platform: "linux",
  architecture: "arm64",
  artifactDigest: digest,
  entrypoint: "bin/tool",
  dependencyPolicy: "locked",
  executionContext: "user",
  method: "npm",
  package: "tool",
  compatibility: "v1",
  target: "tool",
  fingerprint,
} as const;
const treeEntries = [
  { path: "nested", digest, executable: true, mode: 0o750, objectKind: "directory" },
  { path: "nested/file", digest, executable: false, mode: 0o640, objectKind: "regular" },
  { path: "link", digest, executable: false, mode: 0, objectKind: "symlink", symlinkTo: "nested/file" },
] as const;
const variants = [
  { ...common, ownership: "WholeFile", kind: "file", policy: "replace", executable: false, mode: 0o640 },
  { ...common, ownership: "Symlink", kind: "file", policy: "replace-if-unmodified", symlinkTo: "destination" },
  { ...common, ownership: "SourceSection", kind: "file", policy: "append-local", executable: false, mode: 0o600 },
  { ...common, ownership: "DirectoryEntries", kind: "directory", policy: "append-local", mode: 0o750, ownedFiles: treeEntries },
  { ...common, ownership: "DirectoryEntries", kind: "skill", policy: "replace-if-unmodified", mode: 0o750, ownedFiles: treeEntries },
  { ...common, ownership: "ConfigKeys", kind: "config", policy: "merge", ownedKeys: ["model"], configFormat: "toml" },
  { ...common, ownership: "QualifiedTool", kind: "tool", policy: "ensure", installerRecipe: provenance },
] as const;

const published = (kind: PublishedResource["kind"], policy: PublishedResource["policy"]): PublishedResource => ({
  id: resourceId,
  kind,
  policy,
  target: common.target,
  dependsOn: [],
  blobs: [],
});
const recordFor = (
  resource: PublishedResource,
  desired: DesiredResource,
  ownership: { readonly ownedFiles?: typeof treeEntries; readonly ownedKeys?: ReadonlyArray<string>; readonly installerRecipe?: typeof provenance } = {},
) => createAppliedResourceRecord({
  resource,
  desired,
  revision: common.revision,
  digest,
  appliedAt: common.appliedAt,
  ...ownership,
});

describe("Applied Resource Record ownership boundary", () => {
  it.each(variants)("accepts complete $ownership ownership for $kind", (record) => {
    expect(decode(AppliedResourceRecordSchema)(record)).toEqual(record);
  });

  it.each([
    { ...common },
    { ...variants[0], ownedKeys: ["model"] },
    { ...variants[0], symlinkTo: "destination" },
    { ...variants[1], executable: false, mode: 0o600 },
    { ...variants[1], symlinkTo: undefined },
    { ...variants[2], policy: "replace" },
    { ...variants[2], mode: undefined },
    { ...variants[3], ownedFiles: undefined },
    { ...variants[3], ownedFiles: [{ ...treeEntries[2], symlinkTo: undefined }] },
    { ...variants[4], policy: "append-local" },
    { ...variants[5], ownedKeys: undefined },
    { ...variants[5], configFormat: undefined },
    { ...variants[6], installerRecipe: undefined },
    { ...variants[6], policy: "replace" },
  ])("rejects incomplete or contradictory ownership %#", (record) => {
    expect(() => decode(AppliedResourceRecordSchema)(record)).toThrow();
  });
});

describe("verified Applied Resource Record construction", () => {
  it("distinguishes whole files, Source sections and symlinks", () => {
    const desired = { kind: "file", digest, executable: false, mode: 0o640 } as const;
    expect(recordFor(published("file", "replace"), desired)).toEqual(variants[0]);
    expect(recordFor(published("file", "append-local"), desired)).toMatchObject({ ownership: "SourceSection", mode: 0o640 });
    const link = recordFor(published("file", "replace-if-unmodified"), { ...desired, symlinkTo: "destination", mode: 0 });
    expect(link).toEqual(variants[1]);
    expect(link).not.toHaveProperty("mode");
    expect(link).not.toHaveProperty("executable");
  });

  it("requires verified directory entries and keeps exact permissions", () => {
    const desired = { kind: "directory", mode: 0o750, directories: [], files: [] } as const;
    expect(() => recordFor(published("directory", "append-local"), desired)).toThrow();
    expect(recordFor(published("directory", "append-local"), desired, { ownedFiles: treeEntries })).toEqual(variants[3]);
  });

  it("records post-write config ownership, including an empty released key set", () => {
    const desired = { kind: "config", digest, format: "toml", keys: ["model", "release"], releases: ["release"] } as const;
    expect(recordFor(published("config", "merge"), desired, { ownedKeys: ["model"] })).toEqual(variants[5]);
    expect(recordFor(published("config", "merge"), desired, { ownedKeys: [] })).toMatchObject({ ownership: "ConfigKeys", ownedKeys: [] });
    expect(() => recordFor(published("config", "merge"), desired)).toThrow();
  });

  it("pins qualified tools to provenance and never records mere discovery or credentials", () => {
    const desired = { kind: "tool", toolId: "tool", recipes: [], loginRequired: false } as const;
    expect(recordFor(published("tool", "ensure"), desired)).toBeUndefined();
    expect(recordFor(published("tool", "ensure"), desired, { installerRecipe: provenance }))
      .toMatchObject({ ownership: "QualifiedTool", digest: fingerprint, installerRecipe: provenance });
    expect(recordFor(published("credential", "require-local"), { kind: "credential", reference: "TOKEN", instructions: "Set TOKEN" }))
      .toBeUndefined();
  });

  it("rejects resource/verification disagreement and incompatible policies", () => {
    const desired = { kind: "file", digest, executable: false, mode: 0o600 } as const;
    expect(() => recordFor(published("directory", "replace"), desired)).toThrow(/verified file differs from directory/);
    expect(() => recordFor(published("file", "merge"), desired)).toThrow();
    expect(() => recordFor(published("file", "append-local"), { ...desired, symlinkTo: "destination" })).toThrow();
  });
});

describe("Applied Resource Record retirement interpretation", () => {
  it.each(variants.filter((record) => record.ownership !== "QualifiedTool"))(
    "always reconstructs $ownership $kind ownership",
    (record) => {
      const applied = decode(AppliedResourceRecordSchema)(record);
      const state = removedResourceState(applied);
      expect(state).toBeDefined();
      expect(state?.resource).toMatchObject({ id: resourceId, kind: record.kind, policy: record.policy, target: common.target });
      expect(state?.desired.kind).toBe(record.kind);
      if (state === undefined) throw new Error(`missing ${record.ownership} retirement state`);
      expect(planRemoved({
        resource: state.resource,
        desired: state.desired,
        observed: { state: "absent" },
        applied,
        platform: "linux",
      })).toMatchObject([{ kind: "remove-resource", detail: { target: common.target } }]);
    },
  );

  it("preserves directory, file and symlink entry evidence without permission defaults", () => {
    const state = removedResourceState(decode(AppliedResourceRecordSchema)(variants[3]));
    expect(state?.desired).toEqual({
      kind: "directory",
      mode: 0o750,
      directories: [{ path: "nested", mode: 0o750 }],
      files: [
        { path: "nested/file", digest, executable: false, mode: 0o640, symlinkTo: undefined },
        { path: "link", digest, executable: false, mode: 0, symlinkTo: "nested/file" },
      ],
    });
  });

  it("uses symlink verification rather than digest verification when retiring a link", () => {
    const applied = decode(AppliedResourceRecordSchema)(variants[1]);
    const state = removedResourceState(applied);
    expect(state).toBeDefined();
    if (state === undefined) throw new Error("symlink retirement state missing");
    expect(removedResourceVerification(applied, state.desired)).toEqual({ method: "symlink", target: "destination" });
  });

  it("makes qualified tool retirement release-only, never an uninstall", () => {
    expect(removedResourceState(decode(AppliedResourceRecordSchema)(variants[6]))).toBeUndefined();
  });
});
