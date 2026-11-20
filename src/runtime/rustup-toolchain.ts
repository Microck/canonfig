import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { machine } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { parse } from "smol-toml";
import { sameIdentity } from "../machine/anchored-directory.ts";
import { HumanActionRequiredError, MachineFilesystemError, type MachineStateError } from "../machine/machine-state.errors.ts";
import type { MachineState } from "../machine/machine-state.service.ts";
import type { MachinePath, ProcessEnvironmentEntry } from "../machine/machine-state.types.ts";

const missingAsUndefined = (cause: unknown): undefined => {
  if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
  throw cause;
};

/** Rustup dispatches by argv[0]. A Cargo proxy may be a symlink or a hard link. */
async function cargoProxyTarget(executable: string): Promise<string | undefined> {
  if (!/^cargo(?:\.exe)?$/iu.test(basename(executable))) return undefined;
  const target = await realpath(executable).catch(missingAsUndefined);
  if (target === undefined) return undefined;
  if (/^rustup(?:-init)?(?:\.exe)?$/iu.test(basename(target))) return target;
  const sibling = join(dirname(target), /\.exe$/iu.test(target) ? "rustup.exe" : "rustup");
  const [cargo, rustup] = await Promise.all([
    stat(target, { bigint: true }),
    stat(sibling, { bigint: true }).catch(missingAsUndefined),
  ]);
  return rustup && sameIdentity(cargo, rustup) ? sibling : undefined;
}

export const inspectCargoProxy = (executable: string) => Effect.tryPromise({
  try: () => cargoProxyTarget(executable),
  catch: (cause) => cause instanceof Error && "code" in cause && cause.code === "ELOOP"
    ? new HumanActionRequiredError({
      action: "repair the rustup proxy",
      recovery: "A Cargo or rustup link loops back on itself. Repair it, then configure the binding again.",
    })
    : new MachineFilesystemError({ operation: "inspect Cargo proxy", path: executable, message: String(cause) }),
});

const maxRustupConfigBytes = 64 * 1024;
const decoder = new TextDecoder();

function readOptional(machine: MachineState["Service"], filename: string) {
  return Effect.gen(function*() {
    // Rustup permits linked settings and toolchain files. Read their resolved regular files with a size limit.
    const resolved = yield* Effect.tryPromise({ try: () => realpath(filename).catch(missingAsUndefined), catch: String });
    if (resolved === undefined) return undefined;
    const path = yield* machine.normalizePath({ path: resolved });
    const bytes = yield* machine.readFile({ path, maximumBytes: maxRustupConfigBytes });
    return decoder.decode(bytes);
  });
}

