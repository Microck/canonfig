import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ActionId, ContentDigest, ResourceId, RunId } from "../src/domain/brand.ts";
import { FollowerIdentity } from "../src/domain/identity.ts";
import { ProfileRevisionSchema } from "../src/domain/profile.ts";
import {
  SynchronizationPlanSchema,
  type SynchronizationPlan,
} from "../src/domain/synchronization.ts";
import { UpgradeGateError } from "../src/state/state-repository.errors.ts";
import { stateRepositoryLayer } from "../src/state/state-repository.layer.ts";
import { stateFormatVersion } from "../src/state/state-schema.ts";
import { StateRepository } from "../src/state/state-repository.service.ts";
import { evaluateCli } from "../src/cli/cli.ts";
import { describeRuntimeError } from "../src/cli/failure-taxonomy.ts";
import { assertUpgradeGate } from "../src/synchronization/upgrade-gate.ts";
import { nodeRuntimeIsSupported } from "../src/runtime/build-identity.ts";

const decode = Schema.decodeUnknownSync;
const asRunId = decode(RunId);
const asActionId = decode(ActionId);
const asResourceId = decode(ResourceId);
const digestA = decode(ContentDigest)("a".repeat(64));

const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const temporaryDirectory = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const follower = decode(FollowerIdentity)({
  id: "follower-1",
  name: "Follower follower-1",
  groups: ["base"],
  revoked: false,
  credentialReference: "secure-store://canonfig/follower",
  enrolledAt: "2026-08-15T12:00:00Z",
});

const revision = decode(ProfileRevisionSchema)({
  id: "revision-1",
  profileId: "profile-1",
  sequence: 1,
  canonicalBytes: '{"profile":"one"}',
  digest: digestA,
  signature: "ed25519:test-signature",
  publishedAt: "2026-08-15T12:00:01Z",
  resources: [],
  groups: [{ name: "base" }],
});

const plan = (): SynchronizationPlan =>
  decode(SynchronizationPlanSchema)({
    follower: "follower-1",
    revision: "revision-1",
    encoded: "plan:follower-1:revision-1",
    actions: [{
      id: asActionId("action-1"),
      resource: asResourceId("resource-1"),
      kind: "verify-only",
      detail: { kind: "verify-only", method: "digest" },
      before: [],
    }],
  });

const seed = Effect.gen(function*() {
  const repository = yield* StateRepository;
  yield* repository.registerFollower({ follower });
  yield* repository.publishRevision({ revision });
});

const startOpenRun = (
  repository: StateRepository["Service"],
  run = "run-gate-1",
) =>
  repository.startRun({
    id: asRunId(run),
    follower: follower.id,
    revision: revision.id,
    plan: plan(),
    startedAt: "2026-08-15T12:01:00Z",
  });

const runWithRepository = <A, E>(
  path: string,
  effect: Effect.Effect<A, E, StateRepository>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(stateRepositoryLayer(path))));
const gateFailureAfterMutation = async (
  mutate?: (database: DatabaseSync) => void,
): Promise<UpgradeGateError | undefined> => {
  const path = join(temporaryDirectory("canonfig-gate-"), "state.sqlite");
  let failure: UpgradeGateError | undefined;
  await Effect.runPromise(Effect.gen(function*() {
    yield* seed;
    const repository = yield* StateRepository;
    yield* startOpenRun(repository);
    if (mutate !== undefined) mutate(new DatabaseSync(path));
    yield* assertUpgradeGate(follower.id).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          failure = error;
        })
      ),
    );
  }).pipe(Effect.provide(stateRepositoryLayer(path))));
  return failure;
};
describe("build identity", () => {
  it("reports an unbuilt source identity through --version --json", () => {
    const outcome = evaluateCli(["--version", "--json"]);
    expect(outcome._tag).toBe("Version");
    if (outcome._tag !== "Version") return;
    // SAFETY: the Version outcome serializes the build identity, whose
    // shape is fixed by src/runtime/build-identity.ts.
    const identity = JSON.parse(outcome.text) as {
      packageVersion: string;
      sourceDigest: string;
      commit: string | null;
    };
    expect(identity.packageVersion).toBe("6.1.1");
    expect(identity.sourceDigest).toBe("unbuilt");
    expect(identity.commit).toBeNull();
  });

  it("accepts Node 24 and newer but rejects older or malformed versions", () => {
    expect(nodeRuntimeIsSupported("24.0.0")).toBe(true);
    expect(nodeRuntimeIsSupported("25.1.2")).toBe(true);
    expect(nodeRuntimeIsSupported("23.99.0")).toBe(false);
    expect(nodeRuntimeIsSupported("not-a-version")).toBe(false);
  });

  it("keeps the plain --version output as the release version", () => {
    expect(evaluateCli(["--version"])).toEqual({
      _tag: "Version",
      text: "6.1.1",
      exitCode: 0,
    });
  });
});

