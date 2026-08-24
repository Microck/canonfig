import { Schema } from "effect";

import { CliExitCode, type CliExitCode as CliExitCodeValue } from "../cli/exit-codes.ts";
import { renderCliResult } from "../cli/render.ts";
import type { CliPayload } from "../cli/source-commands.ts";
import { CanonfigError } from "./core/errors.ts";
import type { Diagnostic, Plan, PlanEntry } from "./core/types.ts";

export interface HarnessConfigurationCliIo {
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly setExitCode: (exitCode: CliExitCodeValue) => void;
}

const actionSymbol = (entry: PlanEntry): string => {
  switch (entry.action) {
    case "create": return "+";
    case "update": return "~";
    case "delete": return "-";
    case "conflict": return "!";
    case "unchanged": return "=";
  }
};

export const renderHumanPlan = (
  plan: Plan,
  includeUnchanged: boolean,
): string => {
  const lines: string[] = [];
  for (const entry of plan.entries) {
    if (!includeUnchanged && entry.action === "unchanged") continue;
    lines.push(`${actionSymbol(entry)} ${entry.action.padEnd(9)} ${entry.path}`);
    if (entry.reason !== undefined) lines.push(`  ${entry.reason}`);
  }
  for (const diagnostic of plan.diagnostics) {
    const target = diagnostic.target === undefined ? "" : `[${diagnostic.target}] `;
    const location = diagnostic.path === undefined ? "" : ` (${diagnostic.path})`;
    lines.push(
      `${diagnostic.level.toUpperCase()} ${target}${diagnostic.code}: ${diagnostic.message}${location}`,
    );
  }
  const counts = ["create", "update", "delete", "unchanged", "conflict"]
    .map((action) => `${plan.entries.filter((entry) => entry.action === action).length} ${action}`)
    .join(", ");
  lines.push(counts);
  return `${lines.join("\n")}\n`;
};

export const toCliPayload = (value: unknown): CliPayload =>
  Schema.decodeUnknownSync(Schema.MutableJson)(
    JSON.parse(JSON.stringify(value)),
  );

export const planPayload = (plan: Plan): CliPayload =>
  toCliPayload({
    root: plan.root,
    targets: plan.targets,
    entries: plan.entries.map(({
      content: _content,
      before: _before,
      after: _after,
      nextState: _nextState,
      ...entry
    }) => entry),
    diagnostics: plan.diagnostics,
  });

export const diagnosticsPayload = (
  diagnostics: ReadonlyArray<Diagnostic>,
): CliPayload => toCliPayload(diagnostics);

export const isHarnessPlanBlocked = (plan: Plan): boolean =>
  plan.entries.some((entry) => entry.action === "conflict")
  || plan.diagnostics.some((diagnostic) => diagnostic.level === "error");

export const renderHarnessResult = (
  io: HarnessConfigurationCliIo,
  input: {
    readonly command: string;
    readonly message: string;
    readonly data?: CliPayload | undefined;
    readonly exitCode: CliExitCodeValue;
    readonly json: boolean;
    readonly human?: string | undefined;
  },
): void => {
  const rendered = input.json
    ? renderCliResult({
      command: input.command,
      message: input.message,
      data: input.data,
      exitCode: input.exitCode,
    }, "json")
    : (input.human ?? renderCliResult({
      command: input.command,
      message: input.message,
      data: input.data,
      exitCode: input.exitCode,
    }, "human"));
  if (input.exitCode === CliExitCode.success) io.writeStdout(rendered);
  else io.writeStderr(rendered);
  io.setExitCode(input.exitCode);
};

export const harnessFailureExitCode = (error: unknown): CliExitCodeValue => {
  if (!(error instanceof CanonfigError)) return CliExitCode.internal;
  if (/CONFLICT|COLLISION|EDITED|ESCAPE|STALE/u.test(error.code)) {
    return CliExitCode.conflictOrDrift;
  }
  if (/APPLY|WRITE|ROLLBACK/u.test(error.code)) {
    return CliExitCode.verificationOrApplyFailure;
  }
  if (/INVALID|NOT_FOUND|UNKNOWN|REQUIRED|EMPTY|PARSE/u.test(error.code)) {
    return CliExitCode.usageOrConfiguration;
  }
  return CliExitCode.internal;
};
