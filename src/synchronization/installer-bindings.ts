import { realpath } from "node:fs/promises";
import { Effect } from "effect";
import {
  decodeInstallerBinding,
  installerMethods,
  isLocalInstallerPath,
  normalizeInstallerMethod,
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
  yield* machine.validatePathWithinRoot({ root: directories.home, path });
  return { root, path, method: normalized, platform: directories.home.platform };
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
      try: () => decodeInstallerBinding(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
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
    try: () => decodeInstallerBinding({
      schema: "canonfig.installer/v1", method: paths.method, platform: paths.platform, ...resolved,
    }),
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
  if (existing !== undefined && Buffer.from(existing).equals(content)) return binding;
  yield* machine.ensureDirectory({ path: paths.root, mode: 0o700 });
  yield* machine.atomicWrite({ path: paths.path, content, mode: 0o600 });
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
  // Removal is a local explicit request, so malformed JSON must not prevent it.
  yield* machine.removeFile({ path: paths.path });
  return true;
});

/** Resolve every deterministic installer through the same follower-owned data. */
export const resolveInstallerInvocation = (method: string) => Effect.gen(function*() {
  const machine = yield* MachineState;
  const normalized = yield* methodFor(method);
  const binding = yield* loadInstallerBinding(normalized);
  if (binding !== undefined) {
    const executable = yield* inspectBindingFiles(binding);
    return { executable, arguments: binding.arguments };
  }
  const name = normalized === "apt" ? "apt-get" : normalized;
  const found = yield* machine.findExecutable({ name });
  if (found.path.platform === "windows" && /\.(?:cmd|bat)$/iu.test(found.path.absolute)) {
    return yield* unavailable("Windows command shims cannot run with shell:false. Bind npm to node.exe plus npm-cli.js (or pnpm to pnpm.cjs), then retry. Do not enable a shell.");
  }
  return { executable: found.path, arguments: [] as ReadonlyArray<string> };
});
