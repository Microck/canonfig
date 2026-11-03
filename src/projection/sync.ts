import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Effect, Schema } from "effect";

import { RunId } from "../domain/brand.ts";
import type { RunId as RunIdType } from "../domain/brand.ts";
import { localProjectionFollower, type SynchronizationOutcome } from "../domain/synchronization.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import { editConfigText, getConfigPath, parseConfigDocument } from "../synchronization/config-codec.ts";
import { cleanupRollbackSnapshots, removeRunTemporaryEntries } from "../synchronization/executor.ts";
import { assertUpgradeGate } from "../synchronization/follower-orchestration.ts";
import { withRunLock } from "../synchronization/run-lock.ts";
import { Synchronization } from "../synchronization/synchronization.service.ts";
import type {
  PlanningLocalRevision,
  SynchronizationArtifact,
} from "../synchronization/synchronization.types.ts";
import { CanonicalFolderError, LocalOverlayCollisionError, loadCanonicalFolder } from "./folder.ts";
import { parseSurfaceResourceId, planFolder, planRestore, rootContext, sharedSkillsOwner, takeoverSummary } from "./plan.ts";
import {
  deleteSnapshot,
  pruneSnapshots,
  readSnapshot,
  snapshotOfRun,
  writeTakeoverSnapshot,
} from "./takeover.ts";

/**
 * Local projection: `canonfig sync`, `recover`, `abandon` and `restore` on the
 * Source or an unenrolled machine. Runs belong to the local projection
 * follower and go through the shared Synchronization run, journal, rollback
 * and recovery.
 */

export interface LocalSyncOptions {
  /** Take over harness surfaces without a takeover snapshot. */
  readonly noBackup: boolean;
  /** Environment variables harness roots are resolved from. */
  readonly environment: (name: string) => string | undefined;
}

/** The Canonical Folder holds the state database. */
const folderOf = (statePath: string): string => dirname(statePath);
const backupsOf = (statePath: string): string => join(folderOf(statePath), ".backups");

const newRunId = (): RunIdType => Schema.decodeUnknownSync(RunId)(`run-${randomUUID()}`);

/** Where a run's projected content waits until the run finishes; recovery reads it back. */
const artifactDirectory = (run: RunIdType) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const cache = (yield* machine.userDirectories()).cache;
    return yield* machine.normalizePath({ path: `canonfig/projection/${run}`, base: cache });
  });

const storeArtifacts = (run: RunIdType, artifacts: ReadonlyArray<SynchronizationArtifact>) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const directory = yield* artifactDirectory(run);
    yield* machine.ensureDirectory({ path: directory, mode: 0o700 });
    for (const artifact of artifacts) {
      const path = yield* machine.normalizePath({ path: artifact.digest, base: directory });
      yield* machine.atomicWrite({ path, content: artifact.content, mode: 0o600 });
    }
  });

/** The stored content of a run, for every digest its revision names. */
const loadArtifacts = (run: RunIdType, revision: PlanningLocalRevision) =>
  Effect.gen(function*() {
    const directory = (yield* artifactDirectory(run)).absolute;
    const digests = new Set(revision.desired.flatMap((entry) => {
      const desired = entry.desired;
      if (desired.kind === "file" || desired.kind === "config") return [desired.digest];
      if (desired.kind === "directory" || desired.kind === "skill") return desired.files.map((file) => file.digest);
      return [];
    }));
    const artifacts: Array<SynchronizationArtifact> = [];
    for (const digest of digests) {
      const content = yield* Effect.promise(() => readFile(join(directory, digest)).catch(() => undefined));
      if (content !== undefined) artifacts.push({ digest, content });
    }
    return artifacts;
  });

const discardArtifacts = (run: RunIdType) =>
  artifactDirectory(run).pipe(
    Effect.flatMap((directory) => Effect.promise(() => rm(directory.absolute, { recursive: true, force: true }))),
  );

