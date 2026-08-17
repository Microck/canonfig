import { basename, delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";

import { Effect, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentTaskId } from "../src/domain/brand.ts";
import type { AgentTask } from "../src/domain/synchronization.ts";
import {
  AgentExecutionCancelledError,
  AgentExecutionTimeoutError,
  AgentInputLimitError,
  AgentOutputLimitError,
  AgentProcessError,
  DeniedAgentCapabilityError,
  InvalidAgentTaskError,
} from "../src/agent/agent-resolution.errors.ts";
import {
  AgentResolutionLive,
  makeAgentResolutionLayer,
  type ControlledExecutor,
} from "../src/agent/agent-resolution.layer.ts";
import {
  AgentResolution,
  derivedCapabilities,
  registryOriginForInvocation,
} from "../src/agent/agent-resolution.service.ts";
import {
  authorizeAction,
  isNestedCommandLauncher,
} from "../src/agent/agent-resolution.service.ts";
import type {
  AgentActionProposal,
  CapturedProcess,
  ControlledProcessInput,
  ProposedProcessAction,
} from "../src/agent/agent-resolution.types.ts";
import {
  executeControlledProcess,
} from "../src/agent/controlled-executor.ts";
import {
  encodeAgentTask,
  extractHarnessResponse,
} from "../src/agent/harness-adapters.ts";

const taskId = Schema.decodeUnknownSync(AgentTaskId)("agent:test");

const executableBehavior = (executable: string) =>
  /^(?:node|nodejs|python\d*(?:\.\d+)*|pypy\d*(?:\.\d+)*|py|(?:ba|da|fi|k|z)?sh|pwsh|powershell)$/u
    .test(basename(executable).replace(/\.(?:cmd|exe)$/u, "").toLowerCase())
    ? "script-interpreter" as const
    : "leaf" as const;

// Mirrors the production rule: an executable that launches nested commands
// can never carry an execution model, not even under an explicit operator
// classification.
const authorizationsFor = (
  executables: ReadonlyArray<string>,
): ReadonlyArray<{ executable: string; behavior: "leaf" | "script-interpreter" }> =>
  executables
    .filter((executable) => !isNestedCommandLauncher(executable))
    .map((executable) => ({
      executable,
      behavior: executableBehavior(executable),
    }));

const task = (root: string, changes: Partial<AgentTask> = {}): AgentTask => {
  const allowedExecutables = changes.allowedExecutables
    ?? ["tool", "verify", process.execPath];
  return {
    id: taskId,
    summary: "Resolve test tool",
    desiredOutcome: "test tool is installed",
    observedEvidence: ["not installed"],
    allowedPaths: [root],
    allowedExecutables,
    executableAuthorizations: changes.executableAuthorizations
      ?? authorizationsFor(allowedExecutables),
    allowedOrigins: ["https://packages.example.test"],
    forbidden: ["elevation", "login", "restart", "reboot"],
    timeLimitSeconds: 2,
    outputLimitBytes: 32_000,
    verification: { command: ["verify"], expectContains: "verified" },
    ...changes,
  };
};

const proposal = (action: ProposedProcessAction): AgentActionProposal => ({
  summary: "bounded resolution",
  actions: [action],
});

const action = (changes: Partial<ProposedProcessAction> = {}): ProposedProcessAction => ({
  kind: "process",
  executable: "tool",
  arguments: [],
  paths: [],
  origins: [],
  capabilities: [],
  ...changes,
});

type PrivilegedCapability = ProposedProcessAction["capabilities"][number];

const wrappedPrivilegeCases: ReadonlyArray<readonly [
  string,
  string,
  ReadonlyArray<string>,
  ReadonlyArray<PrivilegedCapability>,
]> = [
  ["sudo su", "sudo", ["su", "-", "root"], ["elevation", "login"]],
  ["sudo options then su", "sudo", ["-u", "root", "/usr/bin/su", "user"], [
    "elevation",
    "login",
  ]],
  ["sudo reboot", "sudo", ["/sbin/reboot"], ["elevation", "reboot"]],
  ["sudo service restart", "sudo", ["service", "agent", "restart"], [
    "elevation",
    "restart",
  ]],
];

const harness = (
  root: string,
  allowedExecutables: ReadonlyArray<string> = ["tool", "verify", process.execPath],
) => ({
  harness: "codex" as const,
  executable: process.execPath,
  maximumInputBytes: 64_000,
  allowedPaths: [root],
  allowedExecutables,
  executableAuthorizations: authorizationsFor(allowedExecutables),
  allowedOrigins: ["https://packages.example.test"],
  allowedCapabilities: [] as const,
  environment: [{ name: "PATH", value: root }],
});

class RecordingExecutor {
  readonly invocations: Array<ControlledProcessInput> = [];
  readonly proposal: AgentActionProposal;

  constructor(value: AgentActionProposal) {
    this.proposal = value;
  }

  readonly execute: ControlledExecutor = (input) => {
    this.invocations.push(input);
    const index = this.invocations.length;
    const output = index === 1
      ? JSON.stringify(this.proposal)
      : index === 3
        ? "verified"
        : "applied";
    return Effect.succeed({
      executable: input.executable,
      arguments: input.arguments,
      exitCode: 0,
      signal: null,
      stdout: output,
      stderr: "",
    });
  };
}

const resolveWith = (
  executor: ControlledExecutor,
  input: Parameters<typeof task>[0],
  policy: "deterministic-only" | "agent-propose" | "agent-apply",
  proposed = proposal(action()),
) => {
  const recording = new RecordingExecutor(proposed);
  const selected = executor === recording.execute ? recording.execute : executor;
  return Effect.gen(function*() {
    const service = yield* AgentResolution;
    return yield* service.resolve({
      policy,
      task: task(input),
      harness: harness(input),
      scheduled: true,
    });
  }).pipe(Effect.provide(makeAgentResolutionLayer(selected)));
};

describe("agent resolution", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "canonfig-agent-"));
    await Promise.all([
      writeFile(join(directory, "tool"), "#!/bin/sh\nexit 0\n"),
      writeFile(join(directory, "verify"), "#!/bin/sh\nexit 0\n"),
    ]);
    await Promise.all([
      chmod(join(directory, "tool"), 0o755),
      chmod(join(directory, "verify"), 0o755),
    ]);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each([
    ["rm recursive flag", "rm", ["-r", "target"], []],
    ["package manager requirement flag", "pip", ["install", "-r", "requirements.txt"], []],
    ["unrelated restart argument", "echo", ["restart"], []],
    ["shutdown restart flag", "shutdown", ["/r"], ["reboot"]],
    ["systemctl reboot subcommand", "systemctl", ["reboot"], ["reboot"]],
    ["systemctl power-state subcommands", "/usr/bin/SYSTEMCTL.EXE", [
      "--user",
      "KEXEC",
    ], ["reboot"]],
    ["systemctl isolate power-state target", "systemctl", [
      "isolate",
      "reboot.target",
    ], ["reboot"]],
    ["systemctl starts power-state target after options", "systemctl", [
      "--host",
      "machine",
      "start",
      "--no-block",
      "poweroff.target",
    ], ["reboot"]],
    ["systemctl starts target with option value named reboot", "systemctl", [
      "--host",
      "reboot",
      "start",
      "halt.target",
    ], ["reboot"]],
    ["systemctl enables power-state target now", "systemctl", [
      "enable",
      "--now",
      "reboot.target",
    ], ["reboot"]],
    ["systemctl reenables power-state target now", "systemctl", [
      "reenable",
      "--now",
      "reboot.target",
    ], ["reboot"]],
    ["systemctl reenables power-state target with kill-whom value", "systemctl", [
      "reenable",
      "--kill-whom",
      "main",
      "poweroff.target",
      "--now",
    ], ["reboot"]],
    ["systemctl reenables power-state target with kill-value value", "systemctl", [
      "reenable",
      "--kill-value",
      "INT",
      "poweroff.target",
      "--now",
    ], ["reboot"]],
    ["systemctl reenables power-state target with equals kill-value", "systemctl", [
      "reenable",
      "--kill-value=INT",
      "poweroff.target",
      "--now",
    ], ["reboot"]],
    ["systemctl accepts documented kill options together", "systemctl", [
      "reenable",
      "--kill-whom=main",
      "--kill-value=INT",
      "--signal",
      "SIGINT",
      "poweroff.target",
      "--now",
    ], ["reboot"]],
    ["systemctl accepts full output option around reenable", "systemctl", [
      "--full",
      "reenable",
      "soft-reboot.target",
      "--now",
    ], ["reboot"]],
    ["systemctl presets power-state target now", "systemctl", [
      "--user",
      "preset",
      "/usr/lib/systemd/system/poweroff.target",
      "--now",
    ], ["reboot"]],
    ["systemctl try-restarts power-state target", "systemctl", [
      "try-restart",
      "--job-mode=replace",
      "rescue.target",
    ], ["reboot"]],
    ["systemctl reloads or restarts power-state target", "systemctl", [
      "-Hreboot",
      "reload-or-restart",
      "--no-block",
      "emergency.target",
    ], ["reboot"]],
    ["systemctl recognizes power-state target aliases", "systemctl", [
      "start",
      "runlevel0.target",
      "runlevel1.target",
      "runlevel6.target",
      "shutdown.target",
      "sigpwr.target",
      "ctrl-alt-del.target",
      "soft-reboot.target",
    ], ["reboot"]],
    ["systemctl restarts rescue target", "systemctl", [
      "restart",
      "/etc/systemd/system/rescue.target",
    ], ["reboot"]],
    ["systemctl emergency target alias", "systemctl", [
      "--",
      "isolate",
      "emergency.target",
    ], ["reboot"]],
    ["nested systemctl power-state command", "sudo", [
      "--",
      "/usr/bin/systemctl",
      "--user",
      "isolate",
      "runlevel6.target",
    ], ["reboot"]],
    ["nested systemctl enable-now command", "sudo", [
      "-u",
      "root",
      "/usr/bin/systemctl",
      "--host",
      "reboot",
      "enable",
      "--now",
      "reboot.target",
    ], ["reboot"]],
    ["wrapped systemctl reenable-now command with aliases and multiple units", "sudo", [
      "-u",
      "root",
      "--",
      "/usr/bin/systemctl",
      "--user",
      "reenable",
      "--kill-whom=main",
      "runlevel6.target",
      "--now",
      "/etc/systemd/system/poweroff.target",
    ], ["reboot"]],
    ["service restart subcommand", "service", ["agent", "restart"], ["restart"]],
    ["sudo reboot wrapper", "sudo", ["-u", "root", "reboot"], ["reboot"]],
    ["cmd shutdown wrapper", "cmd", ["/c", "shutdown", "/r"], ["reboot"]],
    ["Windows Restart-Computer", "Restart-Computer", [], ["reboot"]],
    ["Windows Stop-Computer restart", "Stop-Computer", ["-Restart"], ["reboot"]],
  ] as const)(
    "derives reboot and restart capabilities structurally for %s",
    (_name, executable, arguments_, expected) => {
      expect([...derivedCapabilities(executable, arguments_)]
        .filter((capability) => capability === "reboot" || capability === "restart"))
        .toEqual(expected);
    },
  );

  it.each([
    ["reboot target service", ["restart", "reboot.service"]],
    ["reboot-like service", ["start", "poweroff.service"]],
    ["service with reboot substring", ["start", "my-reboot.target.service"]],
    ["bare reboot service name", ["start", "reboot"]],
    ["ordinary target", ["restart", "default.target"]],
    ["status of power-state target", ["status", "reboot.target"]],
    ["is-enabled of power-state target", ["is-enabled", "reboot.target"]],
    ["cat of power-state target", ["cat", "poweroff.target"]],
    ["show of power-state target", ["show", "halt.target"]],
    ["disable now of power-state target", ["disable", "--now", "reboot.target"]],
    ["mask of power-state target", ["mask", "emergency.target"]],
    ["unrelated systemctl operation", ["enable", "reboot.target"]],
    ["enable without now", ["enable", "poweroff.target"]],
    ["reenable without now", ["reenable", "reboot.target"]],
    ["reenable with kill-whom but without now", [
      "reenable",
      "--kill-whom=main",
      "reboot.target",
    ]],
    ["preset without now", ["preset", "reboot.target"]],
    ["kill-whom on non-activating operation", [
      "--kill-whom",
      "main",
      "status",
      "reboot.target",
    ]],
    ["kill-value on non-activating operation", [
      "--kill-value=INT",
      "status",
      "reboot.target",
    ]],
    ["restart argument after separator", ["restart", "--", "reboot.service"]],
    ["option value hides power-state-looking target", [
      "--machine=reboot.target",
      "status",
      "default.target",
    ]],
  ] as const)(
    "does not derive reboot for ordinary systemctl operation: %s",
    (_name, arguments_) => {
      expect(derivedCapabilities("/usr/bin/systemctl", arguments_).has("reboot"))
        .toBe(false);
    },
  );

  it.each([
    ["unknown long option", ["--unknown", "reboot", "status", "default.target"]],
    ["unknown short option", ["-x", "reboot.target", "status", "default.target"]],
    ["missing option value", ["--host"]],
    ["invalid value on flag", ["--now=reboot", "status", "default.target"]],
    ["invalid kill option spelling", [
      "--kill-who=main",
      "status",
      "default.target",
    ]],
    ["missing kill-value", [
      "--kill-value",
    ]],
    ["empty kill-value", [
      "--kill-value=",
      "status",
      "default.target",
    ]],
    ["unknown kill-values option", [
      "--kill-values=INT",
      "status",
      "default.target",
    ]],
  ] as const)(
    "fails closed for malformed systemctl grammar: %s",
    (_name, arguments_) => {
      const capabilities = derivedCapabilities("systemctl", arguments_);
      expect(capabilities.has("reboot")).toBe(true);
      expect(capabilities.has("restart")).toBe(true);
    },
  );

  it("denies malformed systemctl grammar even when capabilities are allowed", async () => {
    const systemctl = join(directory, "systemctl");
    const allowedExecutables = [systemctl, join(directory, "verify")];
    await writeFile(systemctl, "#!/bin/sh\nexit 0\n");
    await chmod(systemctl, 0o755);
    await expect(Effect.runPromise(authorizeAction(
      action({
        executable: systemctl,
        arguments: ["--unknown", "reboot", "status", "default.target"],
      }),
      task(directory, { allowedExecutables, forbidden: [] }),
      {
        ...harness(directory, allowedExecutables),
        allowedCapabilities: ["reboot", "restart"],
      },
    ).pipe(Effect.flip))).resolves.toMatchObject({
      capability: "systemctl-grammar",
    });
  });

  it.each([
    ["isolate reboot target", ["isolate", "reboot.target"]],
    ["start poweroff target", ["start", "poweroff.target"]],
    ["restart emergency target", ["restart", "emergency.target"]],
    ["try-restart kexec target", ["try-restart", "kexec.target"]],
    ["reload-or-restart rescue target", ["reload-or-restart", "rescue.target"]],
    ["try-reload-or-restart halt target", [
      "try-reload-or-restart",
      "--no-block",
      "halt.target",
    ]],
    ["enable now reboot target", ["enable", "--now", "reboot.target"]],
    ["reenable now reboot target", [
      "reenable",
      "--kill-whom=main",
      "reboot.target",
      "--now",
    ]],
    ["preset now poweroff target", ["preset", "poweroff.target", "--now"]],
  ] as const)(
    "allows and denies derived systemctl reboot capability: %s",
    async (_name, arguments_) => {
      const systemctl = join(directory, "systemctl");
      await writeFile(systemctl, "#!/bin/sh\nexit 0\n");
      await chmod(systemctl, 0o755);
      const allowedExecutables = [systemctl, join(directory, "verify")];
      const allowedTask = task(directory, {
        allowedExecutables,
        forbidden: [],
      });
      const allowedHarness = {
        ...harness(directory, allowedExecutables),
        allowedCapabilities: ["reboot"] as const,
      };
      await expect(Effect.runPromise(authorizeAction(
        action({ executable: systemctl, arguments: arguments_ }),
        allowedTask,
        allowedHarness,
      ))).resolves.toBeUndefined();

      const denied = await Effect.runPromise(authorizeAction(
        action({ executable: systemctl, arguments: arguments_ }),
        task(directory, { allowedExecutables }),
        harness(directory, allowedExecutables),
      ).pipe(Effect.flip));
      expect(denied).toMatchObject({ capability: "reboot" });
    },
  );

  it.each([
    ["isolate reboot target", ["isolate", "reboot.target"]],
    ["start poweroff target", ["start", "poweroff.target"]],
    ["restart emergency target", ["restart", "emergency.target"]],
    ["try-restart kexec target", ["try-restart", "kexec.target"]],
    ["reload-or-restart rescue target", ["reload-or-restart", "rescue.target"]],
    ["try-reload-or-restart halt target", [
      "try-reload-or-restart",
      "--no-block",
      "halt.target",
    ]],
    ["enable now reboot target", ["enable", "--now", "reboot.target"]],
    ["reenable now reboot target", [
      "reenable",
      "--kill-whom",
      "main",
      "reboot.target",
      "--now",
    ]],
    ["preset now poweroff target", ["preset", "poweroff.target", "--now"]],
    ["invalid kill option spelling", [
      "--kill-who=main",
      "status",
      "default.target",
    ], "systemctl-grammar"],
  ] as const)(
    "does not spawn denied systemctl reboot operation: %s",
    async (
      _name,
      arguments_,
      expectedCapability: "reboot" | "systemctl-grammar" = "reboot",
    ) => {
      const marker = join(directory, "systemctl-marker");
      const systemctl = join(directory, "systemctl");
      const harnessExecutable = join(directory, "agent-harness");
      const verify = join(directory, "verify");
      const allowedExecutables = [harnessExecutable, systemctl, verify];
      const proposed = JSON.stringify(proposal(action({
        executable: systemctl,
        arguments: arguments_,
      })));
      await Promise.all([
        writeFile(systemctl, `#!/bin/sh\nprintf spawned > '${marker}'\n`),
        writeFile(harnessExecutable, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${proposed}'\n`),
      ]);
      await Promise.all([
        chmod(systemctl, 0o755),
        chmod(harnessExecutable, 0o755),
      ]);
      const error = await Effect.runPromise(Effect.gen(function*() {
        const service = yield* AgentResolution;
        return yield* service.resolve({
          policy: "agent-apply",
          task: task(directory, {
            allowedExecutables,
            verification: { command: [verify], expectContains: "verified" },
          }),
          harness: {
            ...harness(directory, allowedExecutables),
            executable: harnessExecutable,
          },
        });
      }).pipe(
        Effect.provide(AgentResolutionLive),
        Effect.flip,
      ));
      expect(error).toMatchObject({ capability: expectedCapability });
      await expect(access(marker)).rejects.toThrow();
    },
  );

  it("encodes a versioned structured task without shell syntax", () => {
    const encoded = JSON.parse(new TextDecoder().decode(encodeAgentTask(task(directory))));
    expect(encoded).toMatchObject({
      schema: "canonfig.agent-task/v1",
      task: { id: "agent:test" },
      responseContract: { selfReportIsProof: false },
    });
  });

  it("extracts machine-readable responses from every supported harness", () => {
    const response = JSON.stringify(proposal(action()));
    expect(extractHarnessResponse(
      "codex",
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: response },
      }),
    )).toBe(response);
    expect(extractHarnessResponse(
      "claude",
      JSON.stringify({ type: "result", result: response }),
    )).toBe(response);
    expect(extractHarnessResponse(
      "gemini",
      JSON.stringify({ response }),
    )).toBe(response);
  });

  it("never invokes a harness under deterministic-only policy", async () => {
    const recording = new RecordingExecutor(proposal(action()));
    const result = await Effect.runPromise(resolveWith(
      recording.execute,
      directory,
      "deterministic-only",
    ));
    expect(result.outcome).toBe("deterministic-only");
    expect(recording.invocations).toEqual([]);
  });

  it("records a proposal without applying it under agent-propose", async () => {
    const recording = new RecordingExecutor(proposal(action()));
    const result = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-propose",
        task: task(directory),
        harness: { ...harness(directory), harness: "claude" },
      });
    }).pipe(Effect.provide(makeAgentResolutionLayer(recording.execute))));
    expect(result.outcome).toBe("proposed");
    expect(recording.invocations).toHaveLength(1);
    expect(recording.invocations[0]?.arguments).toContain("--print");
  });

  it("applies bounded actions then verifies with an independent observer", async () => {
    const recording = new RecordingExecutor(proposal(action()));
    const result = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-apply",
        task: task(directory),
        harness: { ...harness(directory), harness: "gemini" },
      });
    }).pipe(Effect.provide(makeAgentResolutionLayer(recording.execute))));
    expect(result.outcome).toBe("applied");
    expect(recording.invocations.map((entry) => entry.executable)).toEqual([
      process.execPath,
      join(directory, "tool"),
      join(directory, "verify"),
    ]);
  });

  it.each([
    ["executable", action({ executable: "denied" })],
    ["path", action({ paths: [join(directory, "..", "denied")] })],
    ["network-origin", action({ origins: ["https://denied.example.test"] })],
    ["elevation", action({ capabilities: ["elevation"] })],
    ["login", action({ capabilities: ["login"] })],
    ["restart", action({ capabilities: ["restart"] })],
    ["reboot", action({ capabilities: ["reboot"] })],
  ])("denies undeclared %s capability before execution", async (capability, denied) => {
    const recording = new RecordingExecutor(proposal(denied));
    const error = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-apply",
        task: task(directory),
        harness: harness(directory),
      });
    }).pipe(
      Effect.provide(makeAgentResolutionLayer(recording.execute)),
      Effect.flip,
    ));
    expect(error).toBeInstanceOf(DeniedAgentCapabilityError);
    expect(error.capability).toBe(capability);
    expect(recording.invocations).toHaveLength(1);
  });

  it.each([
    ["plain-relative traversal", ["../secret"], "path"],
    ["option-valued traversal", ["--output=../secret"], "path"],
    ["omitted elevation capability", ["--sudo"], "elevation"],
    ["omitted login capability", ["login"], "login"],
  ])("derives and denies %s before execution", async (_name, arguments_, capability) => {
    const recording = new RecordingExecutor(proposal(action({ arguments: arguments_ })));
    const error = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-apply",
        task: task(directory),
        harness: harness(directory),
      });
    }).pipe(
      Effect.provide(makeAgentResolutionLayer(recording.execute)),
      Effect.flip,
    ));
    expect(error).toMatchObject({ capability });
    expect(recording.invocations).toHaveLength(1);
  });

  it("denies a relative argument that resolves through a symlink outside the bounds", async () => {
    const outside = await mkdtemp(join(tmpdir(), "canonfig-agent-outside-"));
    try {
      await symlink(outside, join(directory, "escape"));
      const recording = new RecordingExecutor(proposal(action({
        arguments: [join("escape", "prospective-output")],
      })));
      const error = await Effect.runPromise(Effect.gen(function*() {
        const service = yield* AgentResolution;
        return yield* service.resolve({
          policy: "agent-apply",
          task: task(directory),
          harness: harness(directory),
        });
      }).pipe(
        Effect.provide(makeAgentResolutionLayer(recording.execute)),
        Effect.flip,
      ));
      expect(error).toMatchObject({ capability: "path" });
      expect(recording.invocations).toHaveLength(1);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("compares executable identities instead of trusting matching basenames", async () => {
    const [trustedRoot, attackerRoot] = await Promise.all([
      mkdtemp(join(directory, "trusted-root-")),
      mkdtemp(join(directory, "attacker-root-")),
    ]);
    const trusted = join(trustedRoot, "tool");
    const attacker = join(attackerRoot, "tool");
    const alias = join(directory, "trusted-tool-alias");
    await Promise.all([
      writeFile(trusted, "#!/bin/sh\nexit 0\n"),
      writeFile(attacker, "#!/bin/sh\nexit 0\n"),
    ]);
    await Promise.all([chmod(trusted, 0o755), chmod(attacker, 0o755)]);
    await symlink(trusted, alias);
    const bounded = task(directory, {
      allowedExecutables: [trusted],
      verification: { command: [trusted] },
    });

    await expect(Effect.runPromise(authorizeAction(
      action({ executable: alias }),
      bounded,
    ))).resolves.toBeUndefined();
    const denied = await Effect.runPromise(
      authorizeAction(action({ executable: attacker }), bounded).pipe(
        Effect.flip,
      ),
    );
    expect(denied).toMatchObject({
      capability: "executable",
      value: attacker,
    });
  });

  it("resolves bare executables with harness PATH precedence and binds execution", async () => {
    const first = join(directory, "first");
    const second = join(directory, "second");
    await Promise.all([mkdir(first), mkdir(second)]);
    const trusted = join(second, "tool");
    const shadow = join(first, "tool");
    await Promise.all([
      writeFile(trusted, "#!/bin/sh\nexit 0\n"),
      writeFile(shadow, "#!/bin/sh\nexit 0\n"),
    ]);
    await Promise.all([chmod(trusted, 0o755), chmod(shadow, 0o755)]);
    const recording = new RecordingExecutor(proposal(action()));
    const boundedTask = task(directory, {
      allowedExecutables: [shadow, join(directory, "verify")],
    });
    const result = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-apply",
        task: boundedTask,
        harness: {
          ...harness(directory, [shadow, join(directory, "verify")]),
          environment: [{
            name: "PATH",
            value: `${first}${delimiter}${second}${delimiter}${directory}`,
          }],
        },
      });
    }).pipe(Effect.provide(makeAgentResolutionLayer(recording.execute))));
    expect(result.outcome).toBe("applied");
    expect(recording.invocations[1]?.executable).toBe(shadow);
  });

  it.each(wrappedPrivilegeCases)("derives wrapped privileged capabilities for %s", async (
    _name,
    executable,
    arguments_,
    capabilities,
  ) => {
    const wrapper = join(directory, executable);
    await writeFile(wrapper, "#!/bin/sh\nexit 0\n");
    await chmod(wrapper, 0o755);
    const bounded = task(directory, {
      forbidden: [],
      allowedExecutables: [wrapper, join(directory, "verify")],
    });
    for (const omitted of capabilities) {
      const recording = new RecordingExecutor(proposal(action({
        executable,
        arguments: arguments_,
        capabilities: capabilities.filter((capability) => capability !== omitted),
      })));
      const error = await Effect.runPromise(Effect.gen(function*() {
        const service = yield* AgentResolution;
        return yield* service.resolve({
          policy: "agent-apply",
          task: bounded,
          harness: {
            ...harness(directory, [wrapper, join(directory, "verify")]),
            allowedCapabilities: capabilities.filter((capability) =>
              capability !== omitted
            ),
          },
        });
      }).pipe(
        Effect.provide(makeAgentResolutionLayer(recording.execute)),
        Effect.flip,
      ));
      expect(error).toMatchObject({ capability: omitted });
      expect(recording.invocations).toHaveLength(1);
    }
  });

  it("fails closed on privileged wrappers without an explicit execution model", async () => {
    const sudo = join(directory, "sudo");
    await writeFile(sudo, "#!/bin/sh\nexit 0\n");
    await chmod(sudo, 0o755);
    const recording = new RecordingExecutor(proposal(action({
      executable: "sudo",
      arguments: ["sh", "-c", "su - root"],
    })));
    const error = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-apply",
        task: task(directory, {
          forbidden: [],
          allowedExecutables: [sudo, join(directory, "verify")],
          executableAuthorizations: [{
            executable: join(directory, "verify"),
            behavior: "leaf",
          }],
        }),
        harness: {
          ...harness(directory, [sudo, join(directory, "verify")]),
          executableAuthorizations: [{
            executable: join(directory, "verify"),
            behavior: "leaf",
          }],
          allowedCapabilities: ["elevation", "login", "restart", "reboot"],
        },
      });
    }).pipe(
      Effect.provide(makeAgentResolutionLayer(recording.execute)),
      Effect.flip,
    ));
    expect(error).toMatchObject({ capability: "nested-command-launcher" });
    expect(recording.invocations).toHaveLength(1);
  });

  it.each([
    ["Node -e", process.execPath, ["-e", "process.exit(0)"]],
    ["Node packed print", process.execPath, ["-p1+1"]],
    ["Node assigned eval", process.execPath, ["--eval=process.exit(0)"]],
    ["Python packed command", "python3", ["-cprint(1)"]],
    ["Python combined options and command", "python3", ["-Ic", "print(1)"]],
    ["POSIX shell packed command", "sh", ["-lc", "exit 0"]],
    ["PowerShell abbreviated command", "pwsh", ["-CoMm", "exit 0"]],
    ["PowerShell assigned encoded command", "powershell", ["/Enc=ZQB4AGkAdAA="]],
  ])("denies separator-free inline programs through %s", async (
    _name,
    requestedExecutable,
    arguments_,
  ) => {
    const executable = requestedExecutable === process.execPath
      ? process.execPath
      : join(directory, requestedExecutable);
    if (requestedExecutable !== process.execPath) {
      await writeFile(executable, "#!/bin/sh\nexit 0\n");
      await chmod(executable, 0o755);
    }
    const boundedTask = task(directory, {
      allowedExecutables: [executable, join(directory, "verify")],
    });
    const denied = await Effect.runPromise(authorizeAction(
      action({ executable, arguments: arguments_ }),
      boundedTask,
      {
        ...harness(directory, [executable, join(directory, "verify")]),
      },
    ).pipe(Effect.flip));
    expect(denied).toMatchObject({
      capability: "script-interpreter",
      value: executable,
    });
  });

  it("denies inline interpreter programs hidden behind an allowlisted wrapper", async () => {
    const wrapper = join(directory, "env");
    const node = join(directory, "node");
    await writeFile(wrapper, "#!/bin/sh\nexit 0\n");
    await Promise.all([
      chmod(wrapper, 0o755),
      symlink(process.execPath, node),
    ]);
    const allowedExecutables = [wrapper, node, join(directory, "verify")];
    const executableAuthorizations = [
      { executable: node, behavior: "script-interpreter" as const },
      { executable: join(directory, "verify"), behavior: "leaf" as const },
    ];
    const boundedTask = task(directory, {
      allowedExecutables,
      executableAuthorizations,
    });
    const denied = await Effect.runPromise(authorizeAction(
      action({
        executable: wrapper,
        arguments: ["node", "--eval=process.exit(0)"],
      }),
      boundedTask,
      {
        ...harness(directory, allowedExecutables),
        executableAuthorizations,
      },
    ).pipe(Effect.flip));
    expect(denied).toMatchObject({
      capability: "nested-command-launcher",
      value: wrapper,
    });
  });

  it("denies a bare POSIX shell script whose execution identity comes from PATH", async () => {
    const shell = join(directory, "sh");
    const boundedScript = join(directory, "xargs");
    const shadowDirectory = await mkdtemp(join(tmpdir(), "canonfig-agent-shadow-"));
    const shadowScript = join(shadowDirectory, "xargs");
    try {
      await Promise.all([
        writeFile(shell, "#!/bin/sh\nexit 0\n"),
        writeFile(boundedScript, "exit 0\n"),
        writeFile(shadowScript, "exit 0\n"),
      ]);
      await Promise.all([
        chmod(shell, 0o755),
        chmod(boundedScript, 0o755),
        chmod(shadowScript, 0o755),
      ]);
      const allowedExecutables = [shell, join(directory, "verify")];
      const boundedTask = task(directory, { allowedExecutables });
      const denied = await Effect.runPromise(authorizeAction(
        action({
          executable: shell,
          arguments: ["xargs"],
        }),
        boundedTask,
        {
          ...harness(directory, allowedExecutables),
          environment: [{ name: "PATH", value: shadowDirectory }],
        },
      ).pipe(Effect.flip));
      expect(denied).toMatchObject({
        capability: "script-interpreter",
        value: shell,
      });
    } finally {
      await rm(shadowDirectory, { recursive: true, force: true });
    }
  });

  it("rejects an explicit bounded POSIX shell script identity", async () => {
    const shell = join(directory, "sh");
    const script = join(directory, "bounded-script.sh");
    await Promise.all([
      writeFile(shell, "#!/bin/sh\nexit 0\n"),
      writeFile(script, "exit 0\n"),
    ]);
    await chmod(shell, 0o755);
    const allowedExecutables = [shell, join(directory, "verify")];
    const boundedTask = task(directory, { allowedExecutables });
    const denied = await Effect.runPromise(authorizeAction(
      action({
        executable: shell,
        arguments: ["./bounded-script.sh"],
      }),
      boundedTask,
      {
        ...harness(directory, allowedExecutables),
      },
    ).pipe(Effect.flip));
    expect(denied).toMatchObject({
      capability: "script-interpreter",
      value: shell,
    });
  });

  it.each([
    ["xargs", ["denied-tool"], "nested-command-launcher"],
    ["xargs", ["-a", "commands.txt", "denied-tool"], "nested-command-launcher"],
    ["find", [".", "-exec", "denied-tool", ";"], "nested-command-launcher"],
    ["find", [".", "-ok", "denied-tool", ";"], "nested-command-launcher"],
    ["awk", ["BEGIN { system(\"denied-tool\") }"], "nested-command-launcher"],
    ["perl", ["-e", "system 'denied-tool'"], "nested-command-launcher"],
    ["make", ["--eval=all:\n\tdenied-tool", "all"], "nested-command-launcher"],
    ["make", ["SHELL=denied-tool", "all"], "nested-command-launcher"],
    ["npx", ["denied-package"], "nested-command-launcher"],
    ["npx", ["--package", "allowed-package", "--", "denied-tool"], "nested-command-launcher"],
    ["env", ["denied-tool"], "nested-command-launcher"],
    ["timeout", ["1", "denied-tool"], "nested-command-launcher"],
    // `sudo denied-tool` derives the forbidden elevation capability first;
    // the wrapper never reaches behavior classification.
    ["sudo", ["denied-tool"], "elevation"],
    ["docker", ["run", "denied-image"], "nested-command-launcher"],
    ["git", ["-c", "alias.x=!denied-tool", "x"], "nested-command-launcher"],
  ])("denies opaque %s descendant execution before spawn", async (
    launcherName,
    arguments_,
    capability,
  ) => {
    const launcher = join(directory, launcherName);
    await writeFile(launcher, "#!/bin/sh\nexit 0\n");
    await chmod(launcher, 0o755);
    const verify = join(directory, "verify");
    const allowedExecutables = [launcher, verify];
    // A launcher stays in the executable allowlist, but no classification can
    // be attached to it: an operator attempt to authorize it as a direct leaf
    // or script interpreter must not re-open the nested-command bypass.
    const executableAuthorizations = [{
      executable: verify,
      behavior: "leaf" as const,
    }];
    const recording = new RecordingExecutor(proposal(action({
      executable: launcher,
      arguments: arguments_,
    })));
    const error = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-apply",
        task: task(directory, {
          allowedExecutables,
          executableAuthorizations,
        }),
        harness: {
          ...harness(directory, allowedExecutables),
          executableAuthorizations,
        },
      });
    }).pipe(
      Effect.provide(makeAgentResolutionLayer(recording.execute)),
      Effect.flip,
    ));
    expect(error).toMatchObject({ capability });
    expect(recording.invocations).toHaveLength(1);
  });

  it("rejects tasks and harnesses that classify a launcher with an execution model", async () => {
    const launcher = join(directory, "xargs");
    await writeFile(launcher, "#!/bin/sh\nexit 0\n");
    await chmod(launcher, 0o755);
    const classified = [{ executable: launcher, behavior: "leaf" as const }];
    const recording = new RecordingExecutor(proposal(action()));
    const error = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-apply",
        task: task(directory, {
          allowedExecutables: [launcher, join(directory, "verify")],
          executableAuthorizations: [
            ...classified,
            { executable: join(directory, "verify"), behavior: "leaf" },
          ],
        }),
        harness: harness(directory, [launcher, join(directory, "verify")]),
      });
    }).pipe(
      Effect.provide(makeAgentResolutionLayer(recording.execute)),
      Effect.flip,
    ));
    expect(error).toBeInstanceOf(InvalidAgentTaskError);
    expect(error.message).toContain("nested commands");
    expect(recording.invocations).toHaveLength(0);
  });

  it("applies an explicitly classified direct leaf operation", async () => {
    const recording = new RecordingExecutor(proposal(action()));
    const result = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-apply",
        task: task(directory),
        harness: harness(directory),
      });
    }).pipe(Effect.provide(makeAgentResolutionLayer(recording.execute))));
    expect(result.outcome).toBe("applied");
    expect(recording.invocations[1]?.executable).toBe(join(directory, "tool"));
  });

  it.each([
    ["npm install", "npm", ["install", "--global", "tool@1.2.3"], ["--ignore-scripts"]],
    ["npm install alias", "npm", ["--prefix", directory, "i", "tool"], ["--ignore-scripts"]],
    ["pnpm add alias", "pnpm", ["--dir", directory, "add", "tool"], [
      "--ignore-scripts",
      "--ignore-pnpmfile",
    ]],
    ["bun install", "bun", ["--cwd", directory, "install"], ["--ignore-scripts"]],
    ["uv tool install", "uv", ["tool", "install", "tool==1.2.3"], [
      "--only-binary=:all:",
    ]],
    ["uv pip install", "uv", ["pip", "install", "tool==1.2.3"], [
      "--only-binary=:all:",
    ]],
  ])("injects the canonical script-disabled mode for %s", async (
    _name,
    managerName,
    arguments_,
    disableFlags,
  ) => {
    const manager = join(directory, managerName);
    await writeFile(manager, "#!/bin/sh\nexit 0\n");
    await chmod(manager, 0o755);
    const verify = join(directory, "verify");
    const allowedExecutables = [manager, verify];
    const recording = new RecordingExecutor(proposal(action({
      executable: manager,
      arguments: arguments_,
    })));
    await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-apply",
        task: task(directory, { allowedExecutables }),
        harness: harness(directory, allowedExecutables),
      });
    }).pipe(Effect.provide(makeAgentResolutionLayer(recording.execute))));
    expect(recording.invocations[1]?.arguments).toEqual([
      ...arguments_,
      ...disableFlags,
      ...(managerName === "uv" ? ["--no-config"] : []),
      ...(
        managerName === "uv"
          ? [
            `${arguments_[0] === "pip" ? "--index-url" : "--default-index"}=https://packages.example.test`,
          ]
          : ["--registry=https://packages.example.test"]
      ),
    ]);
  });

  it.each([
    ["pip", "pip", ["install", "tool"], [
      "--only-binary=:all:",
      "--isolated",
      "--index-url=https://packages.example.test",
    ]],
    ["pip3 alias", "pip3", ["install", "tool==1.2.3"], [
      "--only-binary=:all:",
      "--isolated",
      "--index-url=https://packages.example.test",
    ]],
    ["pip versioned alias", "pip3.12", ["install", "tool"], [
      "--only-binary=:all:",
      "--isolated",
      "--index-url=https://packages.example.test",
    ]],
  ] as const)(
    "pins the reviewed origin and disables config for %s",
    async (_name, managerName, arguments_, suffix) => {
      const manager = join(directory, managerName);
      await writeFile(manager, "#!/bin/sh\nexit 0\n");
      await chmod(manager, 0o755);
      const verify = join(directory, "verify");
      const allowedExecutables = [manager, verify];
      const recording = new RecordingExecutor(proposal(action({
        executable: manager,
        arguments: arguments_,
      })));
      await Effect.runPromise(Effect.gen(function*() {
        const service = yield* AgentResolution;
        return yield* service.resolve({
          policy: "agent-apply",
          task: task(directory, { allowedExecutables }),
          harness: harness(directory, allowedExecutables),
        });
      }).pipe(Effect.provide(makeAgentResolutionLayer(recording.execute))));
      expect(recording.invocations[1]?.arguments).toEqual([...arguments_, ...suffix]);
    },
  );

  it("normalizes allowed pip index aliases and isolates a uv project", async () => {
    const manager = join(directory, "uv");
    const verify = join(directory, "verify");
    await Promise.all([
      writeFile(manager, "#!/bin/sh\nexit 0\n"),
      writeFile(verify, "#!/bin/sh\nprintf verified\n"),
    ]);
    await chmod(manager, 0o755);
    await chmod(verify, 0o755);
    const allowedExecutables = [manager, verify];
    const recording = new RecordingExecutor(proposal(action({
      executable: manager,
      arguments: [
        "--project",
        directory,
        "pip",
        "install",
        "tool",
        "--index",
        "https://PACKAGES.EXAMPLE.TEST:443/",
      ],
    })));
    await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-apply",
        task: task(directory, {
          allowedExecutables,
          allowedOrigins: ["https://Packages.Example.Test:443"],
        }),
        harness: {
          ...harness(directory, allowedExecutables),
          allowedOrigins: ["https://Packages.Example.Test:443"],
        },
      });
    }).pipe(Effect.provide(makeAgentResolutionLayer(recording.execute))));
    expect(recording.invocations[1]?.arguments).toEqual([
      "--project",
      directory,
      "pip",
      "install",
      "tool",
      "--only-binary=:all:",
      "--no-config",
      "--index-url=https://packages.example.test",
    ]);
  });

  it("accepts an explicitly allowed pip short index and removes expansion options", async () => {
    const manager = join(directory, "pip3.12");
    const verify = join(directory, "verify");
    await writeFile(manager, "#!/bin/sh\nexit 0\n");
    await writeFile(verify, "#!/bin/sh\nprintf verified\n");
    await chmod(manager, 0o755);
    await chmod(verify, 0o755);
    const allowedExecutables = [manager, verify];
    const recording = new RecordingExecutor(proposal(action({
      executable: manager,
      arguments: [
        "install",
        "tool",
        "-i",
        "https://PACKAGES.EXAMPLE.TEST:443/",
        "--extra-index-url=https://packages.example.test",
      ],
    })));
    await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-apply",
        task: task(directory, { allowedExecutables }),
        harness: harness(directory, allowedExecutables),
      });
    }).pipe(Effect.provide(makeAgentResolutionLayer(recording.execute))));
    expect(recording.invocations[1]?.arguments).toEqual([
      "install",
      "tool",
      "--only-binary=:all:",
      "--isolated",
      "--index-url=https://packages.example.test",
    ]);
  });

  it("recursively authorizes bounded pip requirement and constraint files", async () => {
    const manager = join(directory, "pip");
    const rootRequirements = join(directory, "requirements.txt");
    const nestedRequirements = join(directory, "nested requirements.txt");
    const deeperRequirements = join(directory, "deeper.txt");
    const constraints = join(directory, "constraints.txt");
    await Promise.all([
      writeFile(manager, "#!/bin/sh\nexit 0\n"),
      writeFile(rootRequirements, [
        "\uFEFF# root requirements",
        "# root requirements",
        "-r \"nested requirements.txt\"",
        "--index-url=https://packages.example.test/private/simple",
        "requests[socks] \\",
        "==2.32.0",
        "",
      ].join("\n")),
      writeFile(nestedRequirements, [
        "-r deeper.txt",
        "urllib3>=2.0; python_version >= \"3.9\"",
        "",
      ].join("\n")),
      writeFile(deeperRequirements, "-c constraints.txt\n"),
      writeFile(constraints, "requests<3\n"),
    ]);
    await chmod(manager, 0o755);
    const allowedExecutables = [manager, join(directory, "verify")];
    const recording = new RecordingExecutor(proposal(action({
      executable: manager,
      arguments: ["install", "-r", rootRequirements],
    })));
    const result = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-apply",
        task: task(directory, { allowedExecutables }),
        harness: harness(directory, allowedExecutables),
      });
    }).pipe(Effect.provide(makeAgentResolutionLayer(recording.execute))));
    expect(result.outcome).toBe("applied");
    if (result.outcome !== "applied") return;
    expect(result.proposal.actions[0]?.pipRequirementFiles).toHaveLength(4);
    expect(recording.invocations[1]?.arguments).toEqual([
      "install",
      "-r",
      rootRequirements,
      "--only-binary=:all:",
      "--isolated",
      "--index-url=https://packages.example.test",
    ]);
  });

  it.each([
    ["short separate requirement", ["-r", "requirements.txt"], "-r"],
    ["long separate requirement", ["--requirement", "requirements.txt"], "--requirement"],
    ["short equals requirement", ["-r=requirements.txt"], "-r=requirements.txt"],
    ["long equals requirement", ["--requirement=requirements.txt"], "--requirement=requirements.txt"],
    ["short attached requirement", ["-rrequirements.txt"], "-r"],
    ["short separate constraint", ["-c", "constraints.txt"], "-c"],
    ["long equals constraint", ["--constraint=constraints.txt"], "--constraint=constraints.txt"],
  ] as const)(
    "normalizes local pip %s to the authorized argv identity",
    async (_name, includeArguments, expectedOption) => {
      const manager = join(directory, "pip");
      const requirements = join(directory, "requirements.txt");
      const constraints = join(directory, "constraints.txt");
      const reference = includeArguments.some((argument) =>
        argument === "-c" || argument.startsWith("-c=") || argument.startsWith("--constraint"))
        ? constraints
        : requirements;
      await Promise.all([
        writeFile(manager, "#!/bin/sh\nexit 0\n"),
        writeFile(requirements, "requests\n"),
        writeFile(constraints, "requests<3\n"),
      ]);
      await chmod(manager, 0o755);
      const allowedExecutables = [manager, join(directory, "verify")];
      const recording = new RecordingExecutor(proposal(action({
        executable: manager,
        arguments: ["install", ...includeArguments],
        workingDirectory: directory,
      })));
      await Effect.runPromise(Effect.gen(function*() {
        const service = yield* AgentResolution;
        return yield* service.resolve({
          policy: "agent-apply",
          task: task(directory, { allowedExecutables }),
          harness: harness(directory, allowedExecutables),
        });
      }).pipe(Effect.provide(makeAgentResolutionLayer(recording.execute))));
      const expectedReference = includeArguments.length === 1
        ? expectedOption.includes("=")
          ? `${expectedOption.slice(0, expectedOption.indexOf("=") + 1)}${reference}`
          : `${expectedOption}${reference}`
        : reference;
      expect(recording.invocations[1]?.arguments).toEqual([
        "install",
        ...(includeArguments.length === 1
          ? [expectedReference]
          : [expectedOption, expectedReference]),
        "--only-binary=:all:",
        "--isolated",
        "--index-url=https://packages.example.test",
      ]);
    },
  );

  it("recursively normalizes local requirement continuations before execution", async () => {
    const manager = join(directory, "pip");
    const requirements = join(directory, "requirements.txt");
    const nested = join(directory, "nested.txt");
    const constraints = join(directory, "constraints.txt");
    await Promise.all([
      writeFile(manager, "#!/bin/sh\nexit 0\n"),
      writeFile(requirements, "-r \\\nnested.txt\n"),
      writeFile(nested, "-c \\\nconstraints.txt\n"),
      writeFile(constraints, "requests<3\n"),
    ]);
    await chmod(manager, 0o755);
    const allowedExecutables = [manager, join(directory, "verify")];
    const recording = new RecordingExecutor(proposal(action({
      executable: manager,
      arguments: ["install", "-r", "requirements.txt"],
      workingDirectory: directory,
    })));
    await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-apply",
        task: task(directory, { allowedExecutables }),
        harness: harness(directory, allowedExecutables),
      });
    }).pipe(Effect.provide(makeAgentResolutionLayer(recording.execute))));
    expect(recording.invocations[1]?.arguments[0]).toBe("install");
    expect(recording.invocations[1]?.arguments[1]).toBe("-r");
    expect(recording.invocations[1]?.arguments[2]).toBe(requirements);
  });

  it("fails closed when an earlier action rewrites a pip requirement before the next spawn", async () => {
    const requirements = join(directory, "requirements.txt");
    const rewriter = join(directory, "rewriter");
    const pip = join(directory, "pip");
    await Promise.all([
      writeFile(requirements, "safe-package\n"),
      writeFile(rewriter, "#!/bin/sh\nexit 0\n"),
      writeFile(pip, "#!/bin/sh\nprintf downloaded > pip-downloaded\n"),
    ]);
    await Promise.all([chmod(rewriter, 0o755), chmod(pip, 0o755)]);
    const allowedExecutables = [
      rewriter,
      pip,
      join(directory, "verify"),
      process.execPath,
    ];
    const actions: AgentActionProposal = {
      summary: "rewrite then install",
      actions: [
        action({ executable: rewriter }),
        action({
        executable: pip,
        arguments: ["install", "-r", requirements],
        workingDirectory: directory,
        }),
      ],
    };
    const invocations: Array<ControlledProcessInput> = [];
    const executor: ControlledExecutor = (input) => {
      invocations.push(input);
      if (invocations.length === 1) {
        return Effect.succeed({
          executable: input.executable,
          arguments: input.arguments,
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify(actions),
          stderr: "",
        });
      }
      if (invocations.length === 2) {
        return Effect.promise(() =>
          writeFile(requirements, "evil-package\n").then(() => ({
            executable: input.executable,
            arguments: input.arguments,
            exitCode: 0,
            signal: null,
            stdout: "rewritten",
            stderr: "",
          }))
        );
      }
      return Effect.succeed({
        executable: input.executable,
        arguments: input.arguments,
        exitCode: 0,
        signal: null,
        stdout: "downloaded",
        stderr: "",
      });
    };
    const error = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-apply",
        task: task(directory, {
          allowedExecutables,
          verification: { command: [join(directory, "verify")] },
        }),
        harness: harness(directory, allowedExecutables),
      });
    }).pipe(
      Effect.provide(makeAgentResolutionLayer(executor)),
      Effect.flip,
    ));

    expect(error).toMatchObject({ capability: "package-manager-requirements" });
    expect(invocations).toHaveLength(2);
    await expect(access(join(directory, "pip-downloaded"))).rejects.toThrow();
  });

  it.each([
    ["unauthorized nested index", "--extra-index-url=https://evil.example.test\n", "network-origin"],
    ["unauthorized nested find-links", "--find-links=https://evil.example.test\n", "network-origin"],
    ["fragmented nested index", "--index-url=https://packages.example.test/simple#fragment\n", "network-origin"],
    ["credentialed nested index", "--index-url=https://user:password@packages.example.test/simple\n", "network-origin"],
    ["unsupported nested option", "--trusted-host=evil.example.test\n", "package-manager-requirements"],
    ["direct URL requirement", "https://evil.example.test/tool.whl\n", "package-manager-requirements"],
    ["editable requirement", "-e ./local-tool\n", "package-manager-requirements"],
  ] as const)("denies %s before the package manager can run", async (_name, content, capability) => {
    const manager = join(directory, "pip");
    const requirements = join(directory, "requirements.txt");
    await Promise.all([
      writeFile(manager, "#!/bin/sh\nprintf spawned > pip-marker\n"),
      writeFile(requirements, content),
    ]);
    await chmod(manager, 0o755);
    const allowedExecutables = [manager, join(directory, "verify")];
    const error = await Effect.runPromise(authorizeAction(
      action({ executable: manager, arguments: ["install", "-r", requirements] }),
      task(directory, { allowedExecutables }),
      harness(directory, allowedExecutables),
    ).pipe(Effect.flip));
    expect(error).toMatchObject({ capability });
    await expect(access(join(directory, "pip-marker"))).rejects.toThrow();
  });

  it.each([
    ["https URL", ["-r", "https://evil.example.test/requirements.txt"], "package-manager-requirements"],
    ["http URL", ["--requirement=http://evil.example.test/requirements.txt"], "package-manager-requirements"],
    ["file URL", ["-c", "file:///tmp/constraints.txt"], "package-manager-requirements"],
    ["git VCS URL", ["-r", "git+https://github.com/example/requirements.git"], "package-manager-requirements"],
    ["scheme-relative URL", ["-c=//evil.example.test/constraints.txt"], "package-manager-requirements"],
    ["UNC path", ["-r", "\\\\evil.example.test\\share\\requirements.txt"], "package-manager-requirements"],
    ["encoded separator", ["-r", "nested%2Frequirements.txt"], "package-manager-requirements"],
    ["encoded scheme", ["-c", "https%3A%2F%2Fevil.example.test/constraints.txt"], "package-manager-requirements"],
    ["drive-relative URL-like path", ["-r", "C:requirements.txt"], "package-manager-requirements"],
    ["drive-rooted path", ["-c", "C:\\requirements.txt"], "path"],
  ] as const)(
    "denies direct remote-like pip include %s before execution",
    async (_name, includeArguments, capability) => {
      const manager = join(directory, "pip");
      const requirements = join(directory, "requirements.txt");
      await Promise.all([
        writeFile(manager, "#!/bin/sh\nprintf spawned > pip-marker\n"),
        writeFile(requirements, "safe-package\n"),
      ]);
      await chmod(manager, 0o755);
      const allowedExecutables = [manager, join(directory, "verify")];
      const error = await Effect.runPromise(authorizeAction(
        action({
          executable: manager,
          arguments: ["install", ...includeArguments],
          workingDirectory: directory,
        }),
        task(directory, { allowedExecutables }),
        harness(directory, allowedExecutables),
      ).pipe(Effect.flip));
      expect(error).toMatchObject({ capability });
      await expect(access(join(directory, "pip-marker"))).rejects.toThrow();
    },
  );

  it.each([
    ["https URL", "-r https://evil.example.test/requirements.txt\n", "package-manager-requirements"],
    ["http URL", "-c http://evil.example.test/constraints.txt\n", "package-manager-requirements"],
    ["file URL", "-r file:///tmp/requirements.txt\n", "package-manager-requirements"],
    ["git VCS URL", "-c git+https://github.com/example/constraints.git\n", "package-manager-requirements"],
    ["scheme-relative URL", "-r //evil.example.test/requirements.txt\n", "package-manager-requirements"],
    ["UNC path", "-c '\\\\evil.example.test\\share\\constraints.txt'\n", "package-manager-requirements"],
    ["encoded separator", "-r nested%2Frequirements.txt\n", "package-manager-requirements"],
    ["encoded scheme", "-c https%3A%2F%2Fevil.example.test/constraints.txt\n", "package-manager-requirements"],
    ["drive-relative URL-like path", "-r C:requirements.txt\n", "package-manager-requirements"],
    ["drive-rooted path", "-c 'C:\\requirements.txt'\n", "path"],
  ] as const)(
    "denies nested remote-like pip include %s before execution",
    async (_name, content, capability) => {
      const manager = join(directory, "pip");
      const requirements = join(directory, "requirements.txt");
      await Promise.all([
        writeFile(manager, "#!/bin/sh\nprintf spawned > pip-marker\n"),
        writeFile(requirements, content),
      ]);
      await chmod(manager, 0o755);
      const allowedExecutables = [manager, join(directory, "verify")];
      const error = await Effect.runPromise(authorizeAction(
        action({
          executable: manager,
          arguments: ["install", "-r", requirements],
          workingDirectory: directory,
        }),
        task(directory, { allowedExecutables }),
        harness(directory, allowedExecutables),
      ).pipe(Effect.flip));
      expect(error).toMatchObject({ capability });
      await expect(access(join(directory, "pip-marker"))).rejects.toThrow();
    },
  );

  it.each([
    ["nested cycle", "-r cycle-b.txt\n", "-r requirements.txt\n"],
    ["path escape", "-r ../outside.txt\n", undefined],
  ] as const)("denies %s and does not follow unbounded includes", async (
    _name,
    rootContent,
    nestedContent,
  ) => {
    const manager = join(directory, "pip");
    const requirements = join(directory, "requirements.txt");
    await writeFile(manager, "#!/bin/sh\nexit 0\n");
    await writeFile(requirements, rootContent);
    if (nestedContent !== undefined) {
      await writeFile(join(directory, "cycle-b.txt"), nestedContent);
    }
    await chmod(manager, 0o755);
    const allowedExecutables = [manager, join(directory, "verify")];
    const error = await Effect.runPromise(authorizeAction(
      action({ executable: manager, arguments: ["install", "-r", requirements] }),
      task(directory, { allowedExecutables }),
      harness(directory, allowedExecutables),
    ).pipe(Effect.flip));
    expect(error).toMatchObject({ capability: _name === "path escape" ? "path" : "package-manager-requirements" });
  });

  it.each([
    ["pypi simple", "https://pypi.org/simple"],
    ["private simple subpath", "https://packages.example.test/repository/simple?trusted=1"],
  ] as const)("preserves the full approved pip index URL for %s", async (_name, index) => {
    const manager = join(directory, "pip");
    await writeFile(manager, "#!/bin/sh\nexit 0\n");
    await chmod(manager, 0o755);
    const allowedExecutables = [manager, join(directory, "verify")];
    const recording = new RecordingExecutor(proposal(action({
      executable: manager,
      arguments: ["install", "tool", "--index-url", index],
    })));
    await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-apply",
        task: task(directory, { allowedExecutables, allowedOrigins: [index] }),
        harness: {
          ...harness(directory, allowedExecutables),
          allowedOrigins: [index],
        },
      });
    }).pipe(Effect.provide(makeAgentResolutionLayer(recording.execute))));
    expect(recording.invocations[1]?.arguments).toEqual([
      "install",
      "tool",
      "--only-binary=:all:",
      "--isolated",
      `--index-url=${index}`,
    ]);
    expect(registryOriginForInvocation(manager, recording.invocations[1]?.arguments ?? []))
      .toBe(index);
  });

  it("redacts credentials from rejected pip index options", async () => {
    const manager = join(directory, "pip");
    await writeFile(manager, "#!/bin/sh\nexit 0\n");
    await chmod(manager, 0o755);
    const allowedExecutables = [manager, join(directory, "verify")];
    const denied = await Effect.runPromise(authorizeAction(
      action({
        executable: manager,
        arguments: ["install", "tool", "-i", "https://user:password@evil.example.test/"],
      }),
      task(directory, { allowedExecutables }),
      harness(directory, allowedExecutables),
    ).pipe(Effect.flip));
    expect(denied).toMatchObject({
      capability: "network-origin",
      value: "[REDACTED]",
    });
  });

  it.each([
    ["extra index", ["install", "tool", "--extra-index-url=https://evil.example.test"]],
    ["find links", ["install", "tool", "-f", "https://evil.example.test"]],
    ["trusted host", ["install", "tool", "--trusted-host=evil.example.test"]],
    ["config setting", ["install", "tool", "--config-settings", "setup_args=--global-option=evil"]],
    ["proxy", ["install", "tool", "--proxy=https://evil.example.test"]],
  ] as const)(
    "rejects hostile pip registry/config option: %s",
    async (_name, arguments_) => {
      const manager = join(directory, "pip3.12");
      await writeFile(manager, "#!/bin/sh\nprintf spawned > hostile-pip-marker\n");
      await chmod(manager, 0o755);
      const allowedExecutables = [manager, join(directory, "verify")];
      const denied = await Effect.runPromise(authorizeAction(
        action({ executable: manager, arguments: arguments_ }),
        task(directory, { allowedExecutables }),
        harness(directory, allowedExecutables),
      ).pipe(Effect.flip));
      expect(denied).toMatchObject({
        capability: _name === "trusted host"
          || _name === "config setting"
          || _name === "proxy"
          ? "package-manager-config"
          : "network-origin",
      });
      await expect(access(join(directory, "hostile-pip-marker"))).rejects.toThrow();
    },
  );

  it.each([
    ["npm run", "npm", ["run", "postinstall"]],
    ["npm exec alias", "npm", ["x", "denied-package"]],
    ["npm credential-bearing dependency", "npm", ["install", "https://user:pass@github.com/example/tool.tgz"]],
    ["npm unknown protocol dependency", "npm", ["install", "custom+ssh://example.com/tool"]],
    ["npm separate ignore-scripts value", "npm", ["install", "tool", "--ignore-scripts", "true"]],
    ["npm separator ambiguity", "npm", ["install", "tool", "--", "--ignore-scripts"]],
    ["npm separator package", "npm", ["install", "--", "tool"]],
    ["npm explicit scripts", "npm", ["install", "tool", "--ignore-scripts=false"]],
    ["pnpm script", "pnpm", ["run", "postinstall"]],
    ["yarn install without a stable script gate", "yarn", ["install", "tool"]],
    ["bun run", "bun", ["run", "postinstall"]],
    ["uv run", "uv", ["run", "denied-tool"]],
    ["uv source build override", "uv", [
      "pip",
      "install",
      "tool",
      "--no-binary=:all:",
    ]],
    ["uv noncanonical binary mode", "uv", [
      "tool",
      "install",
      "tool",
      "--only-binary=:none:",
    ]],
  ])("denies script-capable package-manager bypass through %s", async (
    _name,
    managerName,
    arguments_,
  ) => {
    const manager = join(directory, managerName);
    await writeFile(manager, "#!/bin/sh\nexit 0\n");
    await chmod(manager, 0o755);
    const verify = join(directory, "verify");
    const allowedExecutables = [manager, verify];
    const denied = await Effect.runPromise(authorizeAction(
      action({ executable: manager, arguments: arguments_ }),
      task(directory, { allowedExecutables }),
      harness(directory, allowedExecutables),
    ).pipe(Effect.flip));
    expect(denied).toMatchObject({
      capability: "package-manager-scripts",
      value: manager,
    });
  });

  it.each([
    ["unscoped registry package", ["install", "tool"]],
    ["scoped registry package", ["install", "@scope/tool@1.2.3"]],
    ["npm alias", ["install", "alias@npm:real-tool"]],
    ["scoped npm alias", ["install", "@scope/alias@npm:@scope/real-tool"]],
    ["bare scoped npm alias", ["install", "npm:@scope/real-tool"]],
    ["bounded file dependency", ["install", "file:./local-tool"]],
    ["bounded link dependency", ["install", "link:./local-tool"]],
    ["workspace dependency", ["install", "workspace:*"]],
  ])("authorizes bounded npm %s without treating it as a remote origin", async (
    _name,
    arguments_,
  ) => {
    await mkdir(join(directory, "local-tool"));
    const manager = join(directory, "npm");
    await writeFile(manager, "#!/bin/sh\nexit 0\n");
    await chmod(manager, 0o755);
    const allowedExecutables = [manager, join(directory, "verify")];
    await expect(Effect.runPromise(authorizeAction(
      action({ executable: manager, arguments: arguments_ }),
      task(directory, { allowedExecutables }),
      harness(directory, allowedExecutables),
    ))).resolves.toBeUndefined();
  });

  it("selects one reviewed registry and overrides hostile package-manager config", async () => {
    const marker = join(directory, "registry-observation.json");
    const manager = join(directory, "npm");
    const verify = join(directory, "verify");
    const harnessScript = join(directory, "package-harness.mjs");
    await Promise.all([
      writeFile(
        manager,
        `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  registry: process.env.NPM_CONFIG_REGISTRY,
  scoped: process.env["npm_config_@scope:registry"],
  args: process.argv.slice(2),
}));
process.exit(
  process.argv.includes("--registry=https://packages.example.test")
    && process.argv.includes("--@scope:registry=https://packages.example.test")
    ? 0
    : 1
);
`,
      ),
      writeFile(verify, "#!/bin/sh\nprintf verified\n"),
      writeFile(
        harnessScript,
        `process.stdout.write(${JSON.stringify(JSON.stringify(proposal(action({
          executable: manager,
          arguments: ["install", "@scope/tool"],
        }))))});\n`,
      ),
    ]);
    await Promise.all([chmod(manager, 0o755), chmod(verify, 0o755)]);
    const allowedExecutables = [manager, verify];
    const result = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-apply",
        task: task(directory, {
          allowedExecutables,
          verification: { command: [verify], expectContains: "verified" },
        }),
        harness: {
          ...harness(directory, allowedExecutables),
          executable: process.execPath,
          arguments: [harnessScript],
          environment: [
            { name: "PATH", value: directory },
            { name: "NPM_CONFIG_REGISTRY", value: "https://evil.example.test" },
            { name: "npm_config_@scope:registry", value: "https://evil.example.test" },
            { name: "NPM_CONFIG_USERCONFIG", value: join(directory, ".npmrc") },
          ],
        },
      });
    }).pipe(Effect.provide(AgentResolutionLive)));
    expect(result.outcome).toBe("applied");
    // SAFETY: The fixture writes exactly these JSON fields before resolving.
    const observed = JSON.parse(await readFile(marker, "utf8")) as {
      registry: string;
      scoped: string;
      args: string[];
    };
    expect(observed.registry).toBe("https://packages.example.test");
    expect(observed.scoped).toBe("https://packages.example.test");
    expect(observed.args).toContain("--registry=https://packages.example.test");
    expect(observed.args).toContain("--@scope:registry=https://packages.example.test");
  });

  it.each([
    ["no unambiguous allowed registry", ["install", "tool"], ["https://one.example.test", "https://two.example.test"]],
    ["disallowed explicit registry", ["install", "tool", "--registry=https://evil.example.test"], ["https://packages.example.test"]],
    ["disallowed scoped registry", ["install", "@scope/tool", "--@scope:registry=https://evil.example.test"], ["https://packages.example.test"]],
    ["arbitrary config file", ["install", "tool", "--userconfig=/tmp/evil.npmrc"], ["https://packages.example.test"]],
  ])("fails closed for %s", async (
    _name,
    arguments_,
    allowedOrigins,
  ) => {
    const manager = join(directory, "npm");
    await writeFile(manager, "#!/bin/sh\nexit 0\n");
    await chmod(manager, 0o755);
    const allowedExecutables = [manager, join(directory, "verify")];
    const denied = await Effect.runPromise(authorizeAction(
      action({ executable: manager, arguments: arguments_ }),
      task(directory, { allowedExecutables, allowedOrigins }),
      {
        ...harness(directory, allowedExecutables),
        allowedOrigins,
      },
    ).pipe(Effect.flip));
    expect(denied).toMatchObject({
      capability: _name === "arbitrary config file"
        ? "package-manager-config"
        : "network-origin",
    });
  });

  it("accepts an explicitly allowed registry and canonicalizes its option", async () => {
    const manager = join(directory, "npm");
    await writeFile(manager, "#!/bin/sh\nexit 0\n");
    await chmod(manager, 0o755);
    const allowedExecutables = [manager, join(directory, "verify")];
    const result = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-propose",
        task: task(directory, { allowedExecutables }),
        harness: harness(directory, allowedExecutables),
      });
    }).pipe(Effect.provide(makeAgentResolutionLayer(
      (input) => Effect.succeed({
        executable: input.executable,
        arguments: input.arguments,
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify(proposal(action({
          executable: manager,
          arguments: ["install", "tool", "--registry=https://packages.example.test"],
        }))),
        stderr: "",
      }),
    ))));
    expect(result.outcome).toBe("proposed");
    if (result.outcome !== "proposed") return;
    expect(result.proposal.actions[0]?.arguments).toEqual([
      "install",
      "tool",
      "--ignore-scripts",
      "--registry=https://packages.example.test",
    ]);
  });

  it("redacts credentials from rejected registry options", async () => {
    const manager = join(directory, "npm");
    await writeFile(manager, "#!/bin/sh\nexit 0\n");
    await chmod(manager, 0o755);
    const allowedExecutables = [manager, join(directory, "verify")];
    const denied = await Effect.runPromise(authorizeAction(
      action({
        executable: manager,
        arguments: ["install", "tool", "--registry=https://user:password@evil.example.test"],
      }),
      task(directory, { allowedExecutables }),
      harness(directory, allowedExecutables),
    ).pipe(Effect.flip));
    expect(denied.value).toBe("[REDACTED]");
    expect(denied.value).not.toContain("password");
  });

  it.each([
    ["GitHub shorthand", "user/repo", "https://github.com"],
    ["github protocol", "github:user/repo", "https://github.com"],
    ["GitLab protocol", "gitlab:user/repo", "https://gitlab.com"],
    ["Bitbucket protocol", "bitbucket:user/repo", "https://bitbucket.org"],
    ["git+ssh hosted URL", "git+ssh://git@github.com/user/repo.git", "https://github.com"],
    ["git+https hosted URL", "git+https://github.com/user/repo.git", "https://github.com"],
    ["cased encoded hosted URL", "git+https://GITHUB.COM/user%2Frepo.git", "https://github.com"],
    ["non-default hosted port", "https://github.com:8443/user/repo.tgz", "https://github.com:8443"],
    ["hosted tarball", "https://github.com/user/repo/archive/v1.2.3.tgz", "https://github.com"],
    ["alias with remote", "alias@github:user/repo", "https://github.com"],
    ["scoped alias with remote", "@scope/alias@git+https://github.com/user/repo.git", "https://github.com"],
  ])("authorizes %s only when its canonical origin is allowed", async (
    _name,
    dependency,
    origin,
  ) => {
    const manager = join(directory, "npm");
    await writeFile(manager, "#!/bin/sh\nexit 0\n");
    await chmod(manager, 0o755);
    const allowedExecutables = [manager, join(directory, "verify")];
    const allowedBounds = {
      allowedOrigins: [origin],
    };
    await expect(Effect.runPromise(authorizeAction(
      action({ executable: manager, arguments: ["install", dependency] }),
      task(directory, { allowedExecutables, ...allowedBounds }),
      { ...harness(directory, allowedExecutables), ...allowedBounds },
    ))).resolves.toBeUndefined();

    await expect(Effect.runPromise(authorizeAction(
      action({ executable: manager, arguments: ["install", dependency] }),
      task(directory, {
        allowedExecutables,
        allowedOrigins: ["https://denied.example.test"],
      }),
      {
        ...harness(directory, allowedExecutables),
        allowedOrigins: ["https://denied.example.test"],
      },
    ).pipe(Effect.flip))).resolves.toMatchObject({
      capability: "network-origin",
    });
  });

  it.each([
    ["non-hosted git+ssh", "git+ssh://git@example.com/user/repo.git"],
    ["ambiguous protocol", "git+custom://example.com/user/repo"],
    ["separator package", "install", "--", "user/repo"],
    ["unknown option value", "install", "--registry", "not-a-url"],
  ])("rejects ambiguous npm remote form %s", async (
    _name,
    ...dependencyArguments
  ) => {
    const manager = join(directory, "npm");
    await writeFile(manager, "#!/bin/sh\nexit 0\n");
    await chmod(manager, 0o755);
    const allowedExecutables = [manager, join(directory, "verify")];
    const arguments_ = dependencyArguments[0] === "install"
      ? dependencyArguments
      : ["install", ...dependencyArguments];
    await expect(Effect.runPromise(authorizeAction(
      action({ executable: manager, arguments: arguments_ }),
      task(directory, { allowedExecutables }),
      harness(directory, allowedExecutables),
    ).pipe(Effect.flip))).resolves.toMatchObject({
      capability: _name === "unknown option value"
        ? "network-origin"
        : "package-manager-scripts",
    });
  });

  it.each([
    ["npm metadata", "npm", ["view", "tool", "version"]],
    ["pnpm metadata", "pnpm", ["list", "--depth=0"]],
    ["bun help", "bun", ["help"]],
    ["uv installed-package metadata", "uv", ["pip", "list"]],
  ])("allows structurally non-executing package-manager operation %s", async (
    _name,
    managerName,
    arguments_,
  ) => {
    const manager = join(directory, managerName);
    await writeFile(manager, "#!/bin/sh\nexit 0\n");
    await chmod(manager, 0o755);
    const verify = join(directory, "verify");
    const allowedExecutables = [manager, verify];
    await expect(Effect.runPromise(authorizeAction(
      action({ executable: manager, arguments: arguments_ }),
      task(directory, { allowedExecutables }),
      harness(directory, allowedExecutables),
    ))).resolves.toBeUndefined();
  });

  it("prevents a real package lifecycle script from running", async () => {
    const marker = join(directory, "lifecycle-ran");
    const manager = join(directory, "npm");
    const harnessScript = join(directory, "package-harness.mjs");
    const verify = join(directory, "verify");
    await Promise.all([
      writeFile(
        manager,
        [
          "#!/bin/sh",
          "for argument in \"$@\"; do",
          "  if [ \"$argument\" = \"--ignore-scripts\" ]; then exit 0; fi",
          "done",
          `printf lifecycle > ${JSON.stringify(marker)}`,
          "",
        ].join("\n"),
      ),
      writeFile(
        harnessScript,
        `process.stdout.write(${JSON.stringify(JSON.stringify(proposal(action({
          executable: manager,
          arguments: ["install", "--global", "hostile-package"],
        }))))});\n`,
      ),
    ]);
    await chmod(manager, 0o755);
    const allowedExecutables = [manager, verify];
    const result = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-apply",
        task: task(directory, {
          allowedExecutables,
          verification: { command: [verify] },
        }),
        harness: {
          ...harness(directory, allowedExecutables),
          executable: process.execPath,
          arguments: [harnessScript],
        },
      });
    }).pipe(Effect.provide(AgentResolutionLive)));
    expect(result.outcome).toBe("applied");
    expect(result.executions[0]?.arguments).toContain("--ignore-scripts");
    await expect(access(marker)).rejects.toThrow();
  });

  it("applies the same fail-closed behavior to verification commands", async () => {
    const launcher = join(directory, "xargs");
    await writeFile(launcher, "#!/bin/sh\nexit 0\n");
    await chmod(launcher, 0o755);
    const allowedExecutables = [launcher];
    const recording = new RecordingExecutor({ summary: "no action", actions: [] });
    const error = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-apply",
        task: task(directory, {
          allowedExecutables,
          executableAuthorizations: [],
          verification: { command: [launcher, "denied-tool"] },
        }),
        harness: {
          ...harness(directory, allowedExecutables),
          executableAuthorizations: [],
        },
      });
    }).pipe(
      Effect.provide(makeAgentResolutionLayer(recording.execute)),
      Effect.flip,
    ));
    expect(error).toMatchObject({
      capability: "nested-command-launcher",
    });
    expect(recording.invocations).toHaveLength(1);
  });

  it("prevents a real opaque launcher from reaching its descendant", async () => {
    const marker = join(directory, "spawned");
    const launcher = join(directory, "xargs");
    const harnessScript = join(directory, "harness.mjs");
    const verify = join(directory, "verify");
    await Promise.all([
      writeFile(launcher, `#!/bin/sh\nprintf spawned > ${JSON.stringify(marker)}\n`),
      writeFile(
        harnessScript,
        `process.stdout.write(${JSON.stringify(JSON.stringify(proposal(action({
          executable: launcher,
          arguments: ["denied-tool"],
        }))))});\n`,
      ),
    ]);
    await chmod(launcher, 0o755);
    const allowedExecutables = [launcher, verify];
    const executableAuthorizations = [{
      executable: verify,
      behavior: "leaf" as const,
    }];
    const error = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-apply",
        task: task(directory, {
          allowedExecutables,
          executableAuthorizations,
        }),
        harness: {
          ...harness(directory, allowedExecutables),
          executable: process.execPath,
          arguments: [harnessScript],
          executableAuthorizations,
        },
      });
    }).pipe(
      Effect.provide(AgentResolutionLive),
      Effect.flip,
    ));
    expect(error).toMatchObject({ capability: "nested-command-launcher" });
    await expect(access(marker)).rejects.toThrow();
  });

  it("does not spawn an allowlisted interpreter", async () => {
    const marker = join(directory, "interpreter-ran");
    const script = join(directory, "bounded-script.mjs");
    const harnessScript = join(directory, "interpreter-harness.mjs");
    await Promise.all([
      writeFile(
        script,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`,
      ),
      writeFile(
        harnessScript,
        `process.stdout.write(${JSON.stringify(JSON.stringify(proposal(action({
          executable: process.execPath,
          arguments: [script],
        }))))});\n`,
      ),
    ]);
    const allowedExecutables = [process.execPath, join(directory, "verify")];
    const error = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-apply",
        task: task(directory, { allowedExecutables }),
        harness: {
          ...harness(directory, allowedExecutables),
          executable: process.execPath,
          arguments: [harnessScript],
        },
      });
    }).pipe(
      Effect.provide(AgentResolutionLive),
      Effect.flip,
    ));
    expect(error).toMatchObject({
      capability: "script-interpreter",
      value: process.execPath,
    });
    await expect(access(marker)).rejects.toThrow();
  });

  it("rejects interpreter script files even when path bounded", async () => {
    const script = join(directory, "bounded-script.mjs");
    await writeFile(script, "process.exit(0);\n");
    const boundedTask = task(directory, {
      allowedExecutables: [process.execPath, join(directory, "verify")],
    });
    const bounds = {
      ...harness(directory, [process.execPath, join(directory, "verify")]),
    };
    const denied = await Effect.runPromise(authorizeAction(
      action({
        executable: process.execPath,
        arguments: [script, "-e", "literal;not-shell-syntax"],
      }),
      boundedTask,
      bounds,
    ).pipe(Effect.flip));
    expect(denied).toMatchObject({
      capability: "script-interpreter",
      value: process.execPath,
    });
  });

  it("fails closed on unknown interpreter modes instead of treating payloads as scripts", async () => {
    const boundedTask = task(directory, {
      allowedExecutables: [process.execPath, join(directory, "verify")],
    });
    const denied = await Effect.runPromise(authorizeAction(
      action({
        executable: process.execPath,
        arguments: ["--unknown-inline-mode", "process.exit(0)"],
      }),
      boundedTask,
      {
        ...harness(directory, [process.execPath, join(directory, "verify")]),
      },
    ).pipe(Effect.flip));
    expect(denied).toMatchObject({ capability: "script-interpreter" });
  });

  it("fails when independent verification rejects the agent self-report", async () => {
    let count = 0;
    const executor: ControlledExecutor = (input) => {
      count += 1;
      const stdout = count === 1
        ? JSON.stringify(proposal(action()))
        : count === 2
          ? "agent says verified"
          : "not verified";
      const result: CapturedProcess = {
        executable: input.executable,
        arguments: input.arguments,
        exitCode: count === 3 ? 1 : 0,
        signal: null,
        stdout,
        stderr: "",
      };
      return Effect.succeed(result);
    };
    const error = await Effect.runPromise(resolveWith(
      executor,
      directory,
      "agent-apply",
    ).pipe(Effect.flip));
    expect(error._tag).toBe("AgentVerificationError");
  });

  it("redacts configured secrets from tasks, proposals, and recorded harness output", async () => {
    const secret = "sensitive-value";
    const recording = new RecordingExecutor({
      summary: `resolved with ${secret}`,
      actions: [],
    });
    const result = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.resolve({
        policy: "agent-propose",
        task: task(directory, {
          observedEvidence: [`token=${secret}`],
        }),
        harness: harness(directory),
        secrets: [secret],
      });
    }).pipe(Effect.provide(makeAgentResolutionLayer(recording.execute))));
    expect(result.outcome).toBe("proposed");
    if (result.outcome !== "proposed") return;
    expect(result.task.observedEvidence).toEqual(["token=[REDACTED]"]);
    expect(result.proposal.summary).toBe("resolved with [REDACTED]");
    expect(result.harness.stdout).not.toContain(secret);
  });

  it("creates only a pending reviewed profile proposal from discovery", async () => {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const service = yield* AgentResolution;
      return yield* service.proposeProfileChange({
        reason: "resolved ambiguous package",
        additions: [],
        modifications: [],
        removals: [],
        evidence: [{
          source: "AGENTS.md",
          line: 4,
          excerpt: "use test-tool",
          kind: "prose",
        }],
      }, "2026-08-15T00:00:00.000Z");
    }).pipe(Effect.provide(AgentResolutionLive)));
    expect(result).toMatchObject({
      reviewStatus: "pending",
      proposal: {
        reason: "resolved ambiguous package",
        additions: [],
        modifications: [],
      },
    });
    expect(result).not.toHaveProperty("publish");
  });
});

describe("real controlled subprocess", () => {
  it("refuses a package operation without an authorized registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "canonfig-registry-"));
    try {
      const manager = join(root, "npm");
      await writeFile(manager, "#!/bin/sh\nprintf spawned > hostile-download\n");
      await chmod(manager, 0o755);
      const error = await Effect.runPromise(executeControlledProcess({
        executable: manager,
        arguments: ["install", "tool"],
        workingDirectory: root,
        environment: [
          { name: "NPM_CONFIG_REGISTRY", value: "https://evil.example.test" },
        ],
        timeoutMilliseconds: 2_000,
        maximumInputBytes: 0,
        maximumOutputBytes: 1_000,
        secrets: [],
      }).pipe(Effect.flip));
      expect(error).toBeInstanceOf(AgentProcessError);
      await expect(access(join(root, "hostile-download"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pins pip aliases and clears hostile pip/uv environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "canonfig-pip-registry-"));
    try {
      const marker = join(root, "pip-environment.json");
      const manager = join(root, "pip3.12");
      await writeFile(
        manager,
        `#!${process.execPath}
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  index: process.env.PIP_INDEX_URL,
  extra: process.env.PIP_EXTRA_INDEX_URL,
  config: process.env.PIP_CONFIG_FILE,
  proxy: process.env.HTTPS_PROXY,
  args: process.argv.slice(2),
}));
`,
      );
      await chmod(manager, 0o755);
      const result = await Effect.runPromise(executeControlledProcess({
        executable: manager,
        arguments: [
          "install",
          "tool",
          "--index-url=https://packages.example.test",
        ],
        workingDirectory: root,
        environment: [
          { name: "PIP_INDEX_URL", value: "https://evil.example.test" },
          { name: "PIP_EXTRA_INDEX_URL", value: "https://evil.example.test" },
          { name: "PIP_CONFIG_FILE", value: join(root, "evil-pip.conf") },
          { name: "UV_INDEX_URL", value: "https://evil.example.test" },
          { name: "HTTPS_PROXY", value: "https://user:password@evil.example.test" },
        ],
        packageRegistryOrigin: "https://PACKAGES.EXAMPLE.TEST:443/",
        timeoutMilliseconds: 2_000,
        maximumInputBytes: 0,
        maximumOutputBytes: 10_000,
        secrets: ["password"],
      }));
      expect(result.exitCode).toBe(0);
      // SAFETY: The fixture writes exactly these JSON fields before exiting.
      const observed = JSON.parse(await readFile(marker, "utf8")) as {
        index: string;
        extra?: string;
        config: string;
        proxy?: string;
        args: string[];
      };
      expect(observed.index).toBe("https://packages.example.test");
      expect(observed.extra).toBeUndefined();
      expect(observed.config).toBe(process.platform === "win32" ? "NUL" : "/dev/null");
      expect(observed.proxy).toBeUndefined();
      expect(observed.args).toContain("--index-url=https://packages.example.test");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("injects the full approved pip index URL into argv and environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "canonfig-pip-index-path-"));
    try {
      const marker = join(root, "pip-index.json");
      const manager = join(root, "pip");
      const index = "https://packages.example.test/repository/simple?channel=stable";
      await writeFile(
        manager,
        `#!${process.execPath}
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  index: process.env.PIP_INDEX_URL,
  args: process.argv.slice(2),
}));
`,
      );
      await chmod(manager, 0o755);
      const result = await Effect.runPromise(executeControlledProcess({
        executable: manager,
        arguments: ["install", "tool", `--index-url=${index}`],
        workingDirectory: root,
        packageRegistryOrigin: index,
        timeoutMilliseconds: 2_000,
        maximumInputBytes: 0,
        maximumOutputBytes: 10_000,
        secrets: [],
      }));
      expect(result.exitCode).toBe(0);
      // SAFETY: The fixture writes exactly these JSON fields before exiting.
      const observed = JSON.parse(await readFile(marker, "utf8")) as {
        index: string;
        args: string[];
      };
      expect(observed.index).toBe(index);
      expect(observed.args).toContain(`--index-url=${index}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an extra pip index before spawning", async () => {
    const root = await mkdtemp(join(tmpdir(), "canonfig-pip-extra-index-"));
    try {
      const manager = join(root, "pip");
      await writeFile(manager, "#!/bin/sh\nprintf spawned > hostile-pip-download\n");
      await chmod(manager, 0o755);
      const error = await Effect.runPromise(executeControlledProcess({
        executable: manager,
        arguments: [
          "install",
          "tool",
          "--extra-index-url",
          "https://evil.example.test",
        ],
        workingDirectory: root,
        packageRegistryOrigin: "https://packages.example.test",
        timeoutMilliseconds: 2_000,
        maximumInputBytes: 0,
        maximumOutputBytes: 1_000,
        secrets: [],
      }).pipe(Effect.flip));
      expect(error).toBeInstanceOf(AgentProcessError);
      await expect(access(join(root, "hostile-pip-download"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects pip requirement files at the controlled-executor boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "canonfig-pip-requirements-boundary-"));
    try {
      const manager = join(root, "pip");
      await writeFile(manager, "#!/bin/sh\nprintf spawned > pip-requirements-marker\n");
      await chmod(manager, 0o755);
      const error = await Effect.runPromise(executeControlledProcess({
        executable: manager,
        arguments: ["install", "-r", "requirements.txt"],
        workingDirectory: root,
        packageRegistryOrigin: "https://packages.example.test",
        timeoutMilliseconds: 2_000,
        maximumInputBytes: 0,
        maximumOutputBytes: 1_000,
        secrets: [],
      }).pipe(Effect.flip));
      expect(error).toBeInstanceOf(AgentProcessError);
      await expect(access(join(root, "pip-requirements-marker"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces input byte limits", async () => {
    const error = await Effect.runPromise(executeControlledProcess({
      executable: process.execPath,
      arguments: ["-e", ""],
      standardInput: new TextEncoder().encode("too large"),
      timeoutMilliseconds: 2_000,
      maximumInputBytes: 2,
      maximumOutputBytes: 1_000,
      secrets: [],
    }).pipe(Effect.flip));
    expect(error).toBeInstanceOf(AgentInputLimitError);
  });

  it("enforces timeout", async () => {
    const error = await Effect.runPromise(executeControlledProcess({
      executable: process.execPath,
      arguments: ["-e", "setTimeout(() => {}, 10_000)"],
      timeoutMilliseconds: 25,
      maximumInputBytes: 0,
      maximumOutputBytes: 1_000,
      secrets: [],
    }).pipe(Effect.flip));
    expect(error).toBeInstanceOf(AgentExecutionTimeoutError);
  });

  it("enforces cancellation", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);
    const error = await Effect.runPromise(executeControlledProcess({
      executable: process.execPath,
      arguments: ["-e", "setTimeout(() => {}, 10_000)"],
      timeoutMilliseconds: 2_000,
      maximumInputBytes: 0,
      maximumOutputBytes: 1_000,
      secrets: [],
      signal: controller.signal,
    }).pipe(Effect.flip));
    expect(error).toBeInstanceOf(AgentExecutionCancelledError);
  });

  it("enforces combined stdout and stderr output limits", async () => {
    const error = await Effect.runPromise(executeControlledProcess({
      executable: process.execPath,
      arguments: ["-e", "process.stdout.write('x'.repeat(600)); process.stderr.write('y'.repeat(600))"],
      timeoutMilliseconds: 2_000,
      maximumInputBytes: 0,
      maximumOutputBytes: 1_000,
      secrets: [],
    }).pipe(Effect.flip));
    expect(error).toBeInstanceOf(AgentOutputLimitError);
  });

  it("redacts secrets from stdout and stderr", async () => {
    const secret = "top-secret-token";
    const result = await Effect.runPromise(executeControlledProcess({
      executable: process.execPath,
      arguments: ["-e", `process.stdout.write('${secret}'); process.stderr.write('${secret}')`],
      timeoutMilliseconds: 2_000,
      maximumInputBytes: 0,
      maximumOutputBytes: 1_000,
      secrets: [secret],
    }));
    expect(result.stdout).toBe("[REDACTED]");
    expect(result.stderr).toBe("[REDACTED]");
  });

  it("runs a real shell-free fixture with argv preserved", async () => {
    const output = join(tmpdir(), `canonfig-agent-output-${String(process.pid)}.txt`);
    const script = join(tmpdir(), `canonfig-agent-fixture-${String(process.pid)}.mjs`);
    await writeFile(script, "import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[2], process.argv[3]);");
    try {
      const result = await Effect.runPromise(executeControlledProcess({
        executable: process.execPath,
        arguments: [script, output, "literal;not-a-shell-command"],
        timeoutMilliseconds: 2_000,
        maximumInputBytes: 0,
        maximumOutputBytes: 1_000,
        secrets: [],
      }));
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(script, { force: true });
      await rm(output, { force: true });
    }
  });
});
