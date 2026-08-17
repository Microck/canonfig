import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Fiber, Layer, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  ActionId,
  AgentTaskId,
  ContentDigest,
  ProfileId,
  ProfileRevisionId,
  ResourceId,
  RunId,
} from "../../src/domain/brand.ts";
import { FollowerIdentity } from "../../src/domain/identity.ts";
import type {
  ProfileRevision,
  PublishedResource,
} from "../../src/domain/profile.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import {
  canonicalJson,
  sha256BytesHex,
  sha256Hex,
} from "../../src/profile/profile-codec.ts";
import { RepositoryDecodeError } from "../../src/state/state-repository.errors.ts";
import { stateRepositoryLayer } from "../../src/state/state-repository.layer.ts";
import { StateRepository } from "../../src/state/state-repository.service.ts";
import { planSynchronization } from "../../src/synchronization/planner.ts";
import { RecoveryIntegrityError } from "../../src/synchronization/synchronization.errors.ts";
import { SynchronizationLive } from "../../src/synchronization/synchronization.layer.ts";
import { Synchronization } from "../../src/synchronization/synchronization.service.ts";
import type {
  DesiredResource,
  PlanningProfileRevision,
  SynchronizationArtifact,
  SynchronizationRecoveryInput,
} from "../../src/synchronization/synchronization.types.ts";

const decode = Schema.decodeUnknownSync;
const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "canonfig-recovery-"));
  temporaryDirectories.push(directory);
  return directory;
};

const follower = decode(FollowerIdentity)({
  id: "follower-recovery",
  name: "Recovery follower",
  groups: [],
  revoked: false,
  credentialReference: "secure-store://recovery",
  enrolledAt: "2026-08-15T00:00:00Z",
});

interface Fixture {
  readonly root: string;
  readonly database: string;
  readonly target: string;
  readonly artifact: SynchronizationArtifact;
  readonly revision: PlanningProfileRevision;
  readonly recovery: SynchronizationRecoveryInput;
}

type TestRollbackPayload =
  | { readonly path: string; readonly existed: boolean; readonly content: string }
  | { readonly path: string; readonly state: "absent" }
  | {
    readonly path: string;
    readonly state: "regular";
    readonly content: string;
    readonly mode: number;
  }
  | { readonly path: string; readonly state: "symlink"; readonly target: string };

const fixture = (
  root: string,
  options: {
    readonly kind?: "file" | "tool";
    readonly version?: string | undefined;
  } = {},
): Fixture => {
  const kind = options.kind ?? "file";
  const target = kind === "file" ? join(root, "home", "settings.json") : "rg";
  const content = new TextEncoder().encode("canonical content");
  const digest = sha256BytesHex(content);
  const resource: PublishedResource = kind === "file"
    ? {
      id: decode(ResourceId)("settings"),
      kind: "file",
      policy: "replace",
      target,
      dependsOn: [],
      blobs: [],
    }
    : {
      id: decode(ResourceId)("tool"),
      kind: "tool",
      policy: "ensure",
      target,
      dependsOn: [],
      blobs: [],
    };
  const baseRevision: ProfileRevision = {
    id: decode(ProfileRevisionId)("revision-recovery"),
    profileId: decode(ProfileId)("profile-recovery"),
    sequence: 1,
    canonicalBytes: "{}",
    digest,
    signature: "test-signature",
    publishedAt: "2026-08-15T00:00:00Z",
    resources: [resource],
    groups: [],
  };
  const desired: DesiredResource = kind === "file"
    ? { kind: "file", digest, executable: false }
    : {
      kind: "tool",
      toolId: "rg",
      recipes: [options.version === undefined
        ? {
          platform: "linux",
          method: "apt",
          package: "ripgrep",
        }
        : {
          platform: "linux",
          method: "apt",
          package: "ripgrep",
          version: options.version,
        }],
      loginRequired: false,
    };
  const revision: PlanningProfileRevision = {
    ...baseRevision,
    desired: [{
      resource: resource.id,
      desired,
      verification: kind === "file"
        ? { method: "digest", digest }
        : { method: "executable-present", executable: "rg" },
    }],
    blobs: [],
  };
  const artifact = { digest, content };
  return {
    root,
    database: join(root, "state.sqlite"),
    target,
    artifact,
    revision,
    recovery: {
      follower: follower.id,
      revision,
      artifacts: kind === "file" ? [artifact] : [],
    },
  };
};