/**
 * Finish a local run the shared engine completed or recovered. A run that
 * rolled back forgets its takeovers and deletes the snapshot it wrote; one
 * that did not keeps them and applies snapshot retention. An interrupted run
 * keeps everything for `canonfig recover`.
 */
const finishRun = (statePath: string, run: RunIdType, outcome: SynchronizationOutcome, revision: PlanningLocalRevision) =>
  Effect.gen(function*() {
    if (outcome.outcome === "Interrupted") return { snapshotDeleted: false, pruned: [] };
    const repository = yield* StateRepository;
    const backups = backupsOf(statePath);
    yield* discardArtifacts(run);
    if (outcome.outcome === "Failed") {
      yield* repository.removeRunTakeovers(run);
      const snapshot = yield* snapshotOfRun(backups, run);
      if (snapshot !== undefined) yield* deleteSnapshot(backups, snapshot);
      return { snapshotDeleted: snapshot !== undefined, pruned: [] };
    }
    if (revision.origin === "snapshot" && outcome.outcome === "Converged") yield* finishRestore(statePath, revision);
    return { snapshotDeleted: false, pruned: yield* pruneSnapshots(backups) };
  });

/**
 * After a converged restore: release the restored surfaces and exclude their
 * harnesses in `local/local.jsonc`, so the next sync does not take them over
 * again. The run itself already deleted their Applied Resource Records.
 */
const finishRestore = (statePath: string, revision: PlanningLocalRevision) =>
  Effect.gen(function*() {
    const repository = yield* StateRepository;
    const machine = yield* MachineState;
    const restored = (revision.removedResources ?? []).flatMap((id) => {
      const parsed = parseSurfaceResourceId(id);
      return parsed === undefined ? [] : [parsed];
    });
    const takeovers = yield* repository.loadHarnessTakeovers();
    const restoredKeys = new Set(restored.map((entry) => `${entry.harness}\0${entry.surface}`));
    yield* repository.releaseTakeovers(takeovers
      .filter((takeover) => restoredKeys.has(`${takeover.harness}\0${takeover.surface.split("#")[0]!}`))
      .map((takeover) => ({ harness: takeover.harness, surface: takeover.surface })));
    const harnesses = [...new Set(restored.map((entry) => entry.harness))]
      .filter((harness) => harness !== sharedSkillsOwner)
      .sort();
    if (harnesses.length === 0) return [];
    const path = yield* machine.normalizePath({ path: join(folderOf(statePath), "local", "local.jsonc") });
    const current = yield* machine.readFile({ path, maximumBytes: 1024 * 1024 }).pipe(
      Effect.map((bytes) => new TextDecoder().decode(bytes)),
      Effect.catchTag("MachineFilesystemError", (error) =>
        /\bENOENT\b/u.test(error.message) ? Effect.succeed(undefined) : Effect.fail(error)
      ),
    );
    const previous = current === undefined ? [] : yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Schema.Array(Schema.String))(
        getConfigPath(parseConfigDocument("json", current), "excludeHarnesses") ?? [],
      ),
      catch: (error) => new CanonicalFolderError({ path: path.absolute, message: `cannot read the harness exclusions: ${String(error)}` }),
    });
    const excluded = [...new Set([...previous, ...harnesses])].sort();
    const updated = yield* Effect.try({
      try: () => editConfigText("json", current, { sets: [{ path: "excludeHarnesses", value: excluded }] }),
      catch: (error) => new CanonicalFolderError({ path: path.absolute, message: `cannot update the harness exclusions: ${String(error)}` }),
    });
    yield* machine.atomicWrite({ path, content: new TextEncoder().encode(updated), mode: 0o600 });
    return harnesses;
  });

const outcomeOf = (
  statePath: string,
  run: RunIdType,
  revision: PlanningLocalRevision,
  outcome: SynchronizationOutcome,
) => finishRun(statePath, run, outcome, revision).pipe(Effect.map((finished) => ({ outcome, ...finished })));

