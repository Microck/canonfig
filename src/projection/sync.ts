import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Effect, Schema } from "effect";

import { RunId } from "../domain/brand.ts";
import type { FollowerId, RunId as RunIdType } from "../domain/brand.ts";
import { localProjectionFollower, type SynchronizationOutcome } from "../domain/synchronization.ts";
import { composeTextFile, parseTextComposition } from "../domain/text-composition.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { sha256BytesHex } from "../profile/profile-codec.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import { editConfigText, getConfigPath, parseConfigDocument } from "../synchronization/config-codec.ts";
import {
  cleanupRollbackSnapshots,
  defaultSynchronizationExecutionLimits,
  removeRunTemporaryEntries,
} from "../synchronization/executor.ts";
import { withRunLock } from "../synchronization/run-lock.ts";
import { assertUpgradeGate } from "../synchronization/upgrade-gate.ts";
import { Synchronization } from "../synchronization/synchronization.service.ts";
import type {
  PlannedSynchronization,
  PlanningLocalRevision,
  SynchronizationArtifact,
  SynchronizationRunInput,
} from "../synchronization/synchronization.types.ts";
import { detectHarnesses, harnessReport } from "./detect.ts";
import { adapterFor } from "./adapters/index.ts";
import { CanonicalFolderError, LocalItemCollisionError, loadCanonicalFolder } from "./folder.ts";
import type { TargetId } from "./model.ts";
import {
  parseSurfaceResourceId,
  planFolder,
  planRestore,
  ProjectionHumanActionError,
  resourcesOwner,
  rootContext,
  sharedSkillsOwner,
  surfaceResourceId,
  takeoverSummary,
  type FolderPlan,
} from "./plan.ts";
import {
  deleteSnapshot,
  dropSnapshotEntries,
  pruneSnapshots,
  readSnapshot,
  snapshotOfRun,
  writeTakeoverSnapshot,
} from "./takeover.ts";

/**
 * Projection runs: `canonfig sync`, `recover`, `abandon` and `restore`. On
 * the Source or an unenrolled machine they project the local folder and
 * belong to the local projection follower; a follower's sync runs the same
 * way under its own identity. Every run goes through the shared
 * Synchronization run, journal, rollback and recovery.
 */

export interface LocalSyncOptions {
  /** Take over harness surfaces without a takeover snapshot. */
  readonly noBackup: boolean;
  /** With `--plan`: write private adoption reviews for append-local first adoptions. */
  readonly reviewLocal?: boolean | undefined;
  /** Environment variables harness roots are resolved from. */
  readonly environment: (name: string) => string | undefined;
}

/** The Canonical Folder holds the state database. */
export const folderOf = (statePath: string): string => dirname(statePath);
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
export const loadRunArtifacts = (run: RunIdType, revision: PlanningLocalRevision) =>
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

export const discardRunArtifacts = (run: RunIdType) =>
  artifactDirectory(run).pipe(
    Effect.flatMap((directory) => Effect.promise(() => rm(directory.absolute, { recursive: true, force: true }))),
  );

/**
 * Finish a run the shared engine completed or recovered. A failed run forgets
 * its takeovers only after rollback completed. Incomplete rollback keeps the
 * original snapshot and ownership available for restore. A run stopped early
 * keeps takeovers only for surfaces it applied. An interrupted run keeps
 * everything for `canonfig recover`.
 */
export const finishProjectionRun = (
  statePath: string,
  follower: FollowerId,
  run: RunIdType,
  outcome: SynchronizationOutcome,
  revision: PlanningLocalRevision,
) =>
  Effect.gen(function*() {
    if (outcome.outcome === "Interrupted") return { snapshotDeleted: false, pruned: [] };
    const repository = yield* StateRepository;
    const backups = backupsOf(statePath);
    if (outcome.outcome === "Failed" && outcome.rollbackIncomplete) {
      if (outcome.failedRollbackResources !== undefined) {
        const retained = new Set(outcome.failedRollbackResources);
        const restored = (yield* repository.loadHarnessTakeovers()).filter((takeover) =>
          takeover.run === run && !retained.has(surfaceResourceId(takeover.harness, takeover.surface.split("#")[0]!))
        );
        yield* repository.releaseTakeovers(restored);
        const snapshot = yield* snapshotOfRun(backups, run);
        if (snapshot !== undefined) yield* dropSnapshotEntries(backups, snapshot, restored);
      }
      return { snapshotDeleted: false, pruned: [] };
    }
    yield* discardRunArtifacts(run);
    if (outcome.outcome === "Failed") {
      yield* repository.removeRunTakeovers(run);
      const snapshot = yield* snapshotOfRun(backups, run);
      if (snapshot !== undefined) yield* deleteSnapshot(backups, snapshot);
      return { snapshotDeleted: snapshot !== undefined, pruned: [] };
    }
    const snapshotDeleted = outcome.outcome === "Converged"
      ? false
      : yield* releaseUnappliedTakeovers(statePath, follower, run);
    if (revision.origin === "snapshot" && outcome.outcome === "Converged") yield* finishRestore(statePath, revision);
    return { snapshotDeleted, pruned: yield* pruneSnapshots(backups) };
  });

