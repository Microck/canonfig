import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Effect, Schema } from "effect";
import { applyEdits, modify } from "jsonc-parser";
import { TaggedError } from "../domain/tagged-error.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { withRunLock } from "../synchronization/run-lock.ts";
import { AUTHORING_ENTRIES, LOCAL_CATEGORIES, decodeFolderConfig, decodeLocalConfig, listFolderFiles, loadCanonicalFiles, type FolderFile } from "./folder.ts";
import { projectResources, rootContext } from "./plan.ts";

export class AuthoringConflict extends TaggedError<AuthoringConflict>()("AuthoringConflict", {
  path: Schema.String, message: Schema.String,
}) {}
export class AuthoringInvalid extends TaggedError<AuthoringInvalid>()("AuthoringInvalid", {
  path: Schema.String, message: Schema.String,
}) {}

export interface AuthoringTarget {
  readonly folder: string;
  readonly scope: "canonical" | "local";
  /** Use the same state location as sync, overlays and restore. */
  readonly statePath: string;
}
export interface AuthoringFile extends FolderFile {
  readonly path: string;
  readonly digest: string;
}
export interface AuthoringItem {
  readonly path: string;
  /** null means the item does not exist, including for create preconditions. */
  readonly digest: string | null;
  /** Paths are relative to the target folder, including skills/<name>/... */
  readonly files: ReadonlyArray<AuthoringFile>;
}
export interface AuthoringChange {
  readonly path: string;
  readonly expectedDigest: string | null;
  /** An empty list deletes the item. A skill's list is its complete desired tree. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: Uint8Array; readonly executable: boolean }>;
}
export interface AuthoringConfigEdit {
  readonly path: ReadonlyArray<string | number>;
  /** undefined removes a key; null is a JSON null and is validated normally. */
  readonly value: Schema.Json | undefined;
}

/** Total authored bytes, including canonical and local files, that the shared reader admits. */
export const maximumAuthoringBytes = 128 * 1024 * 1024;
const digest = (content: Uint8Array) => createHash("sha256").update(content).digest("hex");
const validPath = (path: string) => path.length > 0 && !path.includes("\\") && !path.includes("\0") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const configurationKeys: Readonly<Record<string, true>> = Object.fromEntries(["harnesses", "surfaces", "mcp", "hooks", "settings", "tools", "credentials", "groups", "scheduleDefault", "local", "resources", "profile"].map((key) => [key, true]));
const localKeys: Readonly<Record<string, true>> = Object.fromEntries(["mcp", "settings", "excludeHarnesses", "excludeResources", "overlays", "backups"].map((key) => [key, true]));
const invalid = (path: string, message: string) => new AuthoringInvalid({ path, message });
const conflict = (path: string) => new AuthoringConflict({ path, message: `${path} changed since it was read. Reload it before saving; no authoring files were written.` });

/** File items plus whole skill directories are the write unit, never arbitrary filesystem paths. */
const itemPath = (path: string, scope: AuthoringTarget["scope"]): boolean => {
  if (!validPath(path)) return false;
  if (path === "AGENTS.md" || path === (scope === "canonical" ? "canonfig.jsonc" : "local.jsonc")) return true;
  if (/^(rules|agents|commands)\/[A-Za-z0-9][A-Za-z0-9_-]*\.md$/u.test(path)) return true;
  if (/^skills\/[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(path)) return true;
  return scope === "canonical" && /^(hooks|files)\/.+/u.test(path);
};

const itemFrom = (path: string, files: ReadonlyMap<string, FolderFile>): AuthoringItem => {
  const tree = path.startsWith("skills/");
  const selected = [...files].filter(([name]) => name === path || (tree && name.startsWith(`${path}/`)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, file]) => ({ ...file, path: name, digest: digest(file.content) }));
  return {
    path,
    digest: selected.length === 0 ? null : digest(Buffer.from(JSON.stringify(selected.map(({ path, digest, executable }) => [path, digest, executable])))),
    files: selected,
  };
};

/** Reads only authoring entries, through MachineState's no-follow bounded reader. */
const readFiles = Effect.fn("Authoring.readFiles")(function*(folder: string) {
  const machine = yield* MachineState;
  const root = yield* Effect.tryPromise({ try: () => realpath(folder), catch: (error) => invalid(folder, String(error)) });
  const anchor = yield* machine.normalizePath({ path: root });
  const files = new Map<string, FolderFile>();
  const names = yield* Effect.tryPromise({
    try: async () => {
      const entries: Array<{ path: string; executable: boolean }> = [];
      // listFolderFiles handles missing entries and refuses symlinks and special files.
      for (const directory of [...AUTHORING_ENTRIES.filter((entry) => !entry.includes(".")), "local"]) {
        for (const file of await listFolderFiles(root, directory)) entries.push({ ...file, path: `${directory}/${file.path}` });
      }
      return entries;
    },
    catch: (error) => invalid(folder, String(error)),
  });
  for (const path of ["canonfig.jsonc", "AGENTS.md"]) {
    const observed = yield* Effect.tryPromise({
      try: () => lstat(join(root, path)).catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }),
      catch: (error) => invalid(path, String(error)),
    });
    if (observed !== undefined) {
      if (!observed.isFile()) return yield* Effect.fail(invalid(path, "Authoring input must be a regular file."));
      names.push({ path, executable: (observed.mode & 0o100) !== 0 });
    }
  }
  let remaining = maximumAuthoringBytes;
  for (const entry of names) {
    const path = yield* machine.normalizePath({ path: join(root, entry.path) });
    const content = yield* machine.readFile({ path, anchor, maximumBytes: remaining });
    remaining -= content.length;
    files.set(entry.path, { content, executable: entry.executable });
  }
  return { root, files };
});

