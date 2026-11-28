import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  join,
} from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { AgentResolution } from "../../src/agent/agent-resolution.service.ts";
import type { AgentResolutionInput } from "../../src/agent/agent-resolution.types.ts";
import {
  GroupName,
  SourceSignature,
} from "../../src/domain/brand.ts";
import type { ConfigValue } from "../../src/domain/resource.ts";
import { EnrollmentLive } from "../../src/enrollment/enrollment.layer.ts";
import { Enrollment } from "../../src/enrollment/enrollment.service.ts";
import {
  enrollFollower,
  getRevisionMetadata,
} from "../../src/enrollment/follower-client.ts";
import { startSourceServer } from "../../src/enrollment/source-server.ts";
import type { SourceServerHandle } from "../../src/enrollment/enrollment.types.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { macosMachineStateLayer } from "../../src/machine/macos.layer.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import type {
  MachinePlatform,
  RenderedSchedulerJob,
  SchedulerBackend,
  SchedulerInspection,
  SchedulerSnapshot,
} from "../../src/machine/machine-state.types.ts";
import { windowsMachineStateLayer } from "../../src/machine/windows.layer.ts";
import { windowsAclWorkerScript, windowsPermissionRestoreAssemblyName } from "../../src/machine/windows-acl-worker.ts";
import { makePublication, type ProfileRevisionSigner } from "../../src/profile/publication.ts";
import { adapterFor } from "../../src/projection/adapters/index.ts";
import type { LocalSyncOptions } from "../../src/projection/sync.ts";
import { scheduleManagerLayer } from "../../src/schedule/schedule-manager.layer.ts";
import { ScheduleManager } from "../../src/schedule/schedule-manager.service.ts";
import { stateRepositoryLayer } from "../../src/state/state-repository.layer.ts";
import { StateRepository } from "../../src/state/state-repository.service.ts";
import {
  defaultScheduledInvocation,
  FollowerSynchronizationConfiguration,
} from "../../src/synchronization/follower-sync-config.ts";
import {
  recoverFollower,
  synchronizeFollower,
} from "../../src/synchronization/follower-orchestration.ts";
import { SynchronizationLive } from "../../src/synchronization/synchronization.layer.ts";

const decode = Schema.decodeUnknownSync;
const roots: Array<string> = [];
const servers: Array<SourceServerHandle> = [];
const runtimes: Array<{ readonly dispose: () => Promise<void> }> = [];

// DIAGNOSTIC (PR #502 Windows hang): every MachineState call in flight and
// every slow one, printed when the test ends or times out.
const diagnosticStart = Date.now();
const elapsed = () => `${((Date.now() - diagnosticStart) / 1000).toFixed(2)}s`;
const inflight = new Map<number, string>();
const slowCalls: Array<string> = [];
let nextCall = 0;
const describeArgument = (value: unknown): string => {
  try {
    return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) : item)?.slice(0, 200) ?? "";
  } catch {
    return String(value).slice(0, 200);
  }
};
const step = (name: string) => console.log(`DIAG ${elapsed()} step ${name}`);
const traced = <L extends Layer.Layer<MachineState, never, never>>(label: string, layer: L) =>
  Layer.effect(MachineState, Effect.map(Effect.service(MachineState), (machine) => {
    const wrapped: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(machine)) {
      wrapped[name] = typeof value !== "function" ? value : (...args: Array<unknown>) => {
        const result = (value as (...args: Array<unknown>) => unknown)(...args);
        if (!Effect.isEffect(result)) return result;
        return Effect.suspend(() => {
          const id = ++nextCall;
          const started = Date.now();
          const text = `${label}.${name}(${describeArgument(args[0])}) from ${elapsed()}`;
          inflight.set(id, text);
          return result.pipe(Effect.onExit((exit) => Effect.sync(() => {
            inflight.delete(id);
            const duration = Date.now() - started;
            if (duration >= 300) slowCalls.push(`${text} took ${duration}ms ${exit._tag}`);
          })));
        });
      };
    }
    return wrapped as unknown as MachineState["Service"];
  })).pipe(Layer.provide(layer));

