import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Schema } from "effect";

import { ContentDigest } from "../domain/brand.ts";
import { localProjectionFollower } from "../domain/synchronization.ts";
import { checkGitDestination } from "../git/git-transport.ts";
import { BackupIoError } from "../git/tool-process.ts";
import type { HistoryRequest } from "../gui/contract/history.ts";
import { sha256Hex } from "../profile/profile-codec.ts";
import { preparePublication, validateReviewer, type PublishedFolder } from "../profile/publication.ts";
import { planVerifiedFolder } from "../projection/archive.ts";
import { loadCanonicalFolder, type FolderFile } from "../projection/folder.ts";
import { applyLocalProjection, applyVerifiedFolder, folderOf } from "../projection/sync.ts";
import { machineIdentity, refuseOnFollower } from "../state/machine-role.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import { assertUpgradeGate } from "../synchronization/upgrade-gate.ts";
import { withRunLock } from "../synchronization/run-lock.ts";
import { findHistoryGit, findHistoryScanner, historyRemoteLabel, pushHistory } from "./history-capture.ts";
import { HistoryError, historyRemoteIssue, historyWork, readHistorySettings, writeHistorySettings, type HistorySettings } from "./history-config.ts";
import { historyPath, historyRepositoryWork, withHistoryScratch } from "./history-repository.ts";

interface HistoryContext {
  readonly statePath: string;
  readonly publish: (reviewer: string) => Effect.Effect<PublishedFolder, { readonly message: string }>;
  readonly environment: (name: string) => string | undefined;
}

const checkDestination = (folder: string, executable: string, request: {
  readonly branch: string; readonly remote: string | undefined;
}) => Effect.gen(function*() {
  yield* historyRepositoryWork(folder, executable, "Could not validate the history branch", repo => repo.validateBranch(request.branch));
  const remote = request.remote;
  if (remote === undefined) return { warnings: [] };
  const issue = historyRemoteIssue(remote);
  if (issue !== undefined) return yield* issue;
  yield* findHistoryScanner;
  return yield* historyWork("Could not check the Git remote", signal => withHistoryScratch(async scratch => {
    try {
      const result = await checkGitDestination({ remote, executable, scratch, signal, probeRef: `canonfig-history-check/${randomUUID()}` });
      return { warnings: result.warnings.length === 0 ? [] : ["The remote is unreachable. Push will retry when it is reachable."] };
    } catch (cause) {
      if (!(cause instanceof BackupIoError)) throw cause;
      throw new HistoryError({ code: cause.code === "BACKUP_TOOL_REQUIRED" || cause.code === "BACKUP_CREDENTIAL_REQUIRED"
        ? "tool" : "usage", message: cause.message });
    }
  }));
});

const historyStatus = (folder: string, settings: HistorySettings) => Effect.gen(function*() {
  const present = yield* historyWork("Could not inspect .history.git", async () => {
    return lstat(historyPath(folder)).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
  });
  const entries = present ? yield* Effect.gen(function*() {
    const executable = yield* findHistoryGit;
    return yield* historyRepositoryWork(folder, executable, "Could not read Canonical Folder history", repo => repo.entries());
  }) : [];
  const remote = historyRemoteLabel(settings);
  return { enabled: settings.enabled, branch: settings.branch,
    remote, lastPushError: settings.lastPushError,
    backlog: remote === undefined ? 0 : entries.filter(entry => !entry.pushed).length, entries };
});