const scopedFiles = (target: AuthoringTarget, files: ReadonlyMap<string, FolderFile>) => new Map(
  [...files].filter(([path]) => target.scope === "local" ? path.startsWith("local/") : !path.startsWith("local/"))
    .map(([path, file]) => [target.scope === "local" ? path.slice(6) : path, file]),
);

export const readAuthoringItems = Effect.fn("Authoring.readItems")(function*(target: AuthoringTarget) {
  const { files } = yield* readFiles(target.folder);
  const scoped = scopedFiles(target, files);
  const paths = new Set([...scoped.keys()].map((path) => path.startsWith("skills/") ? path.split("/").slice(0, 2).join("/") : path));
  return [...paths].sort().map((path) => itemFrom(path, scoped));
});

export const readAuthoringItem = Effect.fn("Authoring.readItem")(function*(target: AuthoringTarget, path: string) {
  if (!itemPath(path, target.scope)) return yield* Effect.fail(invalid(path, "Not an editable folder item."));
  const { files } = yield* readFiles(target.folder);
  return itemFrom(path, scopedFiles(target, files));
});

const prepareChanges = (target: AuthoringTarget, files: Map<string, FolderFile>, changes: ReadonlyArray<AuthoringChange>) => {
  const scoped = scopedFiles(target, files);
  const candidate = new Map(files);
  const changed = new Set<string>();
  const configBytes = files.get("canonfig.jsonc")?.content;
  const allow = configBytes === undefined ? [] : decodeFolderConfig("canonfig.jsonc", new TextDecoder().decode(configBytes)).local?.allow ?? [];
  for (const change of changes) {
    if (!itemPath(change.path, target.scope) || changed.has(change.path)) throw invalid(change.path, "Invalid or repeated folder item.");
    changed.add(change.path);
    const previous = itemFrom(change.path, scoped);
    if (previous.digest !== change.expectedDigest) throw conflict(change.path);
    if (target.scope === "local" && change.path !== "local.jsonc") {
      const category = change.path === "AGENTS.md" ? "instructions" : change.path.split("/")[0];
      if (!LOCAL_CATEGORIES.some((known) => known === category && allow.includes(known)) && change.files.some((file) => {
        const prior = scoped.get(file.path);
        return prior === undefined || prior.executable !== file.executable || digest(prior.content) !== digest(file.content);
      })) {
        throw invalid(change.path, `The Source does not allow local ${category}. Change local.allow on the Source first.`);
      }
    }
    const prefix = target.scope === "local" ? "local/" : "";
    for (const file of previous.files) candidate.delete(prefix + file.path);
    const seen = new Set<string>();
    for (const file of change.files) {
      if (!validPath(file.path) || seen.has(file.path) || (change.path.startsWith("skills/") ? !file.path.startsWith(`${change.path}/`) : file.path !== change.path)) {
        throw invalid(file.path, "A changed file must belong to its item exactly once.");
      }
      seen.add(file.path);
      candidate.set(prefix + file.path, { content: file.content, executable: file.executable });
    }
  }
  if (target.scope === "local") {
    const local = candidate.get("local/local.jsonc");
    if (local !== undefined) {
      // Retained entries may be ignored by a narrowed Source policy; only new or changed entries need permission.
      const next = decodeLocalConfig("local/local.jsonc", new TextDecoder().decode(local.content));
      const previousBytes = files.get("local/local.jsonc")?.content;
      const previous = previousBytes === undefined ? {} : decodeLocalConfig("local/local.jsonc", new TextDecoder().decode(previousBytes));
      for (const category of ["mcp", "settings"] as const) {
        if (!allow.includes(category) && Object.entries(next[category] ?? {}).some(([name, entry]) =>
          !isDeepStrictEqual(entry, previous[category]?.[name]))) {
          throw invalid("local/local.jsonc", `The Source does not allow local ${category}.`);
        }
      }
    }
  }
  let remaining = maximumAuthoringBytes;
  for (const file of candidate.values()) {
    remaining -= file.content.byteLength;
    if (remaining < 0) throw invalid(target.folder, `Authoring files exceed the ${maximumAuthoringBytes} byte total limit.`);
  }
  return candidate;
};

