import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Schema } from "effect";
import { localProjectionFollower } from "../domain/synchronization.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import { withRunLock } from "../synchronization/run-lock.ts";
import { parseConfigDocument } from "../synchronization/config-codec.ts";
import { adapterFor } from "../projection/adapters/index.ts";
import { editAuthoringConfig, readAuthoringItem, writeAuthoringItems, type AuthoringTarget } from "../projection/authoring.ts";
import { CanonicalFolderError, decodeLocalConfig, loadCanonicalFolder } from "../projection/folder.ts";
import { NativePluginManifest, NATIVE_PLUGIN_HARNESSES, nativePluginDigest } from "../projection/native-plugin.ts";
import { rootContext } from "../projection/plan.ts";
import { ingestShield } from "../projection/shield-ingest.ts";
import { addNativePlugin, installerKind, redirectInstaller, shieldExecutable } from "../projection/shield-install.ts";
import { shieldPaths } from "../projection/shield.ts";

export type ShieldInput =
  | { readonly action: "status" }
  | { readonly action: "disable" }
  | { readonly action: "ingest" }
  | { readonly action: "enable"; readonly hard: boolean }
  | { readonly action: "install"; readonly argv: ReadonlyArray<string> }
  | { readonly action: "run"; readonly argv: ReadonlyArray<string> }
  | { readonly action: "review"; readonly id: string; readonly digest: string; readonly reviewer: string }
  | { readonly action: "exclude"; readonly id: string }
  | { readonly action: "include"; readonly id: string }
  | { readonly action: "add-plugin"; readonly directory: string; readonly harness: typeof NATIVE_PLUGIN_HARNESSES[number]; readonly entry?: string | undefined };

/** Read-only status works before setup and does not mistake policy selection for active enforcement. */
export const shieldStatus = Effect.fn("Shield.status")(function*(statePath: string) {
  const repository = yield* StateRepository;
  const configuration = yield* repository.getFollowerSynchronizationConfiguration();
  const folder = dirname(statePath);
  const policy = yield* Effect.tryPromise({
    try: async () => {
      const path = join(folder, "local", "local.jsonc");
      const text = await readFile(path, "utf8").catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return "{}";
        throw error;
      });
      return decodeLocalConfig(path, text);
    }, catch: (error) => new CanonicalFolderError({ path: folder, message: String(error) }),
  });
  const applied = yield* repository.loadAppliedResources(configuration?.follower.id ?? localProjectionFollower);
  const registries = applied.filter((record) => record.resource.startsWith("runtime:hooks:"));
  const projected = yield* Effect.tryPromise({
    try: async () => {
      for (const record of registries) {
        const text = await readFile(record.target, "utf8").catch((error) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
          throw error;
        });
        if (text === undefined) continue;
        const registry = Schema.decodeUnknownSync(Schema.Struct({ hooks: Schema.Array(Schema.Struct({ id: Schema.String })) }))(JSON.parse(text));
        if (registry.hooks.some((hook) => hook.id === "canonfig-shield")) return true;
      }
      return false;
    }, catch: (error) => new CanonicalFolderError({ path: folder, message: `Cannot read Shield hook registry: ${String(error)}` }),
  });
  return { enabled: policy.shield?.enabled ?? false, hard: policy.shield?.hard ?? false,
    scope: configuration === undefined ? "canonical" as const : "local" as const,
    destination: configuration === undefined ? folder : join(folder, "local"),
    projected,
    excludedPlugins: policy.excludePlugins ?? [],
    note: "Hooks apply after sync and client reload. Hard protection applies only to shield run. Mixed config files stay writable for native authentication." };
});

