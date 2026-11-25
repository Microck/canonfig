import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Effect, Schema } from "effect";
import type { CliIo } from "../cli/cli.ts";
import { commandFailureExitCode, renderCommandResult, toCliPayload } from "../cli/command-output.ts";
import { TransportPublishedResourceSchema } from "../enrollment/enrollment.types.ts";
import { readGuardFolderFiles, type GuardFileMode } from "../projection/folder.ts";
import { mirrorConfigResource, mirrorItem } from "../projection/mirror.ts";
import { CanonfigError } from "../skills/errors.ts";
import { stateRepositoryLayer } from "../state/state-repository.layer.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import { folderGuardItems } from "./candidates.ts";
import { GuardApprovalChange } from "./contract.ts";
import { changeGuardApproval, enforceGuard, GuardHold, guardMessage, guardStatus, readGuardPolicy } from "./guard.ts";
import { isManagedFollower } from "./local-role.ts";
import { guardModel, installGuardModel, removeGuardModel } from "./model.ts";

const decodeMirrorRevision = Schema.decodeUnknownSync(Schema.Struct({ resources: Schema.Array(TransportPublishedResourceSchema) }));

const appliedMirrorMetadata = Effect.gen(function*() {
  const repository = yield* StateRepository;
  const configuration = yield* repository.getFollowerSynchronizationConfiguration();
  if (configuration === undefined) return undefined;
  const applied = yield* repository.loadAppliedResources(configuration.follower.id);
  const config = applied.find(({ resource }) => resource === mirrorConfigResource);
  if (config === undefined) return undefined;
  const revision = yield* repository.getRevision(config.revision);
  const { resources } = decodeMirrorRevision(JSON.parse(revision.canonicalBytes));
  const modes = new Map<string, GuardFileMode>();
  const hookPositions: number[] = [];
  for (const resource of resources) {
    const entry = mirrorItem(resource);
    if (entry?.kind === "entry" && entry.position !== undefined) hookPositions.push(entry.position);
    if (entry?.kind !== "file") continue;
    const { spec } = resource;
    if (spec.kind === "file") modes.set(entry.path, { executable: spec.executable, mode: spec.mode });
    if (spec.kind === "skill") {
      for (const { path, executable, mode } of spec.files) modes.set(`${entry.path}/${path}`, { executable, mode });
    }
  }
  return { modes, hookPositions: hookPositions.sort((left, right) => left - right) };
});

export async function scanGuardFolder(root: string, follower: boolean, signal: AbortSignal) {
  // Use signed modes and hook slots while still scanning the contents on disk.
  const mirror = follower && await isManagedFollower(root)
    ? await Effect.runPromise(appliedMirrorMetadata.pipe(Effect.provide(stateRepositoryLayer(join(root, "state.sqlite")))), { signal })
    : undefined;
  const files = await readGuardFolderFiles(root, follower, mirror?.modes);
  return enforceGuard(folderGuardItems(files, mirror?.hookPositions), { root, trigger: "guard.scan", staticOnly: follower, signal });
}

const usage = "Usage: canonfig guard <scan|status|approve|revoke|model> [--json]\n"
  + "  approve <item> --digest <sha256> [--note <text>]\n  revoke <item>\n  model <install|remove>\n";

export function parseGuardArguments(args: readonly string[]) {
  const commandIndex = args.indexOf("guard");
  const parsed = parseArgs({ args: [...args.slice(0, commandIndex), ...args.slice(commandIndex + 1)], allowPositionals: true, options: {
    json: { type: "boolean" }, help: { type: "boolean", short: "h" },
    digest: { type: "string" }, note: { type: "string" },
  }, tokens: true });
  const { json = false, help, digest, note } = parsed.values;
  const [command, item, ...extra] = parsed.positionals;
  if (help) return { command: "help", json } as const;
  const repeated = (name: string) => parsed.tokens.filter((token) => token.kind === "option" && token.name === name).length > 1;
  if (extra.length > 0 || (command !== "approve" && (digest !== undefined || note !== undefined))
    || repeated("digest") || repeated("note")) throw new Error(usage);
  if (command === "approve" || command === "revoke") {
    const change = Schema.decodeUnknownSync(GuardApprovalChange)(command === "approve"
      ? { action: command, approval: { item, digest, note } } : { action: command, item });
    return { command, json, change };
  }
  if (command === "model" && (item === "install" || item === "remove")) return { command, json, model: item } as const;
  if (item !== undefined) throw new Error(usage);
  if (command === "scan" || command === "status") return { command, json };
  if (command === undefined || command === "help") return { command: "help", json } as const;
  throw new Error(usage);
}

