import { Effect, Layer, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  evaluateCli,
  runCli,
  type CliIo,
} from "../src/cli/cli.ts";
import {
  CliExitCode,
  type CliFailureCategory,
} from "../src/cli/exit-codes.ts";
import {
  FollowerCommands,
  type FollowerCommandsService,
} from "../src/cli/follower-commands.ts";
import {
  renderCliResult,
} from "../src/cli/render.ts";
import {
  CliCommandFailure,
  SourceCommands,
  type CliPayload,
  type SourceCommandsService,
} from "../src/cli/source-commands.ts";
import {
  SetupCommands,
  type SetupCommandsService,
} from "../src/cli/setup-commands.ts";
import { BlobTransferProgress } from "../src/enrollment/blob-transfer-progress.ts";
import { clientReviewSteps, plannedFileChanges } from "../src/synchronization/client-review.ts";
import { profileFileFailure } from "../src/runtime/layers.ts";
import { decodeMachineProfileJsonc } from "../src/domain/profile.ts";
import { PlannedAction } from "../src/domain/synchronization.ts";

interface Invocation {
  readonly route: string;
  readonly input?: CliPayload | undefined;
}

const invitation = Buffer.from(JSON.stringify({
  code: "invitation-code",
  nonce: "invitation-nonce",
  endpoint: "https://127.0.0.1:17342",
  sourceFingerprint: "source-fingerprint",
  tlsFingerprint: "tls-fingerprint",
  groups: ["developers"],
  expiresAt: "2026-08-16T00:00:00.000Z",
})).toString("base64url");

const recordingLayers = (
  invocations: Array<Invocation>,
  failure?: CliFailureCategory,
  synchronize?: FollowerCommandsService["synchronize"],
) => {
  const invoke = (
    route: string,
    input?: CliPayload,
  ): Effect.Effect<CliPayload, CliCommandFailure> => {
    invocations.push(input === undefined ? { route } : { route, input });
    return failure === undefined
      ? Effect.succeed({ route })
      : Effect.fail(new CliCommandFailure({
        category: failure,
        message: `${failure} failure`,
        details: { credential: "must-not-leak" },
      }));
  };
  const source: SourceCommandsService = {
    initialize: () => invoke("source.init"),
    scan: (input) => invoke("source.scan", input),
    publish: (input) => invoke("source.publish", input),
    digest: (input) => invoke("source.digest", input),
    serve: (input) => invoke("source.serve", input),
    installService: (input) => invoke("source.service.install", input),
    serviceStatus: () => invoke("source.service.status"),
    removeService: () => invoke("source.service.remove"),
    invite: (input) => invoke("source.invite", input),
    revoke: (input) => invoke("source.revoke", input),
    listProfiles: () => invoke("profile.list"),
    inspectProfile: (input) => invoke("profile.show", input),
  };
  const follower: FollowerCommandsService = {
    enroll: (input) => invoke("follower.enroll", input),
    synchronize: synchronize ?? ((input) => invoke("sync", input)),
    recover: (input) => invoke("recover", input),
    abandon: () => invoke("abandon", {}),
    status: (input) => invoke("status", input),
    setLocalOverlay: (input) => invoke("overlay.set", input),
    listLocalOverlays: () => invoke("overlay.list"),
    removeLocalOverlay: (input) => invoke("overlay.remove", input),
    setAgentPolicy: (input) => invoke("agent.policy.set", input),
    getAgentPolicy: () => invoke("agent.policy.get"),
    setAgentHarness: (input) => invoke("agent.harness.set", input),
    getAgentHarness: () => invoke("agent.harness.get"),
    selectProfile: (input) => invoke("profile.select", input),
    setSchedule: (input) => invoke("schedule.set", input),
    scheduleStatus: () => invoke("schedule.status"),
    removeSchedule: () => invoke("schedule.remove"),
    doctor: () => invoke("doctor"),
    startTunnel: (input) => invoke("tunnel.start", input),
    restartTunnel: (input) => invoke("tunnel.restart", input),
    tunnelStatus: () => invoke("tunnel.status"),
    stopTunnel: (input) => invoke("tunnel.stop", input),
  };
  const setup: SetupCommandsService = {
    plan: (input) => invoke("setup.plan", input),
    approve: (input) => invoke("setup.approve", input),
    apply: () => invoke("setup.apply"),
    status: () => invoke("setup.status"),
  };
  return Layer.mergeAll(
    Layer.succeed(SourceCommands, SourceCommands.of(source)),
    Layer.succeed(FollowerCommands, FollowerCommands.of(follower)),
    Layer.succeed(SetupCommands, SetupCommands.of(setup)),
  );
};

