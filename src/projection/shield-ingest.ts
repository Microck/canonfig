import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { Effect, Schema } from "effect";
import { formatConfigPath } from "../domain/config-path.ts";
import type { AppliedResourceRecord } from "../domain/synchronization.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { sha256BytesHex } from "../profile/profile-codec.ts";
import { editConfigText, getConfigPath, parseConfigDocument } from "../synchronization/config-codec.ts";
import { readAuthoringItems, writeAuthoringItemsLocked, type AuthoringChange, type AuthoringTarget } from "./authoring.ts";
import { CanonicalFolderError, type LoadedFolder } from "./folder.ts";
import type { RootContext } from "./harness.ts";
import { scanImports, readImportContent, type ImportCandidate } from "./import.ts";
import { NativePluginManifest, nativePluginDigest } from "./native-plugin.ts";
import { nativeInstallChange, scanNativeInstalls } from "./shield-plugins.ts";
import { homeRelative, recordShieldLog } from "./shield-log.ts";

const failure = (path: string, message: string) => new CanonicalFolderError({ path, message: `Shield: ${message}` });

/** An existing managed item is drift, never a newly installed item to adopt. */
const wasManaged = (candidate: ImportCandidate, records: ReadonlyArray<AppliedResourceRecord>, loaded: LoadedFolder): boolean => {
  if (candidate.category === "mcp") return loaded.model.mcp.some(([name]) => name === candidate.name);
  return records.some((record) => {
    if (candidate.path === record.target) return record.ownership !== "DirectoryEntries";
    if (record.ownership !== "DirectoryEntries") return false;
    const part = relative(record.target, candidate.path).split(sep).join("/");
    return record.ownedFiles.some((entry) => entry.path === part || entry.path.startsWith(`${part}/`));
  });
};