export async function runGuardCli(args: readonly string[], io: CliIo, signal: AbortSignal): Promise<void> {
  let parsed;
  try {
    parsed = parseGuardArguments(args);
  } catch {
    renderCommandResult(io, { command: "guard", message: usage.trimEnd(), exitCode: 2, json: args.includes("--json") });
    return;
  }
  const { command, json } = parsed;
  if (command === "help") {
    renderCommandResult(io, { command: "guard.help", message: "Canonfig Guard", human: usage, exitCode: 0, json });
    return;
  }
  const root = join(homedir(), ".canonfig");
  try {
    if (parsed.change !== undefined) {
      const { change } = parsed;
      const current = await readGuardPolicy(root);
      await changeGuardApproval(root, current.digest, change);
      renderCommandResult(io, { command: `guard.${command}`, message: change.action === "approve"
        ? `Approved ${change.approval.item} at ${change.approval.digest}. Retry the held operation.` : `Revoked approval for ${change.item}.`,
      data: toCliPayload(change), exitCode: 0, json });
      return;
    }
    const follower = await isManagedFollower(root);
    if (parsed.model !== undefined) {
      if (follower) throw new CanonfigError("GUARD_CHECKER_NOT_ALLOWED", "Followers use offline Guard.");
      if (parsed.model === "install") {
        let stage = "";
        await installGuardModel((progress) => {
          if (json || progress.stage === stage) return;
          stage = progress.stage;
          io.writeStderr(progress.stage === "download" ? `Downloading ${guardModel.name}…\n` : "Preparing the model runtime…\n");
        }, signal);
        renderCommandResult(io, { command: "guard.model.install", message: `Installed ${guardModel.name}. Turn it on in guard.jsonc with "checker": { "kind": "skill-update" }.`,
          exitCode: 0, json });
        return;
      }
      if ((await readGuardPolicy(root)).policy.checker?.kind === "skill-update") {
        throw new CanonfigError("GUARD_MODEL_IN_USE", "Remove the skill-update checker from guard.jsonc before removing the model.");
      }
      await removeGuardModel();
      renderCommandResult(io, { command: "guard.model.remove", message: `Removed ${guardModel.name}.`, exitCode: 0, json });
      return;
    }
    if (command === "status") {
      const status = await guardStatus(root, follower);
      const checker = status.policy.checker?.kind;
      const latest = status.latest;
      const rules = status.policy.builtInRules === false ? "built-in rules off" : "offline static rules";
      const mode = checker === undefined ? rules : `${rules} and ${checker === "skill-update" ? guardModel.name : checker}`;
      const message = latest === null ? `Guard uses ${mode}. No result recorded.`
        : `Guard uses ${mode}. Last result from ${latest.trigger} at ${latest.at}: ${guardMessage(latest)}`;
      const approvals = status.approvals.map(({ item, digest, status, note }) =>
        `${item} ${digest} (${status})${note ? `: ${note}` : ""}`);
      renderCommandResult(io, { command: "guard.status", message, data: toCliPayload(status), exitCode: 0, json,
        human: [message, ...approvals].join("\n") + "\n" });
      return;
    }
    const report = await scanGuardFolder(root, follower, signal);
    renderCommandResult(io, { command: "guard.scan", message: guardMessage(report), data: toCliPayload({ guard: report }), exitCode: 0, json });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof GuardHold) {
      renderCommandResult(io, { command: "guard.scan", message: error.message, data: toCliPayload({ guard: error.report }), exitCode: 3, json });
    } else if (error instanceof CanonfigError) {
      renderCommandResult(io, { command: `guard.${command}`, message: error.message, data: { code: error.code },
        exitCode: commandFailureExitCode(error.code), json });
    } else {
      renderCommandResult(io, { command: `guard.${command}`, message: "Guard could not read the policy or candidate. Check guard.jsonc and the Canonical Folder, then retry.", exitCode: 2, json });
    }
  }
}
