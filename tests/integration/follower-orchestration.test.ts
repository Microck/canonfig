import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Fiber, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { AgentResolutionLive } from "../../src/agent/agent-resolution.layer.ts";
import { AgentResolution } from "../../src/agent/agent-resolution.service.ts";
import { DeniedAgentCapabilityError } from "../../src/agent/agent-resolution.errors.ts";
import {
  ActionId,
  AgentTaskId,
  GroupName,
  ProfileId,
  ProfileRevisionId,
  ResourceId,
  RunId,
  SourceSignature,
} from "../../src/domain/brand.ts";
import type { ProfileRevision } from "../../src/domain/profile.ts";
import type { ConfigValue } from "../../src/domain/resource.ts";
import { EnrollmentLive } from "../../src/enrollment/enrollment.layer.ts";
import { Enrollment } from "../../src/enrollment/enrollment.service.ts";
import { enrollFollower } from "../../src/enrollment/follower-client.ts";
import { startSourceServer } from "../../src/enrollment/source-server.ts";
import type { FollowerEnrollment, SourceServerHandle } from "../../src/enrollment/enrollment.types.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import type { RenderedSchedulerJob, SchedulerBackend } from "../../src/machine/machine-state.types.ts";
import { adapterFor } from "../../src/projection/adapters/index.ts";
import type { TargetId } from "../../src/projection/model.ts";
import { canonicalJson, sha256Hex } from "../../src/profile/profile-codec.ts";
import { makePublication, type ProfileRevisionSigner } from "../../src/profile/publication.ts";
import { scheduleManagerLayer } from "../../src/schedule/schedule-manager.layer.ts";
import { ScheduleManager } from "../../src/schedule/schedule-manager.service.ts";
import { SyncScheduleSchema, type SyncSchedule } from "../../src/schedule/schedule-manager.types.ts";
import { stateRepositoryLayer } from "../../src/state/state-repository.layer.ts";
import { StateRepository } from "../../src/state/state-repository.service.ts";
import {
  defaultScheduledInvocation,
  FollowerSynchronizationConfiguration,
} from "../../src/synchronization/follower-sync-config.ts";
import {
  abandonFollowerRun,
  recoverFollower,
  resolveAgentTasks,
  synchronizeFollower,
} from "../../src/synchronization/follower-orchestration.ts";
import { parseConfigDocument } from "../../src/synchronization/config-codec.ts";
import { SynchronizationLive } from "../../src/synchronization/synchronization.layer.ts";

/**
 * Follower orchestration in process: a Source publishes a real
 * `~/.canonfig/` through the real publication path, signed with its enrolled
 * key, and serves it over loopback HTTPS; each follower enrolls against that
 * server and syncs with its state at `<home>/.canonfig/state.sqlite`, so the
 * mirror lands in its own `~/.canonfig/`. Nothing is mocked; schedulers are
 * in-memory backends behind the real ScheduleManager, or a fixture service.
 */

const decode = Schema.decodeUnknownSync;
const roots: Array<string> = [];
const servers: Array<SourceServerHandle> = [];
const runtimes: Array<{ readonly dispose: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const temporaryRoot = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), `canonfig-orchestration-${name}-`));
  roots.push(root);
  return root;
};

const write = (path: string, content: string, mode?: number) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
};

const read = (path: string) => readFileSync(path, "utf8");

const profileId = decode(ProfileId)("workstation");

/** The Source's canonfig.jsonc: the one profile and Claude Code, plus `config`. */
const writeConfig = (folder: string, config: Readonly<Record<string, ConfigValue>> = {}) =>
  write(join(folder, "canonfig.jsonc"), `// The Source's folder\n${JSON.stringify({
    version: 1,
    profile: { id: profileId, name: "Workstation" },
    harnesses: ["claude-code"],
    ...config,
  }, undefined, 2)}\n`);

/** Author a Source folder: canonfig.jsonc plus `files`, relative to the folder. */
const authorFolder = (
  folder: string,
  config: Readonly<Record<string, ConfigValue>> = {},
  files: Readonly<Record<string, string>> = {},
) => {
  writeConfig(folder, config);
  for (const [path, content] of Object.entries(files)) write(join(folder, path), content);
};

/**
 * One machine under `root`: HOME at `root/home` and a PATH of `root/bin`
 * plus `path`, so nothing installed on the host running the tests is seen.
 */
const machineLayer = (
  root: string,
  options: { readonly path?: ReadonlyArray<string>; readonly schedulerBackend?: SchedulerBackend } = {},
) =>
  linuxMachineStateLayer({
    environment: [
      { name: "HOME", value: join(root, "home") },
      { name: "PATH", value: [join(root, "bin"), ...options.path ?? []].join(":") },
    ],
    credentialPolicy: { kind: "local-file", path: join(root, "credentials") },
    schedulerBackend: options.schedulerBackend,
  });

interface SourceMachine {
  /** The Source's `~/.canonfig/`. */
  readonly folder: string;
  readonly server: SourceServerHandle;
  /** Run an effect against the Source's enrollment, machine and state. */
  readonly run: <Value, Error>(effect: Effect.Effect<Value, Error, Enrollment | MachineState | StateRepository>) => Promise<Value>;
  /** `canonfig source publish`: compile and sign the folder as it is now. */
  readonly publish: () => Promise<ProfileRevision>;
}

/** A Source under `root/source` with `author`'s folder published once and served. */
const startSource = async (root: string, author: (folder: string) => void): Promise<SourceMachine> => {
  const folder = join(root, "source", "home", ".canonfig");
  author(folder);
  const layer = EnrollmentLive.pipe(
    Layer.provideMerge(stateRepositoryLayer(join(folder, "state.sqlite"))),
    Layer.provideMerge(machineLayer(join(root, "source"))),
  );
  const runtime = ManagedRuntime.make(layer);
  runtimes.push(runtime);
  const run: SourceMachine["run"] = (effect) => runtime.runPromise(effect);
  const source = await run(Effect.flatMap(Enrollment, (enrollment) => enrollment.initializeSource()));
  // The signer `source publish` builds from the Source's enrolled signing key.
  const privateKey = createPrivateKey(Redacted.value(
    await run(Effect.flatMap(MachineState, (machine) => machine.loadCredential({ reference: source.signingKeyReference }))),
  ));
  const publicKey = createPublicKey(privateKey);
  const signer: ProfileRevisionSigner = {
    keyId: source.source.keyId,
    sign: (payload) => Effect.sync(() =>
      decode(SourceSignature)(`ed25519:${sign(null, Buffer.from(payload), privateKey).toString("base64url")}`)
    ),
    verify: (payload, signature) => Effect.sync(() =>
      verify(null, Buffer.from(payload), publicKey, Buffer.from(signature.slice("ed25519:".length), "base64url"))
    ),
  };
  let minute = 0;
  const publish = () => {
    minute += 1;
    return run(Effect.flatMap(StateRepository, (repository) =>
      makePublication(signer, repository).publish({
        folder,
        reviewer: "reviewer@example.test",
        publishedAt: `2026-11-03T00:${String(minute).padStart(2, "0")}:00Z`,
      })
    ));
  };
  await publish();
  const server = await runtime.runPromise(startSourceServer().pipe(Effect.provide(layer)));
  servers.push(server);
  return { folder, server, run, publish };
};

type MachineLayer = Layer.Layer<MachineState>;

interface FollowerOptions {
  readonly name: string;
  readonly groups?: ReadonlyArray<string>;
  /** Harnesses with a fake executable on the follower PATH. */
  readonly harnesses?: ReadonlyArray<TargetId>;
  /** More PATH entries after the follower's own `bin`. */
  readonly path?: ReadonlyArray<string>;
  readonly schedulerBackend?: SchedulerBackend;
  /** The ScheduleManager a sync reconciles through; none skips schedule reconciliation. */
  readonly schedules?: (machine: MachineLayer) => Layer.Layer<ScheduleManager>;
  /** Follower-owned settings saved with the enrollment configuration. */
  readonly configuration?: Partial<FollowerSynchronizationConfiguration>;
}

