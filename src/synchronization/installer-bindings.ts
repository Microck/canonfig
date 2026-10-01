import { realpath } from "node:fs/promises";
import { win32 } from "node:path";
import { Effect, Option, Schema } from "effect";
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
import type { InstallDestinationHint, MachinePath } from "../machine/machine-state.types.ts";

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
  // Every segment below the home directory is a literal, so containment is
  // structural. Checking it would also lstat a home that need not exist yet,
  // which is the normal state of a machine that has bound no installer.
  return { root, path, method: normalized, platform: directories.home.platform };
});

const inspectOptional = (path: MachinePath) => Effect.gen(function*() {
  const machine = yield* MachineState;
  return yield* machine.inspectPath(path).pipe(Effect.catchTag("MachineFilesystemError", (error) =>
    /\b(?:ENOENT|ENOTDIR)\b/u.test(error.message) ? Effect.succeed(undefined) : Effect.fail(error)
  ));
});

const isWindowsShim = (path: string): boolean => /\.(?:cmd|bat)$/iu.test(path);

const ShimMethod = Schema.Literals(["npm", "pnpm"]);

/** Where npm installs the JavaScript entrypoint each Windows command shim runs. */
const shimEntrypoints = {
  npm: ["node_modules", "npm", "bin", "npm-cli.js"],
  pnpm: ["node_modules", "pnpm", "bin", "pnpm.cjs"],
} satisfies Record<typeof ShimMethod.Type, ReadonlyArray<string>>;

/** The Node plus entrypoint pair that replaces a Windows npm or pnpm shim. */
export interface WindowsNodeBinding {
  readonly shim: string;
  readonly executable: string;
  readonly entrypoint: string;
  /** The exact command that records this binding. */
  readonly command: string;
}

/**
 * The binding for the Windows command shim `shim`, when both halves exist.
 *
 * `npm.cmd` only starts `node` on npm's own entrypoint, and Canonfig never
 * starts a shell, so it runs that pair directly. The entrypoint is where npm
 * installs it beside the shim (the Node.js installer and `npm install -g npm`
 * both use this layout); node.exe is taken beside the shim, as the shim does,
 * or else from PATH the way the Windows machine layer finds any executable.
 */
const nodeBindingForShim = (
  method: string,
  shim: string,
): Effect.Effect<WindowsNodeBinding | undefined, never, MachineState> => Effect.gen(function*() {
  const machine = yield* MachineState;
  if (!Schema.is(ShimMethod)(method) || !isWindowsShim(shim)) return undefined;
  const entry = shimEntrypoints[method];
  const isRegularFile = (absolute: string) => machine.normalizePath({ path: absolute }).pipe(
    Effect.flatMap(machine.inspectPath),
    Effect.map((object) => object.kind === "regular"),
    Effect.orElseSucceed(() => false),
  );
  const directory = win32.dirname(shim);
  const entrypoint = win32.join(directory, ...entry);
  if (!(yield* isRegularFile(entrypoint))) return undefined;
  const besideShim = win32.join(directory, "node.exe");
  const executable = (yield* isRegularFile(besideShim))
    ? besideShim
    : yield* machine.findExecutable({ name: "node" }).pipe(
      Effect.map((found) => /\.exe$/iu.test(found.path.absolute) ? found.path.absolute : undefined),
      Effect.orElseSucceed(() => undefined),
    );
  if (executable === undefined) return undefined;
  return {
    shim,
    executable,
    entrypoint,
    command: `canonfig installer set ${method} --executable "${executable}" --arg "${entrypoint}"`,
  };
});

/**
 * The binding a Windows machine needs for `method`, when PATH resolves it to a
 * command shim that Canonfig cannot run; undefined when no shim is in the way.
 */
export const windowsNodeBinding = (
  method: string,
): Effect.Effect<WindowsNodeBinding | undefined, never, MachineState> => Effect.gen(function*() {
  const machine = yield* MachineState;
  const found = yield* machine.findExecutable({ name: method }).pipe(Effect.option);
  if (Option.isNone(found) || found.value.path.platform !== "windows") return undefined;
  return yield* nodeBindingForShim(method, found.value.path.absolute);
});

/**
 * `lead` names where the shim came from; the rest says what to run instead.
 * The command gets a line of its own so a shortened human rendering keeps it.
 */
const shimRecovery = (lead: string, method: string, binding: WindowsNodeBinding | undefined): string =>
  binding === undefined
    ? `${lead}, which cannot run without a shell. Bind ${method} to node.exe plus ${method === "pnpm" ? "pnpm.cjs" : "npm-cli.js"} with canonfig installer set ${method} --executable <node.exe> --arg <entrypoint>, then retry. Do not enable a shell.`
    : `${lead}, which cannot run without a shell. Bind ${method} to Node and its own entrypoint instead, then retry:\n${binding.command}`;

