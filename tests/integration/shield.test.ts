import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { stateRepositoryLayer } from "../../src/state/state-repository.layer.ts";
import { SynchronizationLive } from "../../src/synchronization/synchronization.layer.ts";
import { withRunLock } from "../../src/synchronization/run-lock.ts";
import { loadCanonicalFolder } from "../../src/projection/folder.ts";
import { ingestShield } from "../../src/projection/shield-ingest.ts";
import { synchronizeLocal } from "../../src/projection/sync.ts";
import { shieldModel } from "../../src/projection/shield.ts";
import { nativePluginDigest } from "../../src/projection/native-plugin.ts";
import { emptyModel } from "../../src/projection/detect.ts";
import type { RootContext } from "../../src/projection/harness.ts";
import { hookRegistryJson, hookRunnerSource } from "../../src/projection/templates/runtime.ts";
import { appendShieldLog, readShieldLog, shieldLogPath } from "../../src/projection/shield-log.ts";
import { npmShimEntrypoint } from "../../src/projection/shield-install.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const write = (file: string, content: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); };
const skill = "---\nname: sample\ndescription: Sample skill\n---\nUse the reviewed command.\n";

function fixture(allow: string[] = ["skills", "plugins", "mcp"]) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "canonfig-shield-test-")));
  roots.push(home);
  const folder = join(home, ".canonfig");
  const statePath = join(folder, "state.sqlite");
  write(join(folder, "canonfig.jsonc"), JSON.stringify({ version: 1, harnesses: ["claude-code", "codex"], local: { allow } }));
  write(join(folder, "local", "local.jsonc"), JSON.stringify({ shield: { enabled: true, hard: false } }));
  for (const command of ["claude", "codex"]) {
    write(join(home, "bin", command), "#!/bin/sh\nexit 0\n");
    chmodSync(join(home, "bin", command), 0o755);
  }
  const environment = new Map([["HOME", home], ["PATH", join(home, "bin")], ["XDG_CONFIG_HOME", join(home, ".config")]]);
  const context: RootContext = { home, platform: "linux", appData: join(home, ".config"), join, environment: (name) => environment.get(name) };
  const machine = linuxMachineStateLayer({ environment: [...environment].map(([name, value]) => ({ name, value })), credentialPolicy: { kind: "local-file", path: join(home, "credentials") } });
  const layer = SynchronizationLive.pipe(Layer.provideMerge(stateRepositoryLayer(statePath)), Layer.provideMerge(machine));
  const sync = (mode: "plan" | "apply" = "apply") => Effect.runPromise(synchronizeLocal(statePath, mode, { environment: context.environment }).pipe(Effect.provide(layer)));
  const ingest = async () => Effect.runPromise(withRunLock(statePath, "shield test", ingestShield({
    target: { folder, statePath, scope: "local" }, context, loaded: await loadCanonicalFolder(folder), applied: [],
  })).pipe(Effect.provide(layer)));
  return { home, folder, context, sync, ingest };
}