const loadFolder = (statePath: string) =>
  Effect.tryPromise({
    try: () => loadCanonicalFolder(folderOf(statePath)),
    catch: (error) =>
      error instanceof CanonicalFolderError || error instanceof LocalOverlayCollisionError
        ? error
        : new CanonicalFolderError({ path: folderOf(statePath), message: String(error) }),
  });

/** Whether the engine recorded the run, open or completed. */
const runRecorded = (run: RunIdType) =>
  Effect.gen(function*() {
    const repository = yield* StateRepository;
    if ((yield* repository.loadDeploymentReceipt(run)) !== undefined) return true;
    return (yield* repository.loadOpenRunIdentity(localProjectionFollower))?.run === run;
  });

/**
 * `canonfig sync --plan|--apply` for the local folder. Apply writes the
 * takeover snapshot (unless backups are off), records the takeovers and the
 * revision, then runs the plan; a run that rolls back takes them back.
 */
export const synchronizeLocal = Effect.fn("LocalProjection.synchronize")(function*(
  statePath: string,
  mode: "plan" | "apply",
  options: LocalSyncOptions,
) {
  const repository = yield* StateRepository;
  const synchronization = yield* Synchronization;
  if (mode === "apply") yield* assertUpgradeGate(localProjectionFollower);
  const loaded = yield* loadFolder(statePath);
  const context = yield* rootContext(options.environment);
  const takeovers = yield* repository.loadHarnessTakeovers();
  const applied = yield* repository.loadAppliedResources(localProjectionFollower);
  const planned = yield* planFolder(loaded, context, takeovers, applied);
  const backup = !options.noBackup && loaded.local.backups;
  const base = {
    mode,
    origin: { folder: loaded.model.folder, digest: loaded.digest },
    harnesses: planned.harnesses.map((entry) => ({ harness: entry.harness, root: entry.layout.root })),
    takeovers: takeoverSummary(planned.takeovers, backup),
    diagnostics: planned.diagnostics.length === 0 ? undefined : planned.diagnostics,
  };
  if (mode === "plan") return { ...base, plan: planned.plan, outcome: undefined };

  const run = newRunId();
  const now = new Date().toISOString();
  const snapshot = planned.takeovers.length > 0 && backup
    ? yield* writeTakeoverSnapshot(backupsOf(statePath), context.home, run, planned.takeovers)
    : undefined;
  // Anything that stops the run before the engine records it leaves no
  // takeover behind: the snapshot and rows are this run's alone.
  const undo = Effect.gen(function*() {
    if (yield* runRecorded(run)) return;
    yield* repository.removeRunTakeovers(run);
    if (snapshot !== undefined) yield* deleteSnapshot(backupsOf(statePath), snapshot);
    yield* discardArtifacts(run);
  }).pipe(Effect.ignore);
  const outcome = yield* Effect.gen(function*() {
    yield* repository.recordLocalRevision(planned.revision, now);
    yield* repository.recordHarnessTakeovers(planned.takeovers.map((unit) => ({
      harness: unit.harness,
      surface: unit.surface,
      root: unit.root,
      snapshot,
      run,
      takenOverAt: now,
    })));
    yield* storeArtifacts(run, planned.artifacts);
    return yield* synchronization.run({
      id: run,
      plan: planned.plan,
      revision: planned.revision,
      appliedResources: planned.appliedResources,
      artifacts: planned.artifacts,
    });
  }).pipe(Effect.tapError(() => undo));
  const finished = yield* outcomeOf(statePath, run, planned.revision, outcome);
  return { ...base, snapshot: finished.snapshotDeleted ? undefined : snapshot, outcome: finished.outcome };
}, (effect, statePath, mode) => mode === "plan" ? effect : withRunLock(statePath, "sync --apply", effect));

/**
 * `canonfig restore [<snapshot>]`: write a takeover snapshot back as a
 * journaled run, refusing drifted surfaces, then exclude its harnesses.
 */