/**
 * Enroll a follower under `root/<name>` against `source`'s server, then save
 * the configuration `follower enroll` records: the Source's one profile, the
 * state at `~/.canonfig/state.sqlite` and the cache beside it.
 */
const enroll = async (root: string, source: SourceMachine, options: FollowerOptions) => {
  const machineRoot = join(root, options.name.toLowerCase().replaceAll(" ", "-"));
  const home = join(machineRoot, "home");
  const bin = join(machineRoot, "bin");
  const folder = join(home, ".canonfig");
  const state = join(folder, "state.sqlite");
  // An empty folder authors nothing; enrolling refuses one that does.
  mkdirSync(folder, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const harness of options.harnesses ?? []) {
    write(join(bin, adapterFor(harness).descriptor.executables[0]!), "#!/bin/sh\nexit 0\n", 0o755);
  }
  const machine = machineLayer(machineRoot, { path: options.path, schedulerBackend: options.schedulerBackend });
  const invitation = await source.run(Effect.flatMap(Enrollment, (enrollment) => enrollment.createInvitation({
    endpoint: source.server.endpoint,
    expiresInMilliseconds: 60_000,
    groups: options.groups?.map((group) => decode(GroupName)(group)),
  })));
  const enrolled: FollowerEnrollment = await Effect.runPromise(
    enrollFollower({ invitation, followerName: options.name }).pipe(Effect.provide(machine)),
  );
  const repository = stateRepositoryLayer(state);
  const withRepository = <Value, Error>(effect: Effect.Effect<Value, Error, StateRepository>) =>
    Effect.runPromise(effect.pipe(Effect.provide(repository)));
  const follower = { ...enrolled.follower, credentialReference: enrolled.credentialReference };
  const configuration: FollowerSynchronizationConfiguration = {
    schemaVersion: 1,
    follower,
    profile: profileId,
    source: {
      endpoint: source.server.endpoint,
      tlsFingerprint: enrolled.tlsFingerprint,
      signingFingerprint: enrolled.source.publicKeyFingerprint,
    },
    credentialReference: enrolled.credentialReference,
    cacheDirectory: join(folder, "cache"),
    stateLocation: state,
    agentPolicy: "deterministic-only",
    scheduledInvocation: defaultScheduledInvocation,
    updatedAt: "2026-11-03T00:00:00Z",
    ...options.configuration,
  };
  /** Save the enrolled configuration with `overrides` (an undefined field is cleared). */
  const configure = (overrides: Partial<FollowerSynchronizationConfiguration> = {}) =>
    withRepository(Effect.flatMap(StateRepository, (stored) => stored.saveFollowerSynchronizationConfiguration({
      sourceIdentity: enrolled.source,
      configuration: { ...configuration, ...overrides },
    })));
  await configure();
  const application = Layer.mergeAll(
    repository,
    machine,
    AgentResolutionLive,
    SynchronizationLive.pipe(Layer.provide(Layer.merge(repository, machine))),
  );
  const schedules = options.schedules?.(machine);
  const sync = (mode: "plan" | "apply") => {
    const synchronized = synchronizeFollower(state, mode, { environment: () => undefined, noBackup: false });
    return Effect.runPromise(schedules === undefined
      ? synchronized.pipe(Effect.provide(application))
      : synchronized.pipe(Effect.provide(Layer.merge(application, schedules))));
  };
  // Only a plan-mode run carries `plan`.
  const plan = async () => {
    const planned = await sync("plan");
    if (!("plan" in planned)) throw new Error("sync --plan returned no plan");
    return planned;
  };
  return {
    home, bin, folder, state, machine, application, schedules, enrolled, follower,
    configure, withRepository, plan, apply: () => sync("apply"),
  };
};

/** The plan's action kinds for one resource. */
const kindsOf = (plan: { readonly actions: ReadonlyArray<{ readonly resource: string; readonly kind: string }> }, resource: string) =>
  plan.actions.filter((action) => action.resource === resource).map((action) => action.kind);

/** Parse a mirror or projected JSON file as JSONC, the way Canonfig reads it. */
const readJson = (path: string) => parseConfigDocument("json", read(path));

const asJson = <Value>(value: Value) =>
  decode(Schema.MutableJson)(JSON.parse(JSON.stringify(value)));

