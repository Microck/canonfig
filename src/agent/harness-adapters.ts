import { Option, Schema } from "effect";

import type { AgentTask } from "../domain/synchronization.ts";
import type {
  AgentHarnessConfiguration,
  AgentTaskDocument,
  SupportedHarness,
} from "./agent-resolution.types.ts";

export interface HarnessInvocation {
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
  readonly environment: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }>;
  readonly input: Uint8Array;
}

const encoder = new TextEncoder();

const ClaudeResultSchema = Schema.Struct({
  type: Schema.Literal("result"),
  result: Schema.String,
});

const CodexEventSchema = Schema.Struct({
  type: Schema.String,
  item: Schema.optional(Schema.Struct({
    type: Schema.String,
    text: Schema.optional(Schema.String),
  })),
});

export const encodeAgentTask = (task: AgentTask): Uint8Array => {
  const document: AgentTaskDocument = {
    schema: "canonfig.agent-task/v1",
    task,
    responseContract: {
      format: "json",
      actions: ["process"],
      selfReportIsProof: false,
    },
  };
  return encoder.encode(`${JSON.stringify(document, undefined, 2)}\n`);
};

/**
 * Built-ins get fixed read-only flags, plus `--model` when set (both CLIs take it
 * as a top-level option: `codex --model <m> exec ...`, `claude --model <m> --print ...`).
 * A custom harness gets exactly the arguments the user configured and nothing else,
 * so its read-only behaviour is the user's responsibility (ADR 0002).
 */
const harnessArguments = (
  configuration: AgentHarnessConfiguration,
): ReadonlyArray<string> => {
  const model = configuration.model === undefined ? [] : ["--model", configuration.model];
  switch (configuration.harness) {
    case "codex":
      // Synchronization tasks target machine paths, not a Git working tree.
      // Keep Codex read-only; Canonfig separately authorizes proposed actions.
      return [...model, "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-"];
    case "claude":
      return [...model, "--print", "--permission-mode", "plan", "--output-format", "json"];
    case "custom":
      return configuration.arguments ?? [];
  }
};

/**
 * Harness selection is an explicit configuration value. No task text or
 * executable name is inspected to infer a harness.
 */
export const adaptHarnessInvocation = (
  configuration: AgentHarnessConfiguration,
  task: AgentTask,
): HarnessInvocation => ({
  executable: configuration.executable,
  arguments: harnessArguments(configuration),
  environment: configuration.environment ?? [],
  input: encodeAgentTask(task),
});

/**
 * Normalizes each built-in CLI's machine-readable envelope. A custom harness
 * writes the proposal JSON itself to stdout, so its output is used as is.
 */
export const extractHarnessResponse = (
  harness: SupportedHarness,
  output: string,
): string => {
  if (harness === "custom") return output;
  if (harness === "codex") {
    const events = output
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const decoded = Schema.decodeUnknownOption(CodexEventSchema)(JSON.parse(line));
          return Option.isSome(decoded) ? [decoded.value] : [];
        } catch {
          return [];
        }
      });
    const message = [...events].reverse().find((event) =>
      event.item?.type === "agent_message" && event.item.text !== undefined
    )?.item?.text;
    return message ?? output;
  }
  try {
    const decoded = Schema.decodeUnknownOption(ClaudeResultSchema)(JSON.parse(output));
    return Option.isSome(decoded) ? decoded.value.result : output;
  } catch {
    return output;
  }
};
