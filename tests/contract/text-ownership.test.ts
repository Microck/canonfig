import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ActionId, ResourceId, RunId } from "../../src/domain/brand.ts";
import {
  ActionDetailSchema,
  checkTextWriteTransition,
  classifyTextOwnership,
  InvalidTextTransitionError,
  ObservedResourceStateSchema,
  planTextWriteTransition,
  TextWriteTransition,
  type AppliedResourceRecord,
} from "../../src/domain/synchronization.ts";
import { composeTextFile, parseTextComposition } from "../../src/domain/text-composition.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { sha256BytesHex, sha256Hex } from "../../src/profile/profile-codec.ts";
import { defaultSynchronizationExecutionLimits } from "../../src/synchronization/executor.ts";
import { prepareResourceAction, type ResourceExecutionContext } from "../../src/synchronization/resource-executors.ts";
import { planResource } from "../../src/synchronization/resource-plans.ts";

const source = "Source instructions.\n";
const digest = sha256Hex(source);
const previousDigest = sha256Hex("Previous instructions.\n");
const resource = ResourceId.make("text-fixture");
const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const applied = (shared: boolean): AppliedResourceRecord => shared
  ? { ownership: "SourceSection", resource, revision: "previous", digest: previousDigest, appliedAt: "2026-10-28T00:00:00Z", kind: "file", policy: "append-local", target: "~/notes.md", executable: false, mode: 0o600 }
  : { ownership: "WholeFile", resource, revision: "previous", digest: previousDigest, appliedAt: "2026-10-28T00:00:00Z", kind: "file", policy: "replace", target: "~/notes.md", executable: false, mode: 0o600 };

const fixture = (transition: TextWriteTransition, before?: Uint8Array) => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-text-transition-"));
  roots.push(root);
  const target = join(root, "notes.md");
  if (before !== undefined) writeFileSync(target, before, { mode: 0o600 });
  const shared = transition.kind !== "whole-file" && transition.kind !== "leave-section";
  const content = new TextEncoder().encode(source);
  const context: ResourceExecutionContext = {
    run: RunId.make("run-text-transition"),
    resource: { id: resource, kind: "file", target, policy: shared ? "append-local" : "replace", dependsOn: [], blobs: [] },
    action: { id: ActionId.make("action-text-transition"), resource, kind: "write-file", before: [], detail: { kind: "write-file", target, digest, executable: false, mode: 0o600, textTransition: transition } },
    desired: { kind: "file", digest, executable: false, mode: 0o600 },
    verification: { method: "digest", digest },
    artifacts: new Map([[digest, { digest, content }]]),
    limits: defaultSynchronizationExecutionLimits,
  };
  const layer = linuxMachineStateLayer({
    environment: [{ name: "HOME", value: root }, { name: "XDG_CACHE_HOME", value: join(root, ".cache") }],
    credentialPolicy: { kind: "local-file", path: join(root, "credentials") },
  });
  return { target, context, layer };
};

const encode = (text: string) => new TextEncoder().encode(text);