/**
 * After a run that stopped early (Human Action Required or Follower Drift) or
 * was interrupted and then abandoned: the run never finished some surfaces it
 * took over. Their takeover rows are released; otherwise the next run would
 * treat them as owned with no Applied Resource Record and report drift on
 * content Canonfig may never have written. A surface counts as applied when it
 * has a record, and a config key when that record owns it.
 *
 * Snapshot entries are dropped only for surfaces whose action never started,
 * deleting the snapshot if it empties. A started action may have written its
 * target before the process died without journaling success; the next
 * takeover would then snapshot Canonfig's content, so this snapshot keeps the
 * only copy of what was there before. Returns whether the run's snapshot was
 * deleted.
 */
export const releaseUnappliedTakeovers = (statePath: string, follower: FollowerId, run: RunIdType) =>
  Effect.gen(function*() {
    const repository = yield* StateRepository;
    const applied = new Map((yield* repository.loadAppliedResources(follower)).map((record) => [record.resource, record]));
    const unapplied = (yield* repository.loadHarnessTakeovers()).flatMap((takeover) => {
      if (takeover.run !== run) return [];
      const hash = takeover.surface.indexOf("#");
      const resource = surfaceResourceId(takeover.harness, hash < 0 ? takeover.surface : takeover.surface.slice(0, hash));
      const record = applied.get(resource);
      const owned = record !== undefined && (hash < 0 || (record.ownedKeys ?? []).includes(takeover.surface.slice(hash + 1)));
      return owned ? [] : [{ harness: takeover.harness, surface: takeover.surface, resource }];
    });
    if (unapplied.length === 0) return false;
    yield* repository.releaseTakeovers(unapplied);
    const started = new Set<string>(yield* repository.loadStartedResources(run));
    const neverStarted = unapplied.filter((takeover) => !started.has(takeover.resource));
    const backups = backupsOf(statePath);
    const snapshot = neverStarted.length === 0 ? undefined : yield* snapshotOfRun(backups, run);
    return snapshot === undefined ? false : yield* dropSnapshotEntries(backups, snapshot, neverStarted);
  });

/**
 * After a converged restore: release the restored surfaces, and the single
 * config keys a partly restored file gave back, then exclude their harnesses
 * (and authored resources) in `local/local.jsonc` so the next sync does not
 * take them over again. The run itself already deleted or narrowed their
 * Applied Resource Records.
 */