export const runShield = Effect.fn("Shield.command")(function*(statePath: string, input: ShieldInput) {
  const status = yield* shieldStatus(statePath);
  if (input.action === "status") return status;
  const folder = dirname(statePath);
  const target: AuthoringTarget = { folder, statePath, scope: status.scope };
  const local: AuthoringTarget = { ...target, scope: "local" };
  const machine = yield* MachineState;
  const repository = yield* StateRepository;
  const context = yield* rootContext((name) => process.env[name]);
  const loaded = yield* Effect.tryPromise({ try: () => loadCanonicalFolder(folder), catch: (error) => new CanonicalFolderError({ path: folder, message: String(error) }) });
  if (input.action === "enable" || input.action === "disable") {
    if (input.action === "enable" && input.hard) {
      if (context.platform !== "linux") return yield* new CanonicalFolderError({ path: folder, message: "Hard Shield requires Linux bubblewrap; macOS and Windows remain hook/instruction/ingestion only." });
      yield* machine.findExecutable({ name: "bwrap" });
    }
    const current = yield* readAuthoringItem(local, "local.jsonc");
    yield* editAuthoringConfig(local, current.digest, [{ path: ["shield"], value: { enabled: input.action === "enable", hard: input.action === "enable" && input.hard } }]);
    return { enabled: input.action === "enable", hard: input.action === "enable" && input.hard, next: "canonfig sync --apply; then reload running clients", published: false };
  }
  if (!status.enabled) return yield* new CanonicalFolderError({ path: folder, message: "Enable Shield first with 'canonfig shield enable'." });
  if (input.action === "include" || input.action === "exclude") {
    const current = yield* readAuthoringItem(local, "local.jsonc");
    const exclusions = input.action === "exclude" ? [...new Set([...status.excludedPlugins, input.id])] : status.excludedPlugins.filter((id) => id !== input.id);
    yield* editAuthoringConfig(local, current.digest, [{ path: ["excludePlugins"], value: exclusions }]);
    return { excludedPlugins: exclusions, next: "canonfig sync --apply" };
  }
  if (input.action === "review") {
    const path = `plugins/${input.id}`;
    const item = yield* readAuthoringItem(target, path);
    const manifestFile = item.files.find((file) => file.path === `${path}/plugin.jsonc`);
    if (manifestFile === undefined) return yield* new CanonicalFolderError({ path, message: "No plugin to review in the writable folder." });
    const manifest = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(NativePluginManifest)(parseConfigDocument("json", new TextDecoder().decode(manifestFile.content))),
      catch: (error) => new CanonicalFolderError({ path, message: String(error) }),
    });
    const digest = nativePluginDigest(manifest, item.files.map((file) => ({ ...file, path: file.path.slice(path.length + 1) })));
    if (input.digest !== digest) return yield* new CanonicalFolderError({ path, message: `Review digest changed. Inspect the package again; current digest is ${digest}.` });
    yield* writeAuthoringItems(target, [{ path, expectedDigest: item.digest, files: item.files.map((file) => file === manifestFile
      ? { ...file, content: new TextEncoder().encode(JSON.stringify({ ...manifest, review: { digest, reviewer: input.reviewer } }, null, 2) + "\n") } : file) }]);
    return { plugin: input.id, digest, reviewer: input.reviewer, published: false, next: "canonfig sync --apply" };
  }
  if (input.action === "add-plugin") return yield* addNativePlugin({ target, directory: input.directory, harness: input.harness, entry: input.entry });
  if (input.action === "install" || input.action === "run" && installerKind(input.argv) !== undefined) return yield* redirectInstaller({ target, context, loaded, argv: input.argv });
  if (input.action === "ingest") {
    const configuration = yield* repository.getFollowerSynchronizationConfiguration();
    const applied = yield* repository.loadAppliedResources(configuration?.follower.id ?? localProjectionFollower);
    return yield* withRunLock(statePath, "shield ingest", ingestShield({ target, context, loaded, applied }));
  }
  // A launcher owns its PATH shims and optional mount namespace, never a resident daemon.
  const temporary = yield* Effect.tryPromise({ try: () => mkdtemp(join(tmpdir(), "canonfig-shield-run-")), catch: (error) => new CanonicalFolderError({ path: folder, message: String(error) }) });
  return yield* Effect.gen(function*() {
    const node = process.execPath;
    const originalPath = process.env.PATH ?? "";
    for (const name of ["npx", "skills", "claude", "codex", "qwen"]) {
      const executable = yield* machine.findExecutable({ name }).pipe(Effect.option);
      if (executable._tag === "None") continue;
      const source = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const name = ${JSON.stringify(name)};
const skillsArgs = name === "npx" ? args.filter((arg) => arg !== "--yes" && arg !== "-y") : args;
const install = name === "skills" ? /^(add|install)$/.test(args[0] ?? "")
  : name === "npx" ? /^skills(?:@[a-zA-Z0-9.^~+-]+)?$/.test(skillsArgs[0] ?? "") && /^(add|install)$/.test(skillsArgs[1] ?? "")
  : args[0] === "mcp" && args[1] === "add"
    || name === "claude" && args[0] === "plugin" && (args[1] === "install" || args[1] === "marketplace" && args[2] === "add")
    || name === "qwen" && args[0] === "extensions" && /^(install|link)$/.test(args[1] ?? "");
const run = install ? ${JSON.stringify([node, ...process.execArgv, process.argv[1], "shield", "install", "--", executable.value.path.absolute])} : [${JSON.stringify(executable.value.path.absolute)}];
const result = spawnSync(run[0], [...run.slice(1), ...args], { stdio: "inherit", env: install ? { ...process.env, PATH: ${JSON.stringify(originalPath)} } : process.env });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
`;
      yield* Effect.tryPromise({ try: async () => {
        await writeFile(join(temporary, name), source, { mode: 0o700 });
        if (context.platform === "windows") {
          await writeFile(join(temporary, `${name}.cjs`), source, { mode: 0o600 });
          await writeFile(join(temporary, `${name}.cmd`), `@"${node}" "${join(temporary, name + ".cjs")}" %*\r\n`);
        }
      }, catch: (error) => new CanonicalFolderError({ path: temporary, message: String(error) }) });
    }
    const program = yield* shieldExecutable(input.argv[0]!);
    let executable = program;
    let args = input.argv.slice(1);
    if (status.hard) {
      if (context.platform !== "linux") return yield* new CanonicalFolderError({ path: folder, message: "Hard Shield requires Linux bubblewrap." });
      executable = (yield* machine.findExecutable({ name: "bwrap" })).path;
      const mounts: string[] = [];
      const mixed = new Set(loaded.model.harnesses.flatMap((harness) => adapterFor(harness).layout(context, loaded.model).surfaces
        .flatMap((surface) => surface.kind === "config" ? [surface.target, ...(surface.alternatives ?? [])] : [])));
      const files = new Set(loaded.model.harnesses.flatMap((harness) => adapterFor(harness).layout(context, loaded.model).surfaces
        .flatMap((surface) => surface.kind === "file" ? [surface.target] : [])));
      for (const path of shieldPaths(loaded.model, context)) {
        if (mixed.has(path)) continue;
        const present = yield* Effect.tryPromise({ try: () => lstat(path).then(() => true, (error) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
          throw error;
        }), catch: (error) => new CanonicalFolderError({ path, message: String(error) }) });
        if (!present && files.has(path)) continue;
        if (!present) yield* Effect.tryPromise({ try: () => mkdir(path, { recursive: true, mode: 0o700 }), catch: (error) => new CanonicalFolderError({ path, message: String(error) }) });
        mounts.push("--ro-bind", path, path);
      }
      args = ["--die-with-parent", "--unshare-pid", "--bind", "/", "/", "--proc", "/proc", "--cap-drop", "ALL", ...mounts, "--", program.absolute, ...args];
    }
    const result = yield* machine.runProcess({ executable, arguments: args,
      environment: [{ name: "PATH", value: `${temporary}${delimiter}${originalPath}` }],
      timeoutMilliseconds: 300000, maximumOutputBytes: 8 * 1024 * 1024 });
    if (result.exitCode !== 0) return yield* new CanonicalFolderError({ path: folder, message: `Shield command exited ${result.exitCode}: ${new TextDecoder().decode(result.standardError)}` });
    return { exitCode: result.exitCode, stdout: new TextDecoder().decode(result.standardOutput), stderr: new TextDecoder().decode(result.standardError), hard: status.hard };
  }).pipe(Effect.ensuring(Effect.promise(() => rm(temporary, { recursive: true, force: true }))));
});