/** No binding is recorded and PATH resolves `method` to the Windows shim `shim`. */
const unboundShimRecovery = (method: string, shim: string) =>
  Effect.map(nodeBindingForShim(method, shim), (binding) => shimRecovery(
    `No installer binding is set for ${method}, and PATH resolves it to the Windows command shim ${shim}`,
    method,
    binding,
  ));

/**
 * What to do when no binding is recorded for `method`: bind it, and on a
 * Windows machine whose PATH resolves it to a command shim, exactly how.
 */
export const unboundInstallerRecovery = (
  method: string,
): Effect.Effect<string, never, MachineState> => Effect.gen(function*() {
  const machine = yield* MachineState;
  const found = yield* machine.findExecutable({ name: method }).pipe(Effect.option);
  if (Option.isNone(found) || found.value.path.platform !== "windows" || !isWindowsShim(found.value.path.absolute)) {
    return "Run installer set with the existing executable and optional JavaScript entrypoint, then retry.";
  }
  return yield* unboundShimRecovery(method, found.value.path.absolute);
});

/** The executable a binding document names, even when it is not a valid binding. */
const namedExecutable = (text: string): string | undefined => {
  try {
    return Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.Struct({ executable: Schema.String }))(JSON.parse(text)),
    )?.executable;
  } catch {
    return undefined;
  }
};

const removalRecordSchema = "canonfig.installer-removed/v1";

/**
 * The local binding state from a single file read. A removal is recorded in
 * the binding file itself (one atomic write per transition), so concurrent
 * `set` and `remove` commands always converge to a coherent state: the last
 * completed write wins, and no interleaving can lose both the binding and
 * its removal record.
 */
const RemovalRecordSchema = Schema.Struct({ schema: Schema.Literal(removalRecordSchema) });

const isRemovalRecord = (text: string): boolean => {
  try {
    Schema.decodeUnknownSync(RemovalRecordSchema)(JSON.parse(text));
    return true;
  } catch {
    return false;
  }
};

export type InstallerBindingState =
  | { readonly status: "bound"; readonly binding: InstallerBinding }
  | { readonly status: "removed" }
  | { readonly status: "absent" };

export const loadInstallerState = (method: string): Effect.Effect<InstallerBindingState, MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const paths = yield* pathsFor(method);
    const rootKind = yield* inspectOptional(paths.root);
    if (rootKind === undefined) return { status: "absent" } as const;
    if (rootKind.kind !== "directory") return yield* unavailable("The installer binding directory must not be a symbolic link or special file.");
    const kind = yield* inspectOptional(paths.path);
    if (kind === undefined) return { status: "absent" } as const;
    if (kind.kind !== "regular") return yield* unavailable("The installer binding must be a regular file.");
    const raw = yield* machine.readFile({ path: paths.path, maximumBytes: 16 * 1024 });
    let text: string | undefined;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      text = undefined;
    }
    if (text === undefined) {
      return yield* unavailable("The local installer binding is invalid; review and replace it with installer set.");
    }
    let binding: InstallerBinding | undefined;
    try {
      binding = parseInstallerBinding(text);
    } catch {
      binding = undefined;
    }
    if (binding !== undefined) {
      if (binding.method !== paths.method || binding.platform !== paths.platform) {
        return yield* unavailable("The installer binding belongs to a different method or platform; configure it on this machine.");
      }
      return { status: "bound", binding } as const;
    }
    if (isRemovalRecord(text)) return { status: "removed" } as const;
    const named = namedExecutable(text);
    if (paths.platform === "windows" && named !== undefined && isWindowsShim(named)) {
      return yield* unavailable(shimRecovery(
        `The installer binding for ${paths.method} names the Windows command shim ${named}`,
        paths.method,
        yield* nodeBindingForShim(paths.method, named),
      ));
    }
    return yield* unavailable("The local installer binding is invalid; review and replace it with installer set.");
  });