const finishRestore = (statePath: string, revision: PlanningLocalRevision) =>
  Effect.gen(function*() {
    const repository = yield* StateRepository;
    const surfaces = new Set<string>();
    const keys = new Set<string>();
    const harnesses = new Set<string>();
    const resources = new Set<string>();
    const owner = (parsed: { readonly harness: string; readonly surface: string }) => {
      if (parsed.harness === resourcesOwner) resources.add(parsed.surface);
      else harnesses.add(parsed.harness);
    };
    for (const id of revision.removedResources ?? []) {
      const parsed = parseSurfaceResourceId(id);
      if (parsed === undefined) continue;
      surfaces.add(`${parsed.harness}\0${parsed.surface}`);
      owner(parsed);
    }
    for (const entry of revision.desired) {
      const parsed = parseSurfaceResourceId(entry.resource);
      if (parsed === undefined || entry.desired.kind !== "config" || entry.desired.releases === undefined) continue;
      for (const key of entry.desired.releases) keys.add(`${parsed.harness}\0${parsed.surface}#${key}`);
      owner(parsed);
    }
    const takeovers = yield* repository.loadHarnessTakeovers();
    yield* repository.releaseTakeovers(takeovers
      .filter((takeover) =>
        surfaces.has(`${takeover.harness}\0${takeover.surface.split("#")[0]!}`)
        || keys.has(`${takeover.harness}\0${takeover.surface}`)
      )
      .map((takeover) => ({ harness: takeover.harness, surface: takeover.surface })));
    if (harnesses.has(sharedSkillsOwner)) {
      const loaded = yield* loadFolder(statePath);
      const context = yield* rootContext((name) => process.env[name]);
      for (const harness of loaded.model.harnesses) {
        if (adapterFor(harness).layout(context, loaded.model).sharedSkills) harnesses.add(harness);
      }
    }
    if (resources.size > 0) yield* editLocalList(folderOf(statePath), "excludeResources", (previous) => [...previous, ...resources]);
    const excluded = [...harnesses].filter((harness) => harness !== sharedSkillsOwner).sort();
    if (excluded.length === 0) return [];
    yield* editLocalList(folderOf(statePath), "excludeHarnesses", (previous) => [...previous, ...excluded]);
    return excluded;
  });

/**
 * Rewrite one list in `local/local.jsonc` (sorted, unique), keeping the
 * file's comments and other keys: `excludeHarnesses` (restore and
 * `canonfig harnesses include|exclude`), `excludeResources` (restore) and
 * `overlays` (`canonfig overlay set|remove`). The loader checks the result
 * on the next read, as it checks a hand edit.
 *
 * The read-modify-write is not atomic on its own, so every caller holds the
 * run lock: `restore` already does, and the `harnesses` and `overlay`
 * commands take it around their edit. Two edits, or an edit and a restore,
 * then cannot both read the old list and lose one change; the second one
 * fails with `RunLockHeldError` and the person retries.
 */
export const editLocalList = (
  folder: string,
  key: "excludeHarnesses" | "excludeResources" | "overlays",
  update: (current: ReadonlyArray<string>) => ReadonlyArray<string>,
) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const directory = yield* machine.normalizePath({ path: join(folder, "local") });
    const path = yield* machine.normalizePath({ path: join(folder, "local", "local.jsonc") });
    const current = yield* machine.readFile({ path, maximumBytes: 1024 * 1024 }).pipe(
      Effect.map((bytes) => new TextDecoder().decode(bytes)),
      Effect.catchTag("MachineFilesystemError", (error) =>
        /\bENOENT\b/u.test(error.message) ? Effect.succeed(undefined) : Effect.fail(error)
      ),
    );
    const previous = current === undefined ? [] : yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Schema.Array(Schema.String))(
        getConfigPath(parseConfigDocument("json", current), key) ?? [],
      ),
      catch: (error) => new CanonicalFolderError({ path: path.absolute, message: `cannot read ${key}: ${String(error)}` }),
    });
    const listed = [...new Set(update(previous))].sort();
    const updated = yield* Effect.try({
      try: () => editConfigText("json", current, { sets: [{ path: key, value: listed }] }),
      catch: (error) => new CanonicalFolderError({ path: path.absolute, message: `cannot update ${key}: ${String(error)}` }),
    });
    yield* machine.ensureDirectory({ path: directory, mode: 0o700 });
    yield* machine.atomicWrite({ path, content: new TextEncoder().encode(updated), mode: 0o600 });
    return listed;
  });

const loadFolder = (statePath: string) =>
  Effect.tryPromise({
    try: () => loadCanonicalFolder(folderOf(statePath)),
    catch: (error) =>
      error instanceof CanonicalFolderError || error instanceof LocalItemCollisionError
        ? error
        : new CanonicalFolderError({ path: folderOf(statePath), message: String(error) }),
  });

/** Whether the engine recorded the run, open or completed. */
const runRecorded = (follower: FollowerId, run: RunIdType) =>
  Effect.gen(function*() {
    const repository = yield* StateRepository;
    if ((yield* repository.loadDeploymentReceipt(run)) !== undefined) return true;
    return (yield* repository.loadOpenRunIdentity(follower))?.run === run;
  });