describe("explicit text ownership transitions", () => {
  it.each([
    { kind: "adopt-local" },
    { kind: "convert-whole" },
    { kind: "update-section" },
    { kind: "leave-section" },
    { kind: "adopt-local", retainedDigest: digest, previousSourceDigest: previousDigest },
    { kind: "whole-file", retainedDigest: digest },
    { kind: "create-section", previousDigest },
  ])("rejects missing or contradictory transition evidence: %j", (transition) => {
    expect(Schema.is(TextWriteTransition)(transition)).toBe(false);
  });

  it("rejects the old optional-field action shape instead of guessing an intent", () => {
    expect(Schema.is(ActionDetailSchema)({ kind: "write-file", target: "~/notes.md", digest, retainedLocalDigest: digest })).toBe(false);
    expect(Schema.is(ActionDetailSchema)({ kind: "write-file", target: "~/notes.md", digest, textTransition: { kind: "whole-file" }, previousSourceDigest: digest })).toBe(false);
  });

  it("keeps required evidence exclusive in the TypeScript union", () => {
    // @ts-expect-error adoption cannot carry both an unmanaged and a Source baseline
    const contradictory: TextWriteTransition = { kind: "adopt-local", retainedDigest: digest, previousSourceDigest: previousDigest };
    // @ts-expect-error a section update requires its Source baseline
    const missing: TextWriteTransition = { kind: "update-section" };
    expect(Schema.is(TextWriteTransition)(contradictory)).toBe(false);
    expect(Schema.is(TextWriteTransition)(missing)).toBe(false);
  });

  it.each([
    { kind: "managed", sourceDigest: digest },
    { kind: "managed", hasLocal: false },
    { kind: "unmanaged", sourceDigest: digest, hasLocal: false },
  ])("rejects incomplete composition observations: %j", (textComposition) => {
    expect(Schema.is(ObservedResourceStateSchema)({ state: "present", digest, executable: false, objectKind: "regular", textComposition })).toBe(false);
  });

  it("classifies matching unowned markers separately from unmanaged adoption", () => {
    const ownership = classifyTextOwnership({ state: "present", digest, executable: false, objectKind: "regular", textComposition: { kind: "managed", sourceDigest: digest, hasLocal: true } }, undefined);
    expect(ownership.kind).toBe("orphan-section");
    expect(planTextWriteTransition(ownership, "shared")).toEqual({ kind: "adopt-section", sourceDigest: digest });
    expect(() => checkTextWriteTransition({ kind: "adopt-section", sourceDigest: digest }, { kind: "managed", digest, sourceDigest: previousDigest, hasLocal: true }, digest)).toThrow(InvalidTextTransitionError);
  });

  it.each([true, false])("preserves the existing orphan-section drift rule (matching=%s)", (matching) => {
    const actions = planResource({
      resource: { id: resource, kind: "file", target: "~/notes.md", policy: "append-local", dependsOn: [], blobs: [] },
      desired: { kind: "file", digest, executable: false, mode: 0o600 },
      observed: { state: "present", digest: sha256Hex("whole composed file"), executable: false, mode: 0o600, objectKind: "regular", textComposition: { kind: "managed", sourceDigest: matching ? digest : previousDigest, hasLocal: true } },
      platform: "linux",
    });
    expect(actions.map((action) => action.kind)).toEqual([matching ? "no-op" : "drift-conflict"]);
  });

  it("blocks turning sharing off when the machine still has a local suffix", () => {
    const actions = planResource({
      resource: { id: resource, kind: "file", target: "~/notes.md", policy: "replace", dependsOn: [], blobs: [] },
      desired: { kind: "file", digest, executable: false, mode: 0o600 },
      observed: { state: "present", digest, executable: false, mode: 0o600, objectKind: "regular", textComposition: { kind: "managed", sourceDigest: previousDigest, hasLocal: true } },
      applied: applied(true),
      platform: "linux",
    });
    expect(actions.map((action) => action.kind)).toEqual(["human-action"]);
  });

  it("plans adoption even when unmanaged bytes already equal the Source", () => {
    const actions = planResource({
      resource: { id: resource, kind: "file", target: "~/notes.md", policy: "append-local", dependsOn: [], blobs: [] },
      desired: { kind: "file", digest, executable: false, mode: 0o600 },
      observed: { state: "present", digest, executable: false, mode: 0o600, objectKind: "regular", textComposition: { kind: "unmanaged" } },
      platform: "linux",
    });
    expect(actions[0]?.detail).toMatchObject({ kind: "write-file", textTransition: { kind: "adopt-local", retainedDigest: digest } });
  });

  it("distinguishes whole conversion and section update from the same applied digest", () => {
    const whole = classifyTextOwnership({ state: "present", digest: previousDigest, executable: false, objectKind: "regular", textComposition: { kind: "unmanaged" } }, applied(false));
    const section = classifyTextOwnership({ state: "present", digest, executable: false, objectKind: "regular", textComposition: { kind: "managed", sourceDigest: previousDigest, hasLocal: true } }, applied(true));
    expect(planTextWriteTransition(whole, "shared")).toEqual({ kind: "convert-whole", previousDigest });
    expect(planTextWriteTransition(section, "shared")).toEqual({ kind: "update-section", previousSourceDigest: previousDigest });
  });

  it("converts whole-file ownership without retaining the obsolete Source copy", async () => {
    const value = fixture({ kind: "convert-whole", previousDigest }, encode("Previous instructions.\n"));
    await Effect.runPromise(prepareResourceAction(value.context).pipe(Effect.flatMap((prepared) => prepared.execute), Effect.provide(value.layer)));
    expect(parseTextComposition(readFileSync(value.target))).toEqual({ kind: "managed", source, local: "" });
  });

  it("does not infer orphan ownership from markers added to a whole-owned file", () => {
    const actions = planResource({
      resource: { id: resource, kind: "file", target: "~/notes.md", policy: "append-local", dependsOn: [], blobs: [] },
      desired: { kind: "file", digest, executable: false, mode: 0o600 },
      observed: { state: "present", digest: sha256Hex("locally rewritten whole file"), executable: false, mode: 0o600, objectKind: "regular",
        textComposition: { kind: "managed", sourceDigest: digest, hasLocal: true } },
      applied: applied(false), platform: "linux",
    });
    expect(actions.map((action) => action.kind)).toEqual(["drift-conflict"]);
  });

  it("updates only the owned Source section and retains local text", async () => {
    const value = fixture({ kind: "update-section", previousSourceDigest: previousDigest }, composeTextFile("Previous instructions.\n", { kind: "unmanaged", local: "My notes.\n" }));
    await Effect.runPromise(prepareResourceAction(value.context).pipe(Effect.flatMap((prepared) => prepared.execute), Effect.provide(value.layer)));
    expect(parseTextComposition(readFileSync(value.target))).toEqual({ kind: "managed", source, local: "My notes.\n" });
  });

  it("rejects adoption when the reviewed local bytes changed before preparation", async () => {
    const changed = encode("Changed local notes.\n");
    const value = fixture({ kind: "adopt-local", retainedDigest: digest }, changed);
    const failure = await Effect.runPromise(prepareResourceAction(value.context).pipe(Effect.flip, Effect.provide(value.layer)));
    expect(failure._tag).toBe("InvalidExecutionPlanError");
    expect(readFileSync(value.target)).toEqual(Buffer.from(changed));
  });

  it("rejects creation when a local file appeared after planning", async () => {
    const local = encode("New local notes.\n");
    const value = fixture({ kind: "create-section" }, local);
    const failure = await Effect.runPromise(prepareResourceAction(value.context).pipe(Effect.flip, Effect.provide(value.layer)));
    expect(failure._tag).toBe("InvalidExecutionPlanError");
    expect(readFileSync(value.target)).toEqual(Buffer.from(local));
  });

  it("refuses leaving shared ownership when local text appeared after planning", async () => {
    const local = composeTextFile("Previous instructions.\n", { kind: "unmanaged", local: "Added after the plan.\n" });
    const value = fixture({ kind: "leave-section", previousSourceDigest: previousDigest }, local);
    const failure = await Effect.runPromise(prepareResourceAction(value.context).pipe(Effect.flip, Effect.provide(value.layer)));
    expect(failure._tag).toBe("InvalidExecutionPlanError");
    expect(sha256BytesHex(readFileSync(value.target))).toBe(sha256BytesHex(local));
  });

  it("refuses a local suffix added while leaving shared ownership is prepared", async () => {
    const value = fixture({ kind: "leave-section", previousSourceDigest: previousDigest }, composeTextFile("Previous instructions.\n"));
    const local = composeTextFile("Previous instructions.\n", { kind: "unmanaged", local: "Added during preparation.\n" });
    const failure = await Effect.runPromise(Effect.gen(function*() {
      const prepared = yield* prepareResourceAction(value.context);
      writeFileSync(value.target, local);
      return yield* Effect.flip(prepared.execute);
    }).pipe(Effect.provide(value.layer)));
    expect(failure._tag).toBe("InvalidExecutionPlanError");
    expect(readFileSync(value.target)).toEqual(Buffer.from(local));
  });

  it("leaves an empty shared section as plain text and rolls it back exactly", async () => {
    const before = composeTextFile("Previous instructions.\n");
    const value = fixture({ kind: "leave-section", previousSourceDigest: previousDigest }, before);
    await Effect.runPromise(Effect.gen(function*() {
      const prepared = yield* prepareResourceAction(value.context);
      yield* prepared.execute;
      expect(readFileSync(value.target, "utf8")).toBe(source);
      if (prepared.rollback === undefined) throw new Error("a text write must have rollback evidence");
      yield* prepared.rollback;
    }).pipe(Effect.provide(value.layer)));
    expect(readFileSync(value.target)).toEqual(Buffer.from(before));
  });
});
