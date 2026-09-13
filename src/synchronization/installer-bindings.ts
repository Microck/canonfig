import { realpath } from "node:fs/promises";
import { Effect } from "effect";
import {
  installerBindingFor,
  installerMethods,
  isLocalInstallerPath,
  normalizeInstallerMethod,
  parseInstallerBinding,
  type InstallerBinding,
} from "../domain/installer-binding.ts";
import { HumanActionRequiredError, type MachineStateError } from "../machine/machine-state.errors.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import type { MachinePath } from "../machine/machine-state.types.ts";

const unavailable = (recovery: string) => new HumanActionRequiredError({
  action: "configure the local installer binding", recovery,
});

const methodFor = (method: string) => Effect.try({
  try: () => normalizeInstallerMethod(method),
  catch: () => unavailable("Select a supported installer method."),
});

const pathsFor = (method: string) => Effect.gen(function*() {
  const machine = yield* MachineState;
  const normalized = yield* methodFor(method);
  const directories = yield* machine.userDirectories();
  const root = yield* machine.normalizePath({ path: ".canonfig/installers", base: directories.home });
  const path = yield* machine.normalizePath({ path: `${normalized}.json`, base: root });
  const tombstone = yield* machine.normalizePath({ path: `${normalized}.removed.json`, base: root });
  // Every segment below the home directory is a literal, so containment is
  // structural. Checking it would also lstat a home that need not exist yet,
  // which is the normal state of a machine that has bound no installer.
  return { root, path, tombstone, method: normalized, platform: directories.home.platform };
});

const inspectOptional = (path: MachinePath) => Effect.gen(function*() {
  const machine = yield* MachineState;
  return yield* machine.inspectPath(path).pipe(Effect.catchTag("MachineFilesystemError", (error) =>
    /\b(?:ENOENT|ENOTDIR)\b/u.test(error.message) ? Effect.succeed(undefined) : Effect.fail(error)
  ));
});

export const loadInstallerBinding = (method: string): Effect.Effect<InstallerBinding | undefined, MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const paths = yield* pathsFor(method);
    const rootKind = yield* inspectOptional(paths.root);
    if (rootKind === undefined) return undefined;
    if (rootKind.kind !== "directory") return yield* unavailable("The installer binding directory must not be a symbolic link or special file.");
    const kind = yield* inspectOptional(paths.path);
    if (kind === undefined) return undefined;
    if (kind.kind !== "regular") return yield* unavailable("The installer binding must be a regular file.");
    const bytes = yield* machine.readFile({ path: paths.path, maximumBytes: 16 * 1024 });
    const binding = yield* Effect.try({
      try: () => parseInstallerBinding(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      catch: () => unavailable("The local installer binding is invalid; review and replace it with installer set."),
    });
    if (binding.method !== paths.method || binding.platform !== paths.platform) {
      return yield* unavailable("The installer binding belongs to a different method or platform; configure it on this machine.");
    }
    return binding;
  });

const inspectBindingFiles = (binding: InstallerBinding) => Effect.gen(function*() {
  const machine = yield* MachineState;
  const executable = yield* machine.normalizePath({ path: binding.executable });
  for (const value of [binding.executable, ...binding.arguments]) {
    const path = yield* machine.normalizePath({ path: value });
    const kind = yield* inspectOptional(path);
    if (kind?.kind !== "regular") return yield* unavailable("A bound executable or entrypoint is missing or no longer a regular file; configure the binding again.");
  }
  // Windows does not use Unix execute-permission bits to authorize a program.
  if (executable.platform !== "windows" && !(yield* machine.permissions(executable)).executableByOwner) {
    return yield* unavailable("The bound installer executable is not executable by the current user.");
  }
  return executable;
});

export const checkInstallerBinding = (binding: InstallerBinding) => Effect.gen(function*() {
  const machine = yield* MachineState;
  const executable = yield* inspectBindingFiles(binding);
  const result = yield* machine.runProcess({
    executable, arguments: [...binding.arguments, "--version"],
    timeoutMilliseconds: 5_000, maximumOutputBytes: 16 * 1024,
  });
  if (result.exitCode !== 0) return yield* unavailable("The exact bound installer failed its bounded --version check. Inspect it locally; no package was installed.");
  return { binding, verified: true as const, scope: "current-process" as const };
});

