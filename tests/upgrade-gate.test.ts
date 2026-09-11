import { mkdtempSync, rmSync } from "node:fs";
import type { StatsFs } from "node:fs";
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
import { assertUpgradeGate } from "../src/synchronization/follower-orchestration.ts";
import { preflightDisk } from "../src/synchronization/executor.ts";
import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { MachineState } from "../src/machine/machine-state.service.ts";

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
  return await Effect.runPromise(Effect.gen(function*() {
    yield* seed;
    const repository = yield* StateRepository;
    yield* startOpenRun(repository);
    if (mutate !== undefined) mutate(new DatabaseSync(path));
    const outcome = yield* Effect.either(assertUpgradeGate(follower.id));
    return outcome._tag === "Left" ? outcome.left : undefined;
  }).pipe(Effect.provide(stateRepositoryLayer(path))));
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
    expect(identity.packageVersion).toBe("3.1.5");
    expect(identity.sourceDigest).toBe("unbuilt");
    expect(identity.commit).toBeNull();
  });

  it("keeps the plain --version output as the release version", () => {
    expect(evaluateCli(["--version"])).toEqual({
      _tag: "Version",
      text: "3.1.5",
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
      creatingVersion: "3.1.5",
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

  it("treats a run without a recorded identity as foreign", async () => {
    const failure = await gateFailureAfterMutation((database) => {
      database.prepare(
        "UPDATE synchronization_runs SET creating_identity = NULL, creating_version = NULL",
      ).run();
    });
    expect(failure).toBeInstanceOf(UpgradeGateError);
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
          completedActions: [asActionId("action-1")],
        },
        appliedResources: [],
        removedResources: [],
      });
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
        package_version: "3.1.5",
        build_identity: "unbuilt",
        state_format: stateFormatVersion,
        outcome: "Converged",
      });
    } finally {
      database.close();
    }
  });
});

describe("disk preflight", () => {
  const fakeStatfs = (freeBlocks: bigint) =>
    async (): Promise<StatsFs> =>
      // SAFETY: only bsize and bavail feed the estimate; the remaining
      // fields of the platform statfs result are irrelevant to the check.
      ({ bsize: 4096, bavail: freeBlocks }) as StatsFs;

  const machineLayer = (home: string) =>
    linuxMachineStateLayer({
      credentialPolicy: {
        kind: "local-file",
        path: join(home, "credentials"),
      },
      environment: [{ name: "HOME", value: home }],
    });

  const runInput = {
    id: asRunId("run-disk-1"),
    plan: plan(),
    revision,
    appliedResources: [],
    artifacts: [{ digest: digestA, content: new Uint8Array(100) }],
    knownSecrets: [],
  } as Parameters<typeof preflightDisk>[0];

  it("fails with an estimate when the filesystem cannot fit the run", async () => {
    const home = temporaryDirectory("canonfig-disk-home-");
    const failure = await Effect.runPromise(
      Effect.flip(
        preflightDisk(runInput, fakeStatfs(0n)).pipe(
          Effect.provide(machineLayer(home)),
        ),
      ),
    );
    expect(failure.requiredBytes).toBe(BigInt(2 * 100 + 4 * 1024 * 1024));
    expect(failure.availableBytes).toBe(0n);
  });

  it("passes when the filesystem holds the requirement", async () => {
    const home = temporaryDirectory("canonfig-disk-home-");
    await Effect.runPromise(
      preflightDisk(runInput, fakeStatfs(1024n * 1024n)).pipe(
        Effect.provide(machineLayer(home)),
      ),
    );
  });

  it("agrees with the real statfs of a temporary directory", async () => {
    const home = temporaryDirectory("canonfig-disk-home-");
    await Effect.runPromise(
      preflightDisk(runInput).pipe(Effect.provide(machineLayer(home))),
    );
  });
});
