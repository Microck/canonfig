import { spawnSync } from "node:child_process";
import { constants, linkSync, copyFileSync, unlinkSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
// The binding stores what fs/promises.realpath returns, which on Windows
// expands 8.3 short names that fs.realpathSync leaves alone. Resolve the
// expected paths the same way, or the two spellings of one file disagree.
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionId, ResourceId, RunId } from "../../src/domain/brand.ts";
import { installerRecipeProvenance } from "../../src/domain/mcp-qualification.ts";
import { isLocalInstallerPath, parseInstallerBinding } from "../../src/domain/installer-binding.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { macosMachineStateLayer } from "../../src/machine/macos.layer.ts";
import { windowsMachineStateLayer } from "../../src/machine/windows.layer.ts";
import { ExecutableNotFoundError, MachineFilesystemError } from "../../src/machine/machine-state.errors.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import {
  checkInstallerBinding, listInstallerBindings, installerRefusals, loadInstallerBinding, loadInstallerState, removeInstallerBinding,
  resolveInstallerInvocation, saveInstallerBinding, unboundInstallerRecovery,
} from "../../src/synchronization/installer-bindings.ts";
import { prepareResourceAction, verifyResource, type ResourceExecutionContext } from "../../src/synchronization/resource-executors.ts";
import { runInstallerCli } from "../../src/runtime/installer-cli.ts";
import { installerArguments, isInstallerCommand } from "../../src/runtime/command-routing.ts";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-installer-binding-"));
  roots.push(home);
  const entry = join(home, "npm-cli.js");
  const output = join(home, "invocation.json");
  writeFileSync(entry, [
    "const fs = require('node:fs');",
    "if (process.argv[2] === '--version') console.log('1.0.0-fixture');",
    // npm ls exits 1 when the package is not installed globally.
    "else if (process.argv[2] === 'ls') process.exit(1);",
    `else fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({argv:process.argv.slice(2),path:process.env.PATH??process.env.Path??''}));`,
  ].join("\n"));
  const environment = Object.entries({
    ...process.env, HOME: home, USERPROFILE: home, XDG_CACHE_HOME: join(home, ".cache"),
    APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), PATH: "",
  }).flatMap(([name, value]) => value === undefined || (name.toLowerCase() === "path" && name !== "PATH") ? [] : [{ name, value }]);
  const options = { environment, credentialPolicy: { kind: "local-file" as const, path: join(home, "credentials") } };
  const layer = process.platform === "win32" ? windowsMachineStateLayer(options)
    : process.platform === "darwin" ? macosMachineStateLayer(options) : linuxMachineStateLayer(options);
  return { home, entry, output, layer };
};

const linuxBinding = { schema: "canonfig.installer/v1", platform: "linux", method: "npm", executable: "/runtime/node", arguments: ["/runtime/npm-cli.js"] };

