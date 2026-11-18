import { homedir } from "node:os";
import { join } from "node:path";
import type { CliIo } from "../cli/cli.ts";
import { renderCommandResult, toCliPayload } from "../cli/command-output.ts";
import { readGuardFolderFiles } from "../projection/folder.ts";
import { folderGuardItems } from "./candidates.ts";
import { enforceGuard, GuardHold, guardMessage, guardStatus } from "./guard.ts";
import { isManagedFollower } from "./local-role.ts";

export async function scanGuardFolder(root: string, follower: boolean, signal: AbortSignal) {
  const files = await readGuardFolderFiles(root, follower);
  return enforceGuard(folderGuardItems(files), { root, trigger: "guard.scan", staticOnly: follower, signal });
}

export async function runGuardCli(args: readonly string[], io: CliIo, signal: AbortSignal): Promise<void> {
  const json = args.includes("--json");
  const tokens = args.filter((arg) => arg !== "--json");
  const command = tokens[1];
  if (tokens.length <= 2 && (command === undefined || command === "help" || command === "--help" || command === "-h")) {
    renderCommandResult(io, { command: "guard.help", message: "Canonfig Guard", human: "Usage: canonfig guard <scan|status> [--json]\n", exitCode: 0, json });
    return;
  }
  if (tokens.length !== 2 || (command !== "scan" && command !== "status")) {
    renderCommandResult(io, { command: "guard", message: "Use canonfig guard scan or canonfig guard status.", exitCode: 2, json });
    return;
  }
  const root = join(homedir(), ".canonfig");
  try {
    const follower = await isManagedFollower(root);
    if (command === "status") {
      const status = await guardStatus(root, follower);
      const checker = "policy" in status ? status.policy?.checker?.kind : undefined;
      const latest = status.latest;
      const mode = checker ?? "offline static rules";
      const message = latest === null ? `Guard uses ${mode}. No result recorded.`
        : `Guard uses ${mode}. Last result from ${latest.trigger} at ${latest.at}: ${guardMessage(latest)}`;
      renderCommandResult(io, { command: "guard.status", message, data: toCliPayload(status), exitCode: 0, json });
      return;
    }
    const report = await scanGuardFolder(root, follower, signal);
    renderCommandResult(io, { command: "guard.scan", message: guardMessage(report), data: toCliPayload({ guard: report }), exitCode: 0, json });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof GuardHold) {
      renderCommandResult(io, { command: "guard.scan", message: error.message, data: toCliPayload({ guard: error.report }), exitCode: 3, json });
    } else {
      renderCommandResult(io, { command: `guard.${command}`, message: "Guard could not read the policy or candidate. Check guard.jsonc and the Canonical Folder, then retry.", exitCode: 2, json });
    }
  }
}
