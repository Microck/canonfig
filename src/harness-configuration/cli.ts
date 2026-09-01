import { CliExitCode } from "../cli/exit-codes.ts";
import {
  harnessHelpText,
  parseHarnessArguments,
  type ParsedHarnessArguments,
} from "./cli-arguments.ts";
import {
  diagnosticsPayload,
  harnessFailureExitCode,
  isHarnessPlanBlocked,
  planPayload,
  renderHarnessResult,
  renderHumanPlan,
  toCliPayload,
  type HarnessConfigurationCliIo,
} from "./cli-output.ts";
import {
  HarnessConfigurationCompiler,
  createDefaultRegistry,
} from "./core/compiler.ts";
import { findRepositoryRoot } from "./core/config.ts";
import { formatPlanDiff } from "./core/diff.ts";
import { doctorTargets } from "./core/doctor.ts";
import { CanonfigError, errorMessage } from "./core/errors.ts";
import { applyPlan, createPlan } from "./core/planner.ts";
import { scaffoldProject } from "./core/scaffold.ts";
import { TARGET_IDS } from "./core/types.ts";

export type { HarnessConfigurationCliIo } from "./cli-output.ts";

export const isHarnessConfigurationCommand = (
  arguments_: ReadonlyArray<string>,
): boolean => arguments_[0] === "harness";

const renderHelp = (
  parsed: ParsedHarnessArguments,
  io: HarnessConfigurationCliIo,
): void => {
  renderHarnessResult(io, {
    command: "harness.help",
    message: "Harness configuration help",
    data: {
      commands: [
        "init",
        "validate",
        "targets",
        "plan",
        "apply",
        "status",
        "diff",
        "clean",
        "doctor",
      ],
    },
    exitCode: CliExitCode.success,
    json: parsed.json,
    human: harnessHelpText,
  });
};

export const runHarnessConfigurationCli = async (
  arguments_: ReadonlyArray<string>,
  io: HarnessConfigurationCliIo,
): Promise<void> => {
  let parsed: ParsedHarnessArguments | undefined;
  try {
    parsed = parseHarnessArguments(arguments_);
    const registry = createDefaultRegistry();
    const compiler = new HarnessConfigurationCompiler(registry);
    const commandName = `harness.${parsed.command}`;

    if (parsed.command === "help") {
      renderHelp(parsed, io);
      return;
    }

    if (parsed.command === "init") {
      const written = await scaffoldProject(parsed.root, {
        targets: parsed.targets,
        force: parsed.force,
        format: parsed.format,
      });
      renderHarnessResult(io, {
        command: commandName,
        message: written.length === 0
          ? "No harness source files changed"
          : "Harness source initialized",
        data: { root: parsed.root, written },
        exitCode: CliExitCode.success,
        json: parsed.json,
        human: written.length === 0
          ? "No files changed.\n"
          : `${written.map((file) => `+ ${file}`).join("\n")}\n`,
      });
      return;
    }

    if (parsed.command === "targets") {
      const descriptors = registry.list().map((adapter) => adapter.descriptor);
      renderHarnessResult(io, {
        command: commandName,
        message: "Harness targets listed",
        data: toCliPayload(descriptors),
        exitCode: CliExitCode.success,
        json: parsed.json,
        human: `${descriptors.map((descriptor) => [
          `${descriptor.id.padEnd(16)} ${descriptor.name}`,
          `  ${Object.entries(descriptor.capabilities)
            .map(([feature, level]) => `${feature}:${level}`)
            .join("  ")}`,
        ].join("\n")).join("\n")}\n`,
      });
      return;
    }

    if (parsed.command === "doctor") {
      const results = doctorTargets(registry, parsed.targets);
      renderHarnessResult(io, {
        command: commandName,
        message: "Harness probes completed",
        data: toCliPayload(results),
        exitCode: CliExitCode.success,
        json: parsed.json,
        human: `${results.map((result) =>
          `${result.id.padEnd(16)} ${(result.found ? "found" : "missing").padEnd(8)} ${result.executable ?? result.error ?? ""}`
        ).join("\n")}\n`,
      });
      return;
    }

    const root = await findRepositoryRoot(parsed.root);
    if (parsed.command === "clean") {
      const plan = await createPlan(
        root,
        [...TARGET_IDS],
        [],
        [],
        { force: parsed.force },
      );
      const exitCode = isHarnessPlanBlocked(plan)
        ? CliExitCode.conflictOrDrift
        : CliExitCode.success;
      if (exitCode === CliExitCode.success && !parsed.dryRun) await applyPlan(plan);
      renderHarnessResult(io, {
        command: commandName,
        message: exitCode !== CliExitCode.success
          ? "Harness cleanup blocked"
          : parsed.dryRun
          ? "Harness cleanup planned"
          : "Harness-owned configuration cleaned",
        data: planPayload(plan),
        exitCode,
        json: parsed.json,
        human: renderHumanPlan(plan, parsed.all),
      });
      return;
    }

    const plan = await compiler.plan({
      root,
      targets: parsed.targets,
      strict: parsed.strict,
      force: parsed.force,
    });
    const exitCode = isHarnessPlanBlocked(plan)
      ? CliExitCode.conflictOrDrift
      : CliExitCode.success;

    if (parsed.command === "validate") {
      renderHarnessResult(io, {
        command: commandName,
        message: exitCode === CliExitCode.success
          ? "Harness configuration is valid"
          : "Harness configuration validation failed",
        data: diagnosticsPayload(plan.diagnostics),
        exitCode,
        json: parsed.json,
        human: exitCode === CliExitCode.success
          ? "Harness configuration is valid.\n"
          : renderHumanPlan(plan, false),
      });
      return;
    }

    if (parsed.command === "plan" || parsed.command === "status") {
      renderHarnessResult(io, {
        command: commandName,
        message: parsed.command === "status"
          ? (exitCode === CliExitCode.success
            ? "Harness configuration status computed"
            : "Harness configuration has conflicts")
          : "Harness configuration plan computed",
        data: planPayload(plan),
        exitCode,
        json: parsed.json,
        human: renderHumanPlan(plan, parsed.all),
      });
      return;
    }

    if (parsed.command === "diff") {
      const diff = formatPlanDiff(plan);
      renderHarnessResult(io, {
        command: commandName,
        message: "Harness configuration diff computed",
        data: planPayload(plan),
        exitCode,
        json: parsed.json,
        human: diff === "" ? "No pending changes.\n" : `${diff}\n`,
      });
      return;
    }

    if (parsed.command === "apply" || parsed.command === "sync") {
      if (exitCode === CliExitCode.success && !parsed.dryRun) await applyPlan(plan);
      renderHarnessResult(io, {
        command: commandName,
        message: exitCode !== CliExitCode.success
          ? "Harness configuration apply blocked"
          : parsed.dryRun
          ? "Harness configuration apply planned"
          : "Harness configuration applied",
        data: planPayload(plan),
        exitCode,
        json: parsed.json,
        human: renderHumanPlan(plan, parsed.all),
      });
      return;
    }

    throw new CanonfigError(
      "HARNESS_COMMAND_UNKNOWN",
      `Unknown harness command: ${parsed.command}`,
    );
  } catch (error) {
    const exitCode = harnessFailureExitCode(error);
    renderHarnessResult(io, {
      command: `harness.${parsed?.command ?? "unknown"}`,
      message: errorMessage(error),
      data: error instanceof CanonfigError ? { code: error.code } : undefined,
      exitCode,
      json: parsed?.json ?? arguments_.includes("--json"),
    });
  }
};