const machineLayer = (root: string) =>
  linuxMachineStateLayer({
    environment: [
      { name: "HOME", value: join(root, "home") },
      { name: "PATH", value: join(root, "bin") },
    ],
    credentialPolicy: {
      kind: "local-file",
      path: join(root, "credentials"),
    },
  });

const decorateMachine = (
  root: string,
  transform: (service: MachineState["Service"]) => MachineState["Service"],
) =>
  Layer.effect(
    MachineState,
    Effect.map(MachineState, transform),
  ).pipe(Layer.provide(machineLayer(root)));

const applicationLayer = (
  value: Fixture,
  machine = machineLayer(value.root),
) =>
  SynchronizationLive.pipe(
    Layer.provideMerge(stateRepositoryLayer(value.database)),
    Layer.provideMerge(machine),
  );

const persistedPlan = (value: Fixture) => {
  const desired = value.revision.desired[0]!.desired;
  const planned = Effect.runSync(planSynchronization({
    revision: value.revision,
    follower: follower.id,
    observedState: {
      platform: "linux",
      resources: [{
        resource: value.revision.resources[0]!.id,
        observed: { state: "absent" },
      }],
      availableBlobs: [],
    },
    localOverlay: [],
    appliedResources: [],
  }));
  if (desired.kind !== "file" || value.revision.resources.length !== 1) return planned;
  return planned;
};

const seed = (
  value: Fixture,
  plan = persistedPlan(value),
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const repository = yield* StateRepository;
      yield* repository.registerFollower({ follower });
      yield* repository.publishRevision({ revision: value.revision });
      yield* repository.startRun({
        id: decode(RunId)("run-recovery"),
        follower: follower.id,
        revision: value.revision.id,
        plan,
        startedAt: "2026-08-15T00:01:00Z",
      });
    }).pipe(Effect.provide(stateRepositoryLayer(value.database))),
  );

const journal = (
  value: Fixture,
  action: string,
  state: "running" | "succeeded" | "failed" | "skipped",
  rollbackReference?: string,
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const repository = yield* StateRepository;
      yield* repository.journalAction({
        run: decode(RunId)("run-recovery"),
        action: decode(ActionId)(action),
        state,
        recordedAt: "2026-08-15T00:02:00Z",
        attempt: 1,
        verification: state === "succeeded"
          ? { status: "passed" as const, method: "sha256" }
          : undefined,
        rollbackReference,
      });
    }).pipe(Effect.provide(stateRepositoryLayer(value.database))),
  );

const interruptRun = (value: Fixture) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const repository = yield* StateRepository;
      yield* repository.completeRun({
        run: decode(RunId)("run-recovery"),
        completedAt: "2026-08-15T00:03:00Z",
        outcome: {
          outcome: "Interrupted",
          run: decode(RunId)("run-recovery"),
          completedActions: [],
        },
        appliedResources: [],
      });
    }).pipe(Effect.provide(stateRepositoryLayer(value.database))),
  );

const rollbackReference = (
  value: Fixture,
  action: string,
  previous: string,
): string => {
  return writeRollbackPayload(value, action, {
    path: value.target,
    existed: true,
    content: Buffer.from(previous).toString("base64"),
  });
};

const writeRollbackPayload = (
  value: Fixture,
  action: string,
  payload: TestRollbackPayload,
): string => {
  const path = join(
    value.root,
    "home",
    ".cache",
    "canonfig",
    "rollback",
    "run-recovery",
    `${sha256Hex(action)}.json`,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify([payload]));
  return path;
};

const recover = (
  value: Fixture,
  machine = machineLayer(value.root),
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const synchronization = yield* Synchronization;
      return yield* synchronization.recover(value.recovery);
    }).pipe(Effect.provide(applicationLayer(value, machine))),
  );