export const restoreLocal = Effect.fn("LocalProjection.restore")(function*(
  statePath: string,
  requested: string | undefined,
) {
  const repository = yield* StateRepository;
  const synchronization = yield* Synchronization;
  yield* assertUpgradeGate(localProjectionFollower);
  const snapshot = yield* readSnapshot(backupsOf(statePath), requested);
  const takeovers = yield* repository.loadHarnessTakeovers();
  const applied = yield* repository.loadAppliedResources(localProjectionFollower);
  const planned = yield* planRestore(snapshot, takeovers, applied);
  const run = newRunId();
  const outcome = yield* Effect.gen(function*() {
    yield* repository.recordLocalRevision(planned.revision, new Date().toISOString());
    yield* storeArtifacts(run, planned.artifacts);
    return yield* synchronization.run({
      id: run,
      plan: planned.plan,
      revision: planned.revision,
      appliedResources: planned.appliedResources,
      artifacts: planned.artifacts,
    });
  }).pipe(Effect.tapError(() => discardArtifacts(run).pipe(Effect.ignore)));
  const finished = yield* outcomeOf(statePath, run, planned.revision, outcome);
  return {
    restored: snapshot.id,
    excludedHarnesses: finished.outcome.outcome === "Converged" ? planned.harnesses : [],
    plan: planned.plan,
    outcome: finished.outcome,
  };
}, (effect, statePath) => withRunLock(statePath, "restore", effect));

/** Whether this machine has an unfinished local run. */
export const hasOpenLocalRun = Effect.gen(function*() {
  const repository = yield* StateRepository;
  return (yield* repository.loadRecovery(localProjectionFollower)) !== undefined;
});

/** `canonfig recover` for an interrupted local run. */
export const recoverLocal = Effect.fn("LocalProjection.recover")(function*(statePath: string) {
  const repository = yield* StateRepository;
  const synchronization = yield* Synchronization;
  const recovery = yield* repository.loadRecovery(localProjectionFollower);
  if (recovery === undefined) {
    return yield* new CanonicalFolderError({ path: statePath, message: "no interrupted local run is waiting for recovery" });
  }
  yield* assertUpgradeGate(localProjectionFollower);
  const revision = yield* repository.getLocalRevision(recovery.run.revision);
  const artifacts = yield* loadArtifacts(recovery.run.id, revision);
  const outcome = yield* synchronization.recover({ follower: localProjectionFollower, revision, artifacts });
  const finished = yield* outcomeOf(statePath, recovery.run.id, revision, outcome);
  return { run: recovery.run.id, origin: revision.origin, outcome: finished.outcome };
}, (effect, statePath) => withRunLock(statePath, "recover", effect));

/**
 * `canonfig abandon` for an interrupted local run: close it without rollback.
 * What it applied stays applied, with its takeovers and snapshot.
 */
export const abandonLocal = Effect.fn("LocalProjection.abandon")(function*(statePath: string) {
  const repository = yield* StateRepository;
  const recovery = yield* repository.loadRecovery(localProjectionFollower);
  if (recovery === undefined) {
    return yield* new CanonicalFolderError({ path: statePath, message: "no interrupted local run is open" });
  }
  yield* assertUpgradeGate(localProjectionFollower);
  yield* removeRunTemporaryEntries(recovery.run.plan.actions, recovery.run.id);
  yield* cleanupRollbackSnapshots(
    recovery.run.id,
    recovery.run.plan.actions.map((action) => action.id),
    [],
    recovery.actions.flatMap((action) => action.rollbackReference === undefined ? [] : [action.rollbackReference]),
  );
  yield* repository.completeRun({
    run: recovery.run.id,
    completedAt: new Date().toISOString(),
    outcome: { outcome: "Failed", run: recovery.run.id, reason: "the interrupted run was abandoned by the operator" },
    appliedResources: yield* repository.loadAppliedResources(localProjectionFollower),
  });
  yield* discardArtifacts(recovery.run.id);
  return { run: recovery.run.id, revision: recovery.run.revision, abandoned: true as const };
}, (effect, statePath) => withRunLock(statePath, "abandon", effect));

