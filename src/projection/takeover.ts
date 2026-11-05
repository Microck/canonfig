import { readdir, readFile, rename, rm } from "node:fs/promises";
import { join, posix, win32 } from "node:path";

import { Effect, Schema } from "effect";

import { ContentDigest } from "../domain/brand.ts";
import type { RunId } from "../domain/brand.ts";
import { TaggedError } from "../domain/tagged-error.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import type { MachinePath } from "../machine/machine-state.types.ts";
import { getConfigPath, parseConfigDocument } from "../synchronization/config-codec.ts";
import type { ConfigJson } from "../synchronization/config-value.ts";
import type { ConfigFormat } from "./harness.ts";

/**
 * Takeover snapshots: content Canonfig is about to overwrite, under
 * `~/.canonfig/.backups/<UTC>/`. That is what a harness surface held before
 * Canonfig first wrote it, or the Canonical Folder entries an
 * `import --replace` (or a restore of such a backup) replaces, recorded under
 * the owner `canonicalFolderOwner` instead of a harness.
 *
 * Each snapshot has `manifest.json` and one directory per owner holding the
 * copied files at their path relative to the home directory, plus `keys.json`
 * with the prior values of the config keys taken over (never the whole file,
 * so credentials sharing that file never enter a backup). Directories are
 * created 0700 and files 0600 through the protected machine writer.
 */

/** The snapshot owner of Canonical Folder entries, where a takeover names its harness. */
export const canonicalFolderOwner = "canonfig";

export class TakeoverSnapshotError extends TaggedError<TakeoverSnapshotError>()(
  "TakeoverSnapshotError",
  { path: Schema.String, message: Schema.String },
) {}

export class SnapshotNotFoundError extends TaggedError<SnapshotNotFoundError>()(
  "SnapshotNotFoundError",
  { snapshot: Schema.String, message: Schema.String },
) {}

/** One surface (or one config key) Canonfig is about to own for the first time. */
export interface TakeoverUnit {
  /** A harness id, or `agents` for the shared `~/.agents/skills/`. */
  readonly harness: string;
  /** Surface id, or `<surface>#<key>` for one config key. */
  readonly surface: string;
  readonly root: string;
  readonly kind: "file" | "directory" | "config";
  readonly target: string;
  readonly format?: ConfigFormat | undefined;
  readonly key?: string | undefined;
}

const DirectoryEntry = Schema.Union([
  Schema.Struct({ path: Schema.String, object: Schema.Literal("directory"), mode: Schema.Int }),
  Schema.Struct({
    path: Schema.String,
    object: Schema.Literal("regular"),
    mode: Schema.Int,
    sha256: ContentDigest,
    copy: Schema.String,
  }),
  Schema.Struct({ path: Schema.String, object: Schema.Literal("symlink"), symlinkTo: Schema.String }),
]);
export type SnapshotDirectoryEntry = typeof DirectoryEntry.Type;

const EntryBase = {
  harness: Schema.String,
  surface: Schema.String,
  root: Schema.String,
  target: Schema.String,
};

const ManifestEntry = Schema.Union([
  Schema.Struct({ ...EntryBase, kind: Schema.Literals(["file", "directory"]), state: Schema.Literal("absent") }),
  Schema.Struct({
    ...EntryBase,
    kind: Schema.Literal("file"),
    state: Schema.Literal("present"),
    object: Schema.Literal("regular"),
    mode: Schema.Int,
    sha256: ContentDigest,
    copy: Schema.String,
  }),
  Schema.Struct({
    ...EntryBase,
    kind: Schema.Literal("file"),
    state: Schema.Literal("present"),
    object: Schema.Literal("symlink"),
    symlinkTo: Schema.String,
  }),
  Schema.Struct({
    ...EntryBase,
    kind: Schema.Literal("directory"),
    state: Schema.Literal("present"),
    mode: Schema.Int,
    entries: Schema.Array(DirectoryEntry),
  }),
  Schema.Struct({
    ...EntryBase,
    kind: Schema.Literal("config"),
    state: Schema.Literals(["absent", "present"]),
    format: Schema.Literals(["json", "toml", "yaml"]),
    key: Schema.String,
  }),
]);
export type SnapshotEntry = typeof ManifestEntry.Type;

const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  snapshot: Schema.String,
  run: Schema.String,
  createdAt: Schema.String,
  entries: Schema.Array(ManifestEntry),
});
export type SnapshotManifest = typeof Manifest.Type;

/**
 * Prior config key values: harness, then target, then key path. Any JSON
 * value, null included: a JSON or YAML file can hold a null key, and restore
 * writes it back as it was.
 */
