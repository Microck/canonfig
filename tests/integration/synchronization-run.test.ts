import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Fiber, Layer, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  ActionId,
  ContentDigest,
  FollowerId,
  ProfileId,
  ProfileRevisionId,
  ResourceId,
  RunId,
} from "../../src/domain/brand.ts";
import { FollowerIdentity } from "../../src/domain/identity.ts";
import type { ProfileRevision, PublishedResource } from "../../src/domain/profile.ts";
import type { SynchronizationOutcome } from "../../src/domain/synchronization.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import {
  canonicalJson,
  sha256BytesHex,
  sha256Hex,
} from "../../src/profile/profile-codec.ts";
import { stateRepositoryLayer } from "../../src/state/state-repository.layer.ts";
import { StateRepository } from "../../src/state/state-repository.service.ts";
import { planSynchronization } from "../../src/synchronization/planner.ts";
import {
  defaultSynchronizationExecutionLimits,
} from "../../src/synchronization/executor.ts";
import {
  getConfigPath,
  parseConfigDocument,
  serializeConfigDocument,
  setConfigPath,
} from "../../src/synchronization/config-codec.ts";
import {
  prepareResourceAction,
  type ResourceExecutionContext,
} from "../../src/synchronization/resource-executors.ts";
import { SynchronizationLive } from "../../src/synchronization/synchronization.layer.ts";
import { Synchronization } from "../../src/synchronization/synchronization.service.ts";
import type {
  DesiredResource,
  PlanningProfileRevision,
  SynchronizationArtifact,
  SynchronizationRunInput,
} from "../../src/synchronization/synchronization.types.ts";

const decode = Schema.decodeUnknownSync;
const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "canonfig-run-"));
  temporaryDirectories.push(directory);
  return directory;
};

interface Fixture {
  readonly root: string;
  readonly database: string;
  readonly target: string;
  readonly revision: PlanningProfileRevision;
  readonly artifact: SynchronizationArtifact;
  readonly input: SynchronizationRunInput;
}

const fileFixture = (
  root: string,
  run = "run-1",
  observedDigest?: string | undefined,
): Fixture => {
  const content = new TextEncoder().encode("canonical content");
  const digest = sha256BytesHex(content);
  const target = join(root, "home", "settings.json");
  const resource: PublishedResource = {
    id: decode(ResourceId)("settings"),
    kind: "file",
    policy: "replace",
    target,
    dependsOn: [],
    blobs: [],
  };
  const baseRevision: ProfileRevision = {
    id: decode(ProfileRevisionId)("revision-1"),
    profileId: decode(ProfileId)("profile-1"),
    sequence: 1,
    canonicalBytes: "{}",
    digest,
    signature: "test-signature",
    publishedAt: "2026-08-15T00:00:00Z",
    resources: [resource],
    groups: [],
  };
  const desired: DesiredResource = {
    kind: "file",
    digest,
    executable: false,
  };
  const revision: PlanningProfileRevision = {
    ...baseRevision,
    desired: [{
      resource: resource.id,
      desired,
      verification: { method: "digest", digest },
    }],
    blobs: [],
  };
  const follower = decode(FollowerId)("follower-1");
  const plan = Effect.runSync(planSynchronization({
    revision,
    follower,
    observedState: {
      platform: "linux",
      resources: [{
        resource: resource.id,
        observed: observedDigest === undefined
          ? { state: "absent" }
          : {
            state: "present",
            digest: decode(ContentDigest)(observedDigest),
            executable: false,
          },
      }],
      availableBlobs: [],
    },
    localOverlay: [],
    appliedResources: [],
  }));
  const artifact = { digest, content };
  return {
    root,
    database: join(root, "state.sqlite"),
    target,
    revision,
    artifact,
    input: {
      id: decode(RunId)(run),
      plan,
      revision,
      artifacts: [artifact],
    },
  };
};