const validateSourceRestore = (files: ReadonlyMap<string, FolderFile>, repository: StateRepository["Service"]) =>
  Effect.acquireUseRelease(
    historyWork("Could not stage the Source history candidate", () => mkdtemp(join(tmpdir(), "canonfig-history-validate-"))),
    scratch => Effect.gen(function*() {
      yield* historyWork("Could not write the Source history candidate to staging", async () => {
        for (const [path, file] of files) {
          const target = join(scratch, path);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, file.content, { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
        }
      });
      yield* preparePublication(scratch, repository);
    }),
    scratch => Effect.promise(() => rm(scratch, { recursive: true, force: true })),
  );

const restore = (context: HistoryContext, executable: string, request: Extract<HistoryRequest, { action: "restore" }>) =>
  Effect.gen(function*() {
    const folder = folderOf(context.statePath);
    const repository = yield* StateRepository;
    const identity = yield* machineIdentity;
    const reviewer = request.reviewer?.trim();
    if (identity.role === "source") yield* validateReviewer(reviewer ?? "");
    yield* assertUpgradeGate(localProjectionFollower);
    const { entry, files } = yield* historyRepositoryWork(folder, executable, "Could not extract the history entry",
      repo => repo.extract(request.revision));
    yield* Effect.tryPromise({
      try: () => loadCanonicalFolder(folder, files),
      catch: cause => new HistoryError({ code: "integrity",
        message: cause instanceof Error ? cause.message : "The history entry is not a valid Canonical Folder" }),
    });
    if (identity.role === "source") yield* validateSourceRestore(files, repository);
    const planned = yield* planVerifiedFolder({
      folder, mode: "exact", digest: Schema.decodeUnknownSync(ContentDigest)(sha256Hex(entry.id)),
      appliedResources: yield* repository.loadAppliedResources(localProjectionFollower),
      files: [...files].map(([path, file]) => ({ path, content: file.content, mode: file.executable ? 0o700 : 0o600 })),
    });
    const blocked = planned.plan.actions.find(action => action.detail.kind === "human-action");
    if (blocked?.detail.kind === "human-action") return yield* new HistoryError({ code: "conflict", message: blocked.detail.reason });
    const restored = yield* applyVerifiedFolder(context.statePath, planned);
    if (restored.outcome.outcome !== "Converged") return restored;
    if (identity.role === "source") {
      const revision = yield* context.publish(reviewer!).pipe(Effect.mapError(error => new HistoryError({
        code: "integrity",
        message: `The folder was restored${restored.backup === undefined ? "" : ` (Takeover Snapshot ${restored.backup})`}, but publication failed: ${error.message}`,
      })));
      return { ...restored, revision };
    }
    const projection = yield* applyLocalProjection(context.statePath, "apply", { noBackup: false, environment: context.environment })
      .pipe(Effect.mapError(error => new HistoryError({
        code: "integrity",
        message: `The folder was restored${restored.backup === undefined ? "" : ` (Takeover Snapshot ${restored.backup})`}, but Projection failed: ${error.message}`,
      })));
    return { ...restored, outcome: projection.outcome, history: "history" in projection ? projection.history : undefined };
  });

const configure = (context: HistoryContext, settings: HistorySettings, executable: string,
  request: Extract<HistoryRequest, { action: "enable" | "check" }>) => Effect.gen(function*() {
  const folder = folderOf(context.statePath);
  const remote = request.remote === undefined ? settings.remote : request.remote ?? undefined;
  const branch = request.branch ?? settings.branch;
  const checked = yield* checkDestination(folder, executable, { branch, remote });
  if (request.action === "check") return checked;
  const destinationChanged = settings.remote !== remote || settings.branch !== branch;
  yield* historyRepositoryWork(folder, executable, "Could not initialize .history.git", async repo => {
    await repo.init();
    // Clear the acknowledgement before saving. If interrupted, retrying the old destination is harmless.
    if (destinationChanged) await repo.clearAcknowledgement();
  });
  const next = { enabled: true, remote, branch,
    lastPushError: destinationChanged ? undefined : settings.lastPushError };
  yield* writeHistorySettings(folder, next);
  return { ...(yield* historyStatus(folder, next)), ...checked };
});

export const historyCommand = (context: HistoryContext, request: HistoryRequest) => {
  const run = Effect.gen(function*() {
    const repository = yield* StateRepository;
    yield* refuseOnFollower(repository, "use Canonical Folder history");
    const folder = folderOf(context.statePath);
    const settings = yield* readHistorySettings(folder);
    if (request.action === "list") return yield* historyStatus(folder, settings);
    if (request.action === "disable") {
      yield* writeHistorySettings(folder, { ...settings, enabled: false });
      return { enabled: false };
    }
    const executable = yield* findHistoryGit;
    switch (request.action) {
      case "enable":
      case "check":
        return yield* configure(context, settings, executable, request);
      case "diff":
        return yield* historyRepositoryWork(folder, executable, "Could not diff history entries within the 1 MiB output limit",
          repo => repo.diff(request.from, request.to));
      case "restore":
        return yield* restore(context, executable, request);
      case "push": {
        if (!settings.enabled || settings.remote === undefined) return yield* new HistoryError({
          code: "usage", message: "Enable history with a Git remote before pushing",
        });
        const pushed = yield* pushHistory(folder, settings, executable);
        if (pushed.status === "not-pushed") return yield* new HistoryError({ code: pushed.code, message: pushed.reason });
        return pushed;
      }
    }
  });
  return request.action === "list" || request.action === "diff" || request.action === "check"
    ? run : withRunLock(context.statePath, `history ${request.action}`, run);
};