const KeyValues = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json));

export interface Snapshot {
  readonly id: string;
  readonly directory: string;
  readonly manifest: SnapshotManifest;
  /** `harness`, then target path, then key path, to the prior value. */
  readonly keys: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, ConfigJson>>>;
}

const snapshotName = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?$/u;
/**
 * A snapshot is built under `.tmp-<id>` and renamed to `<id>` once its
 * manifest is complete, so a capture that fails or is killed never leaves a
 * directory that looks like a snapshot.
 */
const temporaryPrefix = ".tmp-";

/** Wrap a typed failure (machine, schema) with the path it concerns. */
const snapshotError = (path: string) => (error: { readonly message: string }) =>
  new TakeoverSnapshotError({ path, message: error.message });

/** Entry names of `.backups/`, or none when it does not exist. */
const backupEntries = (backups: string): Effect.Effect<ReadonlyArray<string>, TakeoverSnapshotError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await readdir(backups);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
      }
    },
    catch: (error) => new TakeoverSnapshotError({ path: backups, message: String(error) }),
  });

/**
 * Snapshot ids, oldest first. Names sort chronologically. Only a directory
 * with a valid manifest is a snapshot; anything else in `.backups/` is never
 * listed, restored or counted by retention.
 */
export const listSnapshots = (backups: string): Effect.Effect<ReadonlyArray<string>, TakeoverSnapshotError> =>
  Effect.gen(function*() {
    const named = (yield* backupEntries(backups)).filter((name) => snapshotName.test(name)).sort();
    return yield* Effect.filter(named, (id) => readManifest(join(backups, id), id).pipe(Effect.isSuccess));
  });

/** Remove one snapshot directory and everything in it. */
export const deleteSnapshot = (backups: string, id: string): Effect.Effect<void, TakeoverSnapshotError> =>
  Effect.tryPromise({
    try: () => rm(join(backups, id), { recursive: true, force: true }),
    catch: (error) => new TakeoverSnapshotError({ path: join(backups, id), message: String(error) }),
  });

/**
 * Keep the first harness snapshot, the harnesses' state before Canonfig ever
 * wrote, the first folder snapshot, the folder before an import first
 * replaced it, and the four most recent. Kept apart, so a folder backup taken
 * before any takeover never pushes the first harness snapshot out. Called
 * after a run that wrote a new snapshot did not roll back. Runs hold the run
 * lock, so a temporary directory left then belongs to a capture that was
 * killed and is removed too.
 */
export const pruneSnapshots = (backups: string): Effect.Effect<ReadonlyArray<string>, TakeoverSnapshotError> =>
  Effect.gen(function*() {
    const stale = (yield* backupEntries(backups)).filter((name) => name.startsWith(temporaryPrefix));
    yield* Effect.forEach(stale, (name) => deleteSnapshot(backups, name), { discard: true });
    const snapshots = yield* listSnapshots(backups);
    const holdsFolder = new Set<string>();
    for (const id of snapshots) {
      const manifest = yield* readManifest(join(backups, id), id).pipe(Effect.mapError(snapshotError(join(backups, id))));
      if (manifest.entries.some((entry) => entry.harness === canonicalFolderOwner)) holdsFolder.add(id);
    }
    const firsts = new Set([snapshots.find((id) => holdsFolder.has(id)), snapshots.find((id) => !holdsFolder.has(id))]);
    const pruned = snapshots.slice(0, Math.max(0, snapshots.length - 4)).filter((id) => !firsts.has(id));
    yield* Effect.forEach(pruned, (id) => deleteSnapshot(backups, id), { discard: true });
    return pruned;
  });

const readManifest = (directory: string, id: string) =>
  Effect.tryPromise({
    try: async () => JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")),
    catch: (error) => new SnapshotNotFoundError({ snapshot: id, message: `snapshot ${id} has no readable manifest: ${String(error)}` }),
  }).pipe(
    Effect.flatMap((value) => Schema.decodeUnknownEffect(Manifest)(value)),
    Effect.mapError((error) =>
      error instanceof SnapshotNotFoundError
        ? error
        : new SnapshotNotFoundError({ snapshot: id, message: `snapshot ${id} has an invalid manifest: ${String(error)}` })
    ),
  );

/** The snapshot a run wrote, if it wrote one. */
export const snapshotOfRun = (backups: string, run: RunId) =>
  Effect.gen(function*() {
    for (const id of yield* listSnapshots(backups)) {
      const manifest = yield* readManifest(join(backups, id), id).pipe(Effect.option);
      if (manifest._tag === "Some" && manifest.value.run === run) return id;
    }
    return undefined;
  });