export interface ProjectionRunInput {
  readonly statePath: string;
  readonly follower: FollowerId;
  readonly planned: FolderPlan;
  /** Write a takeover snapshot before the first write to a surface. */
  readonly backup: boolean;
  readonly home: string;
  /** What a follower adds to the run: its Configuration Agent and process bounds. */
  readonly agent?: SynchronizationRunInput["agent"];
  readonly agentResolution?: SynchronizationRunInput["agentResolution"];
  readonly limits?: SynchronizationRunInput["limits"];
}

/**
 * Apply a planned projection run: write the takeover snapshot (unless
 * backups are off), record the takeovers and the revision, store the run's
 * content for recovery, then run the plan. A run that rolls back takes its
 * takeovers and snapshot back.
 */
export const runProjection = (input: ProjectionRunInput) =>
  Effect.gen(function*() {
    const repository = yield* StateRepository;
    const synchronization = yield* Synchronization;
    const planned = input.planned;
    const run = newRunId();
    const now = new Date().toISOString();
    const backups = backupsOf(input.statePath);
    const snapshot = planned.takeovers.length > 0 && input.backup
      ? yield* writeTakeoverSnapshot(backups, input.home, run, planned.takeovers)
      : undefined;
    // Anything that stops the run before the engine records it leaves no
    // takeover behind: the snapshot and rows are this run's alone.
    const undo = Effect.gen(function*() {
      if (yield* runRecorded(input.follower, run)) return;
      yield* repository.removeRunTakeovers(run);
      if (snapshot !== undefined) yield* deleteSnapshot(backups, snapshot);
      yield* discardRunArtifacts(run);
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
        agent: input.agent,
        agentResolution: input.agentResolution,
        limits: input.limits,
      });
    }).pipe(Effect.tapError(() => undo));
    const finished = yield* finishProjectionRun(input.statePath, input.follower, run, outcome, planned.revision);
    return { outcome, snapshot: finished.snapshotDeleted ? undefined : snapshot };
  });

/**
 * `sync --plan --review-local`: for every append-local first adoption the
 * plan holds, write the exact Source text, the existing text kept as this
 * machine's own, and the file apply would write to a private JSON file under
 * `~/.canonfig/.reviews/adoption-review-<id>/` (directory 0700, files 0600).
 * The text never enters the plan, the journal or the command output: it can
 * hold local secrets. Each target is read again and must still be the
 * unmarked file the plan saw, or the review stops. Every adoption is checked
 * before the directory is created, and a failed write removes the directory:
 * a stopped review leaves no partial copy of local text behind.
 */
export const writeAdoptionReviews = (
  statePath: string,
  plan: PlannedSynchronization,
  artifacts: ReadonlyArray<SynchronizationArtifact>,
) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const adoptions = plan.actions.filter((action) =>
      action.detail.kind === "write-file" && action.detail.retainedLocalDigest !== undefined
    );
    if (adoptions.length === 0) return [];
    const stale = (message: string) =>
      new ProjectionHumanActionError({ message: `${message}; run 'canonfig sync --plan --review-local' again` });
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const encoder = new TextEncoder();
    const prepared: Array<{ resource: string; target: string; review: object }> = [];
    for (const action of adoptions) {
      const detail = action.detail;
      if (detail.kind !== "write-file") continue;
      const target = yield* machine.normalizePath({ path: detail.target });
      if ((yield* machine.inspectPath(target)).kind !== "regular") return yield* stale(`${detail.target} is no longer a regular file`);
      const bytes = yield* machine.readFile({ path: target, maximumBytes: defaultSynchronizationExecutionLimits.maximumFileBytes });
      if (sha256BytesHex(bytes) !== detail.retainedLocalDigest) return yield* stale(`${detail.target} changed after planning`);
      const current = yield* Effect.try({
        try: () => parseTextComposition(bytes),
        catch: () => stale(`${detail.target} is no longer valid text without Canonfig markers`),
      });
      if (current.kind !== "unmanaged") return yield* stale(`${detail.target} already holds a Canonfig section`);
      const sourceBytes = artifacts.find((artifact) => artifact.digest === detail.digest)?.content;
      if (sourceBytes === undefined) return yield* stale(`the Source text for ${detail.target} is unavailable`);
      const source = decoder.decode(sourceBytes);
      prepared.push({
        resource: action.resource,
        target: detail.target,
        review: {
          schema: "canonfig.adoption-review/v1",
          revision: plan.revision,
          planDigest: plan.digest,
          resource: action.resource,
          target: detail.target,
          sourceDigest: detail.digest,
          retainedLocalDigest: detail.retainedLocalDigest,
          sourceAddition: source,
          retainedLocal: current.local,
          proposedText: decoder.decode(composeTextFile(source, current)),
        },
      });
    }
    const root = yield* machine.normalizePath({ path: join(folderOf(statePath), ".reviews", `adoption-review-${randomUUID()}`) });
    yield* machine.ensureDirectory({ path: root, mode: 0o700 });
    return yield* Effect.forEach(prepared, (entry, index) =>
      Effect.gen(function*() {
        const path = yield* machine.normalizePath({ path: `${index + 1}.json`, base: root });
        yield* machine.atomicWrite({ path, mode: 0o600, content: encoder.encode(`${JSON.stringify(entry.review, undefined, 2)}\n`) });
        return { resource: entry.resource, target: entry.target, path: path.absolute };
      })).pipe(
        // The directory is this call's own (a fresh UUID), so removing it whole
        // takes only the reviews written so far.
        Effect.onError(() => Effect.promise(() => rm(root.absolute, { recursive: true, force: true }))),
      );
  });

