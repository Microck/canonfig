import path from "node:path";

import { parseTargetList } from "./core/config.ts";
import { CanonfigError } from "./core/errors.ts";
import type { TargetId } from "./core/types.ts";

export type HarnessConfigFormat = "yaml" | "json";

export interface ParsedHarnessArguments {
  readonly command: string;
  readonly root: string;
  readonly json: boolean;
  readonly format: HarnessConfigFormat;
  readonly strict: boolean;
  readonly force: boolean;
  readonly all: boolean;
  readonly dryRun: boolean;
  readonly targets?: ReadonlyArray<TargetId> | undefined;
}

export const harnessHelpText = `Canonfig harness configuration

Usage: canonfig harness <command> [options]

Commands:
  init       Create .canonfig/harness.yaml or .canonfig/harness.json
  validate   Validate canonical sources and selected adapter translations
  targets    List built-in harness adapters and support levels
  plan       Show native files that would change
  apply      Apply the current plan atomically
  sync       Alias for apply
  status     Report pending changes, conflicts, and diagnostics
  diff       Print a unified-style diff for pending changes
  clean      Remove only configuration currently owned by Canonfig
  doctor     Probe selected harness executables

Options:
  --root <path>         Repository root or descendant working directory
  --target <id>         Select one target; repeatable
  --targets <ids>       Select comma-separated targets
  --format <format>     Configuration format for init: yaml or json
  --strict              Reject shim, lossy, and unsupported mappings
  --force               Take ownership of explicit collisions or managed edits
  --all                 Include unchanged files in plan output
  --dry-run             Do not write during apply or clean
  --no-input            Never prompt; accepted for scheduled invocations
  --json                Emit the stable canonfig.cli/v1 envelope
`;

export const parseHarnessArguments = (
  arguments_: ReadonlyArray<string>,
): ParsedHarnessArguments => {
  // The first argument is the command only when it is not an option. Taking it
  // unconditionally made `canonfig harness --help` report `--help` as an
  // unknown harness command, while `canonfig harness` alone and
  // `canonfig harness plan --help` both printed help. Leaving a leading option
  // in the option list lets the loop below handle it, so `--help` still wins
  // and flags such as `--json` are not swallowed with it.
  const leadsWithOption = arguments_[0]?.startsWith("-") ?? false;
  const command = leadsWithOption ? "help" : arguments_[0] ?? "help";
  const rest = leadsWithOption ? arguments_ : arguments_.slice(1);
  let root = process.cwd();
  let json = false;
  let format: HarnessConfigFormat = "yaml";
  let strict = false;
  let force = false;
  let all = false;
  let dryRun = false;
  const requestedTargets: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--strict") {
      strict = true;
      continue;
    }
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument === "--all") {
      all = true;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--no-input") continue;
    if (argument === "--help" || argument === "-h") {
      return {
        command: "help",
        root: path.resolve(root),
        json,
        format,
        strict,
        force,
        all,
        dryRun,
      };
    }
    if (
      argument === "--root"
      || argument === "--cwd"
      || argument === "--target"
      || argument === "--targets"
      || argument === "--format"
    ) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new CanonfigError(
          "HARNESS_OPTION_VALUE_REQUIRED",
          `${argument} requires a value.`,
        );
      }
      index += 1;
      if (argument === "--root" || argument === "--cwd") {
        root = path.resolve(value);
      } else if (argument === "--format") {
        if (command !== "init") {
          throw new CanonfigError(
            "HARNESS_FORMAT_NOT_ALLOWED",
            "--format is only valid with harness init.",
          );
        }
        if (value !== "yaml" && value !== "json") {
          throw new CanonfigError(
            "HARNESS_FORMAT_INVALID",
            "--format must be yaml or json.",
          );
        }
        format = value;
      } else {
        requestedTargets.push(value);
      }
      continue;
    }
    throw new CanonfigError(
      "HARNESS_OPTION_UNKNOWN",
      `Unknown harness option: ${argument}`,
    );
  }

  const targets = requestedTargets.length === 0
    ? undefined
    : parseTargetList(requestedTargets.join(","));
  return {
    command,
    root: path.resolve(root),
    json,
    format,
    strict,
    force,
    all,
    dryRun,
    ...(targets === undefined ? {} : { targets }),
  };
};
