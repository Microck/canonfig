import { basename, delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
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
  DeniedAgentCapabilityError,
  InvalidAgentTaskError,
} from "../src/agent/agent-resolution.errors.ts";
import {
  AgentResolutionLive,
  makeAgentResolutionLayer,
  type ControlledExecutor,
} from "../src/agent/agent-resolution.layer.ts";
import { AgentResolution } from "../src/agent/agent-resolution.service.ts";
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
    ["omitted restart capability", ["restart"], "restart"],
    ["omitted reboot capability", ["reboot"], "reboot"],
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
      capability: "inline-program",
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
        capability: "script-identity",
        value: "xargs",
      });
    } finally {
      await rm(shadowDirectory, { recursive: true, force: true });
    }
  });

  it("allows an explicit bounded POSIX shell script identity", async () => {
    const shell = join(directory, "sh");
    const script = join(directory, "bounded-script.sh");
    await Promise.all([
      writeFile(shell, "#!/bin/sh\nexit 0\n"),
      writeFile(script, "exit 0\n"),
    ]);
    await chmod(shell, 0o755);
    const allowedExecutables = [shell, join(directory, "verify")];
    const boundedTask = task(directory, { allowedExecutables });
    await expect(Effect.runPromise(authorizeAction(
      action({
        executable: shell,
        arguments: ["./bounded-script.sh"],
      }),
      boundedTask,
      {
        ...harness(directory, allowedExecutables),
      },
    ))).resolves.toBeUndefined();
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
    ]);
  });

  it.each([
    ["npm run", "npm", ["run", "postinstall"]],
    ["npm exec alias", "npm", ["x", "denied-package"]],
    ["npm git dependency", "npm", ["install", "git+https://github.com/example/tool.git#v1.2.3"]],
    ["npm file dependency", "npm", ["install", "file:../tool"]],
    ["npm link dependency", "npm", ["install", "link:../tool"]],
    ["npm workspace dependency", "npm", ["install", "workspace:*"]],
    ["npm package alias", "npm", ["install", "alias@npm:real-tool"]],
    ["npm bare alias", "npm", ["install", "npm:real-tool"]],
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

  it("allows explicit interpreter script files only within path bounds", async () => {
    const script = join(directory, "bounded-script.mjs");
    await writeFile(script, "process.exit(0);\n");
    const boundedTask = task(directory, {
      allowedExecutables: [process.execPath, join(directory, "verify")],
    });
    const bounds = {
      ...harness(directory, [process.execPath, join(directory, "verify")]),
    };
    await expect(Effect.runPromise(authorizeAction(
      action({
        executable: process.execPath,
        arguments: [script, "-e", "literal;not-shell-syntax"],
      }),
      boundedTask,
      bounds,
    ))).resolves.toBeUndefined();

    const outsideScript = join(directory, "..", "outside-script.mjs");
    const denied = await Effect.runPromise(authorizeAction(
      action({
        executable: process.execPath,
        arguments: [outsideScript],
      }),
      boundedTask,
      bounds,
    ).pipe(Effect.flip));
    expect(denied).toMatchObject({ capability: "path" });

    const powershell = join(directory, "pwsh");
    const powershellScript = join(directory, "bounded-script.ps1");
    await Promise.all([
      writeFile(powershell, "#!/bin/sh\nexit 0\n"),
      writeFile(powershellScript, "exit 0\n"),
    ]);
    await chmod(powershell, 0o755);
    const powershellTask = task(directory, {
      allowedExecutables: [powershell, join(directory, "verify")],
    });
    await expect(Effect.runPromise(authorizeAction(
      action({
        executable: powershell,
        arguments: ["-File", powershellScript, "-Command", "literal argument"],
      }),
      powershellTask,
      {
        ...harness(directory, [powershell, join(directory, "verify")]),
      },
    ))).resolves.toBeUndefined();
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
    expect(denied).toMatchObject({ capability: "inline-program" });
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