const RustupSettings = Schema.Struct({
  version: Schema.optional(Schema.String),
  default_toolchain: Schema.optional(Schema.String),
  default_host_triple: Schema.optional(Schema.String),
  default_host_tuple: Schema.optional(Schema.String),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const ToolchainFile = Schema.Struct({
  toolchain: Schema.Struct({
    channel: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
    profile: Schema.optional(Schema.Literals(["minimal", "default", "complete"])),
    components: Schema.optional(Schema.Array(Schema.String)),
    targets: Schema.optional(Schema.Array(Schema.String)),
  }),
});
const decodeSettings = Schema.decodeUnknownSync(RustupSettings);
const decodeToolchainFile = Schema.decodeUnknownSync(ToolchainFile);

function readSettings(machine: MachineState["Service"], filename: string) {
  return Effect.gen(function*() {
    const text = yield* readOptional(machine, filename);
    if (text === undefined) return undefined;
    return yield* Effect.try({ try: () => decodeSettings(parse(text)), catch: String });
  });
}

function parseToolchainFile(text: string): string | undefined {
  const { toolchain } = decodeToolchainFile(parse(text));
  const { channel, path, profile, components, targets } = toolchain;
  if (path !== undefined) {
    if (!isAbsolute(path) || channel !== undefined || profile !== undefined || components !== undefined || targets !== undefined) {
      throw new Error("a toolchain path must be absolute and cannot be combined with other toolchain options");
    }
    return path;
  }
  if (channel !== undefined) return manifestChannel(channel);
  if (components === undefined && targets === undefined) {
    throw new Error("the toolchain file must select a channel or absolute path or declare components or targets");
  }
  // A nearest file that only declares components or targets inherits the default.
  return undefined;
}

function directoryToolchain(machine: MachineState["Service"], overrides: Readonly<Record<string, string>> | undefined) {
  return Effect.gen(function*() {
    let directory = yield* Effect.tryPromise({ try: () => realpath(process.cwd()), catch: String });
    while (true) {
      const override = overrides?.[directory];
      if (override !== undefined) return override;
      const legacy = yield* readOptional(machine, join(directory, "rust-toolchain"));
      const legacySelection = legacy?.trim();
      if (legacySelection && !legacySelection.includes("\n")) {
        return yield* Effect.try({
          try: () => isAbsolute(legacySelection) ? legacySelection : manifestChannel(legacySelection),
          catch: String,
        });
      }
      const file = legacy ?? (yield* readOptional(machine, join(directory, "rust-toolchain.toml")));
      if (file !== undefined) return yield* Effect.try({ try: () => parseToolchainFile(file), catch: String });
      const parent = dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  });
}

let linuxAbi: "gnu" | "musl" | undefined;

function nativeHost(platform: MachinePath["platform"]): string {
  const architecture = machine();
  const rustArchitecture = architecture === "arm64" ? "aarch64" : architecture;
  switch (platform) {
    case "windows": return `${rustArchitecture}-pc-windows-msvc`;
    case "macos": return `${rustArchitecture}-apple-darwin`;
    case "linux": {
      // SAFETY: Node's diagnostic report has a header on both GNU and musl. Only GNU reports the glibc version.
      linuxAbi ??= (process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime ? "gnu" : "musl";
      return `${rustArchitecture}-unknown-linux-${linuxAbi}`;
    }
  }
}

const channelSelector = /^(?<channel>stable|beta|nightly|\d\.(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d?))?(?:-beta(?:\.\d{1,2})?)?)(?<date>-\d{4}-\d{2}-\d{2})?(?:-(?<target>.+))?$/u;
// Rustup recognizes these components even when they describe a foreign toolchain.
// Source: https://github.com/rust-lang/rustup/blob/dc46b8e48cdb4407ad59e38399eb60a900866df8/src/dist/target_tuple/known.rs
const targetArchitectures = [
  "aarch64", "aarch64_be", "aarch64v8r", "amdgcn", "arm", "arm64_32", "arm64e", "arm64ec",
  "armeb", "armebv7r", "armv4t", "armv5te", "armv6", "armv6k", "armv7", "armv7a", "armv7k",
  "armv7r", "armv7s", "armv8r", "avr", "bpfeb", "bpfel", "csky", "hexagon", "i386", "i586",
  "i686", "loongarch32", "loongarch64", "m68k", "mips", "mips64", "mips64el", "mipsel",
  "mipsisa32r6", "mipsisa32r6el", "mipsisa64r6", "mipsisa64r6el", "msp430", "nvptx64",
  "powerpc", "powerpc64", "powerpc64le", "riscv32", "riscv32e", "riscv32em", "riscv32emc",
  "riscv32gc", "riscv32i", "riscv32im", "riscv32ima", "riscv32imac", "riscv32imafc",
  "riscv32imc", "riscv32imfc", "riscv64", "riscv64a23", "riscv64gc", "riscv64im", "riscv64imac",
  "s390x", "sparc", "sparc64", "sparcv9", "thumbv4t", "thumbv5te", "thumbv6", "thumbv6m",
  "thumbv7a", "thumbv7em", "thumbv7m", "thumbv7neon", "thumbv7r", "thumbv8m.base",
  "thumbv8m.main", "thumbv8r", "wasm32", "wasm32v1", "wasm64", "x86_64", "x86_64h", "xtensa",
];
const targetOperatingSystems = [
  "amd-amdhsa", "apple-darwin", "apple-ios", "apple-tvos", "apple-visionos", "apple-watchos",
  "esp-espidf", "esp32-espidf", "esp32-none", "esp32s2-espidf", "esp32s2-none",
  "esp32s3-espidf", "esp32s3-none", "fortanix-unknown", "ibm-aix", "kmc-solid_asp3", "linux",
  "lynx-lynxos178", "mti-none", "nintendo-3ds", "nintendo-switch", "none", "nuttx-eabi", "nuttx-eabihf", "nvidia-cuda", "oe-linux", "openwrt-linux", "pc-cygwin", "pc-nto", "pc-qnx", "pc-solaris", "pc-windows", "risc0-zkvm", "rtems-eabihf", "sony-ps3", "sony-psp", "sony-psx",
  "sony-vita", "sun-solaris", "unikraft-linux", "unknown-dragonfly", "unknown-emscripten",
  "unknown-freebsd", "unknown-fuchsia", "unknown-haiku", "unknown-helenos", "unknown-hermit",
  "unknown-hurd", "unknown-hyperlight", "unknown-illumos", "unknown-l4re", "unknown-linux",
  "unknown-managarm", "unknown-motor", "unknown-netbsd", "unknown-none", "unknown-nto",
  "unknown-nuttx", "unknown-openbsd", "unknown-qnx", "unknown-qtee", "unknown-qurt", "unknown-redox", "unknown-teeos", "unknown-trusty", "unknown-uefi", "unknown-unknown", "unknown-xous",
  "uwp-windows", "vex-v5", "wali-linux", "wasip1", "wasip1-threads", "wasip2", "wasip3",
  "win7-windows", "wrs-vxworks",
];
const targetAbis = [
  "android", "androideabi", "component", "eabi", "eabihf", "elf", "freestanding", "gnu",
  "gnu_ilp32", "gnuabi64", "gnuabiv2", "gnuabiv2hf", "gnuasan", "gnueabi", "gnueabihf",
  "gnuelfv2", "gnullvm", "gnumsan", "gnuspe", "gnutsan", "gnux32", "macabi", "mlibc", "msvc",
  "musl", "muslabi64", "musleabi", "musleabihf", "muslspe", "newlibeabihf", "none", "ohos",
  "pauthtest", "qnx700", "qnx710", "qnx710_iosock", "sgx", "sim", "softfloat", "spe", "uclibc",
  "uclibceabi", "uclibceabihf",
];
const targetTuple = new RegExp(
  `^(?:-(?<arch>${targetArchitectures.join("|").replaceAll(".", "\\.")}))?`
  + `(?:-(?<os>${targetOperatingSystems.join("|")}))?(?:-(?<abi>${targetAbis.join("|")}))?$`,
  "u",
);

/** Named toolchains occupy one directory below rustup's toolchains folder. */
function namedToolchain(selector: string): string {
  const name = selector.replace(/\/+$/u, "");
  if (!name || name === "." || name === ".." || name === "none" || name.startsWith("+")
    || /[/\\\0]/u.test(name) || (process.platform === "win32" && /[:]|[. ]$/u.test(name))) {
    throw new Error("invalid Rustup toolchain name: " + JSON.stringify(selector));
  }
  return name;
}

function manifestChannel(selector: string): string {
  const channel = namedToolchain(selector);
  const requestedTarget = channelSelector.exec(channel)?.groups?.target;
  if (requestedTarget !== undefined) {
    const target = targetTuple.exec(`-${requestedTarget}`)?.groups;
    if (target && (!target.arch || !target.os)) throw new Error("a toolchain file must use an unqualified channel or a complete target");
  }
  return channel;
}

function resolveToolchain(home: string, toolchain: string, host: string) {
  if (isAbsolute(toolchain)) return { directory: toolchain, custom: true };
  const name = namedToolchain(toolchain);
  const release = channelSelector.exec(name)?.groups;
  const partial = release?.channel ? targetTuple.exec(release.target ? `-${release.target}` : "")?.groups : undefined;
  if (!release?.channel || !partial) return { directory: join(home, "toolchains", name), custom: true };
  const native = targetTuple.exec(`-${host}`)?.groups;
  const arch = partial.arch ?? native?.arch;
  const os = partial.os ?? native?.os;
  const abi = partial.abi ?? (partial.os === undefined ? native?.abi : undefined);
  if (!arch || !os) throw new Error(`cannot complete the selected toolchain with host ${host}`);
  // Rustup maps these releases to their sole patch version before resolving a target.
  const channel = /^1\.[0-8]$/u.test(release.channel) ? `${release.channel}.0` : release.channel;
  const qualified = [channel + (release.date ?? ""), arch, os, abi].filter(Boolean).join("-");
  return { directory: join(home, "toolchains", qualified), custom: false };
}

export function rustupHomePath(home: MachinePath): string {
  return process.env["RUSTUP_HOME"] ?? join(home.absolute, ".rustup");
}

/** Rustup sets the active toolchain's loader path, even when Cargo comes from a fallback. */
function toolchainLibraryEnvironment(directory: string, platform: MachinePath["platform"]): readonly ProcessEnvironmentEntry[] {
  if (platform === "windows") return [];
  const name = platform === "macos" ? "DYLD_FALLBACK_LIBRARY_PATH" : "LD_LIBRARY_PATH";
  const inherited = process.env[name];
  const paths = [join(directory, "lib")];
  if (inherited) paths.push(inherited);
  else if (platform === "macos") {
    if (process.env["HOME"]) paths.push(join(process.env["HOME"], "lib"));
    paths.push("/usr/local/lib", "/usr/lib");
  }
  return [{ name, value: paths.join(delimiter) }];
}

type CargoVersionProbe = {
  readonly executable: MachinePath;
  readonly environment?: readonly ProcessEnvironmentEntry[];
};

/** Read the active Cargo selection without starting rustup or touching its cache. */
function installedRustupCargo(
  machine: MachineState["Service"],
  home: MachinePath,
): Effect.Effect<{ executable: string; environment: readonly ProcessEnvironmentEntry[] } | { reason: string }> {
  const rustupHome = resolve(rustupHomePath(home));
  const recovery = "Configure the toolchain explicitly with `rustup default stable`, or install Cargo in the selected toolchain, then retry.";
  return Effect.gen(function*() {
    const settings = yield* readSettings(machine, join(rustupHome, "settings.toml"));
    if (settings && settings.version !== "12") {
      return { reason: "Rustup metadata needs to be repaired. Run `rustup self upgrade-data`, then retry." } as const;
    }
    const configuredDefault = Effect.gen(function*() {
      const toolchain = settings?.default_toolchain;
      if (toolchain !== undefined || home.platform === "windows") return toolchain;
      const fallback = yield* readSettings(machine, process.env["RUSTUP_OVERRIDE_UNIX_FALLBACK_SETTINGS"] ?? "/etc/rustup/settings.toml");
      return fallback?.default_toolchain;
    });
    // Match rustup's precedence for a command with no explicit +toolchain.
    const toolchain = (process.env["RUSTUP_TOOLCHAIN"] || undefined)
      ?? (yield* directoryToolchain(machine, settings?.overrides))
      ?? (yield* configuredDefault);
    if (!toolchain) return { reason: `Rustup has no selected toolchain in this session. ${recovery}` } as const;
    const host = settings?.default_host_tuple ?? settings?.default_host_triple
      ?? process.env["RUSTUP_OVERRIDE_HOST_TUPLE"] ?? process.env["RUSTUP_OVERRIDE_HOST_TRIPLE"] ?? nativeHost(home.platform);
    return yield* Effect.tryPromise({
      try: async () => {
        const { directory, custom } = resolveToolchain(rustupHome, toolchain, host);
        const binary = home.platform === "windows" ? "cargo.exe" : "cargo";
        let cargo = join(directory, "bin", binary);
        let entry = await stat(cargo).catch(missingAsUndefined);
        if (!entry && custom && (await stat(directory).catch(missingAsUndefined))?.isDirectory()) {
          // Once a channel is present, verify it before reporting readiness.
          // A broken installation must not be hidden by a lower-priority channel.
          for (const channel of ["nightly", "beta", "stable"]) {
            const fallback = resolveToolchain(rustupHome, channel, host).directory;
            if (!(await stat(fallback).catch(missingAsUndefined))) continue;
            cargo = join(fallback, "bin", binary);
            entry = await stat(cargo).catch(missingAsUndefined);
            break;
          }
        }
        if (!entry?.isFile() || await cargoProxyTarget(cargo) !== undefined) {
          return { reason: `Rustup did not find a real Cargo executable at ${cargo}. ${recovery}` } as const;
        }
        if (home.platform !== "windows") await access(cargo, constants.X_OK);
        return { executable: cargo, environment: toolchainLibraryEnvironment(directory, home.platform) } as const;
      },
      catch: String,
    });
  }).pipe(Effect.catch((cause) => Effect.succeed({
    reason: `Could not resolve Cargo without running the rustup proxy (${String(cause)}). ${recovery}`,
  })));
}

export const resolveCargoVersionProbe = (
  machine: MachineState["Service"],
  executable: MachinePath,
  home: MachinePath,
): Effect.Effect<CargoVersionProbe | { reason: string }, MachineStateError> => Effect.gen(function*() {
  if (!/^cargo(?:\.exe)?$/iu.test(basename(executable.absolute))) return { executable };
  const proxy = yield* inspectCargoProxy(executable.absolute);
  if (proxy !== undefined) return yield* resolveRustupVersionProbe(machine, home);

  // A surviving rustup hard link is indistinguishable from a regular Cargo
  // executable once its sibling is gone. Never probe an unidentified Cargo
  // executable from rustup's proxy directory.
  const defaultCargoHome = join(home.absolute, ".cargo");
  const configuredCargoHome = resolve(process.env["CARGO_HOME"] ?? defaultCargoHome);
  const proxyBins = new Set([join(defaultCargoHome, "bin"), join(configuredCargoHome, "bin")]);
  const parent = dirname(executable.absolute);
  const inProxyDirectory = yield* Effect.tryPromise({
    try: async () => {
      const directory = await realpath(parent);
      const bins = await Promise.all(Array.from(proxyBins, (bin) => realpath(bin).catch(missingAsUndefined)));
      return bins.some((bin) => home.platform === "windows" ? bin?.toLowerCase() === directory.toLowerCase() : bin === directory);
    },
    catch: (cause) => new MachineFilesystemError({ operation: "inspect Cargo directory", path: parent, message: String(cause) }),
  });
  if (inProxyDirectory) return {
    reason: "Cargo in rustup's proxy directory could not be verified. Repair rustup's Cargo proxy, then retry.",
  };
  return { executable };
});

export const resolveRustupVersionProbe = (
  machine: MachineState["Service"],
  home: MachinePath,
): Effect.Effect<CargoVersionProbe | { reason: string }, MachineStateError> => Effect.gen(function*() {
  const cargo = yield* installedRustupCargo(machine, home);
  if ("reason" in cargo) return cargo;
  return { executable: yield* machine.normalizePath({ path: cargo.executable }), environment: cargo.environment };
});