/** Read a snapshot, the latest when no id is given. */
export const readSnapshot = (
  backups: string,
  requested: string | undefined,
): Effect.Effect<Snapshot, SnapshotNotFoundError | TakeoverSnapshotError> =>
  Effect.gen(function*() {
    const snapshots = yield* listSnapshots(backups);
    const id = requested ?? snapshots.at(-1);
    if (id === undefined || !snapshots.includes(id)) {
      return yield* new SnapshotNotFoundError({
        snapshot: requested ?? "latest",
        message: requested === undefined
          ? `there are no takeover snapshots in ${backups}`
          : `snapshot ${requested} does not exist; snapshots: ${snapshots.join(", ") || "none"}`,
      });
    }
    const directory = join(backups, id);
    const manifest = yield* readManifest(directory, id);
    const keys = new Map<string, Map<string, Map<string, ConfigJson>>>();
    // keys.json exists only for harnesses with at least one key that had a value.
    const withValues = manifest.entries.filter((entry) => entry.kind === "config" && entry.state === "present");
    for (const harness of new Set(withValues.map((entry) => entry.harness))) {
      const decoded = yield* Effect.tryPromise({
        try: async () => JSON.parse(await readFile(join(directory, harness, "keys.json"), "utf8")),
        catch: (error) => new SnapshotNotFoundError({ snapshot: id, message: `${harness}/keys.json is unreadable: ${String(error)}` }),
      }).pipe(
        Effect.flatMap((value) => Schema.decodeUnknownEffect(KeyValues)(value)),
        Effect.mapError((error) =>
          error instanceof SnapshotNotFoundError
            ? error
            : new SnapshotNotFoundError({ snapshot: id, message: `${harness}/keys.json is invalid: ${String(error)}` })
        ),
      );
      keys.set(harness, new Map(Object.entries(decoded).map(([target, values]) => [target, new Map(Object.entries(values))])));
    }
    return { id, directory, manifest, keys };
  });

/**
 * Drop the entries of `surfaces` from a snapshot, with their copied files and
 * key values, and delete the snapshot when no entry is left. A run that
 * stopped before it wrote a surface uses this, so the snapshot keeps only
 * prior content of surfaces Canonfig did take over. The manifest is rewritten
 * first: an interruption then leaves only unreferenced copies, never a
 * manifest naming a missing one. Returns whether the snapshot was deleted.
 */
export const dropSnapshotEntries = (
  backups: string,
  id: string,
  surfaces: ReadonlyArray<{ readonly harness: string; readonly surface: string }>,
): Effect.Effect<boolean, TakeoverSnapshotError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const snapshot = yield* readSnapshot(backups, id).pipe(
      Effect.mapError((error) => new TakeoverSnapshotError({ path: join(backups, id), message: error.message })),
    );
    const droppedSurfaces = new Set(surfaces.map((entry) => `${entry.harness}\0${entry.surface}`));
    const isDropped = (entry: SnapshotEntry) => droppedSurfaces.has(`${entry.harness}\0${entry.surface}`);
    const dropped = snapshot.manifest.entries.filter(isDropped);
    if (dropped.length === 0) return false;
    const kept = snapshot.manifest.entries.filter((entry) => !isDropped(entry));
    if (kept.length === 0) {
      yield* deleteSnapshot(backups, id);
      return true;
    }
    const pathOf = (relative: string) => join(snapshot.directory, ...relative.split("/"));
    const write = (relative: string, value: SnapshotManifest | Record<string, Record<string, ConfigJson>>) =>
      machine.normalizePath({ path: pathOf(relative) }).pipe(
        Effect.flatMap((path) => machine.atomicWrite({ path, content: new TextEncoder().encode(`${JSON.stringify(value, undefined, 2)}\n`), mode: 0o600 })),
        Effect.mapError(snapshotError(pathOf(relative))),
      );
    const remove = (relative: string) => Effect.tryPromise({
      try: () => rm(pathOf(relative), { recursive: true, force: true }),
      catch: (error) => new TakeoverSnapshotError({ path: pathOf(relative), message: String(error) }),
    });
    yield* write("manifest.json", { ...snapshot.manifest, entries: kept } satisfies SnapshotManifest);
    const keptHarnesses = new Set(kept.map((entry) => entry.harness));
    for (const harness of new Set(dropped.map((entry) => entry.harness))) {
      if (!keptHarnesses.has(harness)) {
        yield* remove(harness);
        continue;
      }
      // keys.json holds the kept keys that had a value, or goes away.
      const values: Record<string, Record<string, ConfigJson>> = {};
      for (const entry of kept) {
        if (entry.harness !== harness || entry.kind !== "config" || entry.state !== "present") continue;
        const value = snapshot.keys.get(harness)?.get(entry.target)?.get(entry.key);
        if (value !== undefined) values[entry.target] = { ...values[entry.target], [entry.key]: value };
      }
      if (Object.keys(values).length === 0) yield* remove(`${harness}/keys.json`);
      else yield* write(`${harness}/keys.json`, values);
      for (const entry of dropped) {
        if (entry.harness !== harness || entry.state !== "present") continue;
        if (entry.kind === "file" && entry.object === "regular") yield* remove(entry.copy);
        if (entry.kind !== "directory") continue;
        // Every copied child sits under the directory's own copy.
        const child = entry.entries.find((candidate) => candidate.object === "regular");
        if (child?.object === "regular") yield* remove(child.copy.slice(0, child.copy.length - child.path.length - 1));
      }
    }
    return false;
  });