/**
 * `canonfig sync --plan|--apply` for the local folder. A listed harness
 * projects only once installed; until then it is reported and its earlier
 * outputs are held, and the run can still converge.
 */
export const synchronizeLocal = Effect.fn("LocalProjection.synchronize")(function*(
  statePath: string,
  mode: "plan" | "apply",
  options: LocalSyncOptions,
) {
  const repository = yield* StateRepository;
  if (mode === "apply") yield* assertUpgradeGate(localProjectionFollower);
  const loaded = yield* loadFolder(statePath);
  const context = yield* rootContext(options.environment);
  const takeovers = yield* repository.loadHarnessTakeovers();
  const applied = yield* repository.loadAppliedResources(localProjectionFollower);
  const installed = new Set((yield* detectHarnesses(context, loaded.model.folder))
    .filter((entry) => entry.installed)
    .map((entry) => entry.harness));
  const notInstalled = loaded.model.harnesses.filter((harness) => !installed.has(harness));
  const planned = yield* planFolder(loaded, context, takeovers, applied, notInstalled);
  const backup = !options.noBackup && loaded.local.backups;
  const base = {
    mode,
    origin: { folder: loaded.model.folder, digest: loaded.digest },
    harnesses: planned.harnesses.map((entry) => ({ harness: entry.harness, root: entry.layout.root })),
    notInstalled: notInstalled.length === 0 ? undefined : notInstalled,
    takeovers: takeoverSummary(planned.takeovers, backup),
    diagnostics: planned.diagnostics.length === 0 ? undefined : planned.diagnostics,
  };
  if (mode === "plan") {
    const adoptionReviews = options.reviewLocal === true
      ? yield* writeAdoptionReviews(statePath, planned.plan, planned.artifacts)
      : undefined;
    return { ...base, plan: planned.plan, adoptionReviews, outcome: undefined };
  }
  const result = yield* runProjection({
    statePath,
    follower: localProjectionFollower,
    planned,
    backup,
    home: context.home,
  });
  return { ...base, snapshot: result.snapshot, outcome: result.outcome };
}, (effect, statePath, mode) => mode === "plan" ? effect : withRunLock(statePath, "sync --apply", effect));

/**
 * `canonfig restore [<snapshot>]`: write a takeover snapshot back as a
 * journaled run, refusing drifted surfaces, then exclude its harnesses and
 * authored resources. The run belongs to whoever projected the surfaces:
 * this machine's local projection, or its follower identity once enrolled.
 */
export const restoreLocal = Effect.fn("LocalProjection.restore")(function*(
  statePath: string,
  requested: string | undefined,
  follower: FollowerId,
) {
  const repository = yield* StateRepository;
  const synchronization = yield* Synchronization;
  yield* assertUpgradeGate(follower);
  const snapshot = yield* readSnapshot(backupsOf(statePath), requested);
  const applied = yield* repository.loadAppliedResources(follower);
  const planned = yield* planRestore(snapshot, applied, follower);
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
  }).pipe(Effect.tapError(() => discardRunArtifacts(run).pipe(Effect.ignore)));
  yield* finishProjectionRun(statePath, follower, run, outcome, planned.revision);
  const converged = outcome.outcome === "Converged";
  return {
    restored: snapshot.id,
    excludedHarnesses: converged ? planned.harnesses : [],
    excludedResources: converged ? planned.resources : [],
    plan: planned.plan,
    outcome,
  };
}, (effect, statePath) => withRunLock(statePath, "restore", effect));

