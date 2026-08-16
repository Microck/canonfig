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

const GeminiResultSchema = Schema.Struct({
  response: Schema.String,
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

const harnessArguments = (
  harness: SupportedHarness,
): ReadonlyArray<string> => {
  switch (harness) {
    case "codex":
      return ["exec", "--json", "--sandbox", "read-only", "-"];
    case "claude":
      return ["--print", "--permission-mode", "plan", "--output-format", "json"];
    case "gemini":
      return ["--approval-mode", "plan", "--output-format", "json"];
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
  arguments: [
    ...(configuration.arguments ?? []),
    ...harnessArguments(configuration.harness),
  ],
  environment: configuration.environment ?? [],
  input: encodeAgentTask(task),
});

/**
 * Normalizes each supported CLI's machine-readable envelope. Recording
 * harnesses may return the proposal JSON directly.
 */
export const extractHarnessResponse = (
  harness: SupportedHarness,
  output: string,
): string => {
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
    const parsed = JSON.parse(output);
    if (harness === "claude") {
      const decoded = Schema.decodeUnknownOption(ClaudeResultSchema)(parsed);
      return Option.isSome(decoded) ? decoded.value.result : output;
    }
    const decoded = Schema.decodeUnknownOption(GeminiResultSchema)(parsed);
    return Option.isSome(decoded) ? decoded.value.response : output;
  } catch {
    return output;
  }
};