const execute = async (
  arguments_: ReadonlyArray<string>,
  failure?: CliFailureCategory,
  synchronize?: FollowerCommandsService["synchronize"],
) => {
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];
  const exitCodes: Array<number> = [];
  const invocations: Array<Invocation> = [];
  const io: CliIo = {
    writeStdout: (text) => stdout.push(text),
    writeStderr: (text) => stderr.push(text),
    setExitCode: (code) => exitCodes.push(code),
  };
  await Effect.runPromise(
    runCli(arguments_, io).pipe(
      Effect.provide(recordingLayers(invocations, failure, synchronize)),
    ),
  );
  return {
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    exitCode: exitCodes.at(-1),
    invocations,
  };
};

describe("typed CLI command boundary", () => {
  it.each([
    [["source", "init"], "source.init"],
    [["source", "scan", "--file", "AGENTS.md"], "source.scan"],
    [[
      "source",
      "publish",
      "--proposal",
      "proposal.json",
      "--profile",
      "workstation",
      "--name",
      "Workstation",
      "--reviewer",
      "operator",
    ], "source.publish"],
    [[
      "source",
      "publish",
      "--profile-file",
      "profile.jsonc",
      "--reviewer",
      "operator",
    ], "source.publish"],
    [["source", "digest", "--profile-file", "profile.jsonc", "--resource", "codex-config"], "source.digest"],
    [["source", "serve"], "source.serve"],
    [[
      "source",
      "invite",
      "--endpoint",
      "https://127.0.0.1:17342",
      "--group",
      "developers",
      "--output",
      "/tmp/canonfig-invite",
    ], "source.invite"],
    [["source", "revoke", "follower-one"], "source.revoke"],
    [
      // --profile is required: the help text always showed it as required and
      // the runtime always refused without it, but the parser used to accept
      // its absence and hint at a usage line that omitted it.
      ["follower", "enroll", invitation, "--name", "workstation", "--profile", "base"],
      "follower.enroll",
    ],
    [["sync", "--plan"], "sync"],
    [["sync", "--apply"], "sync"],
    [["recover"], "recover"],
    [["abandon"], "abandon"],
    [["status", "--follower", "follower-one"], "status"],
    [["overlay", "list"], "overlay.list"],
    [[
      "overlay",
      "set",
      "config-one",
      "--target",
      "/home/user/config.json",
      "--key",
      "local.theme",
    ], "overlay.set"],
    [["overlay", "remove", "config-one"], "overlay.remove"],
    [["doctor"], "doctor"],
    [["profile", "list"], "profile.list"],
    [["profile", "show", "revision-one"], "profile.show"],
    [["profile", "select", "profile-one"], "profile.select"],
    [["agent", "policy"], "agent.policy.get"],
    [["agent", "policy", "agent-propose"], "agent.policy.set"],
    [["agent", "harness"], "agent.harness.get"],
    [[
      "agent",
      "harness",
      "codex",
      "--executable",
      "/opt/codex",
      "--bind-secret",
      "MCP_TOKEN=shared-mcp-token",
      "--allow-path",
      "/tmp/canonfig",
      "--allow-leaf-executable",
      "npm",
      "--allow-origin",
      "https://registry.npmjs.org",
    ], "agent.harness.set"],
    [[
      "tunnel",
      "start",
      "--invitation",
      "/tmp/canonfig-invite",
      "--ssh-host",
      "source.example",
      "--ssh-user",
      "operator",
      "--ssh-host-key-file",
      "/tmp/source-host-key.pub",
    ], "tunnel.start"],
    [["tunnel", "start"], "tunnel.restart"],
    [["tunnel", "start", "--timeout-ms", "5000"], "tunnel.restart"],
    [["tunnel", "status"], "tunnel.status"],
    [["tunnel", "stop"], "tunnel.stop"],
    [["tunnel", "stop", "--forget"], "tunnel.stop"],
    [["source", "service", "install", "--port", "17400"], "source.service.install"],
    [["source", "service", "status"], "source.service.status"],
    [["source", "service", "remove"], "source.service.remove"],
    [[
      "setup",
      "plan",
      "--role",
      "source",
      "--file",
      "AGENTS.md",
      "--intent",
      "prepare source",
    ], "setup.plan"],
    [["setup", "approve", "--approver", "operator"], "setup.approve"],
    [["setup", "apply"], "setup.apply"],
    [["setup", "status"], "setup.status"],
    [["schedule", "set", "daily@00:00"], "schedule.set"],
    [["schedule", "set", "weekly:Mon@12:30"], "schedule.set"],
    [["schedule", "set", "--default"], "schedule.set"],
    [["schedule", "status"], "schedule.status"],
    [["schedule", "remove"], "schedule.remove"],
  ] as const)("routes %j through %s", async (arguments_, expectedRoute) => {
    const result = await execute([...arguments_, "--json"]);
    expect(result.exitCode).toBe(CliExitCode.success);
    expect(result.stderr).toBe("");
    expect(result.invocations).toHaveLength(1);
    expect(result.invocations[0]?.route).toBe(expectedRoute);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: "canonfig.cli/v1",
      status: "success",
      exitCode: 0,
    });
  });

  it("routes setup plan scope through to the service input", async () => {
    const scoped = await execute(["setup", "plan", "--role", "source", "--scope", "cli-only", "--json"]);
    expect(scoped.invocations).toEqual([{
      route: "setup.plan",
      input: { role: "source", scope: "cli-only", files: [], intent: undefined },
    }]);
    const byDefault = await execute(["setup", "plan", "--role", "follower", "--json"]);
    expect(byDefault.invocations).toEqual([{
      route: "setup.plan",
      input: { role: "follower", scope: "full", files: [], intent: undefined },
    }]);
  });

  it("decodes symbolic secret bindings into harness configuration", async () => {
    const result = await execute([
      "agent",
      "harness",
      "codex",
      "--executable",
      "/opt/codex",
      "--bind-secret",
      "MCP_TOKEN=shared-mcp-token",
      "--json",
    ]);

    expect(result.exitCode).toBe(CliExitCode.success);
    expect(result.invocations).toEqual([{
      route: "agent.harness.set",
      input: expect.objectContaining({
        secretBindings: [{
          name: "MCP_TOKEN",
          secret: "shared-mcp-token",
        }],
      }),
    }]);
  });

  it("decodes schedule, identifiers, and enrollment invitation before dispatch", async () => {
    const schedule = await execute([
      "schedule",
      "set",
      "weekly:Fri,Mon,Fri@23:15",
      "--timezone",
      "Europe/Paris",
      "--executable",
      "/opt/canonfig",
    ]);
    expect(schedule.invocations[0]?.input).toEqual({
      schedule: {
        kind: "weekly",
        weekdays: ["Mon", "Fri"],
        localTime: "23:15",
        timezone: "Europe/Paris",
      },
      executable: "/opt/canonfig",
    });

    const enrollment = await execute([
      "follower",
      "enroll",
      invitation,
      "--name",
      "laptop",
      "--profile",
      "workstation",
    ]);
    expect(enrollment.invocations[0]?.input).toMatchObject({
      followerName: "laptop",
      invitation: {
        code: "invitation-code",
        groups: ["developers"],
      },
    });

    const harness = await execute([
      "agent",
      "harness",
      "claude",
      "--executable",
      "/opt/claude",
      "--allow-path",
      "/home/operator",
      "--allow-leaf-executable",
      "npm",
      "--allow-origin",
      "https://registry.npmjs.org",
      "--allow-capability",
      "restart",
      "--maximum-input-bytes",
      "4096",
    ]);
    expect(harness.invocations[0]?.input).toEqual({
      kind: "claude",
      executable: "/opt/claude",
      maximumInputBytes: 4096,
      secretBindings: [],
      allowedPaths: ["/home/operator"],
      allowedExecutables: ["npm"],
      executableAuthorizations: [{ executable: "npm", behavior: "leaf" }],
      allowedOrigins: ["https://registry.npmjs.org"],
      allowedCapabilities: ["restart"],
    });
  });

  it("carries authored profile input separately from discovery review input", async () => {
    const result = await execute([
      "source",
      "publish",
      "--proposal",
      "proposal.json",
      "--profile-file",
      "profile.jsonc",
      "--reviewer",
      "operator",
    ]);
    expect(result.invocations[0]?.input).toEqual({
      proposalPath: "proposal.json",
      profilePath: "profile.jsonc",
      reviewer: "operator",
      allowEmpty: false,
    });
    const empty = await execute([
      "source",
      "publish",
      "--profile-file",
      "profile.jsonc",
      "--reviewer",
      "operator",
      "--allow-empty",
    ]);
    expect(empty.invocations[0]?.input).toMatchObject({ allowEmpty: true });
  });

  it("emits a CLI envelope for a usage error when --json is requested", async () => {
    // Every post-parse failure was already an envelope; parse failures printed
    // two human lines whatever the output mode, so a program driving Canonfig
    // with --json got unparseable text for the whole class.
    const result = await execute(["sync", "--plan", "--apply", "--json"]);
    expect(result.exitCode).toBe(CliExitCode.usageOrConfiguration);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      schema: "canonfig.cli/v1",
      command: "usage",
      status: "error",
      exitCode: CliExitCode.usageOrConfiguration,
      message: "--plan and --apply are mutually exclusive",
    });
  });

  it("keeps the help hint out of the envelope but in human output", async () => {
    const human = await execute(["sync", "--plan", "--apply"]);
    expect(human.stderr).toBe(
      "--plan and --apply are mutually exclusive\nRun 'canonfig --help' for usage.\n",
    );
  });

  it("reports a bare option list as a missing command", async () => {
    // `canonfig --json` used to produce the empty message `Unknown argument: `.
    const result = await execute(["--json"]);
    expect(result.exitCode).toBe(CliExitCode.usageOrConfiguration);
    expect(JSON.parse(result.stderr)).toMatchObject({
      command: "usage",
      status: "error",
      message: "Missing command",
    });
  });

  it("blames a stray argument rather than the command that received it", async () => {
    // These reported `Unknown schedule command: status`, naming the action as
    // unknown when the problem was the extra argument.
    for (
      const arguments_ of [
        ["schedule", "status", "extra"],
        ["schedule", "remove", "extra"],
      ]
    ) {
      const result = await execute(arguments_);
      expect(result.exitCode).toBe(CliExitCode.usageOrConfiguration);
      expect(result.stderr).toContain(
        `canonfig schedule ${arguments_[1]} accepts no arguments`,
      );
      expect(result.stderr).not.toContain("Unknown schedule command");
    }
  });

  it("reports an unknown option as an unknown option", async () => {
    for (
      const arguments_ of [
        ["schedule", "status", "--executable", "/x"],
        ["agent", "policy", "--no-input"],
      ]
    ) {
      const result = await execute(arguments_);
      expect(result.exitCode).toBe(CliExitCode.usageOrConfiguration);
      expect(result.stderr).toContain("Unknown option:");
    }
  });

  it("routes --replace through to enrollment", async () => {
    const result = await execute([
      "follower",
      "enroll",
      invitation,
      "--name",
      "laptop",
      "--profile",
      "workstation",
      "--replace",
      "--json",
    ]);
    expect(result.exitCode).toBe(CliExitCode.success);
    expect(result.invocations[0]?.input).toMatchObject({
      followerName: "laptop",
      replace: true,
    });
  });

  it("defaults --replace to false", async () => {
    const result = await execute([
      "follower",
      "enroll",
      invitation,
      "--name",
      "laptop",
      "--profile",
      "workstation",
      "--json",
    ]);
    expect(result.invocations[0]?.input).toMatchObject({ replace: false });
  });

  it("requires the --profile the enroll usage line promises", async () => {
    const result = await execute(["follower", "enroll", invitation, "--name", "laptop"]);
    expect(result.exitCode).toBe(CliExitCode.usageOrConfiguration);
    expect(result.stderr).toContain("Missing required option: --profile");
  });

  it("restarts the recorded tunnel only when no new configuration is given", async () => {
    const result = await execute(["tunnel", "start", "--ssh-host", "source.example"]);
    expect(result.exitCode).toBe(CliExitCode.usageOrConfiguration);
    expect(result.invocations).toEqual([]);
    expect(result.stderr).toContain("pass --invitation to configure a new tunnel");
  });

  it("reports the exit code it set, so source serve can wait only on success", async () => {
    // `source serve` keeps the process alive; main.ts decides that from this
    // result, because runCli turns every failure into an exit code rather than
    // into a failed effect.
    const succeeded = await Effect.runPromise(
      runCli(["source", "serve"], {
        writeStdout: () => {},
        writeStderr: () => {},
        setExitCode: () => {},
      }).pipe(Effect.provide(recordingLayers([]))),
    );
    expect(succeeded).toBe(CliExitCode.success);
    const failed = await Effect.runPromise(
      runCli(["source", "serve"], {
        writeStdout: () => {},
        writeStderr: () => {},
        setExitCode: () => {},
      }).pipe(Effect.provide(recordingLayers([], "transport"))),
    );
    expect(failed).toBe(CliExitCode.transport);
  });

  it("rejects malformed and ambiguous inputs before selecting a service", async () => {
    for (const arguments_ of [
      ["sync", "--plan", "--apply"],
      ["source", "revoke", "not valid"],
      ["follower", "enroll", "not-base64", "--name", "host"],
      ["schedule", "set", "weekly:Funday@99:00"],
      ["schedule", "set", "--default", "daily@04:00"],
      ["schedule", "set", "--default", "--timezone", "Europe/Paris"],
      ["source", "invite", "--endpoint", "http://example.test"],
      ["agent", "harness", "unsupported", "--executable", "agent"],
      [
        "agent",
        "harness",
        "codex",
        "--executable",
        "codex",
        "--allow-origin",
        "https://example.test/path",
      ],
      ["legacy-source", "init"],
    ]) {
      const result = await execute(arguments_);
      expect(result.exitCode).toBe(CliExitCode.usageOrConfiguration);
      expect(result.invocations).toEqual([]);
      expect(result.stderr).toContain("Run 'canonfig --help' for usage.");
    }
  });

  it("carries --no-input to apply and recovery without a prompting seam", async () => {
    const apply = await execute(["sync", "--apply", "--no-input"]);
    expect(apply.invocations).toEqual([{
      route: "sync",
      input: { mode: "apply", noInput: true, scheduled: false },
    }]);
    expect(apply.stdout).toBe("");
    const recover = await execute(["recover", "--no-input"]);
    expect(recover.invocations).toEqual([{
      route: "recover",
      input: { noInput: true },
    }]);
    const scheduled = await execute(["sync", "--apply", "--no-input", "--scheduled"]);
    expect(scheduled.invocations).toEqual([{
      route: "sync",
      input: { mode: "apply", noInput: true, scheduled: true },
    }]);
  });

  it("rejects classifying a nested-command launcher as bounded at parse time", async () => {
    for (const launcher of ["xargs", "find", "awk", "perl", "make", "npx"]) {
      const result = await execute([
        "agent",
        "harness",
        "codex",
        "--executable",
        "/opt/codex",
        "--allow-path",
        "/home/operator",
        "--allow-leaf-executable",
        launcher,
      ]);
      expect(result.exitCode).toBe(CliExitCode.usageOrConfiguration);
      expect(result.invocations).toEqual([]);
      expect(result.stderr).toContain("nested commands");
    }
  });

  it("rejects the removed script-interpreter authorization option", async () => {
    const result = await execute([
      "agent",
      "harness",
      "codex",
      "--executable",
      "/opt/codex",
      "--allow-path",
      "/home/operator",
      "--allow-leaf-executable",
      "npm",
      "--allow-script-interpreter",
      "/usr/bin/node",
    ]);
    expect(result.exitCode).toBe(CliExitCode.usageOrConfiguration);
    expect(result.invocations).toEqual([]);
    expect(result.stderr).toContain("Unknown option: --allow-script-interpreter");
  });
});

