import { readdir, readFile, rm } from "node:fs/promises";
import { join, posix, win32 } from "node:path";

import { Effect, Schema } from "effect";

import { ContentDigest } from "../domain/brand.ts";
import type { RunId } from "../domain/brand.ts";
import { ConfigValue } from "../domain/resource.ts";
import { TaggedError } from "../domain/tagged-error.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import type { MachinePath } from "../machine/machine-state.types.ts";
import { getConfigPath, parseConfigDocument } from "../synchronization/config-codec.ts";
import type { ConfigFormat } from "./harness.ts";

/**
 * Takeover snapshots: the content a harness surface held before Canonfig
 * first wrote it, under `~/.canonfig/.backups/<UTC>/`.
 *
 * Each snapshot has `manifest.json` and one directory per harness holding the
 * copied files at their path relative to the home directory, plus `keys.json`
 * with the prior values of the config keys taken over (never the whole file,
 * so credentials sharing that file never enter a backup). Directories are
 * created 0700 and files 0600 through the protected machine writer.
 */

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

/** Prior config key values: harness, then target, then key path. */
const KeyValues = Schema.Record(Schema.String, Schema.Record(Schema.String, ConfigValue));

export interface Snapshot {
  readonly id: string;
  readonly directory: string;
  readonly manifest: SnapshotManifest;
  /** `harness`, then target path, then key path, to the prior value. */
  readonly keys: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, ConfigValue>>>;
}

const snapshotName = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?$/u;

/** Wrap a typed failure (machine, schema) with the path it concerns. */
const snapshotError = (path: string) => (error: { readonly message: string }) =>
  new TakeoverSnapshotError({ path, message: error.message });

/** Snapshot ids, oldest first. Names sort chronologically. */
export const listSnapshots = (backups: string): Effect.Effect<ReadonlyArray<string>, TakeoverSnapshotError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return (await readdir(backups)).filter((name) => snapshotName.test(name)).sort();
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
      }
    },
    catch: (error) => new TakeoverSnapshotError({ path: backups, message: String(error) }),
  });

/** Remove one snapshot directory and everything in it. */
export const deleteSnapshot = (backups: string, id: string): Effect.Effect<void, TakeoverSnapshotError> =>
  Effect.tryPromise({
    try: () => rm(join(backups, id), { recursive: true, force: true }),
    catch: (error) => new TakeoverSnapshotError({ path: join(backups, id), message: String(error) }),
  });

/**
 * Keep the first snapshot, the state before Canonfig ever wrote, and the four
 * most recent. Called after a run that wrote a new snapshot did not roll back.
 */
export const pruneSnapshots = (backups: string): Effect.Effect<ReadonlyArray<string>, TakeoverSnapshotError> =>
  Effect.gen(function*() {
    const snapshots = yield* listSnapshots(backups);
    const pruned = snapshots.slice(1, Math.max(1, snapshots.length - 4));
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
    const keys = new Map<string, Map<string, Map<string, ConfigValue>>>();
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

const isNotFound = (error: { readonly message: string }) => /\b(?:ENOENT|ENOTDIR)\b/u.test(error.message);

/**
 * Copy every unit's prior state into a new snapshot and return its id.
 * Nothing outside the units' targets is read.
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
    const existing = yield* listSnapshots(backups);
    const createdAt = new Date();
    const base = createdAt.toISOString().replaceAll(":", "-").replace(".", "-");
    let id = base;
    for (let suffix = 1; existing.includes(id); suffix += 1) id = `${base}-${suffix}`;
    const directory = paths.join(backups, id);
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

    yield* ensure(directory);
    const entries: Array<SnapshotEntry> = [];
    const keys = new Map<string, Record<string, Record<string, ConfigValue>>>();
    for (const unit of units) {
      const base = { harness: unit.harness, surface: unit.surface, root: unit.root, target: unit.target };
      const path = yield* at(unit.target);
      const object = yield* inspect(path);
      if (unit.kind === "config") {
        const format = unit.format!;
        const key = unit.key!;
        let value: ConfigValue | undefined;
        if (object === "regular") {
          const bytes = yield* machine.readFile({ path, maximumBytes: 8 * 1024 * 1024 }).pipe(Effect.mapError(snapshotError(unit.target)));
          const document = yield* Effect.try({
            try: () => parseConfigDocument(format, new TextDecoder().decode(bytes)),
            catch: (error) => fail(unit.target, `cannot read the owned keys: ${String(error)}`),
          });
          const current = getConfigPath(document, key);
          value = current === undefined
            ? undefined
            : yield* Schema.decodeUnknownEffect(ConfigValue)(current).pipe(
              Effect.mapError(() => fail(unit.target, `${key} holds a value Canonfig cannot store (null)`)),
            );
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
    return id;
  }).pipe(Effect.mapError((error) => error instanceof TakeoverSnapshotError ? error : snapshotError(backups)(error)));

/** Where a snapshot entry's copied bytes live. */
export const snapshotCopy = (snapshot: Snapshot, copy: string): string =>
  join(snapshot.directory, ...copy.split("/"));