/** All candidates validate before the first write. Each file publishes atomically; a tree is not a filesystem transaction. */
export const writeAuthoringItems = Effect.fn("Authoring.writeItems")(function*(target: AuthoringTarget, changes: ReadonlyArray<AuthoringChange>) {
  const machine = yield* MachineState;
  const { root, files } = yield* readFiles(target.folder);
  const candidate = yield* Effect.try({
    try: () => prepareChanges(target, files, changes),
    catch: (error) => error instanceof AuthoringConflict || error instanceof AuthoringInvalid ? error : invalid(target.folder, String(error)),
  });
  const loaded = yield* Effect.tryPromise({ try: () => loadCanonicalFiles(root, candidate), catch: (error) => invalid(target.folder, String(error)) });
  if (target.scope === "canonical" && loaded.authoredResources.length > 0) {
    // Local exclusions affect projection, never the validity of authored resources.
    const context = yield* rootContext((name) => process.env[name]);
    yield* projectResources({ ...loaded.model, resources: loaded.authoredResources }, context, join(root, "canonfig.jsonc"));
  }
  // Re-read after validation: hand edits and changed policy during validation must not be overwritten.
  const current = yield* readFiles(root);
  if (files.size !== current.files.size || [...files].some(([path, file]) => {
    const now = current.files.get(path);
    return now === undefined || file.executable !== now.executable || digest(file.content) !== digest(now.content);
  })) return yield* Effect.fail(conflict(target.folder));
  const anchor = yield* machine.normalizePath({ path: root });
  const directories = new Set<string>();
  for (const name of files.keys()) {
    if (candidate.has(name)) continue;
    const path = yield* machine.normalizePath({ path: join(root, name) });
    yield* machine.mutateWithinRoot({ root: anchor, path, mutation: { kind: "remove" } });
    let parent = dirname(name);
    while (parent !== "." && parent !== "local") { directories.add(parent); parent = dirname(parent); }
  }
  for (const name of [...directories].sort((a, b) => b.length - a.length)) {
    if ([...candidate.keys()].some((path) => path.startsWith(`${name}/`))) continue;
    const path = yield* machine.normalizePath({ path: join(root, name) });
    yield* machine.removeEmptyDirectory({ path });
  }
  for (const [name, file] of candidate) {
    const prior = files.get(name);
    if (prior !== undefined && prior.executable === file.executable && digest(prior.content) === digest(file.content)) continue;
    const path = yield* machine.normalizePath({ path: join(root, name) });
    const parents = name.split("/").slice(0, -1);
    for (let depth = 1; depth <= parents.length; depth++) {
      const parent = yield* machine.normalizePath({ path: join(root, ...parents.slice(0, depth)) });
      const exists = yield* Effect.tryPromise({
        try: () => lstat(parent.absolute).catch((error) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
          throw error;
        }),
        catch: (error) => invalid(parent.absolute, String(error)),
      });
      if (exists !== undefined && !exists.isDirectory()) return yield* Effect.fail(invalid(parent.absolute, "An authoring parent must be a real directory."));
      if (exists === undefined) yield* machine.ensureDirectory({ path: parent, mode: 0o700 });
    }
    yield* machine.atomicWrite({ path, anchor, content: file.content, mode: file.executable ? 0o700 : 0o600, noReplace: prior === undefined });
  }
  const scoped = scopedFiles(target, candidate);
  return changes.map(({ path }) => itemFrom(path, scoped));
}, (effect, target) => withRunLock(target.statePath, "author folder", effect));

export const editAuthoringConfig = Effect.fn("Authoring.editConfig")(function*(target: AuthoringTarget, expectedDigest: string | null, edits: ReadonlyArray<AuthoringConfigEdit>, changes: ReadonlyArray<AuthoringChange> = []) {
  const path = target.scope === "canonical" ? "canonfig.jsonc" : "local.jsonc";
  const current = yield* readAuthoringItem(target, path);
  if (current.digest !== expectedDigest) return yield* Effect.fail(conflict(path));
  const content = yield* Effect.try({
    try: () => {
      let text = current.files[0] === undefined ? (target.scope === "canonical" ? '{\n  "version": 1,\n  "harnesses": []\n}\n' : "{}\n") : new TextDecoder("utf-8", { fatal: true }).decode(current.files[0].content);
      for (const edit of edits) {
        const first = edit.path[0];
        if (!Schema.is(Schema.String)(first) || (target.scope === "canonical" ? configurationKeys : localKeys)[first] !== true) throw invalid(path, "Only declared configuration keys can be edited.");
        text = applyEdits(text, modify(text, [...edit.path], edit.value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }));
      }
      return new TextEncoder().encode(text);
    },
    catch: (error) => error instanceof AuthoringInvalid ? error : invalid(path, String(error)),
  });
  return yield* writeAuthoringItems(target, [...changes, { path, expectedDigest, files: [{ path, content, executable: false }] }]);
});