const runRows = (value: Fixture) => {
  const database = new DatabaseSync(value.database, { readOnly: true });
  const rows = database.prepare(`
    SELECT action_id, state, attempt, rollback_reference
    FROM action_journal
    ORDER BY sequence
  `).all();
  database.close();
  return rows;
};

describe("synchronization crash recovery", () => {
  it.each([
    ["before mutation", "pending", false],
    ["during write/replace", "running", true],
    ["after mutation before journal completion", "running", true],
    ["after completion before run finalization", "succeeded", true],
  ] as const)(
    "recovers an interruption %s",
    async (_label, state, mutated) => {
      const value = fixture(temporaryDirectory());
      const plan = persistedPlan(value);
      await seed(value, plan);
      const action = plan.actions[0]!;
      mkdirSync(dirname(value.target), { recursive: true });
      writeFileSync(value.target, mutated ? "partial content" : "original");
      if (state !== "pending") {
        const reference = rollbackReference(value, action.id, "original");
        await journal(value, action.id, "running", reference);
        if (state === "succeeded") {
          writeFileSync(value.target, value.artifact.content);
          await journal(value, action.id, "succeeded", reference);
        }
      }

      let targetWrites = 0;
      const machine = decorateMachine(value.root, (service) => ({
        ...service,
        atomicWrite: (input) => {
          if (input.path.absolute === value.target) targetWrites += 1;
          return service.atomicWrite(input);
        },
      }));
      const outcome = await recover(value, machine);

      expect(outcome.outcome).toBe("Converged");
      expect(await readFile(value.target, "utf8")).toBe("canonical content");
      expect(targetWrites).toBe(state === "succeeded" ? 0 : mutated ? 2 : 1);
    },
  );

  it("resumes actions in stable order without repeating verified terminals", async () => {
    const value = fixture(temporaryDirectory());
    const base = persistedPlan(value);
    const first = base.actions[0]!;
    const second = {
      ...first,
      id: decode(ActionId)("action:settings:second:write-file"),
      before: [first.id],
    };
    const body = {
      revision: base.revision,
      follower: base.follower,
      requiredBlobs: base.requiredBlobs,
      actions: [first, second],
      agentTasks: base.agentTasks,
    };
    const encoded = canonicalJson(
      Schema.decodeUnknownSync(Schema.MutableJson)(body),
    );
    const plan = {
      ...base,
      actions: [first, second],
      encoded,
      digest: sha256Hex(encoded),
    };
    await seed(value, plan);
    mkdirSync(dirname(value.target), { recursive: true });
    writeFileSync(value.target, value.artifact.content);
    await journal(value, first.id, "running");
    await journal(value, first.id, "succeeded");

    const outcome = await recover(value);
    const rows = runRows(value);

    expect(outcome.outcome).toBe("Converged");
    expect(rows.map((row) => [row.action_id, row.state])).toEqual([
      [first.id, "pending"],
      [second.id, "pending"],
      [first.id, "running"],
      [first.id, "succeeded"],
      [second.id, "running"],
      [second.id, "succeeded"],
    ]);
  });

  it("preserves executable execution-model metadata across persisted plan hydration", async () => {
    const value = fixture(temporaryDirectory(), { kind: "tool" });
    const base = persistedPlan(value);
    const agentAction = {
      id: decode(ActionId)("action:tool:1:agent-task"),
      resource: value.revision.resources[0]!.id,
      kind: "agent-task" as const,
      detail: {
        kind: "agent-task" as const,
        taskId: decode(AgentTaskId)("agent:tool:1"),
        summary: "Resolve tool",
      },
      before: [],
    };
    const agentTask = {
      id: decode(AgentTaskId)("agent:tool:1"),
      resource: value.revision.resources[0]!.id,
      summary: "Resolve tool",
      desiredOutcome: "Make the tool available",
      observedEvidence: ["Observed state: absent"],
      allowedPaths: ["~/.canonfig/tool"],
      allowedExecutables: ["custom-tool"],
      executableAuthorizations: [{
        executable: "custom-tool",
        behavior: "leaf" as const,
      }],
      allowedOrigins: [],
      forbidden: ["elevation", "login", "restart", "reboot"] as const,
      timeLimitSeconds: 300,
      outputLimitBytes: 65_536,
      verification: { command: ["custom-tool", "--version"] },
    };
    const body = {
      revision: base.revision,
      follower: base.follower,
      requiredBlobs: base.requiredBlobs,
      actions: [agentAction],
      agentTasks: [agentTask],
    };
    const encoded = canonicalJson(
      Schema.decodeUnknownSync(Schema.MutableJson)(body),
    );
    const plan = {
      ...base,
      actions: body.actions,
      agentTasks: [agentTask],
      encoded,
      digest: sha256Hex(encoded),
    };
    await seed(value, plan);

    // Recovery hydrates the persisted plan; the agent task action routes to
    // Human Action Required without losing its recorded execution models.
    const outcome = await recover(value);
    expect(outcome.outcome).toBe("HumanActionRequired");
    if (outcome.outcome !== "HumanActionRequired") return;
    expect(outcome.actions).toHaveLength(1);
    const database = new DatabaseSync(value.database, { readOnly: true });
    const row = database.prepare(
      "SELECT plan_json FROM synchronization_runs WHERE id = ?",
    ).get("run-recovery");
    database.close();
    const persisted = JSON.parse(String(row?.plan_json));
    expect(persisted.agentTasks[0].executableAuthorizations).toEqual([{
      executable: "custom-tool",
      behavior: "leaf",
    }]);
  });

  it("fails safely on malformed persisted plan data", async () => {
    const value = fixture(temporaryDirectory());
    await seed(value);
    const database = new DatabaseSync(value.database);
    database.prepare(
      "UPDATE synchronization_runs SET plan_json = ? WHERE id = ?",
    ).run('{"actions":', "run-recovery");
    database.close();

    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const synchronization = yield* Synchronization;
        return yield* Effect.flip(synchronization.recover(value.recovery));
      }).pipe(Effect.provide(applicationLayer(value))),
    );
    expect(error).toBeInstanceOf(RepositoryDecodeError);
  });

  it("rejects a hydrated revision that does not match the recorded revision", async () => {
    const value = fixture(temporaryDirectory());
    await seed(value);
    const mismatched = {
      ...value.recovery,
      revision: {
        ...value.revision,
        signature: "different-signature",
      },
    };

    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const synchronization = yield* Synchronization;
        return yield* Effect.flip(synchronization.recover(mismatched));
      }).pipe(Effect.provide(applicationLayer(value))),
    );
    expect(error).toBeInstanceOf(RecoveryIntegrityError);
  });

  it("independently verifies an uncertain installer without rerunning it", async () => {
    const value = fixture(temporaryDirectory(), {
      kind: "tool",
      version: "14.1.0",
    });
    const plan = persistedPlan(value);
    expect(plan.actions[0]?.detail).toMatchObject({ version: "14.1.0" });
    await seed(value, plan);
    await journal(value, plan.actions[0]!.id, "running");
    const bin = join(value.root, "bin");
    mkdirSync(bin, { recursive: true });
    const executable = join(bin, "rg");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    let processes = 0;
    const machine = decorateMachine(value.root, (service) => ({
      ...service,
      runProcess: (input) => {
        processes += 1;
        return service.runProcess(input);
      },
    }));

    const outcome = await recover(value, machine);
    expect(outcome.outcome).toBe("Converged");
    expect(processes).toBe(0);
    expect(runRows(value).at(-1)?.rollback_reference).toBeNull();
  });

  it("requires human action when uncertain installer evidence stays ambiguous", async () => {
    const value = fixture(temporaryDirectory(), { kind: "tool" });
    const plan = persistedPlan(value);
    await seed(value, plan);
    await journal(value, plan.actions[0]!.id, "running");
    const bin = join(value.root, "bin");
    mkdirSync(bin, { recursive: true });
    const installer = join(bin, "apt-get");
    writeFileSync(installer, "#!/bin/sh\nexit 0\n");
    chmodSync(installer, 0o755);
    let processes = 0;
    const machine = decorateMachine(value.root, (service) => ({
      ...service,
      runProcess: (input) => {
        processes += 1;
        return service.runProcess(input);
      },
    }));

    const outcome = await recover(value, machine);
    expect(outcome.outcome).toBe("HumanActionRequired");
    expect(processes).toBe(0);
    expect(runRows(value).at(-1)?.state).toBe("skipped");
    expect(runRows(value).at(-1)?.rollback_reference).toBeNull();
  });

  it("restores owned-file rollback material before retrying an interrupted mutation", async () => {
    const value = fixture(temporaryDirectory());
    const plan = persistedPlan(value);
    await seed(value, plan);
    mkdirSync(dirname(value.target), { recursive: true });
    writeFileSync(value.target, "corrupt partial write");
    const reference = rollbackReference(value, plan.actions[0]!.id, "previous");
    await journal(value, plan.actions[0]!.id, "running", reference);
    await interruptRun(value);
    const writes: Array<string> = [];
    const machine = decorateMachine(value.root, (service) => ({
      ...service,
      atomicWrite: (input) =>
        service.atomicWrite(input).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (input.path.absolute === value.target) {
                writes.push(Buffer.from(input.content).toString("utf8"));
              }
            })
          ),
        ),
    }));

    await recover(value, machine);
    expect(writes).toEqual(["previous", "canonical content"]);
  });

  it("does not resurrect a removed resource after restart recovery", async () => {
    const value = fixture(temporaryDirectory());
    const resource = value.revision.resources[0]!;
    const removedRevision: PlanningProfileRevision = {
      ...value.revision,
      id: decode(ProfileRevisionId)("revision-recovery-removed"),
      sequence: 2,
      canonicalBytes: "{\"removed\":true}",
      digest: decode(ContentDigest)(sha256Hex("{\"removed\":true}")),
      resources: [resource],
      removedResources: [resource.id],
    };
    const plan = Effect.runSync(planSynchronization({
      revision: removedRevision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [{
          resource: resource.id,
          observed: {
            state: "present",
            digest: decode(ContentDigest)(value.artifact.digest),
            executable: false,
          },
        }],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: [{
        resource: resource.id,
        revision: value.revision.id,
        digest: decode(ContentDigest)(value.artifact.digest),
        appliedAt: "2026-08-15T00:00:59Z",
        kind: "file",
        policy: "replace",
        target: value.target,
        executable: false,
      }],
    }));
    mkdirSync(dirname(value.target), { recursive: true });
    writeFileSync(value.target, value.artifact.content);

    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const repository = yield* StateRepository;
        yield* repository.registerFollower({ follower });
        yield* repository.publishRevision({ revision: value.revision });
        yield* repository.publishRevision({
          revision: { ...removedRevision, resources: [] },
        });
        const applied = {
          resource: resource.id,
          revision: value.revision.id,
          digest: decode(ContentDigest)(value.artifact.digest),
          appliedAt: "2026-08-15T00:00:59Z",
          kind: "file" as const,
          policy: "replace" as const,
          target: value.target,
          executable: false,
        };
        const database = new DatabaseSync(value.database);
        database.prepare(`
          INSERT INTO applied_resources (
            follower_id, resource_id, revision_id, digest, applied_at,
            kind, policy, target, executable
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          follower.id,
          applied.resource,
          applied.revision,
          applied.digest,
          applied.appliedAt,
          applied.kind,
          applied.policy,
          applied.target,
          0,
        );
        database.close();
        yield* repository.startRun({
          id: decode(RunId)("run-recovery"),
          follower: follower.id,
          revision: removedRevision.id,
          plan,
          startedAt: "2026-08-15T00:01:00Z",
        });
        yield* repository.journalAction({
          run: decode(RunId)("run-recovery"),
          action: plan.actions[0]!.id,
          state: "running",
          recordedAt: "2026-08-15T00:01:01Z",
          attempt: 1,
          rollbackReference: undefined,
        });
        rmSync(value.target);
        yield* repository.journalAction({
          run: decode(RunId)("run-recovery"),
          action: plan.actions[0]!.id,
          state: "succeeded",
          recordedAt: "2026-08-15T00:01:02Z",
          attempt: 1,
          verification: {
            status: "passed",
            method: "owned-resource-removed",
          },
          removedResource: resource.id,
          removedResourceRecord: applied,
        });
        const synchronization = yield* Synchronization;
        return yield* synchronization.recover({
          follower: follower.id,
          revision: removedRevision,
          artifacts: [value.artifact],
        });
      }).pipe(Effect.provide(applicationLayer(value))),
    );

    expect(outcome.outcome).toBe("Converged");
    await expect(readFile(value.target)).rejects.toMatchObject({ code: "ENOENT" });
    const loaded = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.loadAppliedResources(follower.id)
      ).pipe(Effect.provide(stateRepositoryLayer(value.database))),
    );
    expect(loaded).toEqual([]);
  });

  it.each([
    [
      "absent",
      (value: Fixture) => ({ path: value.target, state: "absent" }),
      (_value: Fixture) => ["remove", "write:canonical content:384"],
    ],
    [
      "regular",
      (value: Fixture) => ({
        path: value.target,
        state: "regular",
        content: Buffer.from("regular").toString("base64"),
        mode: 0o600,
      }),
      (_value: Fixture) => ["write:regular:384", "write:canonical content:384"],
    ],
    [
      "executable",
      (value: Fixture) => ({
        path: value.target,
        state: "regular",
        content: Buffer.from("executable").toString("base64"),
        mode: 0o700,
      }),
      (_value: Fixture) => ["write:executable:448", "write:canonical content:384"],
    ],
    [
      "symlink",
      (value: Fixture) => ({
        path: value.target,
        state: "symlink",
        target: join(value.root, "original-target"),
      }),
      (value: Fixture) => [
        `symlink:${join(value.root, "original-target")}`,
        "write:canonical content:384",
      ],
    ],
  ] as const)(
    "restores persisted %s state before retrying",
    async (_state, payload, expectedOperations) => {
      const value = fixture(temporaryDirectory());
      const plan = persistedPlan(value);
      await seed(value, plan);
      mkdirSync(dirname(value.target), { recursive: true });
      writeFileSync(value.target, "corrupt partial write");
      const reference = writeRollbackPayload(value, plan.actions[0]!.id, payload(value));
      await journal(value, plan.actions[0]!.id, "running", reference);
      const operations: Array<string> = [];
      const machine = decorateMachine(value.root, (service) => ({
        ...service,
        atomicWrite: (input) => {
          if (input.path.absolute === value.target) {
            operations.push(
              `write:${Buffer.from(input.content).toString("utf8")}:${String(input.mode)}`,
            );
          }
          return service.atomicWrite(input);
        },
        removeFile: (input) => {
          if (input.path.absolute === value.target) operations.push("remove");
          return service.removeFile(input);
        },
        replaceSymlink: (input) => {
          if (input.path.absolute === value.target) {
            operations.push(`symlink:${input.target.absolute}`);
          }
          return service.replaceSymlink(input);
        },
      }));

      const outcome = await recover(value, machine);

      expect(outcome.outcome).toBe("Converged");
      expect(operations).toEqual(expectedOperations(value));
    },
  );

  it("preserves Interrupted when cancellation reaches resumed mutation", async () => {
    const value = fixture(temporaryDirectory());
    await seed(value);
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const machine = decorateMachine(value.root, (service) => ({
      ...service,
      atomicWrite: (input) => {
        if (input.path.absolute !== value.target) return service.atomicWrite(input);
        notifyStarted?.();
        return Effect.never;
      },
    }));
    const program = Effect.gen(function*() {
      const synchronization = yield* Synchronization;
      return yield* synchronization.recover(value.recovery);
    }).pipe(Effect.provide(applicationLayer(value, machine)));
    const fiber = Effect.runFork(program);
    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));

    const database = new DatabaseSync(value.database, { readOnly: true });
    const row = database.prepare(
      "SELECT status FROM synchronization_runs WHERE id = ?",
    ).get("run-recovery");
    database.close();
    expect(row?.status).toBe("Interrupted");
  });
});