const isNotFound = (error: { readonly message: string }) => /\b(?:ENOENT|ENOTDIR)\b/u.test(error.message);

/**
 * Copy every unit's prior state into a new snapshot and return its id.
 * Nothing outside the units' targets is read. The snapshot is built under a
 * temporary name, removed again if the capture fails, and renamed to its id
 * only once the manifest is complete.
 */
export const writeTakeoverSnapshot = (
  backups: string,
  home: string,
  run: RunId,
  units: ReadonlyArray<TakeoverUnit>,
): Effect.Effect<string, TakeoverSnapshotError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const platform = (yield* machine.userDirectories().pipe(Effect.mapError(snapshotError(backups)))).home.platform;
    const paths = platform === "windows" ? win32 : posix;
    // Every name, valid snapshot or not: the rename must not land on one.
    const existing = yield* backupEntries(backups);
    const createdAt = new Date();
    const base = createdAt.toISOString().replaceAll(":", "-").replace(".", "-");
    let id = base;
    for (let suffix = 1; existing.includes(id) || existing.includes(`${temporaryPrefix}${id}`); suffix += 1) id = `${base}-${suffix}`;
    const directory = paths.join(backups, `${temporaryPrefix}${id}`);
    const fail = (path: string, message: string) => new TakeoverSnapshotError({ path, message });
    const at = (path: string) => machine.normalizePath({ path }).pipe(Effect.mapError(snapshotError(path)));
    const ensure = (path: string) =>
      at(path).pipe(Effect.flatMap((normalized) => machine.ensureDirectory({ path: normalized, mode: 0o700 })), Effect.mapError(snapshotError(path)));
    /** The copy location of a target, relative to the snapshot, with forward slashes. */
    const copyPath = (harness: string, target: string) =>
      [harness, ...paths.relative(home, target).split(paths.sep)].join("/");
    const write = (copy: string, content: Uint8Array | { readonly file: string; readonly digest: ContentDigest }) =>
      Effect.gen(function*() {
        const absolute = paths.join(directory, ...copy.split("/"));
        const relative = paths.relative(directory, absolute);
        if (paths.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${paths.sep}`)) {
          return yield* fail(absolute, "snapshot copy must remain inside its snapshot directory");
        }
        yield* ensure(paths.dirname(absolute));
        yield* machine.atomicWrite({ path: yield* at(absolute), content, mode: 0o600 }).pipe(Effect.mapError(snapshotError(absolute)));
      });
    const inspect = (path: MachinePath) =>
      machine.inspectPath(path).pipe(
        Effect.map((object) => object.kind),
        Effect.catchTag("MachineFilesystemError", (error) =>
          isNotFound(error) ? Effect.succeed("absent" as const) : Effect.fail(error)
        ),
        Effect.mapError(snapshotError(path.absolute)),
      );
    const copyRegular = (path: MachinePath, copy: string) =>
      Effect.gen(function*() {
        const digest = yield* machine.digestFile({ path }).pipe(Effect.mapError(snapshotError(path.absolute)));
        const sha256 = Schema.decodeUnknownSync(ContentDigest)(digest.value);
        const mode = (yield* machine.permissions(path).pipe(Effect.mapError(snapshotError(path.absolute)))).mode;
        yield* write(copy, { file: path.absolute, digest: sha256 });
        return { mode, sha256 };
      });

    const capture = Effect.gen(function*() {
      yield* ensure(directory);
      const entries: Array<SnapshotEntry> = [];
      const keys = new Map<string, Record<string, Record<string, ConfigJson>>>();
      for (const unit of units) {
        const base = { harness: unit.harness, surface: unit.surface, root: unit.root, target: unit.target };
        const relative = paths.relative(home, unit.target);
        if (paths.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${paths.sep}`)) {
          return yield* fail(unit.target, "takeover target must remain inside the home directory");
        }
        const path = yield* at(unit.target);
        const object = yield* inspect(path);
        if (unit.kind === "config") {
          const format = unit.format!;
          const key = unit.key!;
          let value: ConfigJson | undefined;
          if (object === "regular") {
            const bytes = yield* machine.readFile({ path, maximumBytes: 8 * 1024 * 1024 }).pipe(Effect.mapError(snapshotError(unit.target)));
            const document = yield* Effect.try({
              try: () => parseConfigDocument(format, new TextDecoder().decode(bytes)),
              catch: (error) => fail(unit.target, `cannot read the owned keys: ${String(error)}`),
            });
            value = getConfigPath(document, key);
          } else if (object !== "absent") {
            return yield* fail(unit.target, `is a ${object}, not a regular file`);
          }
          entries.push({ ...base, kind: "config", state: value === undefined ? "absent" : "present", format, key });
          if (value !== undefined) {
            const byTarget = keys.get(unit.harness) ?? {};
            byTarget[unit.target] = { ...byTarget[unit.target], [key]: value };
            keys.set(unit.harness, byTarget);
          }
          continue;
        }
        if (object === "absent") {
          entries.push({ ...base, kind: unit.kind, state: "absent" });
          continue;
        }
        if (unit.kind === "file") {
          if (object === "symlink") {
            const symlinkTo = yield* machine.readSymlink(path).pipe(Effect.mapError(snapshotError(unit.target)));
            entries.push({ ...base, kind: "file", state: "present", object: "symlink", symlinkTo });
            continue;
          }
          if (object !== "regular") return yield* fail(unit.target, `is a ${object}, not a regular file`);
          const copy = copyPath(unit.harness, unit.target);
          entries.push({ ...base, kind: "file", state: "present", object: "regular", copy, ...(yield* copyRegular(path, copy)) });
          continue;
        }
        if (object !== "directory") return yield* fail(unit.target, `is a ${object}, not a directory`);
        const mode = (yield* machine.permissions(path).pipe(Effect.mapError(snapshotError(unit.target)))).mode;
        const listed = yield* machine.listDirectory(path).pipe(Effect.mapError(snapshotError(unit.target)));
        const directoryEntries: Array<SnapshotDirectoryEntry> = [];
        for (const entry of listed) {
          const child = yield* machine.normalizePath({ path: entry.path, base: path }).pipe(Effect.mapError(snapshotError(unit.target)));
          if (entry.kind === "directory") {
            const childMode = (yield* machine.permissions(child).pipe(Effect.mapError(snapshotError(child.absolute)))).mode;
            directoryEntries.push({ path: entry.path, object: "directory", mode: childMode });
          } else if (entry.kind === "symlink") {
            directoryEntries.push({
              path: entry.path,
              object: "symlink",
              symlinkTo: yield* machine.readSymlink(child).pipe(Effect.mapError(snapshotError(child.absolute))),
            });
          } else if (entry.kind === "regular") {
            const copy = `${copyPath(unit.harness, unit.target)}/${entry.path}`;
            directoryEntries.push({ path: entry.path, object: "regular", copy, ...(yield* copyRegular(child, copy)) });
          } else {
            return yield* fail(child.absolute, `is a ${entry.kind}; Canonfig cannot back it up`);
          }
        }
        entries.push({ ...base, kind: "directory", state: "present", mode, entries: directoryEntries });
      }
      for (const [harness, values] of keys) {
        yield* write(`${harness}/keys.json`, new TextEncoder().encode(`${JSON.stringify(values, undefined, 2)}\n`));
      }
      const manifest: SnapshotManifest = { version: 1, snapshot: id, run, createdAt: createdAt.toISOString(), entries };
      yield* write("manifest.json", new TextEncoder().encode(`${JSON.stringify(manifest, undefined, 2)}\n`));
      yield* Effect.tryPromise({
        try: () => rename(directory, paths.join(backups, id)),
        catch: (error) => fail(paths.join(backups, id), String(error)),
      });
      return id;
    });
    return yield* capture.pipe(
      Effect.onError(() => Effect.tryPromise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.ignore)),
    );
  }).pipe(Effect.mapError((error) => error instanceof TakeoverSnapshotError ? error : snapshotError(backups)(error)));

/** Where a snapshot entry's copied bytes live. */
export const snapshotCopy = (snapshot: Snapshot, copy: string): string =>
  join(snapshot.directory, ...copy.split("/"));