/** Caller holds the sync lock. Read, validate and admit the whole batch before removing any foreign entry. */
export const ingestShield = Effect.fn("Shield.ingest")(function*(input: {
  readonly target: AuthoringTarget;
  readonly context: RootContext;
  readonly loaded: LoadedFolder;
  readonly applied: ReadonlyArray<AppliedResourceRecord>;
  /** Installer staging homes are also admitted through this same reader. */
  readonly installer?: boolean;
}) {
  const { target, context, loaded } = input;
  if (!loaded.local.shield?.enabled) return { imported: [], warnings: [] };
  const machine = yield* MachineState;
  const native = yield* Effect.tryPromise({
    try: () => scanNativeInstalls(context, loaded.model, input.applied),
    catch: (error) => failure(target.folder, String(error)),
  });
  const scan = yield* Effect.tryPromise({
    try: () => scanImports({ context, harnesses: loaded.model.harnesses, folder: target.folder }),
    catch: (error) => failure(target.folder, String(error)),
  });
  const candidates = [...new Map(scan.candidates.filter((candidate) =>
    !native.roots.some((root) => candidate.path === root || candidate.path.startsWith(root + sep))
    && (!wasManaged(candidate, input.applied, loaded) || input.installer))
    .map((candidate) => [`${candidate.path}\0${candidate.name}`, candidate])).values()];
  if (candidates.length === 0 && native.installs.length === 0) return { imported: [], warnings: scan.skipped.map((entry) => `${entry.path}: ${entry.reason}`) };
  const items = yield* readAuthoringItems(target);
  const changes = new Map<string, AuthoringChange>();
  const sources: Array<ImportCandidate> = [];
  const plugins: Array<{ install: typeof native.installs[number]; digest: string; target: string }> = [];
  for (const install of native.installs) {
    const admission = yield* Effect.tryPromise({ try: () => nativeInstallChange(install, context.platform), catch: (error) => failure(install.path, String(error)) });
    const previous = changes.get(admission.change.path) ?? items.find((item) => item.path === admission.change.path);
    if (previous !== undefined) {
      const priorDigest = yield* Effect.try({
        try: () => {
          const files = previous.files.map((file) => ({ ...file, path: file.path.slice(admission.change.path.length + 1) }));
          const manifestFile = files.find((file) => file.path === "plugin.jsonc");
          if (manifestFile === undefined) throw new Error("missing plugin.jsonc");
          const manifest = Schema.decodeUnknownSync(NativePluginManifest)(parseConfigDocument("json", new TextDecoder().decode(manifestFile.content)));
          return nativePluginDigest(manifest, files);
        }, catch: (error) => failure(install.path, String(error)),
      });
      if (priorDigest !== admission.digest) return yield* failure(install.path, `${admission.change.path} has different canonical code; review a deliberate update, nothing was replaced`);
    } else changes.set(admission.change.path, admission.change);
    plugins.push({ install, digest: admission.digest, target: admission.change.path });
  }
  const configPath = target.scope === "local" ? "local.jsonc" : "canonfig.jsonc";
  const configItem = items.find((item) => item.path === configPath);
  const configBefore = configItem?.files[0]?.content;
  let config = configBefore === undefined ? "{}\n" : new TextDecoder().decode(configBefore);
  for (const candidate of candidates) {
    if (candidate.secrets.length > 0) return yield* failure(candidate.path, `move ${candidate.name}'s credentials to the named environment references before ingestion; no credential literal was copied`);
    const content = yield* Effect.tryPromise({ try: () => readImportContent(candidate, context, target.folder), catch: (error) => failure(candidate.path, String(error)) });
    if (content.kind === "mcp") {
      const key = formatConfigPath(["mcp", candidate.name]);
      const previous = getConfigPath(parseConfigDocument("json", config), key);
      const server = Schema.decodeUnknownSync(Schema.MutableJson)(content.server);
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(server)) return yield* failure(configPath, `${candidate.name} collides with an existing MCP entry; review it and choose a Local Overlay or a different name`);
      config = editConfigText("json", config, { sets: [{ path: key, value: server }] });
    } else {
      const files = content.kind === "tree" ? content.files.map((file) => ({ ...file, path: `${candidate.target}/${file.path}` }))
        : [{ path: candidate.target, content: new TextEncoder().encode(content.content), executable: false }];
      const previous = items.find((item) => item.path === candidate.target);
      const pending = changes.get(candidate.target);
      const existing = pending?.files ?? previous?.files;
      if (existing !== undefined && (existing.length !== files.length || files.some((file) => {
        const prior = existing.find((entry) => entry.path === file.path);
        return prior === undefined || prior.executable !== file.executable || sha256BytesHex(prior.content) !== sha256BytesHex(file.content);
      }))) return yield* failure(candidate.path, `${candidate.target} has different canonical content; nothing was replaced`);
      if (previous === undefined) changes.set(candidate.target, { path: candidate.target, expectedDigest: null, files });
      // Never remove through a linked ancestor; unlinking the skill itself is safe.
      const parent = yield* Effect.tryPromise({ try: () => realpath(dirname(candidate.path)), catch: (error) => failure(candidate.path, String(error)) });
      if (parent !== dirname(candidate.path)) return yield* failure(candidate.path, "the native path has a linked parent; replace it with a real directory before ingestion");
    }
    sources.push(candidate);
  }
  if (config !== (configBefore === undefined ? "{}\n" : new TextDecoder().decode(configBefore))) {
    changes.set(configPath, { path: configPath, expectedDigest: configItem?.digest ?? null,
      files: [{ path: configPath, content: new TextEncoder().encode(config), executable: false }] });
  }
  if (changes.size > 0) yield* writeAuthoringItemsLocked(target, [...changes.values()]);
  for (const plugin of plugins) {
    yield* Effect.tryPromise({
      try: async () => {
        const current = await nativeInstallChange(plugin.install, context.platform);
        if (current.digest !== plugin.digest) throw new Error("native package changed after admission");
      }, catch: (error) => failure(plugin.install.path, `canonical copy saved, but native cleanup refused: ${String(error)}`),
    });
    // Disable the old cache identity so the harness cannot fetch it again before review.
    const disable = plugin.install.disable;
    if (disable !== undefined) {
      const text = yield* Effect.tryPromise({ try: () => readFile(disable.path, "utf8").catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }), catch: (error) => failure(disable.path, String(error)) });
      if (text !== undefined) {
        const updated = editConfigText(disable.format, text, { sets: [{ path: disable.key, value: false }] });
        yield* machine.atomicWrite({ path: yield* machine.normalizePath({ path: disable.path }), anchor: yield* machine.normalizePath({ path: context.home }), content: new TextEncoder().encode(updated), mode: 0o600 });
      }
    }
    yield* Effect.tryPromise({ try: () => rm(plugin.install.path, { recursive: true }), catch: (error) => failure(plugin.install.path, `canonical copy saved, native cleanup failed: ${String(error)}`) });
  }
  // Copies are durable before cleanup. A failed cleanup leaves the admitted copy and reports the source.
  // Config keys stay for the normal three-way planner; matching desired values are adopted, never force-written.
  const removals = yield* Effect.tryPromise({
    try: async () => Promise.all(sources.filter((entry) => entry.category !== "mcp").map(async (candidate) => {
      await readImportContent(candidate, context, target.folder);
      return { candidate, stat: await lstat(candidate.path) };
    })), catch: (error) => failure(target.folder, `canonical copies saved, native cleanup refused: ${String(error)}`),
  });
  // Remove aliases before their shared targets; every source was rechecked while both still existed.
  removals.sort((left, right) => Number(right.stat.isSymbolicLink()) - Number(left.stat.isSymbolicLink()));
  for (const { candidate, stat } of removals) {
    yield* Effect.tryPromise({
      try: async () => {
        if (stat.isSymbolicLink()) await rm(candidate.path);
        else {
          const anchor = await realpath(dirname(candidate.path));
          if (anchor !== dirname(candidate.path)) throw new Error("native parent changed during ingestion");
          await rm(candidate.path, { recursive: stat.isDirectory() });
        }
      },
      catch: (error) => failure(candidate.path, `canonical copy saved, but native cleanup failed: ${String(error)}`),
    });
  }
  // A receipt contains only paths and hashes, never native configuration or credential bytes.
  const receipt = { at: new Date().toISOString(), scope: target.scope, items: [...sources.map(({ path, target, digest }) => ({ path, target, digest })), ...plugins.map(({ install, target, digest }) => ({ path: install.path, target, digest }))] };
  const root = yield* machine.normalizePath({ path: target.folder });
  const directory = yield* machine.normalizePath({ path: join(target.folder, ".shield") });
  yield* machine.ensureDirectory({ path: directory, mode: 0o700 });
  const path = yield* machine.normalizePath({ path: join(directory.absolute, "last-ingestion.json") });
  yield* machine.atomicWrite({ path, anchor: root, content: new TextEncoder().encode(JSON.stringify(receipt, null, 2) + "\n"), mode: 0o600 });
  // Installer staging homes are logged once by `shield install` with the installer's kind; this logs what sync found.
  if (input.installer !== true) {
    const at = receipt.at;
    const entries = [
      ...sources.map((entry) => ({ at, kind: "ingested" as const, path: homeRelative(entry.path, context.home), item: entry.category === "mcp" ? `mcp/${entry.name}` : entry.target })),
      ...plugins.map((entry) => ({ at, kind: "ingested" as const, path: homeRelative(entry.install.path, context.home), item: entry.target })),
    ];
    yield* recordShieldLog(target.folder, entries);
  }
  return { imported: [...new Set([...sources.map((entry) => entry.target), ...plugins.map((entry) => entry.target)])], warnings: scan.skipped.map((entry) => `${entry.path}: ${entry.reason}`) };
});
