import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Effect } from "effect";
import { MachineState } from "../machine/machine-state.service.ts";
import { sha256Hex } from "../profile/profile-codec.ts";
import { withRunLock } from "../synchronization/run-lock.ts";
import { readAuthoringItem, writeAuthoringItems, type AuthoringTarget } from "./authoring.ts";
import { CanonicalFolderError, type LoadedFolder } from "./folder.ts";
import type { RootContext } from "./harness.ts";
import { ingestShield } from "./shield-ingest.ts";
import { appendShieldLog } from "./shield-log.ts";
import { nativeInstallChange } from "./shield-plugins.ts";
import type { NativePluginVariant } from "./native-plugin.ts";

const failure = (path: string, message: string) => new CanonicalFolderError({ path, message: `Shield: ${message}` });

/** Explicit paths bypass PATH lookup; runProcess reports missing or non-executable files. */
export const shieldExecutable = Effect.fn("Shield.executable")(function*(command: string) {
  const machine = yield* MachineState;
  if (/[\\/]/u.test(command)) return yield* machine.normalizePath({ path: command });
  return (yield* machine.findExecutable({ name: command })).path;
});


/** A redirected native package is always unreviewed, even if its own files claim otherwise. */
export const addNativePlugin = Effect.fn("Shield.addNativePlugin")(function*(input: {
  readonly target: AuthoringTarget; readonly directory: string;
  readonly harness: NativePluginVariant["harness"]; readonly entry?: string | undefined;
}) {
  const platform = (yield* (yield* MachineState).userDirectories()).home.platform;
  const { change, digest } = yield* Effect.tryPromise({
    try: () => nativeInstallChange({ path: resolve(input.directory), harness: input.harness, entry: input.entry }, platform),
    catch: (error) => failure(input.directory, String(error)),
  });
  const existing = yield* readAuthoringItem(input.target, change.path);
  if (existing.digest !== null) return yield* failure(change.path, "plugin already exists; review a deliberate update instead of replacing executable code");
  yield* writeAuthoringItems(input.target, [change]);
  return { path: change.path, digest, reviewed: false, published: false };
});

/** Match supported installer command shapes, not arbitrary shell expressions. */
export const installerKind = (argv: ReadonlyArray<string>): "skills" | "mcp" | "plugin" | undefined => {
  const executable = basename(argv[0] ?? "").replace(/\.(cmd|exe)$/iu, "");
  const args = argv.slice(1);
  if (executable === "skills" && ["add", "install"].includes(args[0] ?? "")) return "skills";
  if (executable === "npx") {
    const rest = args.filter((argument) => argument !== "--yes" && argument !== "-y");
    if (/^skills(?:@[a-zA-Z0-9.^~+-]+)?$/u.test(rest[0] ?? "") && ["add", "install"].includes(rest[1] ?? "")) return "skills";
  }
  if (["claude", "codex", "qwen"].includes(executable) && args[0] === "mcp" && args[1] === "add") return "mcp";
  if (executable === "claude" && args[0] === "plugin" && (args[1] === "install" || args[1] === "marketplace" && args[2] === "add")) return "plugin";
  if (executable === "qwen" && args[0] === "extensions" && ["install", "link"].includes(args[1] ?? "")) return "plugin";
  return undefined;
};

export const redirectInstaller = Effect.fn("Shield.redirectInstaller")(function*(input: {
  readonly target: AuthoringTarget; readonly context: RootContext; readonly loaded: LoadedFolder; readonly argv: ReadonlyArray<string>;
}) {
  const { target, loaded, argv } = input;
  const kind = installerKind(argv);
  if (kind === undefined) return yield* failure(argv.join(" "), "unsupported installer. Use skills add, claude/codex/qwen mcp add, claude plugin install/marketplace add, or qwen extensions install. For a native package use shield add-plugin. Gemini is not a Target Harness.");
  const machine = yield* MachineState;
  const executable = yield* shieldExecutable(argv[0]!);
  const cache = (yield* machine.userDirectories()).cache.absolute;
  // Marketplace state persists here so add followed by install works, without borrowing live config or credentials.
  const home = join(cache, "canonfig", "shield", sha256Hex(target.folder).slice(0, 16));
  yield* Effect.tryPromise({ try: () => mkdir(home, { recursive: true, mode: 0o700 }), catch: (error) => failure(home, String(error)) });
  const environment = {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state"), APPDATA: join(home, ".config"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"),
    QWEN_HOME: join(home, ".qwen"),
    npm_config_cache: join(home, ".cache", "npm"), GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  };
  const command = argv.slice(1);
  if (kind === "skills" && !command.includes("--global") && !command.includes("-g")) command.push("--global");
  if (kind === "mcp" && !basename(argv[0]!).startsWith("codex")) {
    const scope = command.findIndex((arg) => arg === "--scope" || arg === "-s");
    if (scope >= 0 && command[scope + 1] !== "user") return yield* failure(argv[0]!, "Shield installs global configuration; use --scope user, not project or local scope");
    if (scope < 0) command.splice(2, 0, "--scope", "user");
  }
  // Local installer sources keep their original meaning after changing cwd to the private home.
  for (let index = 0; index < command.length; index++) {
    const argument = command[index]!;
    if (argument.startsWith("./") || argument.startsWith("../")) command[index] = resolve(argument);
  }
  const result = yield* machine.runProcess({ executable, arguments: command,
    workingDirectory: yield* machine.normalizePath({ path: home }),
    environment: Object.entries(environment).map(([name, value]) => ({ name, value })),
    environmentUnset: ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR", "GEMINI_CLI_HOME", "QWEN_CODE_HOME", "QWEN_RUNTIME_DIR", "CLAUDE_CODE_PLUGIN_CACHE_DIR", "CANONFIG_SHIELD_ROOT"],
    timeoutMilliseconds: 300000, maximumOutputBytes: 4 * 1024 * 1024,
  });
  if (result.exitCode !== 0) return yield* failure(home, `installer exited ${result.exitCode}; isolated files remain at ${home}. ${new TextDecoder().decode(result.standardError)}`);
  const context: RootContext = { ...input.context, home, appData: environment.APPDATA, join,
    environment: (name) => Object.entries(environment).find(([key]) => key === name)?.[1] };
  const imported = yield* withRunLock(target.statePath, "shield install", ingestShield({ target, context, loaded, applied: [], installer: true }));
  if (imported.imported.length === 0 && kind !== "plugin") return yield* failure(home, `installer produced no importable items. ${imported.warnings.join("; ")}`);
  yield* Effect.tryPromise({
    try: () => appendShieldLog(target.folder, [{ at: new Date().toISOString(), kind: "installed", installer: kind, items: imported.imported }]),
    catch: (error) => failure(target.folder, `items admitted, but the Shield log could not be written: ${String(error)}`),
  });
  return { ...imported, stagingHome: home, installerExitCode: result.exitCode, published: false };
});