export const loadInstallerBinding = (method: string): Effect.Effect<InstallerBinding | undefined, MachineStateError, MachineState> =>
  Effect.flatMap(loadInstallerState(method), (state) =>
    state.status === "bound" ? Effect.succeed(state.binding) : Effect.succeed(undefined));

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
  // Native npm startup under software-emulated Windows can take minutes.
  const result = yield* machine.runProcess({
    executable, arguments: [...binding.arguments, "--version"],
    timeoutMilliseconds: 300_000, maximumOutputBytes: 16 * 1024,
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
  let binding: InstallerBinding | undefined;
  try {
    binding = installerBindingFor(paths.method, paths.platform, resolved.executable, resolved.arguments);
  } catch {
    binding = undefined;
  }
  if (binding === undefined) {
    return yield* unavailable(paths.platform === "windows" && isWindowsShim(resolved.executable)
      ? shimRecovery(
        `${resolved.executable} is a Windows command shim`,
        paths.method,
        yield* nodeBindingForShim(paths.method, resolved.executable),
      )
      : "Use an absolute native installer path, or Node with an absolute npm-cli.js/pnpm.cjs entrypoint. Shell expressions and shims are not bindings.");
  }
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
  // One atomic write is the whole transition: it overwrites a binding or a
  // removal record alike, so re-binding needs no separate marker cleanup.
  if (existing !== undefined && Buffer.from(existing).equals(content)) {
    // Re-read before skipping the write: a concurrent `remove` may have
    // replaced these bytes with a removal record after the read above.
    // Falling through re-binds (this command wins); returning early here
    // would report success while the file says removed.
    const fresh = yield* machine.readFile({
      path: paths.path, maximumBytes: 16 * 1024,
    }).pipe(
      Effect.catchTag("FileSizeLimitError", () => Effect.succeed(undefined)),
      Effect.catchTag("MachineFilesystemError", () => Effect.succeed(undefined)),
    );
    if (fresh !== undefined && Buffer.from(fresh).equals(content)) return binding;
  }
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
  const state = yield* loadInstallerState(paths.method).pipe(
    // Removal is a local explicit request: malformed, foreign, oversized, or
    // unreadable content is still present content, so it never blocks
    // recording the removal. Other I/O failures propagate.
    Effect.catchTag("HumanActionRequiredError", () => Effect.succeed({ status: "present" } as const)),
    Effect.catchTag("FileSizeLimitError", () => Effect.succeed({ status: "present" } as const)),
    Effect.catchTag("MachineFilesystemError", () => Effect.succeed({ status: "present" } as const)),
  );
  if (state.status === "removed") return false;
  // One atomic write is the whole transition: the binding file becomes the
  // removal record, so no interleaving with `installer set` can lose both.
  const removed = new TextEncoder().encode(
    `${JSON.stringify({ schema: "canonfig.installer-removed/v1", method: paths.method, removedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  yield* machine.atomicWrite({ path: paths.path, content: removed, mode: 0o600 });
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
  // One read decides: a removal recorded here fails actionably instead of
  // silently falling back to whatever PATH happens to resolve.
  const state = yield* loadInstallerState(normalized);
  if (state.status === "bound") {
    const executable = yield* inspectBindingFiles(state.binding);
    return { executable, arguments: state.binding.arguments };
  }
  if (state.status === "removed") {
    return yield* unavailable(
      `The installer binding for ${normalized} was explicitly removed; run installer set to bind it again. No PATH executable was selected.`,
    );
  }
  const name = normalized === "apt" ? "apt-get" : normalized;
  const found = yield* machine.findExecutable({ name });
  if (found.path.platform === "windows" && isWindowsShim(found.path.absolute)) {
    return yield* unavailable(yield* unboundShimRecovery(normalized, found.path.absolute));
  }
  return { executable: found.path, arguments: [] };
});

/**
 * The installers a plan would run that this machine refuses, one line each.
 *
 * The plan used to look runnable and the refusal came only during apply, for
 * instance on Windows, where PATH resolves npm to npm.cmd. Only refusals the
 * operator acts on are listed; an installer that is not installed at all
 * fails the apply naming the directories it searched.
 */
export const installerRefusals = (
  methods: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, never, MachineState> =>
  Effect.forEach([...new Set(methods)], (method) =>
    resolveInstallerInvocation(method).pipe(
      Effect.match({
        onSuccess: () => undefined,
        onFailure: (error) =>
          error instanceof HumanActionRequiredError ? `installer ${method}: ${error.recovery}` : undefined,
      }),
    )).pipe(Effect.map((refusals) => refusals.filter((refusal) => refusal !== undefined)));

/**
 * Where a verifier looks for a tool before PATH: one hint per recipe method
 * for this platform. npm and Homebrew place tools beside their own
 * executable, so their hint carries the installer Canonfig would run; an
 * installer that does not resolve only drops that one directory.
 */
export const toolInstallMethods = (
  recipes: ReadonlyArray<{ readonly platform: string; readonly method: string }>,
): Effect.Effect<ReadonlyArray<InstallDestinationHint>, never, MachineState> => Effect.gen(function*() {
  const machine = yield* MachineState;
  const platform = yield* machine.userDirectories().pipe(
    Effect.map((directories) => directories.home.platform),
    Effect.catch(() => Effect.succeed(undefined)),
  );
  const methods = [...new Set(
    recipes.filter((recipe) => recipe.platform === platform).map((recipe) => recipe.method),
  )];
  return yield* Effect.forEach(methods, (method) =>
    ["npm", "pnpm", "brew", "homebrew"].includes(method)
      ? resolveInstallerInvocation(method).pipe(
        Effect.map((installer): InstallDestinationHint => ({ method, installer: installer.executable })),
        Effect.catch(() => Effect.succeed<InstallDestinationHint>({ method })),
      )
      : Effect.succeed<InstallDestinationHint>({ method }));
});
