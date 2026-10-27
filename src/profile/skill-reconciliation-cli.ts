import { setTimeout as delay } from "node:timers/promises";
import { CliExitCode } from "../cli/exit-codes.ts";
import { CanonfigError, errorMessage } from "../harness-configuration/core/errors.ts";
import { renderHarnessResult, toCliPayload, type HarnessConfigurationCliIo } from "../harness-configuration/cli-output.ts";
import { reconcileSourceSkills } from "./skill-reconciliation.ts";

export const reconciliationHelp = `Usage: canonfig source reconcile-skills --profile-file FILE [--apply] [--watch] [--interval SECONDS]

Preview previously observed source skill deletions. --apply first records existing
source directories; subsequent passes remove only confirmed missing skill resources
from the authored profile. --watch --apply polls every 5 seconds by default.
No profile is published, no follower is changed, and no skill directory is deleted.
Keep the private observation/backup files beside the profile. Conflicts stop the worker.
--json emits one CLI result per pass; --no-input is accepted.
`;

export function parseReconciliationArguments(args: readonly string[]) {
  let profile: string | undefined; let apply = false; let watch = false; let interval = 5;
  const seen = new Set<string>();
  const help = args.includes("--help") || args.includes("-h");
  if (help) return { profile, apply, watch, interval, help };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--json" || arg === "--no-input") continue;
    if (seen.has(arg)) throw new CanonfigError("PROFILE_SKILL_RECONCILE_USAGE", `Repeated option: ${arg}`);
    seen.add(arg);
    if (arg === "--apply") { apply = true; continue; }
    if (arg === "--watch") { watch = true; continue; }
    if (arg !== "--profile-file" && arg !== "--interval") throw new CanonfigError("PROFILE_SKILL_RECONCILE_USAGE", `Unknown option: ${arg}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new CanonfigError("PROFILE_SKILL_RECONCILE_USAGE", `${arg} needs a value`);
    if (arg === "--profile-file") profile = value;
    else {
      if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 86400) throw new CanonfigError("PROFILE_SKILL_RECONCILE_USAGE", "--interval must be whole seconds from 1 to 86400");
      interval = Number(value);
    }
  }
  if (!profile) throw new CanonfigError("PROFILE_SKILL_RECONCILE_USAGE", "--profile-file is required");
  if (watch && !apply) throw new CanonfigError("PROFILE_SKILL_RECONCILE_USAGE", "--watch requires explicit --apply");
  if (!watch && seen.has("--interval")) throw new CanonfigError("PROFILE_SKILL_RECONCILE_USAGE", "--interval requires --watch");
  return { profile, apply, watch, interval, help };
}

export async function runReconciliationCli(args: readonly string[], io: HarnessConfigurationCliIo, signal?: AbortSignal): Promise<void> {
  const json = args.includes("--json");
  try {
    const options = parseReconciliationArguments(args);
    if (options.help) { renderHarnessResult(io, { command: "source.reconcile-skills.help", message: "Source skill reconciliation", human: reconciliationHelp, json, exitCode: CliExitCode.success }); return; }
    if (!options.profile) throw new CanonfigError("PROFILE_SKILL_RECONCILE_USAGE", "--profile-file is required");
    do {
      if (signal?.aborted) return;
      const result = await reconcileSourceSkills(options.profile, options.apply);
      renderHarnessResult(io, { command: "source.reconcile-skills", message: options.apply ? "Source skill profile reconciled" : "Source skill reconciliation preview", data: toCliPayload(result), json, exitCode: CliExitCode.success,
        human: `${options.apply ? "Applied" : "Preview"}: ${result.removed.length} removed resource(s), ${result.observed.length} observed, ${result.skipped.length} outside automatic scope. No publication.\n` });
      if (!options.watch) return;
      try { await delay(options.interval * 1000, undefined, { signal }); }
      catch (error) { if (signal?.aborted) return; throw error; }
    } while (!signal?.aborted);
  } catch (error) {
    const code = error instanceof CanonfigError ? error.code : undefined;
    renderHarnessResult(io, { command: "source.reconcile-skills", message: errorMessage(error), json,
      exitCode: code === "PROFILE_SKILL_RECONCILE_RECOVERY" ? CliExitCode.humanActionRequired
        : code === "PROFILE_SKILL_RECONCILE_CONFLICT" || code === "PROFILE_SKILL_RECONCILE_LOCKED" ? CliExitCode.conflictOrDrift : CliExitCode.usageOrConfiguration });
  }
}
