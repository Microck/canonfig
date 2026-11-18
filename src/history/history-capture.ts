import { Effect, Result, Schema } from "effect";

import { gitWhere } from "../git/git-transport.ts";
import { findGitleaks } from "../git/plaintext-scan.ts";
import type { ProfileRevision } from "../domain/profile.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { canonicalJson } from "../profile/profile-codec.ts";
import type { PublicationHistoryInput } from "../profile/publication.ts";
import type { FolderFile } from "../projection/folder.ts";
import { HistoryError, readHistorySettings, writeHistorySettings, type HistorySettings } from "./history-config.ts";
import { historyRepositoryWork, type HistoryCapture, type HistoryPush } from "./history-repository.ts";

export const findHistoryGit = Effect.gen(function*() {
  const machine = yield* MachineState;
  return (yield* machine.findExecutable({ name: "git" })).path.absolute;
}).pipe(Effect.mapError(() => new HistoryError({ code: "tool", message: "Install Git to use Canonical Folder history" })));

export const findHistoryScanner = findGitleaks.pipe(Effect.mapError(() => new HistoryError({
  code: "tool", message: "Install gitleaks to scan plaintext history before pushing",
})));

export const pushHistory = Effect.fn("History.push")(function*(
  folder: string, settings: HistorySettings, executable: string,
) {
  const remote = settings.remote;
  if (remote === undefined) return { status: "local" } satisfies HistoryPush;
  const outcome: HistoryPush = yield* Effect.gen(function*() {
    const scanner = yield* Effect.result(findHistoryScanner);
    return yield* historyRepositoryWork(folder, executable, "Could not scan or push Canonical Folder history", async repo => {
      const pending = await repo.pendingTip();
      if (pending === undefined) return { status: "up-to-date" } as const;
      if (Result.isFailure(scanner)) throw scanner.failure;
      return repo.push(remote, settings.branch, scanner.success, pending);
    });
  }).pipe(Effect.catch(error => Effect.succeed({
    status: "not-pushed" as const, reason: error.message, code: error.code === "usage" ? "integrity" as const : error.code,
  })));
  const { lastPushError, ...rest } = settings;
  const nextError = outcome.status === "not-pushed" ? outcome.reason : undefined;
  if (lastPushError !== nextError) {
    yield* writeHistorySettings(folder, nextError === undefined ? rest : { ...rest, lastPushError: nextError }).pipe(Effect.ignore);
  }
  return outcome;
});

const CanonicalResources = Schema.Struct({ resources: Schema.Array(Schema.StructWithRest(
  Schema.Struct({ id: Schema.String }), [Schema.Record(Schema.String, Schema.MutableJson)],
)) });

const canonicalResources = (bytes: string) => Schema.decodeUnknownSync(CanonicalResources)(JSON.parse(bytes)).resources;

const publicationSummary = (revision: ProfileRevision, previous: ProfileRevision | undefined): string => {
  // These entries include computed verification, policy, and blob identity.
  const old = new Map((previous === undefined ? [] : canonicalResources(previous.canonicalBytes))
    .map(resource => [resource.id, canonicalJson(resource)]));
  const added: Array<string> = [];
  const changed: Array<string> = [];
  for (const resource of canonicalResources(revision.canonicalBytes)) {
    const before = old.get(resource.id);
    if (before === undefined) added.push(resource.id);
    else if (before !== canonicalJson(resource)) changed.push(resource.id);
    old.delete(resource.id);
  }
  return [
    added.length === 0 ? "" : `add ${added.join(", ")}`,
    changed.length === 0 ? "" : `change ${changed.join(", ")}`,
    old.size === 0 ? "" : `remove ${[...old.keys()].join(", ")}`,
  ].filter(Boolean).join("; ").slice(0, 500) || "update profile";
};

const captureError = (error: HistoryError): HistoryCapture => ({ error: error.message });

export const preparePublicationHistory = (folder: string, { revision, candidate }: PublicationHistoryInput) => Effect.gen(function*() {
  const settings = yield* readHistorySettings(folder);
  if (!settings.enabled) return Effect.succeed(undefined);
  const machine = yield* MachineState;
  const executable = yield* findHistoryGit;
  if (candidate !== undefined) {
    yield* historyRepositoryWork(folder, executable, "Could not stage the Profile Revision for history", async repo => {
      const { previous, files, reviewer } = candidate;
      // A previous publish may have committed to SQLite before Git advanced.
      // Recover that commit before staging its successor.
      if (previous !== undefined) await repo.finishPublication(previous.id);
      // The revision digest covers the normalized profile. Only a pre-publish
      // commit can preserve the exact JSONC, including comments and formatting.
      await repo.commitTree({ files: files(), date: revision.publishedAt, author: reviewer,
        publication: { id: revision.id, sequence: revision.sequence, summary: publicationSummary(revision, previous) } });
    });
  }
  return Effect.gen(function*() {
    const commit = yield* historyRepositoryWork(folder, executable,
      "Could not record the Profile Revision in history. Publish again to retry.", repo => repo.finishPublication(revision.id));
    const push = yield* pushHistory(folder, settings, executable);
    return captureResult(commit, push);
  }).pipe(Effect.provideService(MachineState, machine), Effect.catch(error => Effect.succeed(captureError(error))));
}).pipe(Effect.catch(error => Effect.succeed(Effect.succeed(captureError(error)))));

export const captureApply = (folder: string, settings: HistorySettings, files: ReadonlyMap<string, FolderFile>) =>
  Effect.gen(function*() {
    const executable = yield* findHistoryGit;
    const commit = yield* historyRepositoryWork(folder, executable, "Could not record the apply in history. Apply again to retry.",
      repo => repo.commitTree({ files: [...files].map(([path, file]) => ({ path, ...file })), date: new Date().toISOString(), author: "Canonfig" }));
    const push = yield* pushHistory(folder, settings, executable);
    return captureResult(commit, push);
  }).pipe(Effect.catch(error => Effect.succeed(captureError(error))));

const captureResult = (commit: string | undefined, push: HistoryPush): HistoryCapture | undefined =>
  commit === undefined && (push.status === "local" || push.status === "up-to-date") ? undefined
    : { commit, push };

export const historyRemoteLabel = (settings: HistorySettings) =>
  settings.remote === undefined ? undefined : gitWhere(settings.remote);
