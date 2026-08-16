import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  chmod,
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
} from "../src/agent/agent-resolution.errors.ts";
import {
  AgentResolutionLive,
  makeAgentResolutionLayer,
  type ControlledExecutor,
} from "../src/agent/agent-resolution.layer.ts";
import { AgentResolution } from "../src/agent/agent-resolution.service.ts";
import { authorizeAction } from "../src/agent/agent-resolution.service.ts";
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

const task = (root: string, changes: Partial<AgentTask> = {}): AgentTask => ({
  id: taskId,
  summary: "Resolve test tool",
  desiredOutcome: "test tool is installed",
  observedEvidence: ["not installed"],
  allowedPaths: [root],
  allowedExecutables: ["tool", "verify", process.execPath],
  allowedOrigins: ["https://packages.example.test"],
  forbidden: ["elevation", "login", "restart", "reboot"],
  timeLimitSeconds: 2,
  outputLimitBytes: 32_000,
  verification: { command: ["verify"], expectContains: "verified" },
  ...changes,
});

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

const harness = (root: string) => ({
  harness: "codex" as const,
  executable: process.execPath,
  maximumInputBytes: 64_000,
  allowedPaths: [root],
  allowedExecutables: ["tool", "verify", process.execPath],
  allowedOrigins: ["https://packages.example.test"],
  allowedCapabilities: [] as const,
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
      "tool",
      "verify",
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