describe("local installer binding contract", () => {
  it.skipIf(process.platform === "win32").each([true, false])("uses only verified Homebrew opt bindings (stable opt exists: %s)", async (stableOpt) => {
    const f = fixture();
    // Canonicalize the temporary root (/var is /private/var on macOS),
    // but retain the opt symlink itself in the expected stable binding.
    const prefix = join(await realpath(f.home), "brew");
    const keg = (version: string) => {
      const root = join(prefix, "Cellar", "node", version);
      const node = join(root, "bin", "node");
      const entry = join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js");
      mkdirSync(dirname(node), { recursive: true });
      mkdirSync(dirname(entry), { recursive: true });
      copyFileSync(process.execPath, node, constants.COPYFILE_FICLONE);
      chmodSync(node, 0o755);
      copyFileSync(f.entry, entry);
      return { root, node, entry };
    };
    const old = keg("24.0.0");
    mkdirSync(join(prefix, "opt"), { recursive: true });
    mkdirSync(join(prefix, "bin"), { recursive: true });
    const opt = join(prefix, "opt", "node");
    if (stableOpt) symlinkSync(old.root, opt);
    symlinkSync(old.node, join(prefix, "bin", "node"));
    symlinkSync(old.entry, join(prefix, "bin", "npm"));
    const binding = await Effect.runPromise(saveInstallerBinding("npm", join(prefix, "bin", "node"), [join(prefix, "bin", "npm")]).pipe(Effect.provide(f.layer)));
    if (!stableOpt) {
      expect(binding.executable).toBe(await realpath(old.node));
      expect(binding.arguments).toEqual([await realpath(old.entry)]);
      expect(await Effect.runPromise(checkInstallerBinding(binding).pipe(Effect.provide(f.layer)))).toMatchObject({ verified: true });
      return;
    }
    expect(binding.executable).toBe(join(opt, "bin", "node"));
    expect(binding.arguments).toEqual([join(opt, "lib", "node_modules", "npm", "bin", "npm-cli.js")]);
    const next = keg("24.1.0");
    unlinkSync(opt);
    symlinkSync(next.root, opt);
    rmSync(old.root, { recursive: true });
    expect(await Effect.runPromise(checkInstallerBinding(binding).pipe(Effect.provide(f.layer))))
      .toMatchObject({ verified: true });
    expect(await Effect.runPromise(loadInstallerBinding("npm").pipe(Effect.provide(f.layer))))
      .toEqual(binding);
  });

  it("identifies an unusable binding when listing otherwise valid bindings", async () => {
    const f = fixture();
    const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
    const root = join(f.home, ".canonfig", "installers");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "npm.json"), JSON.stringify({ schema: "canonfig.installer/v1", method: "npm", platform,
      executable: await realpath(process.execPath), arguments: [await realpath(f.entry)] }));
    writeFileSync(join(root, "uv.json"), JSON.stringify({ schema: "canonfig.installer/v1", method: "uv",
      platform: platform === "linux" ? "macos" : "linux", executable: "/tmp/uv", arguments: [] }));
    const failure = await Effect.runPromise(Effect.flip(listInstallerBindings()).pipe(Effect.provide(f.layer)));
    expect(failure._tag).toBe("HumanActionRequiredError");
    if (failure._tag === "HumanActionRequiredError") expect(failure.recovery).toContain("uv installer binding");
    expect(await Effect.runPromise(loadInstallerBinding("npm").pipe(Effect.provide(f.layer)))).toBeDefined();
  });

  it.skipIf(process.platform === "win32").each(["symlink", "hard link"])("retains cargo proxy argv[0] while checking its rustup target (%s)", async (kind) => {
    const f = fixture();
    const source = join(f.home, "proxy.c"), rustup = join(f.home, "rustup"), cargo = join(f.home, "cargo");
    writeFileSync(source, '#include <stdio.h>\n#include <string.h>\nint main(int argc,char **argv){const char *p=strrchr(argv[0],47);p=p?p+1:argv[0];if(strcmp(p,"cargo"))return 17;puts("cargo 1.0.0-fixture");return 0;}\n');
    const compiled = spawnSync("cc", [source, "-o", rustup], { encoding: "utf8", timeout: 30_000 });
    expect(compiled.status, compiled.stderr).toBe(0);
    if (kind === "hard link") linkSync(rustup, cargo);
    else symlinkSync(rustup, cargo);
    const rustupHome = join(f.home, ".rustup");
    vi.stubEnv("RUSTUP_HOME", rustupHome);
    await expect(Effect.runPromise(saveInstallerBinding("cargo", cargo, []).pipe(Effect.provide(f.layer))))
      .rejects.toThrow("no existing rustup settings");
    expect(() => statSync(rustupHome)).toThrow();
    mkdirSync(rustupHome);
    writeFileSync(join(rustupHome, "settings.toml"), "version = '12'\n");
    const binding = await Effect.runPromise(saveInstallerBinding("cargo", cargo, []).pipe(Effect.provide(f.layer)));
    expect(binding.executable).toBe(join(await realpath(f.home), "cargo"));
    expect(await Effect.runPromise(checkInstallerBinding(binding).pipe(Effect.provide(f.layer)))).toMatchObject({ verified: true });
    const invocation = await Effect.runPromise(resolveInstallerInvocation("cargo").pipe(Effect.provide(f.layer)));
    expect(invocation.executable.absolute).toBe(binding.executable);
    rmSync(rustup);
    if (kind === "symlink") await expect(Effect.runPromise(checkInstallerBinding(binding).pipe(Effect.provide(f.layer)))).rejects.toThrow();
    else expect(await Effect.runPromise(checkInstallerBinding(binding).pipe(Effect.provide(f.layer)))).toMatchObject({ verified: true });
    rmSync(cargo); symlinkSync(process.execPath, cargo);
    await expect(Effect.runPromise(checkInstallerBinding(binding).pipe(Effect.provide(f.layer)))).rejects.toThrow();
  });

  it.each([false, true])("binds Corepack pnpm through a pinned Node entrypoint (direct script: %s)", async (direct) => {
    const f = fixture();
    const entry = join(f.home, "node_modules", "corepack", "dist", "pnpm.js");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, [
      "for (const name of ['COREPACK_ENABLE_NETWORK', 'COREPACK_ENABLE_AUTO_PIN', 'COREPACK_ENABLE_DOWNLOAD_PROMPT', 'RUSTUP_AUTO_INSTALL']) {",
      "if (process.env[name] !== '0') process.exit(19);",
      "}",
      'console.log("1.0.0-fixture");',
    ].join("\n"));
    const selected = direct && process.platform !== "win32" ? join(f.home, "pnpm") : entry;
    if (direct && process.platform !== "win32") symlinkSync(entry, selected);
    const binding = await Effect.runPromise(saveInstallerBinding("pnpm", direct ? selected : process.execPath,
      direct ? [] : [entry]).pipe(Effect.provide(f.layer)));
    expect(binding.executable).toBe(await realpath(process.execPath));
    expect(binding.arguments).toEqual([await realpath(entry)]);
    expect(await Effect.runPromise(checkInstallerBinding(binding).pipe(Effect.provide(f.layer)))).toMatchObject({ verified: true });
    const malformed = { ...binding, arguments: [join(f.home, "pnpm.js")] };
    expect(() => parseInstallerBinding(JSON.stringify(malformed))).toThrow();
  });

  it("rejects shell launchers, command shims, relative paths, injected flags, and extra fields", () => {
    for (const value of [
      { ...linuxBinding, executable: "node" },
      { ...linuxBinding, executable: "/bin/sh" },
      { ...linuxBinding, arguments: ["-e", "arbitrary-code"] },
      { ...linuxBinding, arguments: ["/other/script.js"] },
      { ...linuxBinding, environment: { TOKEN: "not-allowed" } },
      { ...linuxBinding, platform: "windows", executable: "C:\\node\\npm.cmd", arguments: [] },
      { ...linuxBinding, platform: "windows", executable: "C:node.exe", arguments: [] },
      { ...linuxBinding, platform: "windows", executable: "\\\\server\\share\\npm.exe", arguments: [] },
    ]) expect(() => parseInstallerBinding(JSON.stringify(value))).toThrow();
    expect(isLocalInstallerPath("relative/node", "linux")).toBe(false);
    expect(isLocalInstallerPath("C:node.exe", "windows")).toBe(false);
  });

  it("accepts explicit Windows Node entrypoints without Unix mode bits", () => {
    expect(parseInstallerBinding(JSON.stringify({ ...linuxBinding, platform: "windows", executable: "C:\\Program Files\\nodejs\\node.exe", arguments: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"] })).method).toBe("npm");
    expect(parseInstallerBinding(JSON.stringify({ ...linuxBinding, method: "homebrew", executable: "/opt/homebrew/bin/brew", arguments: [] })).method).toBe("brew");
  });

  it("persists the exact tested binding and executes a deterministic recipe with an empty PATH", async () => {
    const f = fixture();
    await Effect.runPromise(saveInstallerBinding("npm", process.execPath, [f.entry]).pipe(Effect.provide(f.layer)));
    // Resolve in a new Effect run: success cannot depend on an in-memory cache.
    const loaded = await Effect.runPromise(loadInstallerBinding("npm").pipe(Effect.provide(f.layer)));
    expect(loaded?.executable).toBe(await realpath(process.execPath));
    expect(loaded?.arguments).toEqual([await realpath(f.entry)]);
    const resource = Schema.decodeUnknownSync(ResourceId)("fixture-npm");
    const platform = process.platform === "win32"
      ? "windows" as const
      : process.platform === "darwin" ? "macos" as const : "linux" as const;
    const provenance = installerRecipeProvenance({
      upstream: "https://registry.npmjs.org/fixture-package",
      version: "1.2.3",
      platform,
      architecture: process.arch,
      artifactDigest: "sha512-Zml4dHVyZQ==",
      entrypoint: process.execPath,
      dependencyPolicy: "scripts-disabled",
      executionContext: "follower-local",
      method: "npm",
      package: "fixture-package",
      compatibility: "mcp-fixture",
      target: "fixture-client",
    });
    const probe = {
      command: [process.execPath, f.entry, "--version"],
      expectContains: "1.0.0-fixture",
      operation: "read fixture version",
    };
    const context = {
      run: Schema.decodeUnknownSync(RunId)("fixture-installer-run"),
      action: {
        id: Schema.decodeUnknownSync(ActionId)("fixture-install"),
        resource,
        kind: "install-tool" as const,
        before: [],
        detail: {
          kind: "install-tool" as const,
          toolId: "fixture",
          method: "npm" as const,
          package: "fixture-package",
          version: "1.2.3",
          buildPolicy: { mode: "scripts-disabled" as const },
          provenance,
        },
      },
      resource: { id: resource, kind: "tool" as const, policy: "ensure" as const, target: "fixture", dependsOn: [], blobs: [] },
      desired: {
        kind: "tool" as const,
        toolId: "fixture",
        recipes: [],
        loginRequired: false,
        qualification: {
          method: "mcp-qualification" as const,
          target: "fixture-client",
          compatibility: "mcp-fixture",
          launches: probe,
          protocolCompatible: probe,
          authenticated: probe,
          functional: probe,
          clientLoaded: probe,
        },
      },
      verification: {
        method: "mcp-qualification" as const,
        target: "fixture-client",
        compatibility: "mcp-fixture",
        launches: probe,
        protocolCompatible: probe,
        authenticated: probe,
        functional: probe,
        clientLoaded: probe,
      },
      artifacts: new Map(),
      limits: { maximumFileBytes: 1024, processTimeoutMilliseconds: 10_000, maximumProcessOutputBytes: 16_384, verificationConcurrency: 1 },
    };
    const qualification = await Effect.runPromise(Effect.gen(function*() {
      const prepared = yield* prepareResourceAction(context);
      yield* prepared.execute;
      return yield* verifyResource(context);
    }).pipe(Effect.provide(f.layer)));
    expect(qualification.qualification?.ready).toBe(true);
    const result = JSON.parse(readFileSync(f.output, "utf8"));
    expect(result).toEqual({ argv: ["install", "--global", "fixture-package@1.2.3", "--ignore-scripts"], path: "" });
  }, 30_000);

  it("runs an npm bin through its approved Node with an empty scheduler PATH", async () => {
    const f = fixture();
    await Effect.runPromise(saveInstallerBinding("npm", process.execPath, [f.entry]).pipe(Effect.provide(f.layer)));
    const windows = process.platform === "win32";
    const bin = windows ? join(f.home, "AppData", "Roaming", "npm") : join(f.home, ".local", "bin");
    const script = join(bin, "node_modules", "fixture-tool", "bin with spaces", "cli.js");
    mkdirSync(join(bin, "node_modules", "fixture-tool", "bin with spaces"), { recursive: true });
    writeFileSync(script, [
      "#!/usr/bin/env node",
      "if ((process.env.PATH ?? process.env.Path ?? '') !== '') throw new Error('PATH was changed');",
      "console.log('computed:' + process.argv.slice(2).map(Number).reduce((sum, n) => sum + n, 0));",
      "//" + "padding".repeat(1000),
    ].join("\n"));
    const command = join(bin, windows ? "fixture-tool.cmd" : "fixture-tool");
    if (windows) {
      writeFileSync(command, 'SET "_prog=node"\r\n"%_prog%" "%dp0%\\node_modules\\fixture-tool\\bin with spaces\\cli.js" %*\r\n');
    } else {
      chmodSync(script, 0o755);
      symlinkSync(script, command);
    }
    const resource = Schema.decodeUnknownSync(ResourceId)("fixture-tool");
    const context: ResourceExecutionContext = {
      run: Schema.decodeUnknownSync(RunId)("fixture-tool-run"),
      action: {
        id: Schema.decodeUnknownSync(ActionId)("fixture-tool-check"), resource,
        kind: "no-op", detail: { kind: "no-op", reason: "installed" }, dependsOn: [],
      },
      resource: { id: resource, kind: "tool", policy: "ensure", target: "fixture-tool", dependsOn: [], blobs: [] },
      desired: {
        kind: "tool", toolId: "fixture-tool", loginRequired: false,
        recipes: [{
          platform: windows ? "windows" : process.platform === "darwin" ? "macos" : "linux",
          method: "npm", package: "fixture-tool", version: "1.0.0",
        }],
      },
      verification: { method: "command", command: ["fixture-tool", "4", "5"], expectContains: "computed:9" },
      artifacts: new Map(),
      limits: { maximumFileBytes: 1024, processTimeoutMilliseconds: 10_000, maximumProcessOutputBytes: 16_384, verificationConcurrency: 1 },
    };
    const result = await Effect.runPromise(verifyResource(context).pipe(Effect.provide(f.layer)));
    expect(result).toMatchObject({ passed: true, method: "command:fixture-tool", exitCode: 0 });
  }, 30_000);

  it("repairs and removes malformed regular bindings, and keeps identical writes idempotent", async () => {
    const f = fixture();
    const bind = () => Effect.runPromise(saveInstallerBinding("npm", process.execPath, [f.entry]).pipe(Effect.provide(f.layer)));
    await bind();
    const path = join(f.home, ".canonfig", "installers", "npm.json");
    const before = statSync(path).mtimeMs;
    await bind();
    expect(statSync(path).mtimeMs).toBe(before);
    writeFileSync(path, "invalid-json");
    await expect(Effect.runPromise(loadInstallerBinding("npm").pipe(Effect.provide(f.layer)))).rejects.toBeDefined();
    await bind();
    expect((await Effect.runPromise(loadInstallerBinding("npm").pipe(Effect.provide(f.layer))))?.method).toBe("npm");
    writeFileSync(path, "invalid-json-again");
    expect(await Effect.runPromise(removeInstallerBinding("npm").pipe(Effect.provide(f.layer)))).toBe(true);
    expect(await Effect.runPromise(removeInstallerBinding("npm").pipe(Effect.provide(f.layer)))).toBe(false);
  }, 30_000);

  it("fails actionably when a removed binding would otherwise fall back to PATH", async () => {
    const f = fixture();
    await Effect.runPromise(saveInstallerBinding("npm", process.execPath, [f.entry]).pipe(Effect.provide(f.layer)));
    const resolved = await Effect.runPromise(resolveInstallerInvocation("npm").pipe(Effect.provide(f.layer)));
    expect(resolved.arguments).toEqual([await realpath(f.entry)]);
    expect(await Effect.runPromise(removeInstallerBinding("npm").pipe(Effect.provide(f.layer)))).toBe(true);
    // The removal is recorded in the binding file itself: one atomic write
    // per transition, so no interleaving can lose both the binding and its
    // record.
    const record = JSON.parse(readFileSync(join(f.home, ".canonfig", "installers", "npm.json"), "utf8"));
    expect(record.schema).toBe("canonfig.installer-removed/v1");
    expect(await Effect.runPromise(removeInstallerBinding("npm").pipe(Effect.provide(f.layer)))).toBe(false);
    const refused = await Effect.runPromise(
      resolveInstallerInvocation("npm").pipe(Effect.provide(f.layer), Effect.flip),
    );
    expect(refused._tag).toBe("HumanActionRequiredError");
    if (refused._tag !== "HumanActionRequiredError") throw new Error("expected a human-action failure");
    expect(refused.recovery).toContain("explicitly removed");
    await Effect.runPromise(saveInstallerBinding("npm", process.execPath, [f.entry]).pipe(Effect.provide(f.layer)));
    const rebound = await Effect.runPromise(resolveInstallerInvocation("npm").pipe(Effect.provide(f.layer)));
    expect(rebound.arguments).toEqual([await realpath(f.entry)]);
    // Oversized malformed content is still present content: removal records
    // the removal instead of failing on the bounded read.
    writeFileSync(join(f.home, ".canonfig", "installers", "npm.json"), "x".repeat(20 * 1024));
    expect(await Effect.runPromise(removeInstallerBinding("npm").pipe(Effect.provide(f.layer)))).toBe(true);
    const refusedOversized = await Effect.runPromise(
      resolveInstallerInvocation("npm").pipe(Effect.provide(f.layer), Effect.flip),
    );
    expect(refusedOversized._tag).toBe("HumanActionRequiredError");
    // Unreadable content is still present content: removal records the
    // removal instead of failing on the read. POSIX-only: on Windows the
    // permission bits become a read-only flag that also blocks replacement,
    // so removal loudly reports EPERM there instead.
    if (process.platform !== "win32") {
      const bindingPath = join(f.home, ".canonfig", "installers", "npm.json");
      await Effect.runPromise(saveInstallerBinding("npm", process.execPath, [f.entry]).pipe(Effect.provide(f.layer)));
      chmodSync(bindingPath, 0o000);
      try {
        expect(await Effect.runPromise(removeInstallerBinding("npm").pipe(Effect.provide(f.layer)))).toBe(true);
        const refusedUnreadable = await Effect.runPromise(
          resolveInstallerInvocation("npm").pipe(Effect.provide(f.layer), Effect.flip),
        );
        expect(refusedUnreadable._tag).toBe("HumanActionRequiredError");
      } finally {
        chmodSync(bindingPath, 0o600);
      }
    }
  }, 30_000);

  it("rejects relative input, moved entrypoints, and failed checks without installing anything", async () => {
    const f = fixture();
    await expect(Effect.runPromise(saveInstallerBinding("npm", "node", [f.entry]).pipe(Effect.provide(f.layer)))).rejects.toBeDefined();
    await Effect.runPromise(saveInstallerBinding("npm", process.execPath, [f.entry]).pipe(Effect.provide(f.layer)));
    rmSync(f.entry);
    await expect(Effect.runPromise(resolveInstallerInvocation("npm").pipe(Effect.provide(f.layer)))).rejects.toBeDefined();
    writeFileSync(f.entry, "process.exit(4);");
    const binding = await Effect.runPromise(loadInstallerBinding("npm").pipe(Effect.provide(f.layer)));
    expect(binding).toBeDefined();
    await expect(Effect.runPromise(checkInstallerBinding(binding!).pipe(Effect.provide(f.layer)))).rejects.toBeDefined();
  }, 30_000);

  it("the supported CLI sets, lists, checks, and removes bindings using stable JSON", async () => {
    const f = fixture();
    const invoke = async (args: string[]) => {
      let stdout = "", stderr = "", exitCode = -1;
      await Effect.runPromise(runInstallerCli([...args, "--json"], {
        writeStdout: (text) => { stdout += text; }, writeStderr: (text) => { stderr += text; }, setExitCode: (code) => { exitCode = code; },
      }).pipe(Effect.provide(f.layer)));
      return { exitCode, output: JSON.parse(stdout || stderr) };
    };
    expect((await invoke(["set", "npm", "--executable", process.execPath, "--arg", f.entry])).exitCode).toBe(0);
    expect((await invoke(["list"])).output.data.bindings).toHaveLength(1);
    expect((await invoke(["check", "npm"])).output.data.scope).toBe("current-process");
    expect((await invoke(["remove", "npm"])).output.data.removed).toBe(true);
    expect((await invoke(["check", "npm"])).exitCode).toBe(3);
  }, 30_000);

  // The deterministic executor owns the uv recipe flags, including --no-build.
  // A binding may only replace the program, never prepend to its arguments, so
  // routing uv through a persisted binding cannot alter that policy.
  it("keeps a uv binding free of any argument prefix", () => {
    const uvBinding = { schema: "canonfig.installer/v1", method: "uv", platform: "linux" };
    expect(parseInstallerBinding(JSON.stringify({ ...uvBinding, executable: "/runtime/uv", arguments: [] })).arguments)
      .toEqual([]);
    // Only npm and pnpm may name a JavaScript entrypoint, and only that one.
    for (const arguments_ of [["/runtime/uv.js"], ["--no-build"], ["--build"]]) {
      expect(() => parseInstallerBinding(JSON.stringify({ ...uvBinding, executable: "/runtime/node", arguments: arguments_ })))
        .toThrow();
      expect(() => parseInstallerBinding(JSON.stringify({ ...uvBinding, executable: "/runtime/uv", arguments: arguments_ })))
        .toThrow();
    }
  });

  it("treats --json as a global option at any position", () => {
    expect(isInstallerCommand(["--json", "installer", "list"])).toBe(true);
    expect(isInstallerCommand(["source", "publish"])).toBe(false);
    expect(installerArguments(["--json", "installer", "list"])).toEqual(["--json", "list"]);
    expect(installerArguments(["installer", "set", "npm", "--executable", "/opt/installer"]))
      .toEqual(["set", "npm", "--executable", "/opt/installer"]);
  });

  // The shipped entrypoint has to provide the installer CLI its machine layer.
  // Calling runInstallerCli with a test layer cannot catch that wiring.
  it("reaches the installer CLI through the real entrypoint", () => {
    const home = mkdtempSync(join(tmpdir(), "canonfig-installer-entrypoint-"));
    roots.push(home);
    const result = spawnSync(process.execPath, [
      "--import", "tsx", resolve(import.meta.dirname, "../../src/runtime/main.ts"),
      "installer", "list", "--json",
    ], {
      encoding: "utf8", timeout: 20_000,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.bindings).toEqual([]);
  }, 30_000);
});

// Usability 6: on Windows, PATH resolves npm to npm.cmd, which Canonfig cannot
// run without a shell. The Windows machine layer runs here on any host with
// Windows-shaped paths; the double answers executable lookup and file kinds.
describe("Windows npm command shims", () => {
  const nodejs = "C:\\Program Files\\nodejs";
  const node = `${nodejs}\\node.exe`;
  const npmCli = `${nodejs}\\node_modules\\npm\\bin\\npm-cli.js`;
  const bindingCommand = `canonfig installer set npm --executable "${node}" --arg "${npmCli}"`;
  const installers = "C:\\Users\\operator\\.canonfig\\installers";
  const windowsFollower = (input: {
    readonly executables: Readonly<Record<string, string>>;
    readonly files: ReadonlyArray<string>;
    readonly bindings?: Readonly<Record<string, string>>;
  }) => Layer.effect(MachineState, Effect.gen(function*() {
    const base = yield* MachineState;
    const bindings = input.bindings ?? {};
    const missing = (path: string) => new MachineFilesystemError({
      operation: "inspect path", path, message: `ENOENT: no such file or directory, lstat '${path}'`,
    });
    return MachineState.of({
      ...base,
      findExecutable: (query) => {
        const path = input.executables[query.name];
        return path === undefined
          ? Effect.fail(new ExecutableNotFoundError({ executable: query.name, searched: [nodejs] }))
          : Effect.succeed({ name: query.name, path: { platform: "windows" as const, absolute: path } });
      },
      inspectPath: (path) =>
        path.absolute === installers && Object.keys(bindings).length > 0
          ? Effect.succeed({ kind: "directory" as const })
          : input.files.includes(path.absolute) || path.absolute in bindings
          ? Effect.succeed({ kind: "regular" as const })
          : Effect.fail(missing(path.absolute)),
      readFile: (read) => {
        const content = bindings[read.path.absolute];
        return content === undefined
          ? Effect.fail(missing(read.path.absolute))
          : Effect.succeed(new TextEncoder().encode(content));
      },
    });
  })).pipe(Layer.provide(windowsMachineStateLayer({
    environment: [
      { name: "USERPROFILE", value: "C:\\Users\\operator" },
      { name: "APPDATA", value: "C:\\Users\\operator\\AppData\\Roaming" },
      { name: "LOCALAPPDATA", value: "C:\\Users\\operator\\AppData\\Local" },
      { name: "PATH", value: nodejs },
      { name: "PATHEXT", value: ".COM;.EXE;.BAT;.CMD" },
    ],
  })));
  const runWindows = <Value, Failure>(
    layer: Layer.Layer<MachineState>,
    effect: Effect.Effect<Value, Failure, MachineState>,
  ) => Effect.runPromise(effect.pipe(Effect.provide(layer)));

  it("warns in the plan and names the node.exe plus npm-cli.js binding for an unbound npm.cmd", async () => {
    const layer = windowsFollower({
      executables: { npm: `${nodejs}\\npm.cmd`, node, uv: "C:\\Users\\operator\\.local\\bin\\uv.exe" },
      files: [node, npmCli],
    });
    expect(await runWindows(layer, installerRefusals(["npm", "uv", "npm"]))).toEqual([
      `installer npm: No installer binding is set for npm, and PATH resolves it to the Windows command shim ${nodejs}\\npm.cmd, which cannot run without a shell. Bind npm to Node and its own entrypoint instead, then retry:\n${bindingCommand}`,
    ]);
    const refusal = await runWindows(layer, Effect.flip(resolveInstallerInvocation("npm")));
    expect(refusal).toMatchObject({ _tag: "HumanActionRequiredError" });
    expect(refusal._tag === "HumanActionRequiredError" ? refusal.recovery : "").toContain(bindingCommand);

    const output = { stdout: "", stderr: "", exitCode: -1 };
    const io = {
      writeStdout: (text: string) => { output.stdout += text; },
      writeStderr: (text: string) => { output.stderr += text; },
      setExitCode: (code: number) => { output.exitCode = code; },
    };
    await runWindows(layer, runInstallerCli(["check", "npm"], io));
    expect(output.exitCode).toBe(3);
    expect(output.stderr).toContain(bindingCommand);
    await runWindows(layer, runInstallerCli(["list", "--json"], io));
    expect(JSON.parse(output.stdout).data).toEqual({
      bindings: [],
      suggestions: [{ method: "npm", shim: `${nodejs}\\npm.cmd`, command: bindingCommand }],
    });
  });

  it("suggests Node plus the existing Corepack pnpm entrypoint for a Windows shim", async () => {
    const entrypoint = `${nodejs}\\node_modules\\corepack\\dist\\pnpm.js`;
    const layer = windowsFollower({ executables: { pnpm: `${nodejs}\\pnpm.cmd`, node }, files: [node, entrypoint] });
    expect(await runWindows(layer, unboundInstallerRecovery("pnpm"))).toContain(`--arg "${entrypoint}"`);
    expect(parseInstallerBinding(JSON.stringify({ schema: "canonfig.installer/v1", method: "pnpm", platform: "windows",
      executable: node, arguments: [entrypoint] })).arguments).toEqual([entrypoint]);
  });

  it("takes npm-cli.js beside an npm.cmd upgraded into %APPDATA% and node.exe from PATH", async () => {
    const roaming = "C:\\Users\\operator\\AppData\\Roaming\\npm";
    const roamingCli = `${roaming}\\node_modules\\npm\\bin\\npm-cli.js`;
    const layer = windowsFollower({
      executables: { npm: `${roaming}\\npm.cmd`, node },
      files: [node, npmCli, roamingCli],
    });
    expect(await runWindows(layer, unboundInstallerRecovery("npm"))).toBe(
      `No installer binding is set for npm, and PATH resolves it to the Windows command shim ${roaming}\\npm.cmd, which cannot run without a shell. Bind npm to Node and its own entrypoint instead, then retry:\ncanonfig installer set npm --executable "${node}" --arg "${roamingCli}"`,
    );
  });

  it("names the shim a recorded binding points to, and gives the shape when npm-cli.js is missing", async () => {
    const shim = `${nodejs}\\npm.cmd`;
    const pointsAtShim = windowsFollower({
      executables: { npm: shim, node },
      files: [node, npmCli],
      bindings: {
        [`${installers}\\npm.json`]: JSON.stringify({
          schema: "canonfig.installer/v1", method: "npm", platform: "windows", executable: shim, arguments: [],
        }),
      },
    });
    const refusal = await runWindows(pointsAtShim, Effect.flip(loadInstallerState("npm")));
    expect(refusal).toMatchObject({
      _tag: "HumanActionRequiredError",
      recovery: `The installer binding for npm names the Windows command shim ${shim}, which cannot run without a shell. Bind npm to Node and its own entrypoint instead, then retry:\n${bindingCommand}`,
    });

    const noEntrypoint = windowsFollower({ executables: { npm: shim, node }, files: [node] });
    expect(await runWindows(noEntrypoint, unboundInstallerRecovery("npm"))).toBe(
      `No installer binding is set for npm, and PATH resolves it to the Windows command shim ${shim}, which cannot run without a shell. Bind npm to node.exe plus npm-cli.js with canonfig installer set npm --executable <node.exe> --arg <entrypoint>, then retry. Do not enable a shell.`,
    );
  });
});

it.each(["human", "json"])("preserves the installer parser's actionable error in %s output", async (format) => {
  const f = fixture();
  let stdout = "", stderr = "", exitCode = -1;
  await Effect.runPromise(runInstallerCli(["set", "npm", ...(format === "json" ? ["--json"] : [])], {
    writeStdout: (text) => { stdout += text; },
    writeStderr: (text) => { stderr += text; },
    setExitCode: (code) => { exitCode = code; },
  }).pipe(Effect.provide(f.layer)));
  expect(exitCode).toBe(2);
  expect(stdout).toBe("");
  if (format === "json") expect(JSON.parse(stderr)).toMatchObject({ schema: "canonfig.cli/v1", exitCode: 2, message: "Installer set requires --executable" });
  else expect(stderr).toContain("Installer set requires --executable");
});


it.each([
  [[], "Missing installer command"],
  [["frobnicate"], "Unknown installer command: frobnicate"],
  [["frobnicate", "npm"], "Unknown installer command: frobnicate"],
  [["list", "extra"], "Installer list accepts no arguments"],
] as const)("reports the actual installer action error for %j", async (args, message) => {
  const f = fixture();
  for (const format of ["human", "json"]) {
    let stderr = "", exitCode = -1;
    await Effect.runPromise(runInstallerCli([...args, ...(format === "json" ? ["--json"] : [])], {
      writeStdout: () => { throw new Error("Unexpected stdout"); },
      writeStderr: (text) => { stderr += text; }, setExitCode: (code) => { exitCode = code; },
    }).pipe(Effect.provide(f.layer)));
    expect(exitCode).toBe(2);
    if (format === "json") expect(JSON.parse(stderr).message).toBe(message);
    else expect(stderr).toContain(message);
  }
});