afterEach(async () => {
  console.log(`DIAG ${elapsed()} afterEach after ${nextCall} calls, in-flight:\n${[...inflight.values()].join("\n")}\nslow:\n${slowCalls.join("\n")}`);
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const hostPlatform = (): MachinePlatform => {
  switch (process.platform) {
    case "linux":
      return "linux";
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      throw new Error(`unsupported acceptance host ${process.platform}`);
  }
};

const acceptancePlatform = (): MachinePlatform => {
  const platform = hostPlatform();
  const requested = process.env.CANONFIG_ACCEPTANCE_PLATFORM;
  if (requested !== undefined && requested !== platform) {
    throw new Error(
      `acceptance platform ${requested} does not match native host ${platform}`,
    );
  }
  return platform;
};

const write = (path: string, content: string, mode?: number) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
};

/** An empty executable this platform's PATH lookup accepts. */
const fakeExecutable = (platform: MachinePlatform, bin: string, name: string): string => {
  const path = join(bin, platform === "windows" ? `${name}.exe` : name);
  write(path, "", platform === "windows" ? undefined : 0o755);
  return path;
};

class RecordingScheduler implements SchedulerBackend {
  definition: RenderedSchedulerJob | undefined;
  installs = 0;
  readonly start = () => Effect.die("unused");

  readonly inspect = (
    expected: RenderedSchedulerJob,
  ): Effect.Effect<SchedulerInspection> =>
    Effect.succeed({
      installed: this.definition !== undefined,
      enabled: this.definition !== undefined,
      matches: this.definition?.service === expected.service
        && this.definition.schedule === expected.schedule,
    });

  readonly snapshot = (
    expected: RenderedSchedulerJob,
  ): Effect.Effect<SchedulerSnapshot> =>
    Effect.succeed(this.definition === undefined
      ? {
        state: "absent" as const,
        platform: expected.platform,
        mechanism: expected.mechanism,
        serviceName: expected.serviceName,
      }
      : {
        state: "present" as const,
        platform: expected.platform,
        mechanism: expected.mechanism,
        serviceName: expected.serviceName,
        enabled: true,
        servicePresent: true,
        schedulePresent: true,
        service: this.definition.service,
        schedule: this.definition.schedule,
      });

  readonly install = (
    definition: RenderedSchedulerJob,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      this.definition = definition;
      this.installs += 1;
    });

  readonly remove = (): Effect.Effect<void> =>
    Effect.sync(() => {
      this.definition = undefined;
    });

  readonly restore = (
    expected: RenderedSchedulerJob,
    snapshot: SchedulerSnapshot,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      if (snapshot.state === "absent") {
        this.definition = undefined;
        return;
      }
      this.definition = {
        ...expected,
        service: snapshot.service ?? "",
        schedule: snapshot.schedule ?? "",
      };
    });
}

interface PlatformFixture {
  readonly platform: MachinePlatform;
  readonly home: string;
  /** This machine's `~/.canonfig/`. */
  readonly folder: string;
  readonly bin: string;
  /** What the machine layer sees, and what harness roots resolve from. */
  readonly environment: Readonly<Record<string, string>>;
  readonly layer: ReturnType<typeof linuxMachineStateLayer>;
}

/**
 * One machine of `platform`: its own home, a bin directory on PATH and a
 * local-file credential store. Windows gets USERPROFILE, APPDATA and
 * LOCALAPPDATA under that home, which is where its adapters resolve roots.
 */
const machineFixture = (
  platform: MachinePlatform,
  root: string,
  scheduler?: SchedulerBackend,
): PlatformFixture => {
  const home = join(root, "home");
  const bin = join(root, "bin");
  const credentials = join(root, "credentials");
  mkdirSync(home, { recursive: true });
  fakeExecutable(platform, bin, "canonfig");
  // The Node directory stays on PATH so the published `node` tool verifies
  // as already present.
  const path = [bin, dirname(process.execPath)].join(
    platform === "windows" ? ";" : delimiter,
  );
  const environment: Record<string, string> = platform === "windows"
    ? {
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      PATH: path,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    }
    : { HOME: home, PATH: path };
  const options = {
    credentialPolicy: { kind: "local-file" as const, path: credentials },
    environment: Object.entries(environment).map(([name, value]) => ({ name, value })),
    schedulerBackend: scheduler,
  };
  const layer = platform === "linux"
    ? linuxMachineStateLayer(options)
    : platform === "macos"
    ? macosMachineStateLayer(options)
    : windowsMachineStateLayer(options);
  return { platform, home, folder: join(home, ".canonfig"), bin, environment, layer: traced(root.endsWith("source") ? "source" : "follower", layer) };
};