const mirrorContext = (
  root: string,
  target: string,
  relative: string,
  content: string,
): ResourceExecutionContext => {
  const bytes = new TextEncoder().encode(content);
  const digest = decode(ContentDigest)(sha256BytesHex(bytes));
  const resource = decode(ResourceId)("managed-directory");
  return {
    run: decode(RunId)("run-mirror"),
    action: {
      id: decode(ActionId)("action:managed-directory:0:mirror"),
      resource,
      kind: "mirror-directory",
      detail: {
        kind: "mirror-directory",
        target,
        adds: [relative],
        removes: [],
      },
      before: [],
    },
    resource: {
      id: resource,
      kind: "directory",
      policy: "mirror-owned",
      target,
      dependsOn: [],
      blobs: [],
    },
    desired: {
      kind: "directory",
      files: [{ path: relative, digest, executable: false }],
    },
    verification: { method: "digest", digest },
    artifacts: new Map([[digest, { digest, content: bytes }]]),
    limits: defaultSynchronizationExecutionLimits,
  };
};

const follower = decode(FollowerIdentity)({
  id: "follower-1",
  name: "Follower",
  groups: [],
  revoked: false,
  credentialReference: "secure-store://follower",
  enrolledAt: "2026-08-15T00:00:00Z",
});

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

const applicationLayer = (
  fixture: Fixture,
  machine = machineLayer(fixture.root),
) =>
  SynchronizationLive.pipe(
    Layer.provideMerge(stateRepositoryLayer(fixture.database)),
    Layer.provideMerge(machine),
  );

const seedAndRun = (
  fixture: Fixture,
  machine = machineLayer(fixture.root),
): Promise<SynchronizationOutcome> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const repository = yield* StateRepository;
      yield* repository.registerFollower({ follower });
      yield* repository.publishRevision({ revision: fixture.revision });
      const synchronization = yield* Synchronization;
      return yield* synchronization.run(fixture.input);
    }).pipe(
      Effect.provide(applicationLayer(fixture, machine)),
    ),
  );

const actionRows = (databasePath: string) => {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const rows = database.prepare(`
    SELECT state, verification_json, rollback_reference
    FROM action_journal
    ORDER BY sequence
  `).all();
  database.close();
  return rows;
};

const decorateMachine = (
  root: string,
  transform: (service: MachineState["Service"]) => MachineState["Service"],
) =>
  Layer.effect(
    MachineState,
    Effect.map(MachineState, transform),
  ).pipe(Layer.provide(machineLayer(root)));

const reencodePlan = (
  plan: SynchronizationRunInput["plan"],
): SynchronizationRunInput["plan"] => {
  const encoded = canonicalJson(Schema.decodeUnknownSync(Schema.MutableJson)(
    JSON.parse(JSON.stringify({
      revision: plan.revision,
      follower: plan.follower,
      requiredBlobs: plan.requiredBlobs,
      actions: plan.actions,
      agentTasks: plan.agentTasks,
    })),
  ));
  return { ...plan, encoded, digest: sha256Hex(encoded) };
};

const installerInvocation = async (
  method: string,
  packageName: string,
  version?: string | undefined,
) => {
  const root = temporaryDirectory();
  const executableQueries: Array<string> = [];
  const invocations: Array<{ readonly executable: string; readonly arguments: ReadonlyArray<string> }> = [];
  const machine = decorateMachine(root, (service) => ({
    ...service,
    findExecutable: ({ name }) => {
      executableQueries.push(name);
      return Effect.succeed({
        name,
        path: { platform: "linux", absolute: join(root, "bin", name) },
      });
    },
    runProcess: (input) => {
      invocations.push({
        executable: input.executable.absolute,
        arguments: input.arguments,
      });
      return Effect.succeed({
        exitCode: 0,
        signal: null,
        standardOutput: new Uint8Array(),
        standardError: new Uint8Array(),
      });
    },
  }));
  const resourceId = decode(ResourceId)("tool");
  const detail = version === undefined
    ? {
      kind: "install-tool" as const,
      toolId: "tool",
      method,
      package: packageName,
    }
    : {
      kind: "install-tool" as const,
      toolId: "tool",
      method,
      package: packageName,
      version,
    };
  const context: ResourceExecutionContext = {
    run: decode(RunId)(`run-${method}`),
    action: {
      id: decode(ActionId)(`action:tool:0:install-${method}`),
      resource: resourceId,
      kind: "install-tool",
      detail,
      before: [],
    },
    resource: {
      id: resourceId,
      kind: "tool",
      policy: "ensure",
      target: "tool",
      dependsOn: [],
      blobs: [],
    },
    desired: {
      kind: "tool",
      toolId: "tool",
      recipes: [],
      loginRequired: false,
    },
    verification: { method: "executable-present", executable: "tool" },
    artifacts: new Map(),
    limits: defaultSynchronizationExecutionLimits,
  };
  await Effect.runPromise(
    Effect.gen(function*() {
      const prepared = yield* prepareResourceAction(context);
      yield* prepared.execute;
    }).pipe(Effect.provide(machine)),
  );
  return { executableQueries, invocations };
};