describe("upgrade gate", () => {
  it("records the creating build identity on every started run", async () => {
    const path = join(temporaryDirectory("canonfig-gate-"), "state.sqlite");
    const open = await runWithRepository(path, Effect.gen(function*() {
      yield* seed;
      const repository = yield* StateRepository;
      yield* startOpenRun(repository);
      return yield* repository.loadOpenRunIdentity(follower.id);
    }));
    expect(open).toEqual({
      run: "run-gate-1",
      creatingVersion: "6.1.1",
      creatingIdentity: "unbuilt",
      stateFormat: stateFormatVersion,
    });
  });

  it("allows an unfinished run created by this same build", async () => {
    const path = join(temporaryDirectory("canonfig-gate-"), "state.sqlite");
    await runWithRepository(path, Effect.gen(function*() {
      yield* seed;
      const repository = yield* StateRepository;
      yield* startOpenRun(repository);
      yield* assertUpgradeGate(follower.id);
    }));
  });

  it("stops an incompatible upgrade before the run is touched", async () => {
    const failure = await gateFailureAfterMutation((database) => {
      database.prepare(
        "UPDATE synchronization_runs SET creating_identity = ?",
      ).run("f".repeat(64));
    });
    expect(failure).toBeInstanceOf(UpgradeGateError);
    if (failure instanceof UpgradeGateError) {
      expect(failure.run).toBe("run-gate-1");
      expect(failure.creatingIdentity).toBe("f".repeat(64));
      expect(failure.currentIdentity).toBe("unbuilt");
    }
  });

  it("names the state format, not the same build twice, for a format-only mismatch", async () => {
    const failure = await gateFailureAfterMutation((database) => {
      database.prepare(
        "UPDATE synchronization_runs SET state_format = ?",
      ).run(stateFormatVersion - 1);
    });
    expect(failure).toBeInstanceOf(UpgradeGateError);
    if (!(failure instanceof UpgradeGateError)) return;
    expect(failure.creatingStateFormat).toBe(stateFormatVersion - 1);
    expect(failure.currentStateFormat).toBe(stateFormatVersion);
    const described = describeRuntimeError(failure);
    expect(described.category).toBe("conflict-or-drift");
    expect(described.message).toContain(
      `recorded in state format ${stateFormatVersion - 1}`,
    );
    expect(described.message).toContain(`uses state format ${stateFormatVersion}`);
    expect(described.message).not.toContain("finish the run with the creating build");
  });

  it("accepts a foreign run when the operator explicitly migrates", async () => {
    const previous = process.env.CANONFIG_ACCEPT_FOREIGN_BUILD;
    process.env.CANONFIG_ACCEPT_FOREIGN_BUILD = "1";
    try {
      const path = join(temporaryDirectory("canonfig-gate-"), "state.sqlite");
      await runWithRepository(path, Effect.gen(function*() {
        yield* seed;
        const repository = yield* StateRepository;
        yield* startOpenRun(repository);
        yield* assertUpgradeGate(follower.id);
      }));
    } finally {
      if (previous === undefined) {
        delete process.env.CANONFIG_ACCEPT_FOREIGN_BUILD;
      } else {
        process.env.CANONFIG_ACCEPT_FOREIGN_BUILD = previous;
      }
    }
  });
});

describe("deployment receipts", () => {
  it("records a receipt when a run completes", async () => {
    const path = join(temporaryDirectory("canonfig-gate-"), "state.sqlite");
    await runWithRepository(path, Effect.gen(function*() {
      yield* seed;
      const repository = yield* StateRepository;
      yield* startOpenRun(repository);
      yield* repository.completeRun({
        run: asRunId("run-gate-1"),
        completedAt: "2026-08-15T12:05:00Z",
        outcome: {
          outcome: "Converged",
          run: asRunId("run-gate-1"),
          verified: [],
        },
        appliedResources: [],
        removedResources: [],
      });
      yield* repository.finalizeRun(asRunId("run-gate-1"), "2026-08-15T12:05:01Z");
    }));
    const database = new DatabaseSync(path);
    try {
      // SAFETY: the receipt insert is the only writer of this table and the
      // fixture just completed exactly one run.
      const receipt = database.prepare(
        "SELECT run_id, package_version, build_identity, state_format, outcome FROM deployment_receipts",
      ).get() as {
        run_id: string;
        package_version: string;
        build_identity: string;
        state_format: number;
        outcome: string;
      };
      expect(receipt).toEqual({
        run_id: "run-gate-1",
        package_version: "6.1.1",
        build_identity: "unbuilt",
        state_format: stateFormatVersion,
        outcome: "Converged",
      });
    } finally {
      database.close();
    }
  });
});