describe("CLI rendering and exit semantics", () => {
  it("renders human summaries and stable JSON envelopes", async () => {
    const human = await execute(["profile", "list"]);
    expect(human.stdout).toBe("profile.list completed\nroute: profile.list\n");
    const machine = await execute(["profile", "list", "--json"]);
    expect(machine.stdout).toBe(
      "{\"schema\":\"canonfig.cli/v1\",\"command\":\"profile.list\",\"status\":\"success\",\"exitCode\":0,\"message\":\"profile.list completed\",\"data\":{\"route\":\"profile.list\"}}\n",
    );
  });

  it("ends a human failure with its exit code and category, without raw JSON", async () => {
    const result = await execute(["doctor"], "transport");
    expect(result.stderr).toBe(
      "transport failure\ncredential: [REDACTED]\nexit 6: transport\n",
    );
  });

  it("summarizes a sync plan as actions and the next command", () => {
    const rendered = renderCliResult({
      command: "sync.plan",
      message: "sync.plan completed",
      exitCode: CliExitCode.success,
      data: {
        mode: "plan",
        revision: "workstation:abc",
        downloadedBlobs: 1,
        reusedBlobs: 0,
        agentResolutions: [],
        plan: {
          encoded: "{\"actions\":[]}",
          agentTasks: [],
          actions: [{
            id: "action:codex:0:write-config",
            kind: "write-config",
            resource: "codex",
            before: [],
            detail: {
              kind: "write-config",
              target: "~/.codex/config.toml",
              keys: ["model"],
              retains: ["mcp_servers.old"],
              retentionNotice: "mcp_servers.old stays because a Local Overlay key overlaps it",
            },
          }],
        },
      },
    }, "human");
    expect(rendered).toContain("write-config");
    expect(rendered).toContain("~/.codex/config.toml  keys: model");
    expect(rendered).toMatch(/\n {6}retains: mcp_servers\.old\n {6}mcp_servers\.old stays because a Local Overlay key overlaps it\n/u);
    expect(rendered).toContain("Apply these actions with: canonfig sync --apply");
    expect(rendered).not.toContain("encoded");
    expect(rendered).not.toContain("{");
  });

  it("says why a planned human-action blocks its resource and what to do", () => {
    const rendered = renderCliResult({
      command: "sync.plan",
      message: "sync.plan completed",
      exitCode: CliExitCode.success,
      data: {
        mode: "plan",
        revision: "workstation:abc",
        plan: {
          agentTasks: [],
          actions: [{
            id: "action:antigravity:0:human-action",
            kind: "human-action",
            resource: "antigravity",
            before: [],
            detail: {
              kind: "human-action",
              reason: "~/.agents/mcp_config.json is not valid JSON: expected a property name at line 2 column 10",
              instructions: "Fix ~/.agents/mcp_config.json, then run synchronization again.",
            },
          }],
        },
      },
    }, "human");
    expect(rendered).toMatch(
      /human-action +antigravity\n {6}~\/\.agents\/mcp_config\.json is not valid JSON: expected a property name at line 2 column 10\n {6}Fix ~\/\.agents\/mcp_config\.json, then run synchronization again\.\n/u,
    );
  });

  it("shows a plan's installer warning in full, command included", () => {
    const command = `canonfig installer set npm --executable "C:\\Program Files\\nodejs\\node.exe" --arg "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"`;
    const warning = `installer npm: No installer binding is set for npm, and PATH resolves it to the Windows command shim C:\\Program Files\\nodejs\\npm.cmd, which cannot run without a shell. Bind npm to Node and its own entrypoint instead, then retry:\n${command}`;
    const rendered = renderCliResult({
      command: "sync.plan",
      message: "sync.plan completed",
      exitCode: CliExitCode.success,
      data: {
        mode: "plan",
        plan: { actions: [{ kind: "install-tool", resource: "cli", detail: { kind: "install-tool", toolId: "cli", method: "npm" } }] },
        warnings: [warning],
      },
    }, "human");
    expect(rendered).toContain(`warnings:\n  - ${warning.split("\n")[0]}\n    ${command}\n`);
    expect(rendered).not.toContain("details shortened");
  });

  // Converged means client files were written, not loaded by Codex or Antigravity.
  it("names client checks only for changed hooks and MCP servers", () => {
    const actions = Schema.decodeUnknownSync(Schema.Array(PlannedAction))([
      { kind: "write-file", target: "/home/u/.codex/hooks.json", digest: "d".repeat(64) },
      { kind: "write-config", target: "/home/u/.agents/mcp_config.json", keys: ["mcpServers.docs"] },
      { kind: "write-config", target: "/home/u/.agents/mcp_config.json", keys: ["mcpServers.more"] },
      { kind: "write-config", target: "/home/u/.agents/mcp_config.json", keys: ["theme"] },
      { kind: "write-config", target: "/home/u/.codex/config.toml", keys: ["model"] },
    ].map((detail, index) => ({
      id: `action-${String(index)}`, resource: "client", kind: detail.kind, detail, before: [],
    })));
    const steps = clientReviewSteps(plannedFileChanges(actions));
    expect(steps.map((step) => [step.client, step.target])).toEqual([
      ["codex", "/home/u/.codex/hooks.json"],
      ["antigravity", "/home/u/.agents/mcp_config.json"],
    ]);
    const rendered = renderCliResult({
      command: "sync.apply",
      message: "sync.apply completed",
      exitCode: CliExitCode.success,
      data: { mode: "apply", outcome: { outcome: "Converged" }, clientSteps: steps.map((step) => ({ ...step })) },
    }, "human");
    expect(rendered).toContain("still to do in each client (Canonfig cannot check this; clientLoaded stays not-verified):");
    expect(rendered).toContain("codex /home/u/.codex/hooks.json");
    expect(rendered).toContain("antigravity /home/u/.agents/mcp_config.json");
    expect(steps[1]?.step).toMatch(/invoke a managed MCP tool/u);
  });

  it("keeps fields a summary does not recognize visible in human output", () => {
    const rendered = renderCliResult({
      command: "status",
      message: "status completed",
      exitCode: CliExitCode.success,
      data: {
        machineRole: { role: "follower", follower: "follower-1" },
        lifecycle: { converged: { reached: false, detail: "an interrupted run is open" } },
        lastUnattendedRun: { outcome: "failed", reason: "login Keychain is locked" },
      },
    }, "human");
    expect(rendered).toContain("[ ] converged   an interrupted run is open");
    expect(rendered).toContain("reason: login Keychain is locked");
  });

  it("does not show follower lifecycle rows on an unenrolled Source", () => {
    const rendered = renderCliResult({
      command: "status",
      message: "status completed",
      exitCode: CliExitCode.success,
      data: {
        machineRole: { role: "source", sourceFingerprint: "aa", tlsFingerprint: "bb" },
        lifecycle: { enrolled: { reached: false, detail: "this machine is not enrolled" } },
      },
    }, "human");
    expect(rendered).toContain("follower lifecycle: not applicable on the Source Machine");
    expect(rendered).not.toContain("this machine is not enrolled");
  });

  it("shows a non-passing doctor probe's recovery under the probe", () => {
    const rendered = renderCliResult({
      command: "doctor",
      message: "doctor completed",
      exitCode: CliExitCode.success,
      data: {
        schema: "canonfig.doctor/v1",
        status: "degraded",
        probes: [
          { name: "runtime", status: "pass", message: "runtime is supported", details: { platform: "linux" } },
          { name: "credentials", status: "warning", message: "bus unavailable", details: { recovery: "run the bootstrap" } },
        ],
      },
    }, "human");
    expect(rendered).toMatch(/warning +credentials +bus unavailable\n +recovery: run the bootstrap/u);
    expect(rendered).not.toContain("platform: linux");
  });

  it.each([
    ["usage-or-configuration", 2],
    ["human-action-required", 3],
    ["conflict-or-drift", 4],
    ["authentication-or-revocation", 5],
    ["transport", 6],
    ["verification-or-apply-failure", 7],
    ["internal", 1],
  ] as const)("maps %s failures to exit code %i", async (category, exitCode) => {
    const result = await execute(["doctor", "--json"], category);
    expect(result.exitCode).toBe(exitCode);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`"exitCode":${exitCode}`);
    expect(result.stderr).not.toContain("must-not-leak");
    expect(result.stderr).toContain("[REDACTED]");
  });

  // Usability 15: a large revision downloaded for minutes with no output.
  it("shows a long blob download on stderr for a person, never in --json or scheduled runs", async () => {
    const mebibyte = 1024 * 1024;
    const downloading: FollowerCommandsService["synchronize"] = () => Effect.gen(function*() {
      const report = yield* BlobTransferProgress;
      const first = { blob: "a".repeat(64), blobIndex: 1, blobCount: 2, blobBytes: 4 * mebibyte, total: 5 * mebibyte };
      report({ ...first, blobReceived: mebibyte, received: mebibyte });
      // Within the interval of the start: quiet.
      report({ ...first, blobReceived: 2 * mebibyte, received: 2 * mebibyte });
      vi.setSystemTime(Date.now() + 1500);
      report({ ...first, blobReceived: 3 * mebibyte, received: 3 * mebibyte });
      report({ ...first, blobReceived: 4 * mebibyte, received: 4 * mebibyte });
      report({ ...first, blob: "b".repeat(64), blobIndex: 2, blobBytes: mebibyte, blobReceived: mebibyte, received: 5 * mebibyte });
      return { mode: "apply" };
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const human = await execute(["sync", "--apply"], undefined, downloading);
      expect(human.stderr).toBe(
        "downloading blob 1/2 (aaaaaaaaaaaa): 3.0 MiB of 4.0 MiB; 3.0 MiB of 5.0 MiB in total\n"
          + "downloaded 2 blob(s), 5.0 MiB in 2 s\n",
      );
      for (const arguments_ of [["sync", "--apply", "--json"], ["sync", "--apply", "--no-input", "--scheduled"]]) {
        expect((await execute(arguments_, undefined, downloading)).stderr).toBe("");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("recursively redacts secret values while preserving references", () => {
    const rendered = renderCliResult({
      command: "status",
      message: "status completed",
      exitCode: CliExitCode.success,
      data: {
        credential: "raw",
        nested: { password: "raw", credentialReference: "keychain:item" },
      },
    }, "json");
    expect(rendered).not.toContain('"raw"');
    expect(rendered).toContain("keychain:item");
  });

  it("preserves help and version without constructing command layers", () => {
    expect(evaluateCli(["--help"])._tag).toBe("Help");
    expect(evaluateCli(["--version"])).toEqual({
      _tag: "Version",
      text: "4.0.0",
      exitCode: 0,
    });
  });
});

describe("authored profile validation detail", () => {
  it("names the underlying contract complaint within bounds", () => {
    const failure = profileFileFailure(new Error("Expected 2 | undefined at [version]"));
    expect(failure.category).toBe("usage-or-configuration");
    expect(failure.message).toContain("authored profile file is malformed or invalid");
    expect(failure.message).toContain("Expected 2 | undefined");
  });
  it("falls back safely for empty and unknown causes", () => {
    expect(profileFileFailure(new Error("   ")).message).toContain("profile validation failed");
    expect(profileFileFailure("boom").message).toContain("unknown validation failure");
  });

  it("never echoes parser excerpts from profile contents", () => {
    const failure = profileFileFailure(
      new SyntaxError(`Unexpected token 'u', '{"id": unquoted-secret-value'... is not valid JSON`),
    );
    expect(failure.message).toContain("profile is not valid JSONC");
    expect(failure.message).not.toContain("unquoted-secret-value");
  });

  it("drops rejected values from real decoder failures", () => {
    const text = JSON.stringify({
      id: "x",
      version: 2,
      name: "n",
      groups: [],
      resources: [{
        id: "r",
        kind: "file",
        target: "~/a",
        spec: { kind: "file", content: { secret_marker: "MARKER-ABC-123" } },
        verify: { method: "digest", digest: "0".repeat(64) },
      }],
    });
    let cause: unknown;
    try {
      decodeMachineProfileJsonc(text);
    } catch (error) {
      cause = error;
    }
    expect(cause).toBeDefined();
    const failure = profileFileFailure(cause);
    expect(failure.message).toContain("resources");
    expect(failure.message).not.toContain("MARKER-ABC-123");
  });
});