export interface HarnessExclusionChange {
  readonly action: "include" | "exclude";
  readonly harness: TargetId;
}

/**
 * `canonfig harnesses [include|exclude <id>]`: optionally change this
 * machine's exclusions, then report detection, the folder's list, exclusions,
 * pinned roots and snapshots. Including removes a local exclusion only; the
 * harness list itself lives in `canonfig.jsonc`.
 */
export const harnessesLocal = Effect.fn("LocalProjection.harnesses")(function*(
  statePath: string,
  environment: (name: string) => string | undefined,
  change: HarnessExclusionChange | undefined,
) {
  const repository = yield* StateRepository;
  const folder = folderOf(statePath);
  if (change !== undefined) {
    yield* withRunLock(statePath, `harnesses ${change.action}`, editLocalList(folder, "excludeHarnesses", (current) =>
      change.action === "exclude" ? [...current, change.harness] : current.filter((harness) => harness !== change.harness)));
  }
  const report = yield* harnessReport({
    folder,
    context: yield* rootContext(environment),
    takeovers: yield* repository.loadHarnessTakeovers(),
  });
  const unlisted = change?.action === "include" && !report.listed.includes(change.harness);
  return {
    ...report,
    change,
    warnings: unlisted
      ? [`${change.harness} is not listed in ${join(folder, "canonfig.jsonc")}; add it to "harnesses" there to project it`]
      : undefined,
  };
});

export interface OverlayChange {
  readonly action: "set" | "remove";
  /** `<category>/<name>`, already checked against the overlay reference format. */
  readonly item: string;
}

/**
 * `canonfig overlay set|remove <item>` edits this machine's Local Overlays in
 * `local/local.jsonc` and reports the list; it works before the first sync.
 * `canonfig overlay list` loads the folder (the mirror on a follower) and
 * reports what each overlay finds: an admitted `local/` item, a published
 * item, or both. Overlays are machine-local: never published, never mirrored.
 */
export const overlaysLocal = Effect.fn("LocalProjection.overlays")(function*(
  statePath: string,
  change: OverlayChange | undefined,
) {
  const folder = folderOf(statePath);
  if (change !== undefined) {
    const overlays = yield* withRunLock(statePath, `overlay ${change.action}`, editLocalList(folder, "overlays", (current) =>
      change.action === "set" ? [...current, change.item] : current.filter((item) => item !== change.item)));
    return { change, overlays };
  }
  const loaded = yield* loadFolder(statePath);
  return { overlays: loaded.overlays };
});

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
  const artifacts = yield* loadRunArtifacts(recovery.run.id, revision);
  const outcome = yield* synchronization.recover({ follower: localProjectionFollower, revision, artifacts });
  yield* finishProjectionRun(statePath, localProjectionFollower, recovery.run.id, outcome, revision);
  return { run: recovery.run.id, origin: revision.origin, outcome };
}, (effect, statePath) => withRunLock(statePath, "recover", effect));

/**
 * `canonfig abandon` for an interrupted local run: close it without rollback.
 * What it applied stays applied, with its takeovers and snapshot; takeovers
 * of surfaces it never applied are released, as after an early stop.
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
  // Before the run closes, so a failure here leaves it open for another abandon.
  yield* releaseUnappliedTakeovers(statePath, localProjectionFollower, recovery.run.id);
  yield* repository.completeRun({
    run: recovery.run.id,
    completedAt: new Date().toISOString(),
    outcome: { outcome: "Failed", run: recovery.run.id, reason: "the interrupted run was abandoned by the operator" },
    appliedResources: yield* repository.loadAppliedResources(localProjectionFollower),
  });
  yield* discardRunArtifacts(recovery.run.id);
  return { run: recovery.run.id, revision: recovery.run.revision, abandoned: true as const };
}, (effect, statePath) => withRunLock(statePath, "abandon", effect));