describe("production follower orchestration", () => {
  it("observes the installed tool independently of its verifier runtime without running commands", async () => {
    const root = temporaryRoot("tool-observation");
    const followerHome = join(root, "tool-follower", "home");
    const entry = join(followerHome, "tool-entry.js");
    const verifierMarker = join(root, "verifier-ran");
    const commandVerification = {
      method: "command",
      command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(verifierMarker)}, 'ran')`],
    };
    const cases = [
      { id: "missing-entry", executable: join(followerHome, "missing.js"), verify: commandVerification, expected: "install-tool" },
      { id: "present-entry", executable: entry, verify: commandVerification, expected: "no-op" },
      { id: "missing-command", executable: "missing-tool", verify: commandVerification, expected: "install-tool" },
      { id: "present-command", executable: "installed-tool", verify: commandVerification, expected: "no-op" },
      { id: "explicit-executable", executable: "logical-target", verify: { method: "executable-present", executable: "installed-tool" }, expected: "no-op" },
    ] as const;
    const source = await startSource(root, (folder) => authorFolder(folder, {
      tools: Object.fromEntries(cases.map(({ id, executable, verify: toolVerify }) => [id, {
        executable,
        recipes: [{ platform: "linux", method: "npm", package: id, version: "1.0.0" }],
        verify: toolVerify,
      }])),
    }));
    const follower = await enroll(root, source, { name: "Tool follower" });
    await writeFile(entry, "export {};\n");
    write(join(follower.bin, "installed-tool"), "#!/bin/sh\nexit 0\n", 0o700);

    const planned = await follower.plan();
    for (const testCase of cases) {
      expect(kindsOf(planned.plan, `tools:${testCase.id}`), testCase.id).toEqual([testCase.expected]);
    }
    await expect(readFile(verifierMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(followerHome, "missing.js"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { installerHonorsPin: true, outcome: "Converged" },
    { installerHonorsPin: false, outcome: "Failed" },
  ])("reinstalls a present uv tool at its new pin and checks the installed version (installer honors pin: $installerHonorsPin)", async ({ installerHonorsPin, outcome }) => {
    const root = temporaryRoot("tool-pin");
    const state = join(root, "installed-version");
    const calls = join(root, "uv-calls");
    const source = await startSource(root, (folder) => authorFolder(folder, {
      tools: { isort: { executable: "isort", recipes: [{ platform: "linux", method: "uv", package: "isort", version: "5.13.2" }] } },
    }));
    const follower = await enroll(root, source, { name: "Pin follower" });
    // The tool installed by an earlier revision that pinned 6.0.1.
    write(join(follower.home, ".local", "bin", "isort"), "#!/bin/sh\nexit 0\n", 0o755);
    await writeFile(state, "6.0.1");
    // A uv that keeps the installed version in a file, as `uv tool list`
    // reports it, and installs exactly the requested `isort==<version>`.
    write(join(follower.bin, "uv"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, args.join(" ") + "\\n");
if (args[0] === "tool" && args[1] === "list") {
  process.stdout.write("isort v" + fs.readFileSync(${JSON.stringify(state)}, "utf8") + "\\n- isort\\n");
} else if (args[0] === "python" && args[1] === "find") {
  process.stdout.write(process.execPath + "\\n");
} else if (args[0] === "venv") {
  fs.mkdirSync(args[1], { recursive: true });
} else if (args[0] === "pip") {
  if (args[1] === "freeze") process.stdout.write("isort==5.13.2\\n");
} else if (args[0] === "tool" && args[1] === "install") {
  const requested = args.find((arg) => arg.startsWith("isort=="));
  if (${String(installerHonorsPin)}) fs.writeFileSync(${JSON.stringify(state)}, requested.slice("isort==".length));
} else {
  process.exit(42);
}
`, 0o755);

    const planned = await follower.plan();
    expect(planned.plan.actions.filter((action) => action.resource === "tools:isort")).toEqual([
      expect.objectContaining({
        kind: "install-tool",
        detail: expect.objectContaining({ version: "5.13.2", replaces: "6.0.1" }),
      }),
    ]);
    // Planning only listed the installed tools.
    expect((await readFile(calls, "utf8")).trim().split("\n").every((call) => call.startsWith("tool list"))).toBe(true);

    const applied = await follower.apply();
    expect(applied.outcome).toMatchObject({ outcome });
    if (installerHonorsPin) {
      expect(await readFile(state, "utf8")).toBe("5.13.2");
      expect(kindsOf((await follower.plan()).plan, "tools:isort")).toEqual(["no-op"]);
    } else {
      expect(applied.outcome).toMatchObject({
        reason: expect.stringContaining("reports isort 6.0.1 installed, not the pinned 5.13.2"),
      });
    }
  });

  // A profile's `agentInstall.paths` is written once for every follower, so it
  // uses `~`. The follower's `--allow-path` reaches Canonfig already expanded
  // by the shell. Both have to mean the same directory, or the agent is
  // refused a path the profile and the operator both allowed.
  it("lets a bounded agent install into a `~` agentInstall path the harness allows by its absolute path", async () => {
    const root = temporaryRoot("agent-home-path");
    const machineRoot = join(root, "agent-follower");
    const vendor = join(machineRoot, "vendor");
    const localBin = join(machineRoot, "home", ".local", "bin");
    const installed = join(localBin, "agent-tool");
    // A copy that installs itself. Only the harness PATH reaches it, so the
    // follower observes the tool as absent and plans an Agent Task; the task
    // may run only the tool itself.
    write(
      join(vendor, "agent-tool"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "agent-tool 1.0"; exit 0; fi\ncp "$0" ${JSON.stringify(installed)}\nchmod 755 ${JSON.stringify(installed)}\n`,
      0o755,
    );
    mkdirSync(localBin, { recursive: true });
    const agent = join(machineRoot, "agent");
    write(agent, `#!${process.execPath}
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(${JSON.stringify(JSON.stringify({
      summary: "Install agent-tool into ~/.local/bin",
      actions: [{
        kind: "process",
        executable: "agent-tool",
        arguments: ["install"],
        paths: [installed],
        origins: [],
        capabilities: [],
      }],
    }))}));
`, 0o755);
    const source = await startSource(root, (folder) => authorFolder(folder, {
      tools: {
        "agent-tool": {
          executable: "agent-tool",
          recipes: [],
          agentInstall: { paths: ["~/.local/bin"], origins: ["https://packages.example.test"] },
        },
      },
    }));
    const follower = await enroll(root, source, {
      name: "Agent follower",
      // The operator's PATH holds ~/.local/bin, so the follower's own check
      // finds the tool once the agent has installed it there.
      path: [localBin],
      configuration: {
        agentPolicy: "agent-apply",
        agentHarness: {
          kind: "custom",
          executable: agent,
          environment: [{ name: "PATH", value: `${vendor}:/usr/bin:/bin` }],
          maximumInputBytes: 65_536,
          // What `--allow-path ~/.local/bin` stores after the shell expands it.
          allowedPaths: [localBin],
          allowedExecutables: ["agent-tool"],
          executableAuthorizations: [{ executable: "agent-tool", behavior: "leaf" }],
          allowedOrigins: ["https://packages.example.test"],
          allowedCapabilities: [],
        },
      },
    });

    const planned = await follower.plan();
    expect(planned.agentResolutions).toEqual([
      expect.objectContaining({ outcome: "proposed", task: expect.objectContaining({ allowedPaths: [localBin] }) }),
    ]);

    const applied = await follower.apply();
    expect(applied.outcome, JSON.stringify(applied.outcome)).toMatchObject({ outcome: "Converged" });
    expect(await readFile(installed, "utf8")).toContain("agent-tool 1.0");
  });

  // A folder item's resource id names its path, so renaming a rule retires
  // one mirror item and adds another while the projected rules directory
  // keeps one owner. Canonfig owns that whole directory surface; an unowned
  // file beside it, in the harness root, stays.
  it.each(["rename", "same-content rename", "deleted file", "local edit"] as const)("hands a renamed rule's mirror and projection over: %s", async (change) => {
    const root = temporaryRoot("handover");
    const source = await startSource(root, (folder) => authorFolder(folder, {}, { "rules/old.md": "Source one\n" }));
    const follower = await enroll(root, source, { name: "Rule follower", harnesses: ["claude-code"] });
    expect((await follower.apply()).outcome).toMatchObject({ outcome: "Converged" });
    const mirrorOld = join(follower.folder, "rules", "old.md");
    const mirrorNew = join(follower.folder, "rules", "new.md");
    const projectedOld = join(follower.home, ".claude", "rules", "old.md");
    const projectedNew = join(follower.home, ".claude", "rules", "new.md");
    const unowned = join(follower.home, ".claude", "notes.md");
    expect(read(mirrorOld)).toBe("Source one\n");
    expect(read(projectedOld)).toContain("Source one");
    write(unowned, "Unowned local notes\n");

    if (change === "local edit") write(mirrorOld, "Local edit\n");
    if (change === "deleted file") {
      // A deleted mirror file is restored from the revision it came from.
      rmSync(mirrorOld);
      const restored = await follower.apply();
      expect(restored.outcome, JSON.stringify(restored.outcome)).toMatchObject({ outcome: "Converged" });
      expect(read(mirrorOld)).toBe("Source one\n");
      rmSync(mirrorOld);
    }
    const nextContent = change === "same-content rename" ? "Source one\n" : "Source two\n";
    rmSync(join(source.folder, "rules", "old.md"));
    write(join(source.folder, "rules", "new.md"), nextContent);
    await source.publish();

    const planned = await follower.plan();
    // Planning changes nothing.
    expect(existsSync(mirrorNew)).toBe(false);
    if (change === "deleted file") expect(existsSync(mirrorOld)).toBe(false);
    else expect(read(mirrorOld)).toBe(change === "local edit" ? "Local edit\n" : "Source one\n");
    // The renamed content is the blob the follower already holds.
    if (change === "same-content rename") expect(planned.downloadedBlobs).toBe(0);

    const applied = await follower.apply();
    if (change === "local edit") {
      // A retired mirror file that was edited here is released, not deleted:
      // the edit stays as this machine's own file and the run converges on
      // the renamed rule.
      expect(applied.outcome, JSON.stringify(applied.outcome)).toMatchObject({ outcome: "Converged" });
      expect(kindsOf(planned.plan, "rules:old")).toEqual([]);
      expect(read(mirrorOld)).toBe("Local edit\n");
      expect(read(mirrorNew)).toBe(nextContent);
      expect(read(projectedNew)).toContain(nextContent.trim());
      expect(existsSync(projectedOld)).toBe(false);
      expect(kindsOf((await follower.plan()).plan, "rules:old")).toEqual([]);
    } else {
      expect(kindsOf(planned.plan, "rules:old")).toEqual(["remove-resource"]);
      expect(kindsOf(planned.plan, "rules:new")).toEqual(["write-file"]);
      expect(applied.outcome, JSON.stringify(applied.outcome)).toMatchObject({ outcome: "Converged" });
      expect(read(mirrorNew)).toBe(nextContent);
      expect(existsSync(mirrorOld)).toBe(false);
      expect(read(projectedNew)).toContain(nextContent.trim());
      expect(existsSync(projectedOld)).toBe(false);
      const repeat = await follower.plan();
      expect(kindsOf(repeat.plan, "rules:new")).toEqual(["no-op"]);
      expect(kindsOf(repeat.plan, "rules:old")).toEqual([]);
    }
    expect(read(unowned)).toBe("Unowned local notes\n");
  });

  it("re-renders a follower-local schedule override's binding and keeps its cadence", async () => {
    const root = temporaryRoot("schedule-override");
    // The profile default differs from the override, so a reconciler that
    // reached for the inherited cadence would show up in the timer.
    const source = await startSource(root, (folder) => authorFolder(folder, { scheduleDefault: "daily@04:30" }));
    // An in-memory native scheduler: the real ScheduleManager renders and
    // compares against it, and the test can seed a job whose binding the
    // current renderer no longer produces.
    let installedJob: RenderedSchedulerJob | undefined;
    let installs = 0;
    const scheduler: SchedulerBackend = {
      inspect: (expected) => Effect.sync(() => ({
        installed: installedJob !== undefined, enabled: installedJob !== undefined,
        matches: installedJob?.service === expected.service && installedJob.schedule === expected.schedule,
      })),
      snapshot: (expected) => Effect.sync(() => installedJob === undefined
        ? { state: "absent" as const, platform: expected.platform, mechanism: expected.mechanism, serviceName: expected.serviceName }
        : {
          state: "present" as const, platform: expected.platform, mechanism: expected.mechanism, serviceName: expected.serviceName,
          enabled: true, servicePresent: true, schedulePresent: true, service: installedJob.service, schedule: installedJob.schedule,
        }),
      install: (definition) => Effect.sync(() => { installedJob = definition; installs += 1; }),
      remove: () => Effect.sync(() => { installedJob = undefined; }),
      restore: () => Effect.die("unused"),
    };
    const operatorSchedule: SyncSchedule = { kind: "weekly", weekdays: ["Mon"], localTime: "12:30" };
    const follower = await enroll(root, source, {
      name: "Schedule follower",
      schedulerBackend: scheduler,
      schedules: (machine) => scheduleManagerLayer.pipe(Layer.provide(machine)),
      configuration: { scheduleOverride: { kind: "schedule", schedule: operatorSchedule } },
    });
    const withSchedules = <Value, Error>(effect: Effect.Effect<Value, Error, ScheduleManager>) =>
      Effect.runPromise(effect.pipe(Effect.provide(follower.schedules!)));
    // The job as an earlier renderer bound it: the operator's cadence, but a
    // binding the current renderer no longer produces. The stale executable
    // is a real probe-passing script: the set-time probe runs `<executable>
    // --version` under the unit PATH, so a non-existent path would (correctly)
    // refuse install instead of seeding the stale job (Microck/canonfig#132).
    const staleExecutable = join(follower.bin, "old-canonfig");
    write(staleExecutable, "#!/bin/sh\nexit 0\n", 0o755);
    await withSchedules(Effect.flatMap(ScheduleManager, (manager) => manager.install({ schedule: operatorSchedule, executable: staleExecutable })));
    const staleJob = installedJob!;
    const status = () => withSchedules(Effect.flatMap(ScheduleManager, (manager) => manager.status({ schedule: operatorSchedule })));
    const drifted = await status();
    expect(drifted.state).toBe("drifted");

    expect((await follower.apply()).outcome).toMatchObject({ outcome: "Converged" });
    // Re-rendered to exactly the job `schedule status` was comparing against:
    // same timer as the operator's cadence, new binding.
    expect(installs).toBe(2);
    expect(installedJob).toEqual(drifted.definition);
    expect(installedJob!.schedule).toBe(staleJob.schedule);
    expect(installedJob!.service).not.toBe(staleJob.service);
    expect((await status()).state).toBe("current");
    const configuration = await follower.withRepository(Effect.flatMap(StateRepository, (repository) => repository.getFollowerSynchronizationConfiguration()));
    expect(configuration?.scheduleOverride).toEqual({ kind: "schedule", schedule: operatorSchedule });
    expect(configuration?.scheduleDefault).toEqual({ type: "daily", at: "04:30", timezone: "local" });

    expect((await follower.apply()).outcome).toMatchObject({ outcome: "Converged" });
    expect(installs).toBe(2);
  });

  it("offers a profile default without installing it, and never recreates a job disabled or deleted outside Canonfig", async () => {
    const root = temporaryRoot("schedule-consent");
    const source = await startSource(root, (folder) => authorFolder(folder, { scheduleDefault: "daily@04:30" }));
    // An in-memory native scheduler whose job the test can delete or disable
    // the way `rm` or `systemctl --user disable --now` would.
    let installedJob: RenderedSchedulerJob | undefined;
    let disabled = false;
    let installs = 0;
    const scheduler: SchedulerBackend = {
      inspect: (expected) => Effect.sync(() => ({
        installed: installedJob !== undefined, enabled: installedJob !== undefined && !disabled,
        active: installedJob !== undefined && !disabled,
        matches: installedJob?.service === expected.service && installedJob.schedule === expected.schedule,
      })),
      snapshot: () => Effect.die("unused"),
      install: (definition) => Effect.sync(() => { installedJob = definition; disabled = false; installs += 1; }),
      remove: () => Effect.sync(() => { installedJob = undefined; }),
      restore: () => Effect.die("unused"),
    };
    const follower = await enroll(root, source, {
      name: "Consent follower",
      schedulerBackend: scheduler,
      schedules: (machine) => scheduleManagerLayer.pipe(Layer.provide(machine)),
    });
    const installDefault = () => Effect.runPromise(Effect.flatMap(ScheduleManager, (manager) => manager.install({
      schedule: { kind: "daily", localTime: "04:30" },
    })).pipe(Effect.provide(follower.schedules!)));

    // CF-47: the follower never ran `schedule set`, so the default is only offered.
    expect((await follower.plan()).schedule).toMatchObject({ action: "available" });
    const offered = await follower.apply();
    expect(offered.outcome).toMatchObject({ outcome: "Converged" });
    expect(offered.schedule?.detail).toContain("canonfig schedule set --default");
    expect(installs).toBe(0);
    expect(installedJob).toBeUndefined();

    // Consent (`schedule set --default`) installs the inherited default.
    await follower.configure({ scheduleOverride: { kind: "inherit" } });
    await installDefault();
    expect((await follower.apply()).schedule).toMatchObject({ action: "unchanged", state: "current" });
    expect(installs).toBe(1);

    // CF-46: deleted outside Canonfig stays deleted, and is reported.
    installedJob = undefined;
    const afterDelete = await follower.apply();
    expect(afterDelete.schedule).toMatchObject({ action: "left-as-is", state: "not-installed" });
    expect(afterDelete.schedule?.detail).toContain("automation disabled outside Canonfig");
    expect(installedJob).toBeUndefined();
    expect(installs).toBe(1);

    // CF-46: disabled outside Canonfig stays disabled.
    await installDefault();
    disabled = true;
    const afterDisable = await follower.apply();
    expect(afterDisable.schedule).toMatchObject({ action: "left-as-is", state: "disabled" });
    expect(disabled).toBe(true);
    expect(installs).toBe(2);
  });

  it("routes emitted agent tasks through configured bounded policy and preserves human fallback", async () => {
    const taskId = decode(AgentTaskId)("agent:tool:0");
    const actionId = decode(ActionId)("action:tool:0:agent-task");
    const resource = decode(ResourceId)("tools:agent-tool");
    const task = {
      id: taskId,
      resource,
      summary: "Resolve agent tool",
      desiredOutcome: "Make agent-tool available",
      observedEvidence: ["Observed state: absent"],
      allowedPaths: ["/tmp/canonfig-agent"],
      allowedExecutables: ["agent-tool"],
      executableAuthorizations: [{
        executable: "agent-tool",
        behavior: "leaf" as const,
      }],
      allowedOrigins: ["https://packages.example.test"],
      forbidden: ["elevation", "login", "restart", "reboot"] as const,
      timeLimitSeconds: 30,
      outputLimitBytes: 4096,
      verification: { command: ["agent-tool", "--version"] },
    };
    const body = {
      revision: "revision-agent",
      follower: "follower-agent",
      requiredBlobs: [],
      actions: [{
        id: actionId,
        resource,
        kind: "agent-task" as const,
        detail: {
          kind: "agent-task" as const,
          taskId,
          summary: task.summary,
        },
        before: [],
      }],
      agentTasks: [task],
    };
    const encoded = canonicalJson(asJson(body));
    const plan = {
      ...body,
      encoded,
      digest: sha256Hex(encoded),
    };
    const baseConfiguration = decode(FollowerSynchronizationConfiguration)({
      schemaVersion: 1,
      follower: {
        id: "follower-agent",
        name: "Agent follower",
        groups: [],
        revoked: false,
        credentialReference: "secure-store://agent-follower",
        enrolledAt: "2026-08-16T00:00:00Z",
      },
      profile: "profile-agent",
      source: {
        endpoint: "https://127.0.0.1:17342",
        tlsFingerprint: "tls-agent",
        signingFingerprint: "signing-agent",
      },
      credentialReference: "secure-store://agent-follower",
      cacheDirectory: "/tmp/canonfig-agent-cache",
      stateLocation: "/tmp/canonfig-agent-state.sqlite",
      agentPolicy: "agent-apply",
      agentHarness: {
        kind: "codex",
        executable: "/opt/codex",
        maximumInputBytes: 8192,
        allowedPaths: ["/tmp/canonfig-agent"],
        allowedExecutables: ["agent-tool"],
        executableAuthorizations: [{
          executable: "agent-tool",
          behavior: "leaf",
        }],
        allowedOrigins: ["https://packages.example.test"],
        allowedCapabilities: [],
      },
      scheduledInvocation: defaultScheduledInvocation,
      updatedAt: "2026-08-16T00:00:01Z",
    });
    const recordingAgent = AgentResolution.of({
      resolve: (input) => Effect.succeed({
        outcome: "applied" as const,
        task: input.task,
        proposal: { summary: "Install agent tool", actions: [] },
        harness: {
          executable: "/opt/codex",
          arguments: [],
          exitCode: 0,
          signal: null,
          outputBytes: 0,
          stdout: "",
          stderr: "",
        },
        executions: [],
        verification: {
          command: input.task.verification.command,
          exitCode: 0,
          stdout: "agent-tool 1.0",
          stderr: "",
          matched: true,
        },
      }),
    });
    const applied = await Effect.runPromise(
      resolveAgentTasks(baseConfiguration, plan, false).pipe(
        Effect.provideService(AgentResolution, recordingAgent),
      ),
    );
    expect(applied.plan.actions[0]).toMatchObject({
      kind: "no-op",
      detail: { kind: "no-op" },
    });
    expect(applied.agentResolutions).toHaveLength(1);

    const missingHarness = await Effect.runPromise(
      resolveAgentTasks(
        {
          ...baseConfiguration,
          agentHarness: undefined,
        },
        plan,
        true,
      ).pipe(Effect.provideService(AgentResolution, recordingAgent)),
    );
    expect(missingHarness.plan.actions[0]).toMatchObject({
      kind: "human-action",
      detail: {
        kind: "human-action",
        reason: expect.stringContaining("not configured"),
      },
    });

    // A persisted harness that classifies a nested-command launcher must fail
    // closed at synchronization time, routing the task to Human Action
    // Required instead of trusting the stored classification.
    const launcherClassified = await Effect.runPromise(
      resolveAgentTasks(
        {
          ...baseConfiguration,
          agentHarness: {
            ...baseConfiguration.agentHarness!,
            executableAuthorizations: [{
              executable: "xargs",
              behavior: "leaf",
            }],
          },
        },
        plan,
        true,
      ).pipe(Effect.provideService(AgentResolution, recordingAgent)),
    );
    expect(launcherClassified.plan.actions[0]).toMatchObject({
      kind: "human-action",
      detail: {
        kind: "human-action",
        reason: expect.stringContaining("nested-command launcher"),
      },
    });
    expect(launcherClassified.agentResolutions).toHaveLength(0);

    // A harness that refuses is reported rather than dropped. `sync --plan`
    // used to compute this and discard it, so the agent task showed unchanged
    // with an empty agentResolutions and no reason at all, while the same
    // failure during apply ended the run.
    const refusingAgent = AgentResolution.of({
      resolve: () =>
        Effect.fail(
          new DeniedAgentCapabilityError({
            capability: "path",
            value: "/tmp/canonfig-agent",
          }),
        ),
    });
    const refused = await Effect.runPromise(
      resolveAgentTasks(baseConfiguration, plan, false, undefined, true).pipe(
        Effect.provideService(AgentResolution, refusingAgent),
      ),
    );
    expect(refused.agentResolutions).toEqual([
      expect.objectContaining({
        outcome: "refused",
        reason: expect.stringContaining("could not safely resolve"),
      }),
    ]);
    // A plan still shows the agent task, because a plan describes what would
    // be attempted; the refusal is reported alongside it rather than silently
    // dropped.
    expect(refused.plan.actions[0]).toMatchObject({ kind: "agent-task" });
  });

  it("persists enrollment config, transfers the revision, converges, reuses cache, detects drift, and rejects revocation", async () => {
    const root = temporaryRoot("lifecycle");
    const content = "canonical follower content\n";
    const lifecycleConfig = {
      mcp: { docs: { transport: "stdio", command: "docs-server" } },
      groups: { alpha: ["rules/alpha-only"] },
      scheduleDefault: "daily@00:00",
    };
    const source = await startSource(root, (folder) => authorFolder(folder, lifecycleConfig, {
      "AGENTS.md": content,
      "rules/alpha-only.md": "alpha-only content\n",
      "skills/deploy/SKILL.md": "---\nname: deploy\ndescription: Deploy\n---\nDeploy carefully.\n",
      "skills/deploy/kept.txt": "kept\n",
      "skills/deploy/removed.txt": "remove later\n",
      "skills/deploy/東京.txt": "unicode path\n",
    }));
    const revision = (await source.run(Effect.flatMap(StateRepository, (repository) => repository.getLatestRevision(profileId))))!;
    const publicBlobCount = new Set(revision.resources
      .filter((resource) => resource.groups === undefined)
      .flatMap((resource) => resource.blobs)).size;
    const authorizedBlobCount = new Set(revision.resources.flatMap((resource) => resource.blobs)).size;
    expect(authorizedBlobCount).toBeGreaterThan(publicBlobCount);

    const profileScheduleCalls: Array<unknown> = [];
    let profileSchedule: SyncSchedule | undefined = { kind: "daily", localTime: "00:00" };
    const definition = {
      platform: "linux" as const,
      mechanism: "systemd-user-timer" as const,
      serviceName: "test",
      service: "",
      schedule: "",
    };
    // A fixture ScheduleManager holding one job that exists without any
    // decision of this follower.
    const profileScheduleManager = ScheduleManager.of({
      install: () => Effect.die("unused"),
      inspect: () => Effect.die("unused"),
      reconcile: () => Effect.die("unused"),
      update: (input) => Effect.sync(() => {
        profileScheduleCalls.push(input?.schedule);
        const schedule = input?.schedule ?? { kind: "daily" as const, localTime: "00:00" };
        profileSchedule = schedule;
        return {
          change: "updated" as const,
          status: {
            state: "current" as const, platform: "linux" as const, schedule, definition,
            detail: "fixture", timezone: "UTC", warnings: [],
          },
        };
      }),
      status: (input) => Effect.sync(() => {
        const schedule = input?.schedule ?? { kind: "daily" as const, localTime: "00:00" };
        return {
          state: profileSchedule === undefined
            ? "not-installed" as const
            : JSON.stringify(profileSchedule) === JSON.stringify(schedule)
              ? "current" as const
              : "drifted" as const,
          platform: "linux" as const, schedule, definition,
          detail: "fixture", timezone: "UTC", warnings: [],
        };
      }),
      snapshot: () => Effect.sync(() => profileSchedule === undefined
        ? { state: "absent" as const, platform: "linux" as const, mechanism: "systemd-user-timer" as const, serviceName: "test" }
        : {
          state: "present" as const, platform: "linux" as const, mechanism: "systemd-user-timer" as const, serviceName: "test",
          enabled: true, servicePresent: true, schedulePresent: true, service: "", schedule: JSON.stringify(profileSchedule),
        }),
      restore: (_input, snapshot) => Effect.sync(() => {
        profileSchedule = snapshot.state === "absent"
          ? undefined
          : decode(SyncScheduleSchema)(JSON.parse(snapshot.schedule ?? "{}"));
      }),
      remove: () => Effect.sync(() => {
        profileScheduleCalls.push(undefined);
        profileSchedule = undefined;
        return { change: "removed" as const };
      }),
    });
    const follower = await enroll(root, source, {
      name: "Production follower",
      harnesses: ["claude-code"],
      schedules: () => Layer.succeed(ScheduleManager, profileScheduleManager),
    });
    const { folder, home } = follower;
    expect(follower.enrolled.authorizedProfiles?.map((entry) => entry.profileId)).toEqual([profileId]);
    // A new repository connection reads the persisted enrollment configuration.
    expect(await Effect.runPromise(Effect.flatMap(StateRepository, (repository) =>
      repository.getFollowerSynchronizationConfiguration()
    ).pipe(Effect.provide(stateRepositoryLayer(follower.state))))).toMatchObject({
      profile: profileId,
      stateLocation: follower.state,
      follower: { id: follower.follower.id },
    });
    const appliedResources = () => follower.withRepository(Effect.flatMap(StateRepository, (repository) =>
      repository.loadAppliedResources(follower.follower.id)
    ));

    const planOnly = await follower.plan();
    expect(planOnly.plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource: "instructions", kind: "write-file" }),
    ]));
    expect(existsSync(join(folder, "AGENTS.md"))).toBe(false);
    expect(await appliedResources()).toEqual([]);

    // Planning fetched the revision, so the apply reuses every blob.
    const first = await follower.apply();
    expect(first).toMatchObject({
      revision: revision.id,
      downloadedBlobs: 0,
      reusedBlobs: publicBlobCount,
      outcome: { outcome: "Converged" },
    });
    expect(read(join(folder, "AGENTS.md"))).toBe(content);
    expect(read(join(folder, "skills", "deploy", "removed.txt"))).toBe("remove later\n");
    expect(read(join(folder, "skills", "deploy", "東京.txt"))).toBe("unicode path\n");
    expect(existsSync(join(folder, "rules", "alpha-only.md"))).toBe(false);
    expect(read(join(home, ".claude", "CLAUDE.md"))).toContain("canonical follower content");
    expect(read(join(home, ".claude", "skills", "deploy", "kept.txt"))).toBe("kept\n");
    expect(readJson(join(home, ".claude.json"))).toMatchObject({ mcpServers: { docs: { command: "docs-server" } } });

    const second = await follower.apply();
    expect(second).toMatchObject({
      downloadedBlobs: 0,
      reusedBlobs: publicBlobCount,
      outcome: { outcome: "Converged" },
    });
    expect(source.server.blobRequests()).toBe(publicBlobCount);

    // Joining `alpha` widens the view of the same revision: only the grouped
    // blobs travel.
    await source.run(Effect.flatMap(Enrollment, (enrollment) =>
      enrollment.updateFollowerGroups(follower.follower.id, [decode(GroupName)("alpha")])
    ));
    const alphaViewSync = await follower.apply();
    expect(alphaViewSync).toMatchObject({
      revision: revision.id,
      downloadedBlobs: authorizedBlobCount - publicBlobCount,
      reusedBlobs: publicBlobCount,
      outcome: { outcome: "Converged" },
    });
    expect(read(join(folder, "rules", "alpha-only.md"))).toBe("alpha-only content\n");
    expect(read(join(home, ".claude", "rules", "alpha-only.md"))).toContain("alpha-only content");
    expect(source.server.blobRequests()).toBe(authorizedBlobCount);

    await source.run(Effect.flatMap(Enrollment, (enrollment) => enrollment.updateFollowerGroups(follower.follower.id, [])));
    const publicViewAgain = await follower.apply();
    expect(publicViewAgain).toMatchObject({
      revision: revision.id,
      downloadedBlobs: 0,
      reusedBlobs: publicBlobCount,
      outcome: { outcome: "Converged" },
    });
    expect(existsSync(join(folder, "rules", "alpha-only.md"))).toBe(false);
    expect(existsSync(join(home, ".claude", "rules", "alpha-only.md"))).toBe(false);
    expect((await follower.withRepository(Effect.flatMap(StateRepository, (repository) =>
      repository.getFollowerSynchronizationConfiguration()
    )))?.scheduleDefault).toEqual({ type: "daily", at: "00:00", timezone: "local" });
    expect(source.server.blobRequests()).toBe(authorizedBlobCount);
    // The grouped rule's mirror item was removed once, by a journaled action.
    const database = new DatabaseSync(follower.state, { readOnly: true });
    // SAFETY: COUNT(*) AS count always returns one numeric SQLite aggregate row.
    const removalCount = database.prepare(`
      SELECT COUNT(*) AS count
      FROM action_journal
      WHERE action_id LIKE 'action:rules:alpha-only:%:remove-resource'
        AND state = 'succeeded'
    `).get() as { count: number };
    database.close();
    expect(removalCount.count).toBe(1);

    // The plan the orphaned run below claims. Recovering a run interrupted
    // mid-apply needs the projection content that run stored, so it is
    // exercised with a real interrupted run in tests/acceptance/cross-platform.test.ts.
    const planned = await follower.plan();

    // The next revision drops a skill file, the grouped rule and its group,
    // and moves the schedule default.
    rmSync(join(source.folder, "skills", "deploy", "removed.txt"));
    rmSync(join(source.folder, "rules", "alpha-only.md"));
    writeConfig(source.folder, { ...lifecycleConfig, groups: {}, scheduleDefault: "daily@01:15" });
    const next = await source.publish();
    expect(next.sequence).toBe(2);
    expect(next.resources.some((resource) => resource.id === "rules:alpha-only")).toBe(false);
    const ownershipPlan = await follower.plan();
    expect(ownershipPlan.revision).toBe(next.id);
    expect(kindsOf(ownershipPlan.plan, "skills:deploy")).not.toEqual(["no-op"]);
    const ownershipApplied = await follower.apply();
    expect(ownershipApplied).toMatchObject({ outcome: { outcome: "Converged" } });
    // This follower never consented to scheduling (no `schedule set`), so
    // the profile default is not installed (CF-47). The job that already
    // exists without a decision is kept, never deleted (UF-D6).
    expect(profileScheduleCalls).toEqual([]);
    expect(ownershipApplied).toMatchObject({ schedule: { action: "kept-unmanaged" } });
    expect((await follower.withRepository(Effect.flatMap(StateRepository, (repository) =>
      repository.getFollowerSynchronizationConfiguration()
    )))?.scheduleDefault).toEqual({ type: "daily", at: "01:15", timezone: "local" });
    expect(existsSync(join(folder, "skills", "deploy", "removed.txt"))).toBe(false);
    expect(existsSync(join(home, ".claude", "skills", "deploy", "removed.txt"))).toBe(false);
    expect(read(join(folder, "skills", "deploy", "kept.txt"))).toBe("kept\n");
    expect(read(join(home, ".claude", "skills", "deploy", "kept.txt"))).toBe("kept\n");
    expect(readJson(join(folder, "canonfig.jsonc"))).not.toHaveProperty("groups");
    const ownershipReplan = await follower.plan();
    expect(ownershipReplan.plan.actions.filter((action) => action.kind !== "no-op")).toEqual([]);
    expect((await follower.apply()).outcome).toMatchObject({ outcome: "Converged" });

    // An edited mirror file is Follower Drift: kept, and the run stops.
    write(join(folder, "AGENTS.md"), "local drift\n");
    expect(await follower.apply()).toMatchObject({ outcome: { outcome: "FollowerDrift" } });
    expect(read(join(folder, "AGENTS.md"))).toBe("local drift\n");
    expect(read(join(home, ".claude", "CLAUDE.md"))).toContain("canonical follower content");

    // A run whose revision the Source no longer serves, such as one an
    // earlier release left open, can only be closed. recover must say so
    // instead of sending the operator into a recover/apply loop.
    const orphan = {
      ...revision,
      id: decode(ProfileRevisionId)(`${revision.profileId}:${"f".repeat(64)}`),
      sequence: 99,
    };
    const firstAction = planned.plan.actions[0]!.id;
    await follower.withRepository(Effect.flatMap(StateRepository, (repository) =>
      Effect.andThen(
        repository.publishRevision({ revision: orphan }),
        repository.startRun({
          id: decode(RunId)("orphaned-revision-run"),
          follower: follower.follower.id,
          revision: orphan.id,
          plan: { ...planned.plan, revision: orphan.id },
          startedAt: "2026-11-03T02:00:00Z",
          pendingRollbackReferences: new Map([[firstAction,
            join(root, "old-cache", "canonfig", "rollback", "orphaned-revision-run", `${sha256Hex(firstAction)}.json`)]]),
        }),
      )
    ));
    const unrecoverable = await Effect.runPromise(Effect.flip(
      recoverFollower(follower.state).pipe(Effect.provide(follower.application)),
    ));
    expect(unrecoverable).toMatchObject({
      _tag: "FollowerSynchronizationConfigurationError",
      message: expect.stringContaining(`run orphaned-revision-run cannot be recovered: its revision ${orphan.id} is not stored on this machine`),
    });
    expect(unrecoverable.message).toContain(
      "run 'canonfig abandon' to close it without rollback, then 'canonfig sync --apply'",
    );
    const rollbackDirectories = await Effect.runPromise(Effect.flatMap(MachineState, (machine) =>
      machine.userDirectories()).pipe(Effect.provide(follower.machine)));
    const rollbackRoot = join(root, "old-cache", "canonfig", "rollback");
    expect(rollbackRoot.startsWith(rollbackDirectories.cache.absolute)).toBe(false);
    const abandonedSnapshots = join(rollbackRoot, "orphaned-revision-run");
    const otherSnapshots = join(rollbackRoot, "another-run");
    const actionHash = sha256Hex(firstAction);
    await mkdir(abandonedSnapshots, { recursive: true });
    await mkdir(otherSnapshots, { recursive: true });
    await writeFile(join(abandonedSnapshots, `${actionHash}.json`), "{}", { mode: 0o600 });
    await writeFile(join(abandonedSnapshots, `${actionHash}.json.${"b".repeat(64)}.bin`), "synthetic-private-preimage", { mode: 0o600 });
    await writeFile(join(abandonedSnapshots, ".cf-123456789abc.tmp"), "partial", { mode: 0o600 });
    await writeFile(join(otherSnapshots, "keep.bin"), "other run preimage", { mode: 0o600 });

    await expect(Effect.runPromise(
      abandonFollowerRun(follower.state).pipe(Effect.provide(follower.application)),
    )).resolves.toMatchObject({ run: "orphaned-revision-run", abandoned: true });
    await expect(stat(abandonedSnapshots)).rejects.toMatchObject({ code: "ENOENT" });
    expect(read(join(otherSnapshots, "keep.bin"))).toBe("other run preimage");

    await source.run(Effect.flatMap(Enrollment, (enrollment) => enrollment.revokeFollower(follower.follower.id)));
    const revoked = await Effect.runPromise(Effect.flip(
      synchronizeFollower(follower.state, "apply", { environment: () => undefined, noBackup: false })
        .pipe(Effect.provide(follower.application)),
    ));
    expect(revoked._tag).toBe("RevokedFollowerCredentialError");
  }, 120_000);

  // The only rule goes and comes back, so the projected rules directory is
  // retired and then written again at the same place.
  it("hands a follower older content re-published as the latest revision", async () => {
    const root = temporaryRoot("republish");
    const source = await startSource(root, (folder) => authorFolder(folder, {}, {
      "AGENTS.md": "Shared instructions\n",
      "rules/extra.md": "extra\n",
    }));
    const first = (await source.run(Effect.flatMap(StateRepository, (repository) => repository.getLatestRevision(profileId))))!;
    const follower = await enroll(root, source, { name: "Restoring follower", harnesses: ["claude-code"] });
    const extra = join(follower.folder, "rules", "extra.md");

    expect((await follower.apply()).outcome).toMatchObject({ outcome: "Converged" });
    expect(read(extra)).toBe("extra\n");

    rmSync(join(source.folder, "rules", "extra.md"));
    await source.publish();
    expect((await follower.apply()).outcome).toMatchObject({ outcome: "Converged" });
    expect(existsSync(extra)).toBe(false);

    write(join(source.folder, "rules", "extra.md"), "extra\n");
    const restored = await source.publish();
    expect(restored.sequence).toBe(3);
    expect(restored.canonicalBytes).toBe(first.canonicalBytes);
    expect(restored.id).not.toBe(first.id);
    expect((await follower.plan()).revision).toBe(restored.id);
    const restoredRun = await follower.apply();
    expect(restoredRun.outcome, JSON.stringify(restoredRun.outcome)).toMatchObject({ outcome: "Converged" });
    expect(read(extra)).toBe("extra\n");
    expect(read(join(follower.home, ".claude", "rules", "extra.md"))).toContain("extra");
  });

  it("merges projected MCP servers into a commented ~/.claude.json and blocks only the resource whose file does not parse", async () => {
    const root = temporaryRoot("claude-json");
    const source = await startSource(root, (folder) => authorFolder(folder, {
      mcp: { docs: { transport: "stdio", command: "docs", args: ["--a"], env: { B: "2", A: "1" } } },
    }, { "rules/style.md": "Use two spaces.\n" }));
    const follower = await enroll(root, source, { name: "JSON follower", harnesses: ["claude-code"] });
    const claudeJson = join(follower.home, ".claude.json");
    write(claudeJson, "{\n  // user comment: keep my theme\n  \"theme\": \"Dracula\",\n  \"numStartups\": 3,\n}\n");

    expect((await follower.apply()).outcome).toMatchObject({ outcome: "Converged" });
    const merged = read(claudeJson);
    // Canonfig owns the `mcpServers` key it projects; the comment and the
    // user's other keys stay as written.
    expect(merged).toContain("// user comment: keep my theme");
    expect(merged).toContain("\"theme\": \"Dracula\"");
    expect(readJson(claudeJson)).toMatchObject({
      theme: "Dracula",
      numStartups: 3,
      mcpServers: { docs: { command: "docs", args: ["--a"], env: { A: "1", B: "2" } } },
    });
    // An unchanged follow-up plans nothing.
    const unchanged = await follower.plan();
    expect(unchanged.plan.actions.filter((action) => action.kind !== "no-op")).toEqual([]);
    const mcpResource = unchanged.plan.actions.find((action) =>
      action.resource.startsWith("harness:claude-code:") && action.resource.includes("mcp")
    )!.resource;

    const broken = "{\n  // user comment\n  \"theme\": \n}\n";
    write(claudeJson, broken);
    rmSync(join(follower.folder, "rules", "style.md"));
    const planned = await follower.plan();
    expect(planned.plan.actions.find((action) => action.resource === mcpResource)).toMatchObject({
      kind: "human-action",
      detail: { reason: expect.stringContaining(`${claudeJson} is not valid JSON`) },
    });
    expect(kindsOf(planned.plan, "rules:style")).toEqual(["write-file"]);
    expect(read(claudeJson)).toBe(broken);
  });

  it("takes over a harness with a snapshot once a tool that blocked the first run is installed", async () => {
    const root = temporaryRoot("tool-blocked-takeover");
    const source = await startSource(root, (folder) => authorFolder(folder, {
      // Cargo cannot install with build scripts disabled, so the tool is Human
      // Action Required, and every projected resource waits for it because
      // the MCP server requires it.
      tools: { probe: { executable: "probe-tool", recipes: [{ platform: "linux", method: "cargo", package: "probe-tool", version: "1.0.0" }] } },
      mcp: { probe: { transport: "stdio", command: "probe-tool", requires: ["tools/probe"] } },
    }, { "AGENTS.md": "Prefer small diffs.\n" }));
    const follower = await enroll(root, source, { name: "Blocked follower", harnesses: ["claude-code"] });
    const instructions = join(follower.home, ".claude", "CLAUDE.md");
    write(instructions, "old instructions\n");
    const backups = join(follower.folder, ".backups");
    const takeoverHarnesses = () => {
      const database = new DatabaseSync(follower.state, { readOnly: true });
      try {
        return database.prepare("SELECT harness FROM harness_takeovers").all().map((row) => row.harness);
      } finally {
        database.close();
      }
    };

    const blocked = await follower.apply();
    expect(blocked.outcome).toMatchObject({ outcome: "HumanActionRequired" });
    expect(read(instructions)).toBe("old instructions\n");
    expect(takeoverHarnesses()).toEqual([]);
    expect(existsSync(backups) ? readdirSync(backups) : []).toEqual([]);

    write(join(follower.bin, "probe-tool"), "#!/bin/sh\nexit 0\n", 0o755);
    const resolved = await follower.apply();
    expect(resolved.outcome).toMatchObject({ outcome: "Converged" });
    expect(read(instructions)).toContain("Prefer small diffs.");
    expect(takeoverHarnesses()).toContain("claude-code");
    const [snapshot] = readdirSync(backups);
    expect(read(join(backups, snapshot!, "claude-code", ".claude", "CLAUDE.md"))).toBe("old instructions\n");
    expect((await follower.apply()).outcome).toMatchObject({ outcome: "Converged" });
  });

  it("releases takeovers of surfaces an abandoned first run never applied", async () => {
    const root = temporaryRoot("abandoned-takeover");
    const source = await startSource(root, (folder) => authorFolder(folder, { harnesses: ["amp", "claude-code", "qwen"] }, {
      "AGENTS.md": "Prefer small diffs.\n",
    }));
    const follower = await enroll(root, source, { name: "Abandoned follower", harnesses: ["amp", "claude-code", "qwen"] });
    const instructions = join(follower.home, ".claude", "CLAUDE.md");
    const qwen = join(follower.home, ".qwen", "QWEN.md");
    write(join(follower.home, ".config", "amp", "AGENTS.md"), "old amp\n");
    write(instructions, "old instructions\n");
    write(qwen, "old qwen\n");
    // The run is killed while writing CLAUDE.md: amp sorts before it and is
    // applied, qwen sorts after it and never runs. Only the first write is
    // held; later ones restore the file.
    const { promise: started, resolve: notify } = Promise.withResolvers<void>();
    let held = false;
    const holding = Layer.effect(MachineState, Effect.map(MachineState, (service) => ({
      ...service,
      atomicWrite: (input: Parameters<typeof service.atomicWrite>[0]) => {
        if (held || input.path.absolute !== instructions) return service.atomicWrite(input);
        held = true;
        notify();
        return Effect.never;
      },
    }))).pipe(Layer.provide(follower.machine));
    const repository = stateRepositoryLayer(follower.state);
    const fiber = Effect.runFork(synchronizeFollower(follower.state, "apply", { environment: () => undefined, noBackup: false }).pipe(
      Effect.provide(Layer.mergeAll(
        repository,
        holding,
        AgentResolutionLive,
        SynchronizationLive.pipe(Layer.provide(Layer.merge(repository, holding))),
      )),
    ));
    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));
    await expect(Effect.runPromise(
      abandonFollowerRun(follower.state).pipe(Effect.provide(follower.application)),
    )).resolves.toMatchObject({ abandoned: true });
    const database = new DatabaseSync(follower.state, { readOnly: true });
    const rowsAfterAbandon = database.prepare("SELECT harness, surface FROM harness_takeovers").all();
    database.close();

    const retried = await follower.apply();
    expect(retried.outcome).toMatchObject({ outcome: "Converged" });
    expect(read(instructions)).toContain("Prefer small diffs.");
    expect(read(qwen)).toContain("Prefer small diffs.");
    const backups = join(follower.folder, ".backups");
    const retrySnapshot = join(backups, readdirSync(backups).sort().at(-1)!);
    expect(read(join(retrySnapshot, "qwen", ".qwen", "QWEN.md"))).toBe("old qwen\n");
    expect(read(join(retrySnapshot, "claude-code", ".claude", "CLAUDE.md"))).toBe("old instructions\n");
    expect((await follower.apply()).outcome).toMatchObject({ outcome: "Converged" });

    expect(rowsAfterAbandon.map((row) => row.harness)).toContain("amp");
    expect(rowsAfterAbandon.map((row) => row.harness)).not.toContain("qwen");
  });

  it("retires no harness output while a mirror item has drifted", async () => {
    const root = temporaryRoot("mirror-drift-retirement");
    const source = await startSource(root, (folder) => authorFolder(folder, {}, {
      "AGENTS.md": "Prefer small diffs.\n",
      "rules/style.md": "Use two spaces.\n",
    }));
    const follower = await enroll(root, source, { name: "Drifted follower", harnesses: ["claude-code"] });
    const projectedRule = join(follower.home, ".claude", "rules", "style.md");
    expect((await follower.apply()).outcome).toMatchObject({ outcome: "Converged" });
    expect(read(projectedRule)).toContain("Use two spaces.");

    // The next revision drops the last rule, so harness:claude-code:rules is
    // retired, while the follower has edited its mirrored AGENTS.md.
    rmSync(join(source.folder, "rules", "style.md"));
    await source.publish();
    write(join(follower.folder, "AGENTS.md"), "local drift\n");
    expect((await follower.apply()).outcome).toMatchObject({ outcome: "FollowerDrift" });
    expect(read(join(follower.folder, "AGENTS.md"))).toBe("local drift\n");
    expect(read(projectedRule)).toContain("Use two spaces.");

    write(join(follower.folder, "AGENTS.md"), "Prefer small diffs.\n");
    expect((await follower.apply()).outcome).toMatchObject({ outcome: "Converged" });
    expect(existsSync(projectedRule)).toBe(false);
  });
});
