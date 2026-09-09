import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
// The binding stores what fs/promises.realpath returns, which on Windows
// expands 8.3 short names that fs.realpathSync leaves alone. Resolve the
// expected paths the same way, or the two spellings of one file disagree.
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ActionId, ResourceId, RunId } from "../../src/domain/brand.ts";
import { isLocalInstallerPath, parseInstallerBinding } from "../../src/domain/installer-binding.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { macosMachineStateLayer } from "../../src/machine/macos.layer.ts";
import { windowsMachineStateLayer } from "../../src/machine/windows.layer.ts";
import { checkInstallerBinding, loadInstallerBinding, removeInstallerBinding, resolveInstallerInvocation, saveInstallerBinding } from "../../src/synchronization/installer-bindings.ts";
import { prepareResourceAction } from "../../src/synchronization/resource-executors.ts";
import { installerArguments, isInstallerCommand, runInstallerCli } from "../../src/runtime/installer-cli.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-installer-binding-"));
  roots.push(home);
  const entry = join(home, "npm-cli.js");
  const output = join(home, "invocation.json");
  writeFileSync(entry, [
    "const fs = require('node:fs');",
    "if (process.argv[2] === '--version') console.log('1.0.0-fixture');",
    `else fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({argv:process.argv.slice(2),path:process.env.PATH??process.env.Path??''}));`,
  ].join("\n"));
  const environment = Object.entries({
    ...process.env, HOME: home, USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), PATH: "",
  }).flatMap(([name, value]) => value === undefined || (name.toLowerCase() === "path" && name !== "PATH") ? [] : [{ name, value }]);
  const options = { environment, credentialPolicy: { kind: "local-file" as const, path: join(home, "credentials") } };
  const layer = process.platform === "win32" ? windowsMachineStateLayer(options)
    : process.platform === "darwin" ? macosMachineStateLayer(options) : linuxMachineStateLayer(options);
  return { home, entry, output, layer };
};

const linuxBinding = { schema: "canonfig.installer/v1", platform: "linux", method: "npm", executable: "/runtime/node", arguments: ["/runtime/npm-cli.js"] };

describe("local installer binding contract", () => {
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
    await Effect.runPromise(Effect.gen(function*() {
      const prepared = yield* prepareResourceAction({
        run: Schema.decodeUnknownSync(RunId)("fixture-installer-run"),
        action: { id: Schema.decodeUnknownSync(ActionId)("fixture-install"), resource, kind: "install-tool", before: [],
          detail: { kind: "install-tool", toolId: "fixture", method: "npm", package: "fixture-package", version: "1.2.3", buildPolicy: { mode: "scripts-disabled" } } },
        resource: { id: resource, kind: "tool", policy: "ensure", target: "fixture", dependsOn: [], blobs: [] },
        desired: { kind: "tool", toolId: "fixture", recipes: [], loginRequired: false },
        verification: { method: "command", command: [process.execPath, f.entry, "--version"] },
        artifacts: new Map(),
        limits: { maximumFileBytes: 1024, processTimeoutMilliseconds: 10_000, maximumProcessOutputBytes: 16_384, verificationConcurrency: 1 },
      });
      yield* prepared.execute;
    }).pipe(Effect.provide(f.layer)));
    const result = JSON.parse(readFileSync(f.output, "utf8"));
    expect(result).toEqual({ argv: ["install", "--global", "fixture-package@1.2.3", "--ignore-scripts"], path: "" });
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
