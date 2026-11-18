import { Effect, Schema } from "effect";

import { gitWhere } from "../git/git-transport.ts";
import { findGitleaks } from "../git/plaintext-scan.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { canonicalJson } from "../profile/profile-codec.ts";
import type { PublishFolderInput } from "../profile/publication.ts";
import type { FolderFile } from "../projection/folder.ts";
import { HistoryError, historyWork, readHistorySettings, writeHistorySettings, type HistorySettings } from "./history-config.ts";
import { historyRepository, type HistoryCapture, type HistoryPush } from "./history-repository.ts";

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
    const pending = yield* historyWork("Could not check the history backlog",
      signal => historyRepository(folder, executable, signal).pendingTip());
    if (pending === undefined) return { status: "up-to-date" } as const;
    const scanner = yield* findHistoryScanner;
    return yield* historyWork("Could not scan or push Canonical Folder history",
      signal => historyRepository(folder, executable, signal).push(remote, settings.branch, scanner, pending));
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

type Publication = Parameters<NonNullable<PublishFolderInput["onPublished"]>>[0];

const CanonicalResources = Schema.Struct({ resources: Schema.Array(Schema.StructWithRest(
  Schema.Struct({ id: Schema.String }), [Schema.Record(Schema.String, Schema.MutableJson)],
)) });

const canonicalResources = (bytes: string) => Schema.decodeUnknownSync(CanonicalResources)(JSON.parse(bytes)).resources;

const publicationSummary = ({ revision, previous }: Publication): string => {
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

export const capturePublication = (folder: string, publication: Publication) => Effect.gen(function*() {
  const settings = yield* readHistorySettings(folder);
  if (!settings.enabled) return undefined;
  const { revision, reviewer, files } = publication;
  const executable = yield* findHistoryGit;
  const commit = yield* historyWork("Could not record the Profile Revision in history. Publish again to retry.", async signal => {
    const repo = historyRepository(folder, executable, signal);
    const head = await repo.latest();
    if (head?.revision === revision.id || settings.enabledAfter === revision.id) return undefined;
    const tree = await repo.writeTree(files());
    return repo.commitTree({ tree, date: revision.publishedAt, author: reviewer,
      publication: { id: revision.id, sequence: revision.sequence, summary: publicationSummary(publication) } });
  });
  const push = yield* pushHistory(folder, settings, executable);
  return captureResult(commit, push);
}).pipe(Effect.catch(error => Effect.succeed({ error: error.message } satisfies HistoryCapture)));

export const captureApply = (folder: string, settings: HistorySettings, files: ReadonlyMap<string, FolderFile>) =>
  Effect.gen(function*() {
    const executable = yield* findHistoryGit;
    const commit = yield* historyWork("Could not record the apply in history. Apply again to retry.", async signal => {
      const repo = historyRepository(folder, executable, signal);
      const tree = await repo.writeTree([...files].map(([path, file]) => ({ path, ...file })));
      return repo.commitTree({ tree, date: new Date().toISOString(), author: "Canonfig" });
    });
    const push = yield* pushHistory(folder, settings, executable);
    return captureResult(commit, push);
  }).pipe(Effect.catch(error => Effect.succeed({ error: error.message } satisfies HistoryCapture)));

const captureResult = (commit: string | undefined, push: HistoryPush): HistoryCapture | undefined =>
  commit === undefined && (push.status === "local" || push.status === "up-to-date") ? undefined
    : { commit, push };

export const historyRemoteLabel = (settings: HistorySettings) =>
  settings.remote === undefined ? undefined : gitWhere(settings.remote);