describe("Shield admission and projection", () => {
  it("redirects descendant skills install through a forwarded harness command", () => {
    const f = fixture();
    const executable = (name: string, body: string) => {
      const script = join(f.home, "bin", `${name}.cjs`);
      write(script, body);
      write(join(f.home, "bin", name), `#!${process.execPath}\n${body}`);
      chmodSync(join(f.home, "bin", name), 0o755);
      write(join(f.home, "bin", `${name}.cmd`), `@"${process.execPath}" "${script}" %*\r\n`);
    };
    executable("npx", [
      'const fs = require("node:fs"); const path = require("node:path");',
      'const directory = path.join(process.env.HOME, ".claude", "skills", "sample");',
      'fs.mkdirSync(directory, { recursive: true });',
      `fs.writeFileSync(path.join(directory, "SKILL.md"), ${JSON.stringify(skill)});`,
    ].join("\n"));
    executable("claude", 'const child = require("node:child_process").spawnSync("npx", ["--yes", "skills", "install", "fixture"], { stdio: "inherit", shell: process.platform === "win32" }); process.exit(child.status ?? 1);');
    const child = spawnSync(process.execPath, ["--import", "tsx", resolve("src/runtime/main.ts"), "--json", "shield", "run", "--", process.execPath, "-e",
      'const child = require("node:child_process").spawnSync("claude", ["-p", "fixture"], { stdio: "inherit", shell: process.platform === "win32" }); process.exit(child.status ?? 1);'], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, HOME: f.home, USERPROFILE: f.home, APPDATA: join(f.home, ".config"), LOCALAPPDATA: join(f.home, ".local"),
        XDG_CONFIG_HOME: join(f.home, ".config"), XDG_CACHE_HOME: join(f.home, ".cache"), XDG_DATA_HOME: join(f.home, ".local", "share"), XDG_STATE_HOME: join(f.home, ".local", "state"),
        CLAUDE_CONFIG_DIR: join(f.home, ".claude"), CODEX_HOME: join(f.home, ".codex"),
        CANONFIG_LOCAL_CREDENTIAL_ROOT: join(f.home, "credentials"), CANONFIG_LOG_FILE: join(f.home, "commands.log"),
        PATH: [join(f.home, "bin"), dirname(process.execPath), process.env.PATH].join(delimiter) },
    });
    expect(child.status, child.stderr || child.stdout).toBe(0);
    expect(existsSync(join(f.home, ".claude", "skills", "sample"))).toBe(false);
    expect(readFileSync(join(f.folder, "skills", "sample", "SKILL.md"), "utf8")).toBe(skill);
  });

  it("ingests new skills and shared aliases but preserves edits to managed skills and credentials", async () => {
    const f = fixture();
    expect((await f.sync()).outcome).toMatchObject({ outcome: "Converged" });
    const auth = join(f.home, ".codex", "auth.json");
    write(auth, '{"fixture":"never-copy"}');
    const shared = join(f.home, ".agents", "skills", "sample");
    write(join(shared, "SKILL.md"), skill);
    symlinkSync(shared, join(f.home, ".claude", "skills", "sample"), "dir");
    await f.sync("plan");
    expect(existsSync(join(f.folder, "skills", "sample"))).toBe(false);
    expect((await f.sync()).outcome).toMatchObject({ outcome: "Converged" });
    expect(readFileSync(join(f.folder, "skills", "sample", "SKILL.md"), "utf8")).toBe(skill);
    expect((await readShieldLog(f.folder)).filter((entry) => entry.kind === "ingested").map((entry) => entry.item)).toContain("skills/sample");
    expect(lstatSync(join(f.home, ".claude", "skills", "sample")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(shared, "SKILL.md"), "utf8")).toBe(skill);
    expect(readFileSync(auth, "utf8")).toBe('{"fixture":"never-copy"}');
    write(join(f.home, ".claude", "skills", "sample", "SKILL.md"), skill + "Local edit.\n");
    expect((await f.sync()).outcome).toMatchObject({ outcome: "FollowerDrift" });
    expect(readFileSync(join(f.folder, "skills", "sample", "SKILL.md"), "utf8")).toBe(skill);
  });

  it("routes follower additions only to local and refuses disallowed categories without deleting input", async () => {
    const f = fixture();
    const mirror = readFileSync(join(f.folder, "canonfig.jsonc"));
    const foreign = join(f.home, ".claude", "skills", "sample", "SKILL.md");
    write(foreign, skill);
    expect((await f.ingest()).imported).toEqual(["skills/sample"]);
    expect(readFileSync(join(f.folder, "local", "skills", "sample", "SKILL.md"), "utf8")).toBe(skill);
    expect(readFileSync(join(f.folder, "canonfig.jsonc"))).toEqual(mirror);
    expect(existsSync(join(f.folder, "skills", "sample"))).toBe(false);
    const denied = fixture([]);
    const retained = join(denied.home, ".claude", "skills", "sample", "SKILL.md");
    write(retained, skill);
    await expect(denied.ingest()).rejects.toThrow("does not allow local skills");
    expect(readFileSync(retained, "utf8")).toBe(skill);
    expect(existsSync(join(denied.folder, "local", "skills", "sample"))).toBe(false);
  });

  it("keeps a native package whole and inactive until review, then retires it on exclusion", async () => {
    const f = fixture();
    await f.sync();
    const native = join(f.home, ".claude", "skills", "package-proof");
    write(join(native, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "package-proof", version: "1.0.0" }));
    write(join(native, "skills", "sample", "SKILL.md"), skill);
    write(join(native, "hooks", "hooks.json"), '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo reviewed"}]}]}}');
    expect((await f.sync()).outcome).toMatchObject({ outcome: "Converged" });
    expect(existsSync(native)).toBe(false);
    expect(existsSync(join(f.folder, "skills", "sample"))).toBe(false);
    const [plugin] = (await loadCanonicalFolder(f.folder)).model.plugins;
    expect(plugin?.reviewed).toBe(false);
    const manifest = join(f.folder, "plugins", "claude-code-package-proof", "plugin.jsonc");
    write(manifest, JSON.stringify({ ...plugin!.manifest, review: { reviewer: "fixture", digest: plugin!.digest } }));
    expect((await f.sync()).outcome).toMatchObject({ outcome: "Converged" });
    expect(readFileSync(join(native, "skills", "sample", "SKILL.md"), "utf8")).toBe(skill);
    expect(JSON.parse(readFileSync(join(native, "hooks", "hooks.json"), "utf8")).hooks.SessionStart[0].hooks[0].command).toBe("echo reviewed");
    write(join(f.folder, "local", "local.jsonc"), JSON.stringify({ shield: { enabled: true, hard: false }, excludePlugins: ["claude-code-package-proof"] }));
    expect((await f.sync()).outcome).toMatchObject({ outcome: "Converged" });
    expect(existsSync(native)).toBe(false);
    expect(existsSync(manifest)).toBe(true);
    expect(nativePluginDigest(plugin!.manifest, plugin!.files.map((file) => file.path.endsWith("hooks.json") ? { ...file, executable: !file.executable } : file))).not.toBe(plugin!.digest);
  });

  it("blocks protected tool writes with the follower destination, including aliases and patch moves", () => {
    const f = fixture();
    mkdirSync(join(f.home, ".claude", "skills"), { recursive: true });
    symlinkSync(join(f.home, ".claude", "skills"), join(f.home, "alias"), "dir");
    const model = shieldModel({ ...emptyModel(f.folder), harnesses: ["claude-code", "codex"] }, f.context, "local");
    const hook = model.hooks[0]!;
    const execute = (toolName: string, toolInput: Record<string, string> | string) => spawnSync(process.execPath, hook.run.slice(1), {
      input: JSON.stringify({ toolName, toolInput, cwd: f.home }), encoding: "utf8", cwd: f.home, timeout: 10_000,
    });
    const denied = execute("Write", { file_path: join(f.home, "alias", "sample", "SKILL.md"), content: skill });
    expect(denied.status, denied.stderr).toBe(2);
    expect(JSON.parse(denied.stdout).reason).toContain(join(f.folder, "local", "skills", "sample", "SKILL.md"));
    expect(execute("apply_patch", `*** Begin Patch\n*** Update File: safe\n*** Move to: ${join(f.home, ".claude", "skills", "moved")}\n*** End Patch`).status).toBe(2);
    expect(execute("apply_patch", { command: `*** Begin Patch\n*** Add File: ${join(f.home, ".codex", "skills", "sample", "SKILL.md")}\n+content\n*** End Patch` }).status).toBe(2);
    expect(execute("edit", { input: `[${join(f.home, ".claude", "skills", "sample", "SKILL.md")}#AB12]\nPUT 1.=1:\n+content` }).status).toBe(2);
    expect(execute("edit", { input: `[safe#AB12]\nMV "${join(f.home, ".claude", "skills", "moved")}"` }).status).toBe(2);
    expect(execute("Write", { path: join(f.folder, "local", "skills", "sample", "SKILL.md") }).status).toBe(0);
    expect(execute("Write", { path: join(f.home, ".claude", ".credentials.json") }).status).toBe(0);
    expect(execute("Bash", { command: "canonfig shield install -- npx skills add public/repo" }).status).toBe(0);
    expect(execute("Bash", { command: "npx skills add public/repo" }).status).toBe(2);
    expect(execute("Bash", { command: "cat ~/.claude/skills/sample/SKILL.md" }).status).toBe(0);
    expect(execute("Bash", { command: "ls ~/.claude/skills/sample/SKILL.md 2>/dev/null" }).status).toBe(0);
    expect(execute("Bash", { command: "printf bad > ~/.claude/skills/sample/SKILL.md" }).status).toBe(2);
    expect(execute("Bash", { command: "cp ./sample ~/.claude/skills/sample/SKILL.md" }).status).toBe(2);
    // Every block left one log line with a home-relative path or the bare installer phrase, never the content.
    const log = readFileSync(shieldLogPath(f.folder), "utf8");
    expect(log).not.toContain("content");
    expect(log).not.toContain("public/repo");
    expect(JSON.parse(log.split("\n")[0]!)).toMatchObject({ kind: "blocked", path: "~/alias/sample/SKILL.md" });
    expect(log).toContain('"installer":"skills add"');
  });

  it("keeps 30 days of log entries and skips torn lines", async () => {
    const f = fixture();
    const now = Date.parse("2026-11-14T12:00:00Z");
    write(shieldLogPath(f.folder), [
      JSON.stringify({ at: "2026-10-01T00:00:00Z", kind: "ingested", path: "~/.claude/skills/old", item: "skills/old" }),
      '{"at":"2026-11-13T00:00:00Z","kind":"blo',
      JSON.stringify({ at: "2026-11-13T00:00:00Z", kind: "blocked", harness: "codex", path: "~/.codex/skills/kept" }),
    ].join("\n") + "\n");
    expect(await readShieldLog(f.folder, now)).toEqual([{ at: "2026-11-13T00:00:00Z", kind: "blocked", harness: "codex", path: "~/.codex/skills/kept" }]);
    await appendShieldLog(f.folder, [{ at: "2026-11-14T00:00:00Z", kind: "installed", installer: "skills", items: ["skills/new"] }], now);
    expect((await readShieldLog(f.folder, now)).map((entry) => entry.kind)).toEqual(["installed", "blocked"]);
    expect(readFileSync(shieldLogPath(f.folder), "utf8")).not.toContain("skills/old");
  });

  it("returns native denial envelopes and redirects Antigravity file and command writes", () => {
    const f = fixture();
    const model = shieldModel({ ...emptyModel(f.folder), harnesses: ["claude-code"] }, f.context, "local");
    const hook = model.hooks[0]!;
    const runner = join(f.folder, ".runtime", "hook-runner.mjs");
    write(runner, hookRunnerSource("hooks.json"));
    write(join(f.folder, ".runtime", "hooks.json"), hookRegistryJson([hook]));
    const execute = (target: string, payload: unknown) => spawnSync(process.execPath,
      [runner, "--hook", hook.id, "--target", target, "--event", "before_tool"], {
        input: JSON.stringify(payload), encoding: "utf8", cwd: f.home, timeout: 10_000,
      });
    const protectedFile = join(f.home, ".claude", "skills", "sample", "SKILL.md");
    const antigravity = execute("antigravity", { toolCall: { name: "write_to_file", args: { TargetFile: protectedFile } } });
    expect(antigravity.status, antigravity.stderr).toBe(0);
    expect(JSON.parse(antigravity.stdout)).toMatchObject({ decision: "deny", reason: expect.stringContaining(join(f.folder, "local", "skills", "sample", "SKILL.md")) });
    const shell = execute("antigravity", { toolCall: { name: "run_command", args: { CommandLine: "printf bad > SKILL.md", Cwd: dirname(protectedFile) } } });
    expect(JSON.parse(shell.stdout).decision).toBe("deny");
    const allowed = execute("antigravity", { toolCall: { name: "write_to_file", args: { TargetFile: join(f.folder, "local", "skills", "sample", "SKILL.md") } } });
    expect(JSON.parse(allowed.stdout)).toEqual({ decision: "allow" });
    const cursor = execute("cursor", { tool_name: "Write", tool_input: { file_path: protectedFile } });
    expect(cursor.status, cursor.stderr).toBe(0);
    expect(JSON.parse(cursor.stdout)).toMatchObject({ permission: "deny", agent_message: expect.stringContaining(join(f.folder, "local", "skills", "sample", "SKILL.md")) });
  });

  it("finds the Node entrypoint of an npm Windows command shim and refuses shims that need a shell", () => {
    // Last lines of what npm's cmd-shim writes for a script with a node shebang, and for one without.
    const nodeShim = "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\npm\\bin\\npx-cli.js\" %*\r\n";
    const directShim = "CALL :find_dp0\r\n\"%dp0%\\node_modules\\npm\\bin\\npx-cli.js\"   %*\r\n";
    expect(npmShimEntrypoint(nodeShim)).toBe("node_modules\\npm\\bin\\npx-cli.js");
    expect(npmShimEntrypoint(directShim)).toBeUndefined();
  });
});