describe("synchronization apply run", () => {
  it("does not follow an intermediate mirror symlink outside the managed root", async () => {
    const root = temporaryDirectory();
    const managed = join(root, "managed");
    const outside = join(root, "outside");
    const outsideFile = join(outside, "settings.json");
    mkdirSync(managed, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(outsideFile, "outside content");
    symlinkSync(outside, join(managed, "sub"));
    const context = mirrorContext(
      root,
      managed,
      "sub/settings.json",
      "managed content",
    );

    const prepared = await Effect.runPromise(
      prepareResourceAction(context).pipe(Effect.provide(machineLayer(root))),
    );
    await expect(
      Effect.runPromise(prepared.execute.pipe(Effect.provide(machineLayer(root)))),
    ).rejects.toMatchObject({
      _tag: "MachineFilesystemError",
      operation: "mutate managed path",
    });
    expect(await readFile(outsideFile, "utf8")).toBe("outside content");
  });

  it("writes nested mirror files in-root and replaces only a final symlink", async () => {
    const root = temporaryDirectory();
    const managed = join(root, "managed");
    const outside = join(root, "outside.txt");
    const target = join(managed, "nested", "settings.json");
    mkdirSync(join(managed, "nested"), { recursive: true });
    writeFileSync(outside, "outside content");
    symlinkSync(outside, target);
    const context = mirrorContext(
      root,
      managed,
      "nested/settings.json",
      "managed content",
    );

    const prepared = await Effect.runPromise(
      prepareResourceAction(context).pipe(Effect.provide(machineLayer(root))),
    );
    await Effect.runPromise(
      prepared.execute.pipe(Effect.provide(machineLayer(root))),
    );

    expect(await readFile(target, "utf8")).toBe("managed content");
    expect(await readFile(outside, "utf8")).toBe("outside content");
  });

  it("keeps outside paths untouched when an ancestor is swapped during a mirror write", async () => {
    const root = temporaryDirectory();
    const managed = join(root, "managed");
    const nested = join(managed, "nested");
    const displaced = join(managed, "displaced");
    const outside = join(root, "outside");
    const outsideFile = join(outside, "settings.json");
    mkdirSync(nested, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(outsideFile, "outside content");
    const context = mirrorContext(
      root,
      managed,
      "nested/settings.json",
      "managed content",
    );
    const prepared = await Effect.runPromise(
      prepareResourceAction(context).pipe(Effect.provide(machineLayer(root))),
    );
    const adversarialLayer = linuxMachineStateLayer({
      environment: [
        { name: "HOME", value: join(root, "home") },
        { name: "PATH", value: join(root, "bin") },
      ],
      credentialPolicy: {
        kind: "local-file",
        path: join(root, "credentials"),
      },
      beforeSafeRootMutation: async () => {
        renameSync(nested, displaced);
        symlinkSync(outside, nested);
      },
    });

    await expect(
      Effect.runPromise(prepared.execute.pipe(Effect.provide(adversarialLayer))),
    ).rejects.toMatchObject({
      _tag: "MachineFilesystemError",
      operation: "mutate managed path",
    });
    expect(await readFile(outsideFile, "utf8")).toBe("outside content");
  });

  it("keeps outside paths untouched when an ancestor is swapped during a mirror removal", async () => {
    const root = temporaryDirectory();
    const managed = join(root, "managed");
    const nested = join(managed, "nested");
    const displaced = join(managed, "displaced");
    const outside = join(root, "outside");
    const outsideFile = join(outside, "settings.json");
    mkdirSync(nested, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(nested, "settings.json"), "managed content");
    writeFileSync(outsideFile, "outside content");
    const base = mirrorContext(
      root,
      managed,
      "nested/settings.json",
      "managed content",
    );
    const context: ResourceExecutionContext = {
      ...base,
      action: {
        ...base.action,
        detail: {
          kind: "mirror-directory",
          target: managed,
          adds: [],
          removes: ["nested/settings.json"],
        },
      },
      desired: { kind: "directory", files: [] },
    };
    const prepared = await Effect.runPromise(
      prepareResourceAction(context).pipe(Effect.provide(machineLayer(root))),
    );
    const adversarialLayer = linuxMachineStateLayer({
      environment: [
        { name: "HOME", value: join(root, "home") },
        { name: "PATH", value: join(root, "bin") },
      ],
      credentialPolicy: {
        kind: "local-file",
        path: join(root, "credentials"),
      },
      beforeSafeRootMutation: async () => {
        renameSync(nested, displaced);
        symlinkSync(outside, nested);
      },
    });

    await expect(
      Effect.runPromise(prepared.execute.pipe(Effect.provide(adversarialLayer))),
    ).rejects.toMatchObject({
      _tag: "MachineFilesystemError",
      operation: "mutate managed path",
    });
    expect(await readFile(outsideFile, "utf8")).toBe("outside content");
  });

  it("keeps outside paths untouched when an ancestor is swapped during mirror rollback", async () => {
    const root = temporaryDirectory();
    const managed = join(root, "managed");
    const nested = join(managed, "nested");
    const displaced = join(managed, "displaced");
    const target = join(nested, "settings.json");
    const outside = join(root, "outside");
    const outsideFile = join(outside, "settings.json");
    mkdirSync(nested, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(target, "original content");
    writeFileSync(outsideFile, "outside content");
    const context = mirrorContext(
      root,
      managed,
      "nested/settings.json",
      "managed content",
    );
    const prepared = await Effect.runPromise(
      prepareResourceAction(context).pipe(Effect.provide(machineLayer(root))),
    );
    await Effect.runPromise(
      prepared.execute.pipe(Effect.provide(machineLayer(root))),
    );
    const adversarialLayer = linuxMachineStateLayer({
      environment: [
        { name: "HOME", value: join(root, "home") },
        { name: "PATH", value: join(root, "bin") },
      ],
      credentialPolicy: {
        kind: "local-file",
        path: join(root, "credentials"),
      },
      beforeSafeRootMutation: async () => {
        renameSync(nested, displaced);
        symlinkSync(outside, nested);
      },
    });

    await expect(
      Effect.runPromise(prepared.rollback!.pipe(Effect.provide(adversarialLayer))),
    ).rejects.toMatchObject({
      _tag: "MachineFilesystemError",
      operation: "mutate managed path",
    });
    expect(await readFile(outsideFile, "utf8")).toBe("outside content");
  });

  it("persists, atomically applies, verifies, and journals a successful plan", async () => {
    const fixture = fileFixture(temporaryDirectory());
    const outcome = await seedAndRun(fixture);

    expect(outcome).toEqual({
      outcome: "Converged",
      run: "run-1",
      verified: ["settings"],
    });
    expect(await readFile(fixture.target, "utf8")).toBe("canonical content");
    expect(actionRows(fixture.database).map((row) => row.state)).toEqual([
      "pending",
      "running",
      "succeeded",
    ]);
    expect(String(actionRows(fixture.database)[2]?.verification_json)).toContain(
      "\"status\":\"passed\"",
    );
  });

  it("verifies a no-op without rewriting the target", async () => {
    const root = temporaryDirectory();
    const first = fileFixture(root);
    mkdirSync(dirname(first.target), { recursive: true });
    writeFileSync(first.target, first.artifact.content);
    const fixture = fileFixture(root, "run-no-op", first.artifact.digest);

    const outcome = await seedAndRun(fixture);
    expect(outcome.outcome).toBe("Converged");
    expect(actionRows(fixture.database).map((row) => row.state)).toEqual([
      "pending",
      "running",
      "succeeded",
    ]);
    expect(actionRows(fixture.database)[2]?.rollback_reference).toBeNull();
  });

  it("applies and verifies executable file intent", async () => {
    const base = fileFixture(temporaryDirectory(), "run-executable");
    const resource = base.revision.resources[0]!;
    const desired: DesiredResource = {
      kind: "file",
      digest: base.artifact.digest,
      executable: true,
    };
    const revision: PlanningProfileRevision = {
      ...base.revision,
      desired: [{
        resource: resource.id,
        desired,
        verification: {
          method: "digest",
          digest: base.artifact.digest,
        },
      }],
    };
    const plan = Effect.runSync(planSynchronization({
      revision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [{ resource: resource.id, observed: { state: "absent" } }],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: [],
    }));
    const outcome = await seedAndRun({
      ...base,
      revision,
      input: { ...base.input, plan, revision },
    });

    expect(outcome.outcome).toBe("Converged");
    expect(statSync(base.target).mode & 0o100).toBe(0o100);
  });

  it("applies and verifies symlink file intent", async () => {
    const base = fileFixture(temporaryDirectory(), "run-symlink");
    const destination = join(base.root, "home", "destination.txt");
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, "destination");
    const resource = base.revision.resources[0]!;
    const digest = decode(ContentDigest)(sha256Hex(destination));
    const desired: DesiredResource = {
      kind: "file",
      digest,
      executable: false,
      symlinkTo: destination,
    };
    const revision: PlanningProfileRevision = {
      ...base.revision,
      desired: [{
        resource: resource.id,
        desired,
        verification: { method: "symlink", target: destination },
      }],
    };
    const plan = Effect.runSync(planSynchronization({
      revision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [{ resource: resource.id, observed: { state: "absent" } }],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: [],
    }));
    const outcome = await seedAndRun({
      ...base,
      revision,
      input: { ...base.input, plan, revision, artifacts: [] },
    });

    expect(outcome.outcome).toBe("Converged");
    expect(readlinkSync(base.target)).toBe(destination);
  });

  it("runs the declared verification command instead of the tool id", async () => {
    const base = fileFixture(temporaryDirectory(), "run-declared-verification");
    const tool: PublishedResource = {
      id: decode(ResourceId)("declared-tool"),
      kind: "tool",
      policy: "ensure",
      target: "declared-tool",
      dependsOn: [],
      blobs: [],
    };
    const desired: DesiredResource = {
      kind: "tool",
      toolId: "package-identity-not-an-executable",
      recipes: [],
      loginRequired: false,
    };
    const revision: PlanningProfileRevision = {
      ...base.revision,
      resources: [tool],
      desired: [{
        resource: tool.id,
        desired,
        verification: {
          method: "command",
          command: [
            process.execPath,
            "-e",
            "process.stdout.write('declared-verification')",
          ],
          expectContains: "declared-verification",
        },
      }],
    };
    const plan = Effect.runSync(planSynchronization({
      revision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [{
          resource: tool.id,
          observed: {
            state: "present",
            digest: decode(ContentDigest)(sha256Hex(process.execPath)),
            executable: true,
          },
        }],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: [],
    }));
    const outcome = await seedAndRun({
      ...base,
      revision,
      input: { ...base.input, plan, revision, artifacts: [] },
    });

    expect(outcome.outcome).toBe("Converged");
  });

  it.each([
    ["json", "{\n  \"local\": true\n}\n"],
    ["toml", "local = true\n"],
    ["yaml", "local: true\n"],
  ] as const)("merges dotted config keys with the declared %s codec", async (
    format,
    current,
  ) => {
    const base = fileFixture(temporaryDirectory(), `run-config-${format}`);
    mkdirSync(dirname(base.target), { recursive: true });
    writeFileSync(base.target, current);
    const desiredDocument = {};
    setConfigPath(desiredDocument, "agent.model", "review-model");
    const desiredBytes = new TextEncoder().encode(
      serializeConfigDocument(format, desiredDocument),
    );
    const digest = sha256BytesHex(desiredBytes);
    const resource: PublishedResource = {
      ...base.revision.resources[0]!,
      kind: "config",
      policy: "merge",
    };
    const desired: DesiredResource = {
      kind: "config",
      digest,
      format,
      keys: ["agent.model"],
    };
    const revision: PlanningProfileRevision = {
      ...base.revision,
      resources: [resource],
      desired: [{
        resource: resource.id,
        desired,
        verification: { method: "digest", digest },
      }],
    };
    const plan = Effect.runSync(planSynchronization({
      revision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [{
          resource: resource.id,
          observed: {
            state: "present",
            digest: sha256BytesHex(new TextEncoder().encode(current)),
            executable: false,
          },
        }],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: [],
    }));
    const artifact = { digest, content: desiredBytes };
    const outcome = await seedAndRun({
      ...base,
      revision,
      artifact,
      input: { ...base.input, plan, revision, artifacts: [artifact] },
    });
    const document = parseConfigDocument(
      format,
      await readFile(base.target, "utf8"),
    );

    expect(outcome.outcome).toBe("Converged");
    expect(getConfigPath(document, "local")).toBe(true);
    expect(getConfigPath(document, "agent.model")).toBe("review-model");
  });

  it("returns Failed and restores owned content when verification fails", async () => {
    const fixture = fileFixture(temporaryDirectory(), "run-verification");
    mkdirSync(dirname(fixture.target), { recursive: true });
    await writeFile(fixture.target, "original");
    const wrongDigest = decode(ContentDigest)("f".repeat(64));
    const machine = decorateMachine(fixture.root, (service) => ({
      ...service,
      digestFile: (input) =>
        input.path.absolute === fixture.target
          ? Effect.succeed({ algorithm: "sha256", value: wrongDigest })
          : service.digestFile(input),
    }));

    const outcome = await seedAndRun(fixture, machine);
    expect(outcome.outcome).toBe("Failed");
    expect(await readFile(fixture.target, "utf8")).toBe("original");
    expect(actionRows(fixture.database)[2]?.rollback_reference).toContain(
      "canonfig/rollback",
    );
  });

  it("returns Failed and rolls back an owned-file action failure", async () => {
    const fixture = fileFixture(temporaryDirectory(), "run-action-failure");
    mkdirSync(dirname(fixture.target), { recursive: true });
    await writeFile(fixture.target, "original");
    let targetWrites = 0;
    const machine = decorateMachine(fixture.root, (service) => ({
      ...service,
      atomicWrite: (input) => {
        if (input.path.absolute !== fixture.target) return service.atomicWrite(input);
        targetWrites += 1;
        return targetWrites === 1
          ? Effect.fail({
            _tag: "MachineFilesystemError",
            operation: "test write",
            path: input.path.absolute,
            message: "injected failure",
          })
          : service.atomicWrite(input);
      },
    }));

    const outcome = await seedAndRun(fixture, machine);
    expect(outcome.outcome).toBe("Failed");
    expect(await readFile(fixture.target, "utf8")).toBe("original");
  });

  it("records Interrupted when cancellation reaches an in-flight mutation", async () => {
    const fixture = fileFixture(temporaryDirectory(), "run-cancelled");
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolveStarted) => {
      notifyStarted = resolveStarted;
    });
    const machine = decorateMachine(fixture.root, (service) => ({
      ...service,
      atomicWrite: (input) => {
        if (input.path.absolute !== fixture.target) return service.atomicWrite(input);
        notifyStarted?.();
        return Effect.never;
      },
    }));
    const layer = applicationLayer(fixture, machine);
    const program = Effect.gen(function*() {
      const repository = yield* StateRepository;
      yield* repository.registerFollower({ follower });
      yield* repository.publishRevision({ revision: fixture.revision });
      const synchronization = yield* Synchronization;
      return yield* synchronization.run(fixture.input);
    }).pipe(Effect.provide(layer));
    const fiber = Effect.runFork(program);
    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));

    const database = new DatabaseSync(fixture.database, { readOnly: true });
    const row = database.prepare(
      "SELECT status FROM synchronization_runs WHERE id = ?",
    ).get("run-cancelled");
    database.close();
    expect(row?.status).toBe("Interrupted");
  });

  it("serializes mutations that share a target", async () => {
    const fixture = fileFixture(temporaryDirectory(), "run-serialized");
    const firstAction = fixture.input.plan.actions[0]!;
    const secondAction = {
      ...firstAction,
      id: decode(ActionId)("action:settings:second:write-file"),
      before: [firstAction.id],
    };
    const serializedFixture: Fixture = {
      ...fixture,
      input: {
        ...fixture.input,
        plan: reencodePlan({
          ...fixture.input.plan,
          actions: [firstAction, secondAction],
        }),
      },
    };
    let active = 0;
    let maximum = 0;
    const machine = decorateMachine(fixture.root, (service) => ({
      ...service,
      atomicWrite: (input) =>
        Effect.gen(function*() {
          active += 1;
          maximum = Math.max(maximum, active);
          yield* service.atomicWrite(input);
          active -= 1;
        }),
    }));
    await seedAndRun(serializedFixture, machine);
    expect(maximum).toBe(1);
  });

  it("orders running and terminal journal records around execution", async () => {
    const fixture = fileFixture(temporaryDirectory(), "run-journal");
    await seedAndRun(fixture);
    const rows = actionRows(fixture.database);
    expect(rows.map((row) => row.state)).toEqual([
      "pending",
      "running",
      "succeeded",
    ]);
    expect(rows[1]?.verification_json).toBeNull();
    expect(rows[2]?.verification_json).not.toBeNull();
  });

  it("retains rollback material for owned files", async () => {
    const fixture = fileFixture(temporaryDirectory(), "run-rollback-material");
    mkdirSync(dirname(fixture.target), { recursive: true });
    await writeFile(fixture.target, "previous");
    const previousMode = statSync(fixture.target).mode & 0o7777;
    await seedAndRun(fixture);

    const reference = actionRows(fixture.database)[2]?.rollback_reference;
    expect(reference).toBeTypeOf("string");
    expect(JSON.parse(await readFile(String(reference), "utf8"))).toEqual([{
      path: fixture.target,
      state: "regular",
      content: Buffer.from("previous").toString("base64"),
      mode: previousMode,
    }]);
  });

  it("snapshots absent, executable, and symlink states", async () => {
    const absent = fileFixture(temporaryDirectory(), "run-rollback-absent");
    const executable = fileFixture(temporaryDirectory(), "run-rollback-executable");
    mkdirSync(dirname(executable.target), { recursive: true });
    writeFileSync(executable.target, "script");
    chmodSync(executable.target, 0o700);
    const symlink = fileFixture(temporaryDirectory(), "run-rollback-symlink");
    const symlinkTarget = join(symlink.root, "original-target");
    mkdirSync(dirname(symlink.target), { recursive: true });
    writeFileSync(symlinkTarget, "target");
    symlinkSync(symlinkTarget, symlink.target);

    for (const [value, expected] of [
      [absent, { path: absent.target, state: "absent" }],
      [executable, {
        path: executable.target,
        state: "regular",
        content: Buffer.from("script").toString("base64"),
        mode: 0o700,
      }],
      [symlink, {
        path: symlink.target,
        state: "symlink",
        target: symlinkTarget,
      }],
    ] as const) {
      await seedAndRun(value);
      const reference = actionRows(value.database)[2]?.rollback_reference;
      expect(reference).toBeTypeOf("string");
      expect(JSON.parse(await readFile(String(reference), "utf8"))).toEqual([expected]);
    }
  });

  it.each([
    ["npm", "npm", "@example/tool", "1.2.3", [
      "install",
      "--global",
      "@example/tool@1.2.3",
      "--ignore-scripts",
    ]],
    ["homebrew", "brew", "tool", "1.2.3", ["install", "tool@1.2.3"]],
    ["winget", "winget", "Example.Tool", "1.2.3", [
      "install",
      "--id",
      "Example.Tool",
      "--version",
      "1.2.3",
      "--exact",
      "--silent",
    ]],
    ["uv", "uv", "tool", "1.2.3", [
      "tool",
      "install",
      "tool==1.2.3",
      "--only-binary=:all:",
    ]],
    ["cargo", "cargo", "tool", "1.2.3", [
      "install",
      "tool",
      "--version",
      "1.2.3",
      "--locked",
    ]],
    ["apt", "apt-get", "tool", "1.2.3", ["install", "-y", "tool=1.2.3"]],
  ] as const)(
    "executes versioned %s recipes with ecosystem-specific arguments",
    async (method, executable, packageName, version, arguments_) => {
      const result = await installerInvocation(method, packageName, version);

      expect(result.executableQueries).toEqual([executable]);
      expect(result.invocations).toEqual([{
        executable: expect.stringMatching(new RegExp(`/${executable}$`, "u")),
        arguments: arguments_,
      }]);
    },
  );

  it.each([
    ["npm", "npm", ["install", "--global", "tool", "--ignore-scripts"]],
    ["homebrew", "brew", ["install", "tool"]],
    ["winget", "winget", ["install", "--id", "tool", "--silent"]],
    ["uv", "uv", ["tool", "install", "tool", "--only-binary=:all:"]],
    ["cargo", "cargo", ["install", "tool"]],
    ["apt", "apt-get", ["install", "-y", "tool"]],
    ["source", "source", ["install", "tool"]],
  ] as const)(
    "preserves unversioned %s installer behavior",
    async (method, executable, arguments_) => {
      const result = await installerInvocation(method, "tool");

      expect(result.executableQueries).toEqual([executable]);
      expect(result.invocations[0]?.arguments).toEqual(arguments_);
    },
  );

  it("fails closed when an installer cannot honor a requested version", async () => {
    await expect(installerInvocation(
      "source",
      "https://github.com/example/tool",
      "v1.2.3",
    )).rejects.toMatchObject({
      _tag: "InvalidExecutionPlanError",
      message: "installer source cannot honor requested version v1.2.3",
    });
  });

  it("never claims rollback for external installer actions", async () => {
    const root = temporaryDirectory();
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const installer = join(bin, "apt-get");
    writeFileSync(installer, "#!/bin/sh\nexit 9\n");
    chmodSync(installer, 0o755);
    const base = fileFixture(root, "run-installer");
    const tool: PublishedResource = {
      id: decode(ResourceId)("tool"),
      kind: "tool",
      policy: "ensure",
      target: "ripgrep",
      dependsOn: [],
      blobs: [],
    };
    const desired: DesiredResource = {
      kind: "tool",
      toolId: "rg",
      recipes: [{ platform: "linux", method: "apt", package: "ripgrep" }],
      loginRequired: false,
    };
    const revision: PlanningProfileRevision = {
      ...base.revision,
      resources: [tool],
      desired: [{
        resource: tool.id,
        desired,
        verification: {
          method: "executable-present",
          executable: "rg",
        },
      }],
    };
    const plan = Effect.runSync(planSynchronization({
      revision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [{ resource: tool.id, observed: { state: "absent" } }],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: [],
    }));
    const fixture: Fixture = {
      ...base,
      revision,
      input: {
        id: decode(RunId)("run-installer"),
        plan,
        revision,
        artifacts: [],
      },
    };

    const outcome = await seedAndRun(fixture);
    expect(outcome.outcome).toBe("Failed");
    expect(actionRows(fixture.database)[2]?.rollback_reference).toBeNull();
  });
});