export const saveInstallerBinding = (
  method: string, executable: string, arguments_: ReadonlyArray<string>,
): Effect.Effect<InstallerBinding, MachineStateError, MachineState> => Effect.gen(function*() {
  const machine = yield* MachineState;
  const paths = yield* pathsFor(method);
  if (!isLocalInstallerPath(executable, paths.platform)
    || arguments_.some((argument) => !isLocalInstallerPath(argument, paths.platform))) {
    return yield* unavailable("Installer bindings require explicit local absolute paths.");
  }
  // Resolve existing links once and retain their actual target. No path is
  // inferred from an npm package name or copied from the Source Machine.
  const resolved = yield* Effect.tryPromise({
    try: async () => ({
      executable: await realpath(executable),
      arguments: await Promise.all(arguments_.map((argument) => realpath(argument))),
    }),
    catch: () => unavailable("The selected installer executable or entrypoint cannot be resolved."),
  });
  const binding = yield* Effect.try({
    try: () => installerBindingFor(paths.method, paths.platform, resolved.executable, resolved.arguments),
    catch: () => unavailable("Use an absolute native installer path, or Node with an absolute npm-cli.js/pnpm.cjs entrypoint. Shell expressions and shims are not bindings."),
  });
  yield* checkInstallerBinding(binding);
  const rootKind = yield* inspectOptional(paths.root);
  if (rootKind !== undefined && rootKind.kind !== "directory") return yield* unavailable("The installer binding directory is not a regular directory.");
  const kind = yield* inspectOptional(paths.path);
  if (kind !== undefined && kind.kind !== "regular") return yield* unavailable("An existing installer binding must be a regular file.");
  const content = new TextEncoder().encode(`${JSON.stringify(binding, null, 2)}\n`);
  // An explicit set can repair malformed data. Never parse the old binding as a
  // prerequisite for replacing it, and never suppress access/I/O failures.
  const existing = kind === undefined ? undefined : yield* machine.readFile({
    path: paths.path, maximumBytes: 16 * 1024,
  }).pipe(Effect.catchTag("FileSizeLimitError", () => Effect.succeed(undefined)));
  // Re-binding clears an explicit removal once the binding bytes are durable,
  // including when they are already identical: the operator has chosen again.
  const clearTombstone = Effect.gen(function*() {
    const tombstoneKind = yield* inspectOptional(paths.tombstone);
    if (tombstoneKind !== undefined) yield* machine.removeFile({ path: paths.tombstone });
  });
  if (existing !== undefined && Buffer.from(existing).equals(content)) {
    yield* clearTombstone;
    return binding;
  }
  yield* machine.ensureDirectory({ path: paths.root, mode: 0o700 });
  yield* machine.atomicWrite({ path: paths.path, content, mode: 0o600 });
  yield* clearTombstone;
  return binding;
});

export const listInstallerBindings = () => Effect.gen(function*() {
  const bindings: InstallerBinding[] = [];
  for (const method of installerMethods) {
    const binding = yield* loadInstallerBinding(method);
    if (binding !== undefined) bindings.push(binding);
  }
  return bindings;
});

export const removeInstallerBinding = (method: string) => Effect.gen(function*() {
  const machine = yield* MachineState;
  const paths = yield* pathsFor(method);
  const rootKind = yield* inspectOptional(paths.root);
  if (rootKind === undefined) return false;
  if (rootKind.kind !== "directory") return yield* unavailable("The installer binding directory is not a regular directory.");
  const kind = yield* inspectOptional(paths.path);
  if (kind === undefined) return false;
  if (kind.kind !== "regular") return yield* unavailable("Only a regular local installer binding can be removed.");
  // Record the explicit removal BEFORE deleting the binding: if the delete
  // fails, the binding is still present and wins over the marker; if the
  // marker write fails, the binding is untouched. No failure state loses both.
  const removed = new TextEncoder().encode(
    `${JSON.stringify({ schema: "canonfig.installer-removed/v1", method: paths.method, removedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  yield* machine.atomicWrite({ path: paths.tombstone, content: removed, mode: 0o600 });
  yield* machine.removeFile({ path: paths.path });
  // A concurrent `installer set` may have cleared the marker between the
  // write above and the delete. Re-assert it so the observable state can
  // never be "no binding, no marker" after a completed removal: the worst
  // remaining interleave resolves to binding-wins, which the next command
  // reports loudly instead of silently taking PATH.
  const recheckKind = yield* inspectOptional(paths.tombstone);
  if (recheckKind === undefined) {
    yield* machine.atomicWrite({ path: paths.tombstone, content: removed, mode: 0o600 });
  }
  return true;
});

/** One bounded local program plus the fixed prefix it must always be given. */
export interface InstallerInvocation {
  readonly executable: MachinePath;
  readonly arguments: ReadonlyArray<string>;
}

export const resolveInstallerInvocation = (
  method: string,
): Effect.Effect<InstallerInvocation, MachineStateError, MachineState> => Effect.gen(function*() {
  const machine = yield* MachineState;
  const normalized = yield* methodFor(method);
  const binding = yield* loadInstallerBinding(normalized);
  if (binding !== undefined) {
    const executable = yield* inspectBindingFiles(binding);
    return { executable, arguments: binding.arguments };
  }
  const paths = yield* pathsFor(normalized);
  const tombstoneKind = yield* inspectOptional(paths.tombstone);
  if (tombstoneKind !== undefined) {
    return yield* unavailable(
      `The installer binding for ${normalized} was explicitly removed; run installer set to bind it again. No PATH executable was selected.`,
    );
  }
  const name = normalized === "apt" ? "apt-get" : normalized;
  const found = yield* machine.findExecutable({ name });
  if (found.path.platform === "windows" && /\.(?:cmd|bat)$/iu.test(found.path.absolute)) {
    return yield* unavailable("Windows command shims cannot run with shell:false. Bind npm to node.exe plus npm-cli.js (or pnpm to pnpm.cjs), then retry. Do not enable a shell.");
  }
  return { executable: found.path, arguments: [] };
});
