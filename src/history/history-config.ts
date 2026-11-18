import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";

import { missingBackupFile } from "../backup/backup-config.ts";
import { readBackupMetadata } from "../backup/backup-io.ts";
import { TaggedError } from "../domain/tagged-error.ts";
import { checkGitRemote } from "../git/git-transport.ts";
import { MachineState } from "../machine/machine-state.service.ts";

export class HistoryError extends TaggedError<HistoryError>()("HistoryError", {
  code: Schema.Literals(["usage", "tool", "conflict", "integrity", "transport"]),
  message: Schema.String,
}) {}

export const historyWork = <A>(message: string, work: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: cause => cause instanceof HistoryError ? cause : new HistoryError({
    code: "integrity", message,
  }) });

/** History shows its destination in status and commit results, so refuse URL decorations and inline credentials. */
export const historyRemoteIssue = (remote: string): HistoryError | undefined => {
  try {
    const address = checkGitRemote(remote);
    if (/[\p{Cc}]/u.test(remote) || remote !== remote.trim()) throw new Error("Invalid Git remote");
    if (address === undefined) return;
    if (/[?#]/u.test(remote)) throw new Error("Invalid Git remote");
    if (address.protocol === "file:" && !/[\p{Cc}]/u.test(fileURLToPath(address))) return;
    if (address.protocol === "https:" && /^https:\/\/[^@/]+(?:\/|$)/iu.test(remote)) return;
    if (address.protocol === "ssh:" && /^[A-Za-z0-9._-]*$/u.test(address.username)) return;
  } catch { /* Do not echo a rejected address. */ }
  return new HistoryError({ code: "usage",
    message: "Choose an HTTPS, SSH, file URL or absolute Git path without inline credentials, a query or a fragment",
  });
};

const HistorySettings = Schema.Struct({
  enabled: Schema.Boolean,
  remote: Schema.optional(Schema.String.check(Schema.makeFilter(value => historyRemoteIssue(value)?.message ?? true))),
  branch: Schema.String,
  lastPushError: Schema.optional(Schema.String),
});
export type HistorySettings = typeof HistorySettings.Type;

const settingsPath = (folder: string) => join(folder, "history.json");

export const readHistorySettings = (folder: string) => historyWork("Could not read history.json", async (): Promise<HistorySettings> => {
  try { return await readBackupMetadata(settingsPath(folder), HistorySettings, 128 * 1024); }
  catch (cause) {
    if (missingBackupFile(cause)) return { enabled: false, branch: "main" };
    throw cause;
  }
});

export const writeHistorySettings = (folder: string, settings: HistorySettings) => Effect.gen(function*() {
  const machine = yield* MachineState;
  const anchor = yield* machine.normalizePath({ path: folder });
  yield* machine.ensureDirectory({ path: anchor, mode: 0o700 });
  yield* machine.atomicWrite({ anchor, path: yield* machine.normalizePath({ path: settingsPath(folder) }),
    content: Buffer.from(`${JSON.stringify(settings, undefined, 2)}\n`), mode: 0o600 });
});
