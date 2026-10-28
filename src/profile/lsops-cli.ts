import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { CliExitCode } from "../cli/exit-codes.ts";
import { renderHarnessResult, toCliPayload, type HarnessConfigurationCliIo } from "../harness-configuration/cli-output.ts";
import { CatalogueError, captureCatalogue, synchronizeCatalogue } from "./lsops-catalogue.ts";

export const lsopsHelp = `Usage: canonfig lsops <capture|sync> --config FILE --bundle FILE [--apply] [--watch] [--interval SECONDS]

capture: export visible portable lsops metadata to a shared catalogue file.
sync: reconcile a transported catalogue into this machine's lsops config.
Preview is the default. --apply permits writes. --watch requires --apply and
polls every 30 seconds (minimum 1, maximum 86400). Conflicts stop the worker.
Paths are explicit: no project overlay, executable, credential, installer,
updater approval, publication, enrollment or OS service is changed.
Follower-only entries stay local. Same-name conflicts never silently overwrite.
--json emits one result per pass; --no-input is accepted.
`;

export function parseLsopsArguments(args: readonly string[]) {
  const tokens = args.filter((arg) => arg !== "--json" && arg !== "--no-input");
  const help = tokens.length === 0 || tokens.includes("--help") || tokens.includes("-h") || tokens[0] === "help";
  const command = tokens[0]; let config = ""; let bundle = ""; let apply = false; let watch = false; let interval = 30;
  if (help) return { help, command, config, bundle, apply, watch, interval };
  if (command !== "capture" && command !== "sync") throw new Error("Expected lsops capture or sync");
  const seen = new Set<string>();
  for (let i = 1; i < tokens.length; i++) {
    const arg = tokens[i]!;
    if (seen.has(arg)) throw new Error(`Repeated option: ${arg}`); seen.add(arg);
    if (arg === "--apply") { apply = true; continue; }
    if (arg === "--watch") { watch = true; continue; }
    if (!["--config", "--bundle", "--interval"].includes(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = tokens[++i]; if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    if (arg === "--config") config = value;
    else if (arg === "--bundle") bundle = value;
    else { interval = Number(value); if (!/^\d+$/u.test(value) || !Number.isInteger(interval) || interval < 1 || interval > 86400) throw new Error("Interval must be whole seconds from 1 to 86400"); }
  }
  if (!config || !bundle) throw new Error("--config and --bundle are required");
  if (watch && !apply) throw new Error("--watch requires --apply");
  if (!watch && seen.has("--interval")) throw new Error("--interval requires --watch");
  return { help, command, config, bundle, apply, watch, interval };
}

export async function runLsopsCli(args: readonly string[], io: HarnessConfigurationCliIo, signal?: AbortSignal): Promise<void> {
  const json = args.includes("--json");
  let parsing = true;
  try {
    const options = parseLsopsArguments(args);
    parsing = false;
    if (options.help) { renderHarnessResult(io, { command: "lsops.help", message: "lsops catalogue bridge", human: lsopsHelp, json, exitCode: 0 }); return; }
    do {
      if (signal?.aborted) return;
      const result = options.command === "capture" ? await captureCatalogue(options) : await synchronizeCatalogue(options);
      const conflicts = "conflicts" in result ? result.conflicts : [];
      renderHarnessResult(io, { command: `lsops.${options.command}`, message: conflicts.length ? "Catalogue conflicts; nothing applied" : `${options.apply ? "Applied" : "Preview"} catalogue ${options.command}`, data: toCliPayload(result), json,
        human: conflicts.length ? `Nothing applied:\n${conflicts.join("\n")}\n` : `${options.apply ? "Applied" : "Preview"} catalogue ${options.command}. No CLI installed or uninstalled.\n`, exitCode: conflicts.length ? CliExitCode.conflictOrDrift : CliExitCode.success });
      if (!options.watch || conflicts.length) return;
      try { await delay(options.interval * 1000, undefined, { signal }); } catch (error) { if (signal?.aborted) return; throw error; }
    } while (!signal?.aborted);
  } catch (error) {
    renderHarnessResult(io, { command: "lsops", message: error instanceof Error ? error.message : String(error), json, exitCode: parsing ? CliExitCode.usageOrConfiguration
      : error instanceof CatalogueError ? error.exitCode
      : error instanceof SyntaxError || Schema.isSchemaError(error) ? CliExitCode.usageOrConfiguration
      : error instanceof Error && "code" in error && "syscall" in error ? CliExitCode.humanActionRequired
      : CliExitCode.internal });
  }
}