/** The follower's most recent run: its status and the kinds of its planned actions. */
const LatestRun = Schema.Struct({
  status: Schema.String,
  plan: Schema.fromJsonString(Schema.Struct({ actions: Schema.Array(Schema.Struct({ kind: Schema.String })) })),
});

const latestRun = (databasePath: string) => {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return decode(LatestRun)(database.prepare(`
      SELECT json_extract(outcome_json, '$.outcome') AS status, plan_json AS plan
      FROM synchronization_runs
      ORDER BY rowid DESC
      LIMIT 1
    `).get());
  } finally {
    database.close();
  }
};

describe(`cross-platform acceptance (${acceptancePlatform()})`, () => {
  // One end-to-end convergence, not a unit test: it publishes, enrolls, serves
  // blobs over TLS, converges and then recovers an interrupted run. The suite
  // default of 30s is sized for the ~1000 fast tests. This scenario has taken
  // 2.7s to 6.8s on windows-latest, and that lane has been seen stalling a
  // subprocess past ten times its usual duration, so bound it for a hang.
  it("converges one authenticated revision with deterministic cross-platform evidence", async () => {
    const platform = acceptancePlatform();
    const root = mkdtempSync(join(tmpdir(), `canonfig-acceptance-${platform}-`));
    roots.push(root);
    const scheduler = new RecordingScheduler();
    const sourceMachine = machineFixture(platform, join(root, "source"));
    const followerMachine = machineFixture(
      platform,
      join(root, "follower"),
      scheduler,
    );
    // Both listed harnesses are installed on the follower; nothing else on
    // its PATH names one.
    for (const harness of ["claude-code", "devin"] as const) {
      fakeExecutable(platform, followerMachine.bin, adapterFor(harness).descriptor.executables[0]!);
    }
    const sourceDatabase = join(root, "source.sqlite");
    // The follower's `~/.canonfig/` is where its state lives and where the
    // mirror goes. It authors nothing before enrolling.
    mkdirSync(followerMachine.folder, { recursive: true });
    const followerDatabase = join(followerMachine.folder, "state.sqlite");
    const sourceLayer = EnrollmentLive.pipe(
      Layer.provideMerge(stateRepositoryLayer(sourceDatabase)),
      Layer.provideMerge(sourceMachine.layer),
    );
    const sourceRuntime = ManagedRuntime.make(sourceLayer);
    runtimes.push(sourceRuntime);

    step("localCredential L340");
    const localCredential = await Effect.runPromise(
      Effect.flatMap(MachineState, (machine) =>
        machine.storeCredential({
          name: "acceptance-local-credential",
          value: Redacted.make("acceptance-local-value"),
        })
      ).pipe(Effect.provide(followerMachine.layer)),
    );

    // The Source's Canonical Folder. Instruction bytes carry CRLF and
    // non-ASCII text so the mirror proves byte-exact transport on every
    // platform.
    const instructions = "# Canonical acceptance\r\n東京\n";
    const skillContent = "---\nname: acceptance\ndescription: Acceptance skill\n---\nAccept.\n";
    const platformRecipes = [
      { platform: "linux", method: "apt", package: "canonfig-acceptance", version: "1.0.0" },
      { platform: "macos", method: "brew", package: "canonfig-acceptance", version: "1.0.0" },
      { platform: "windows", method: "winget", package: "Canonfig.Acceptance", version: "1.0.0" },
    ];
    const sourceConfig = {
      version: 1,
      profile: { id: "acceptance-profile", name: "Cross-platform acceptance profile" },
      harnesses: ["claude-code", "devin"],
      mcp: {
        // Requiring the agent-installed tool makes every projected output
        // wait for it, which the interrupted run below relies on.
        installer: {
          transport: "stdio",
          command: "agent-installed-tool",
          args: ["mcp"],
          requires: ["tools/agent-installed-tool"],
        },
      },
      hooks: [{ id: "format", event: "after_tool", run: ["hooks/format.sh"] }],
      settings: { "claude-code": { theme: "dark", telemetry: false } },
      tools: {
        node: { executable: "node", recipes: platformRecipes },
        "acceptance-login": {
          executable: "acceptance-login",
          recipes: platformRecipes,
          login: { required: true, howTo: "Run acceptance-login auth, then rerun synchronization." },
        },
        "agent-installed-tool": {
          executable: "agent-installed-tool",
          recipes: [],
          // A tool an agent may install says so, and says where. Without
          // this the planner refuses to invent bounds and reports a human
          // action instead of dispatching a task nothing can satisfy.
          //
          // `~` is each follower's own home, which lies inside the harness's
          // allowed root, so the two agree and the bounded task keeps the
          // path. A path outside that root would be filtered away, which is
          // what an empty allowedPaths means and why asserting one proves
          // nothing.
          agentInstall: {
            paths: ["~/.local/bin/agent-installed-tool"],
            origins: ["https://packages.example.test"],
          },
        },
      },
      credentials: { "acceptance-local": { reference: String(localCredential) } },
      groups: {
        acceptance: ["tools/acceptance-login"],
        excluded: ["skills/hidden"],
      },
      scheduleDefault: "daily@00:00",
    } satisfies Readonly<Record<string, ConfigValue>>;
    const sourceFolder = sourceMachine.folder;
    write(join(sourceFolder, "canonfig.jsonc"), `// Acceptance Source\n${JSON.stringify(sourceConfig, undefined, 2)}\n`);
    write(join(sourceFolder, "AGENTS.md"), instructions);
    write(join(sourceFolder, "skills", "acceptance", "SKILL.md"), skillContent);
    write(join(sourceFolder, "skills", "hidden", "SKILL.md"), "---\nname: hidden\ndescription: Hidden\n---\nMust stay unauthorized.\n");
    write(join(sourceFolder, "hooks", "format.sh"), "#!/bin/sh\nexit 0\n", 0o755);

    step("revision L414");
    const revision = await sourceRuntime.runPromise(Effect.gen(function*() {
      const enrollment = yield* Enrollment;
      const machine = yield* MachineState;
      const repository = yield* StateRepository;
      const source = yield* enrollment.initializeSource();
      const privateKey = createPrivateKey(Redacted.value(
        yield* machine.loadCredential({ reference: source.signingKeyReference }),
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
      return yield* makePublication(signer, repository).publish({
        folder: sourceFolder,
        reviewer: "reviewer@example.test",
        publishedAt: "2026-08-16T00:00:00Z",
      });
    }));

    step("server L439");
    const server = await sourceRuntime.runPromise(startSourceServer());
    servers.push(server);
    step("invitation L441");
    const invitation = await sourceRuntime.runPromise(
      Effect.flatMap(Enrollment, (enrollment) =>
        enrollment.createInvitation({
          endpoint: server.endpoint,
          expiresInMilliseconds: 60_000,
          groups: [decode(GroupName)("acceptance")],
        })
      ),
    );
    step("enrollment L450");
    const enrollment = await Effect.runPromise(
      enrollFollower({
        invitation,
        followerName: `${platform} acceptance follower`,
      }).pipe(Effect.provide(followerMachine.layer)),
    );
    expect(enrollment.source.publicKeyFingerprint).toBe(
      invitation.sourceFingerprint,
    );
    expect(enrollment.tlsFingerprint).toBe(invitation.tlsFingerprint);

    const follower = {
      ...enrollment.follower,
      credentialReference: enrollment.credentialReference,
    };
    const followerRepository = stateRepositoryLayer(followerDatabase);
    step("line466 L466");
    await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.saveFollowerSynchronizationConfiguration({
          sourceIdentity: enrollment.source,
          configuration: decode(FollowerSynchronizationConfiguration)({
            schemaVersion: 1,
            lifecycle: { _tag: "Active" },
            follower,
            profile: revision.profileId,
            source: {
              endpoint: server.endpoint,
              tlsFingerprint: enrollment.tlsFingerprint,
              signingFingerprint: enrollment.source.publicKeyFingerprint,
            },
            credentialReference: enrollment.credentialReference,
            cacheDirectory: join(root, "follower-cache"),
            stateLocation: followerDatabase,
            agentPolicy: "agent-apply",
            agentHarness: {
              kind: "codex",
              executable: process.execPath,
              maximumInputBytes: 16_384,
              allowedPaths: [followerMachine.home],
              allowedExecutables: [],
              // The follower grants the origin the profile asks for. Both
              // sides have to agree: `agentInstall` says what would be
              // acceptable, the harness says what is actually permitted.
              allowedOrigins: ["https://packages.example.test"],
              allowedCapabilities: [],
            },
            scheduledInvocation: {
              ...defaultScheduledInvocation,
              timeoutMilliseconds: 10_000,
            },
            updatedAt: "2026-08-16T00:00:01Z",
          }),
        })
      ).pipe(Effect.provide(followerRepository)),
    );

    const agentInstalledExecutable = join(
      followerMachine.bin,
      platform === "windows" ? "agent-installed-tool.exe" : "agent-installed-tool",
    );
    const agentInputs: Array<AgentResolutionInput> = [];
    // Set to stop the run the way an operator's interrupt would while the
    // agent works; the next resolution then installs the tool.
    let interruptNextResolution = false;
    const agent = AgentResolution.of({
      resolve: (input) =>
        Effect.gen(function*() {
          agentInputs.push(input);
          if (interruptNextResolution) {
            interruptNextResolution = false;
            return yield* Effect.interrupt;
          }
          if (input.policy === "agent-apply") fakeExecutable(platform, followerMachine.bin, "agent-installed-tool");
          return {
            outcome: "applied" as const,
            task: input.task,
            proposal: { summary: "Accepted bounded acceptance resolution", actions: [] },
            harness: {
              executable: process.execPath,
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
              stdout: "verified",
              stderr: "",
              matched: true,
            },
          };
        }),
    });
    const synchronization = SynchronizationLive.pipe(
      Layer.provide(Layer.merge(followerRepository, followerMachine.layer)),
    );
    const schedules = scheduleManagerLayer.pipe(
      Layer.provide(followerMachine.layer),
    );
    const application = Layer.mergeAll(
      followerRepository,
      followerMachine.layer,
      schedules,
      synchronization,
      Layer.succeed(AgentResolution, agent),
    );
    const projection: LocalSyncOptions = {
      noBackup: false,
      environment: (name) => followerMachine.environment[name],
    };
    const sync = (mode: "plan" | "apply") =>
      Effect.runPromise(
        synchronizeFollower(followerDatabase, mode, projection).pipe(
          Effect.provide(application),
        ),
      );

    step("metadata L571");
    const metadata = await Effect.runPromise(
      getRevisionMetadata({
        endpoint: server.endpoint,
        tlsFingerprint: enrollment.tlsFingerprint,
        credentialReference: enrollment.credentialReference,
        sourceFingerprint: enrollment.source.publicKeyFingerprint,
        revisionId: revision.id,
      }).pipe(Effect.provide(followerMachine.layer)),
    );
    expect(metadata.id).toBe(revision.id);
    const visibleIds = metadata.resources.map((entry) => entry.id);
    // Group membership decides what reaches the follower: its own group's
    // tool does, the other group's skill does not.
    expect(visibleIds).toContain("tools:acceptance-login");
    expect(visibleIds).not.toContain("skills:hidden");
    const visibleBlobCount = new Set(
      metadata.resources.flatMap((resource) => resource.blobs),
    ).size;

    step("initial L590");
    const initial = await sync("plan");
    if (!("plan" in initial) || initial.plan === undefined) {
      throw new Error("acceptance planning did not return a synchronization plan");
    }
    expect(initial.revision).toBe(revision.id);
    expect(initial.downloadedBlobs).toBe(visibleBlobCount);
    expect(initial.reusedBlobs).toBe(0);
    expect(initial.plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resource: "tools:acceptance-login",
        detail: expect.objectContaining({
          kind: "install-tool",
          method: platform === "linux"
            ? "apt"
            : platform === "macos"
            ? "brew"
            : "winget",
        }),
      }),
      expect.objectContaining({
        resource: "tools:acceptance-login",
        detail: expect.objectContaining({
          kind: "human-action",
          instructions: "Run acceptance-login auth, then rerun synchronization.",
        }),
      }),
    ]));
    expect(initial.agentResolutions).toHaveLength(1);
    expect(agentInputs[0]?.scheduled).toBe(false);
    expect(agentInputs[0]?.task).toMatchObject({
      // The declared install path survived the harness bounds, which is what
      // makes this task capable of installing anything at all.
      allowedPaths: [join(followerMachine.home, ".local", "bin", "agent-installed-tool")],
      allowedExecutables: [],
      allowedOrigins: ["https://packages.example.test"],
      forbidden: ["elevation", "login", "restart", "reboot"],
      timeLimitSeconds: 300,
      outputLimitBytes: 65_536,
    });

    // The follower already has a settings file of its own; projection merges
    // into it instead of replacing it.
    const claudeRoot = join(followerMachine.home, ".claude");
    const claudeSettings = join(claudeRoot, "settings.json");
    write(claudeSettings, `${JSON.stringify({ model: "local-choice" })}\n`);
    fakeExecutable(platform, followerMachine.bin, "acceptance-login");
    fakeExecutable(platform, followerMachine.bin, "agent-installed-tool");
    step("first L637");
    const first = await sync("apply");
    expect(first.outcome?.outcome, JSON.stringify(first.outcome)).toBe("Converged");
    // Devin is the adapter whose root differs per platform: %APPDATA% on
    // Windows, ~/.config elsewhere. Claude Code's root is under the home
    // directory (USERPROFILE on Windows) everywhere.
    const devinRoot = platform === "windows"
      ? join(followerMachine.environment.APPDATA!, "devin")
      : join(followerMachine.home, ".config", "devin");
    expect(first).toMatchObject({
      revision: revision.id,
      downloadedBlobs: 0,
      reusedBlobs: visibleBlobCount,
      harnesses: [
        { harness: "claude-code", root: claudeRoot },
        { harness: "devin", root: devinRoot },
      ],
    });

    // The mirror: published bytes at the same place in this machine's
    // `~/.canonfig/`, and canonfig.jsonc rendered from the authorized entries
    // only (tools, credentials, groups and the profile id are applied, not
    // mirrored).
    const mirrorSkill = join(followerMachine.folder, "skills", "acceptance");
    expect(await readFile(join(followerMachine.folder, "AGENTS.md"), "utf8")).toBe(instructions);
    expect(await readFile(join(mirrorSkill, "SKILL.md"), "utf8")).toBe(skillContent);
    expect(existsSync(join(followerMachine.folder, "skills", "hidden"))).toBe(false);
    // canonfig.jsonc without its leading `//` comment lines.
    const mirrorConfig = JSON.parse(
      (await readFile(join(followerMachine.folder, "canonfig.jsonc"), "utf8")).replace(/^\/\/.*$/gmu, ""),
    );
    expect(mirrorConfig).toMatchObject({
      harnesses: ["claude-code", "devin"],
      settings: { "claude-code": { theme: "dark", telemetry: false } },
    });
    expect(Object.keys(mirrorConfig.mcp)).toEqual(["installer"]);
    for (const key of ["profile", "tools", "credentials", "groups", "scheduleDefault"]) {
      expect(mirrorConfig[key], key).toBeUndefined();
    }

    // The projection, at each harness's platform root.
    expect(await readFile(join(claudeRoot, "CLAUDE.md"), "utf8")).toContain("東京");
    expect(await readFile(join(devinRoot, "AGENTS.md"), "utf8")).toContain("東京");
    expect(await readFile(join(claudeRoot, "skills", "acceptance", "SKILL.md"), "utf8")).toContain("Accept.");
    // Devin reads skills from the shared ~/.agents/skills/.
    expect(await readFile(join(followerMachine.home, ".agents", "skills", "acceptance", "SKILL.md"), "utf8")).toContain("Accept.");
    expect(existsSync(join(claudeRoot, "skills", "hidden"))).toBe(false);
    expect(existsSync(join(followerMachine.home, ".agents", "skills", "hidden"))).toBe(false);
    expect(JSON.parse(await readFile(claudeSettings, "utf8"))).toMatchObject({
      model: "local-choice",
      theme: "dark",
      telemetry: false,
    });
    expect(Object.keys(JSON.parse(await readFile(join(followerMachine.home, ".claude.json"), "utf8")).mcpServers)).toEqual(["installer"]);
    expect(Object.keys(JSON.parse(await readFile(join(devinRoot, "mcp_config.json"), "utf8")).mcpServers)).toEqual(["installer"]);
    // POSIX file modes: what Canonfig writes is private to the user, and a
    // published executable stays executable only for the user. Windows has
    // no mode bits to compare.
    if (platform !== "windows") {
      const mode = (path: string) => statSync(path).mode & 0o777;
      expect(mode(join(followerMachine.folder, "AGENTS.md"))).toBe(0o600);
      expect(mode(join(followerMachine.folder, "hooks", "format.sh"))).toBe(0o700);
      expect(mode(join(claudeRoot, "CLAUDE.md"))).toBe(0o600);
    }

    step("second L701");
    const second = await sync("apply");
    expect(second).toMatchObject({
      downloadedBlobs: 0,
      reusedBlobs: visibleBlobCount,
      outcome: { outcome: "Converged" },
    });
    expect(server.blobRequests()).toBe(visibleBlobCount);
    expect(latestRun(followerDatabase).plan.actions.filter(
      (action) => action.kind !== "no-op",
    )).toEqual([]);

    step("line712 L712");
    await Effect.runPromise(
      Effect.flatMap(MachineState, (machine) =>
        machine.removeCredential(localCredential)
      ).pipe(Effect.provide(followerMachine.layer)),
    );
    step("human L717");
    const human = await sync("apply");
    expect(human.outcome).toMatchObject({
      outcome: "HumanActionRequired",
      actions: [
        expect.objectContaining({
          resource: "credentials:acceptance-local",
          reason: expect.stringContaining("unavailable"),
        }),
      ],
    });
    step("restoredCredential L727");
    const restoredCredential = await Effect.runPromise(
      Effect.flatMap(MachineState, (machine) =>
        machine.storeCredential({
          name: "acceptance-local-credential",
          value: Redacted.make("acceptance-local-value"),
        })
      ).pipe(Effect.provide(followerMachine.layer)),
    );
    expect(restoredCredential).toBe(localCredential);

    // A local edit to a mirror file is Follower Drift: kept, reported, and
    // what is projected from it holds still.
    const projectedSkill = join(claudeRoot, "skills", "acceptance", "SKILL.md");
    await writeFile(join(mirrorSkill, "SKILL.md"), "# locally modified\n");
    step("drifted L741");
    const drifted = await sync("apply");
    expect(drifted.outcome).toMatchObject({
      outcome: "FollowerDrift",
      conflicts: [
        expect.objectContaining({
          resource: "skills:acceptance",
          target: mirrorSkill,
        }),
      ],
    });
    expect(await readFile(join(mirrorSkill, "SKILL.md"), "utf8")).toBe("# locally modified\n");
    expect(await readFile(projectedSkill, "utf8")).toContain("Accept.");
    await writeFile(join(mirrorSkill, "SKILL.md"), skillContent);

    const scheduleLayer = scheduleManagerLayer.pipe(
      Layer.provide(followerMachine.layer),
    );
    step("installedSchedule L758");
    const installedSchedule = await Effect.runPromise(
      Effect.flatMap(ScheduleManager, (manager) =>
        manager.install({ executable: process.execPath })
      ).pipe(Effect.provide(scheduleLayer)),
    );
    // CF-47: a converged apply never installs the profile scheduleDefault, so
    // this explicit install creates the first native job.
    expect(installedSchedule.change).toBe("installed");
    expect(installedSchedule.status.platform).toBe(platform);
    expect(installedSchedule.status.definition.mechanism).toBe(
      platform === "linux"
        ? "systemd-user-timer"
        : platform === "macos"
        ? "launchd-user-agent"
        : "task-scheduler",
    );
    expect(scheduler.installs).toBe(1);
    step("unchangedSchedule L775");
    const unchangedSchedule = await Effect.runPromise(
      Effect.flatMap(ScheduleManager, (manager) =>
        manager.install({ executable: process.execPath })
      ).pipe(Effect.provide(scheduleLayer)),
    );
    expect(unchangedSchedule.change).toBe("unchanged");
    expect(scheduler.installs).toBe(1);

    // An interrupted run: the tool the MCP server requires is gone, so the
    // agent task to reinstall it runs before any projected output, and the
    // run is stopped while the agent works. The hook runner (a `replace`
    // output) was changed locally and the run never got to it.
    const runtimeDirectory = join(followerMachine.folder, ".runtime");
    const hookRunner = join(runtimeDirectory, (await readdir(runtimeDirectory)).find((name) => name.startsWith("hook-runner."))!);
    const canonicalHookRunner = await readFile(hookRunner, "utf8");
    await rm(agentInstalledExecutable);
    await writeFile(hookRunner, "interrupted local state\n");
    interruptNextResolution = true;
    step("line793 L793");
    await expect(sync("apply")).rejects.toThrow();
    const interrupted = latestRun(followerDatabase);
    expect(interrupted.status).toBe("Interrupted");
    expect(await readFile(hookRunner, "utf8")).toBe("interrupted local state\n");

    step("recovered L798");
    const recovered = await Effect.runPromise(
      recoverFollower(followerDatabase).pipe(Effect.provide(application)),
    );
    expect(recovered.revision.startsWith(`${revision.id}:view:`), recovered.revision).toBe(true);
    expect(recovered.outcome.outcome, JSON.stringify(recovered.outcome)).toBe("Converged");
    expect(existsSync(agentInstalledExecutable)).toBe(true);
    expect(await readFile(hookRunner, "utf8")).toBe(canonicalHookRunner);
    expect(await readFile(join(mirrorSkill, "SKILL.md"), "utf8")).toBe(skillContent);
    step("done");
  }, 60_000);

  // DIAGNOSTIC (PR #502 Windows hang): time the real PowerShell ACL worker
  // under the environments and spawn flags in play, then fail so the output
  // is printed.
  it.skipIf(process.platform !== "win32")("DIAGNOSTIC PowerShell ACL worker matrix", async () => {
    const report: Array<string> = [];
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const run = async (label: string, environment: NodeJS.ProcessEnv, windowsHide: boolean, assembly: string, root: string) => {
      const started = Date.now();
      const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsAclWorkerScript(assembly)], {
        env: environment, shell: false, stdio: "pipe", windowsHide,
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-1500); });
      const lines: Array<string> = [];
      let waiting: ((line: string | undefined) => void) | undefined;
      createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
        if (waiting === undefined) lines.push(line);
        else { const resolve = waiting; waiting = undefined; resolve(line); }
      });
      let closed = false;
      const closedPromise = new Promise<void>((resolve) => child.once("close", () => { closed = true; resolve(); }));
      let id = 0;
      const ask = async (request: Record<string, unknown>) => {
        const sent = Date.now();
        child.stdin.write(`${JSON.stringify({ id: ++id, ...request })}\n`);
        const line = lines.shift() ?? await new Promise<string | undefined>((resolve) => {
          waiting = resolve;
          setTimeout(() => { if (waiting === resolve) { waiting = undefined; resolve(undefined); } }, 20_000);
        });
        report.push(`${label} ${String(request.op)} ${request.directory === true ? "dir" : "file"}: ${Date.now() - sent}ms ${line === undefined ? "NO REPLY" : line.slice(0, 160)}`);
        return line;
      };
      const file = join(root, "file.txt");
      const directory = join(root, "dir");
      writeFileSync(file, "content");
      mkdirSync(directory, { recursive: true });
      const snapshot = await ask({ op: "snapshot", path: file, directory: false });
      if (snapshot !== undefined) {
        const descriptor = (JSON.parse(snapshot) as { descriptor?: string }).descriptor;
        if (descriptor !== undefined) await ask({ op: "restore", path: file, directory: false, descriptor });
      }
      await ask({ op: "snapshot", path: directory, directory: true });
      const ending = Date.now();
      child.stdin.end();
      const exited = await Promise.race([closedPromise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000))]);
      report.push(`${label} graceful exit: ${exited ? `${Date.now() - ending}ms` : "NOT WITHIN 10s"}; total ${Date.now() - started}ms; stderr: ${stderr.trim().slice(0, 600)}`);
      if (!closed) {
        spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"]);
        await Promise.race([closedPromise, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      }
    };
    for (const environmentKind of ["minimal", "full"] as const) {
      for (const windowsHide of [true, false]) {
        const root = mkdtempSync(join(tmpdir(), "canonfig-acl-matrix-"));
        roots.push(root);
        const home = join(root, "home");
        mkdirSync(home, { recursive: true });
        const local = join(home, "AppData", "Local");
        const environment: NodeJS.ProcessEnv = environmentKind === "minimal"
          ? {
            USERPROFILE: home,
            APPDATA: join(home, "AppData", "Roaming"),
            LOCALAPPDATA: local,
            PATH: [join(root, "bin"), dirname(process.execPath)].join(";"),
            PATHEXT: ".COM;.EXE;.BAT;.CMD",
            SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
          }
          : { ...process.env, LOCALAPPDATA: local };
        const assembly = join(local, "canonfig", "native", windowsPermissionRestoreAssemblyName);
        const label = `[${environmentKind} env, windowsHide ${windowsHide}]`;
        await run(`${label} first worker`, environment, windowsHide, assembly, root);
        await run(`${label} second worker`, environment, windowsHide, assembly, root);
      }
    }
    console.log(`DIAG matrix\n${report.join("\n")}`);
    throw new Error(`diagnostic matrix:\n${report.join("\n")}`);
  }, 300_000);
});
