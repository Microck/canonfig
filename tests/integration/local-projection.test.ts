import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Fiber, Layer, Schema } from "effect";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";

import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { MachineFilesystemError } from "../../src/machine/machine-state.errors.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import { adapterFor } from "../../src/projection/adapters/index.ts";
import { loadCanonicalFolder } from "../../src/projection/folder.ts";
import { TARGET_IDS, type TargetId } from "../../src/projection/model.ts";
import { rootContext } from "../../src/projection/plan.ts";
import { abandonLocal, recoverLocal, restoreLocal, synchronizeLocal } from "../../src/projection/sync.ts";
import { listSnapshots, pruneSnapshots, readSnapshot, writeTakeoverSnapshot, type TakeoverUnit } from "../../src/projection/takeover.ts";
import { RunId } from "../../src/domain/brand.ts";
import { stateRepositoryLayer } from "../../src/state/state-repository.layer.ts";
import { StateRepository } from "../../src/state/state-repository.service.ts";
import type { ConfigValue } from "../../src/domain/resource.ts";
import { localProjectionFollower } from "../../src/domain/synchronization.ts";
import { SynchronizationLive } from "../../src/synchronization/synchronization.layer.ts";

/**
 * Local projection end to end: a real temporary HOME, real SQLite and the
 * real Linux machine layer. Nothing is mocked; the interruption test wraps
 * the machine layer to hold one write open, as the synchronization suites do.
 */

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  readonly home: string;
  readonly folder: string;
  readonly statePath: string;
  readonly environment: Record<string, string>;
}

const write = (path: string, content: string, mode?: number) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
};

const fixture = (harnesses: ReadonlyArray<TargetId>, extra: Readonly<Record<string, ConfigValue>> = {}): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-projection-"));
  roots.push(root);
  const home = join(root, "home");
  const folder = join(home, ".canonfig");
  write(join(folder, "canonfig.jsonc"), `// Canonical Folder fixture\n${JSON.stringify({
    version: 1,
    harnesses,
    mcp: {
      docs: { transport: "streamable-http", url: "https://example.invalid/mcp", headers: { Authorization: { fromEnv: "DOCS_TOKEN" } } },
      git: { transport: "stdio", command: "uvx", args: ["mcp-server-git"] },
    },
    hooks: [{ id: "format", event: "after_tool", run: ["hooks/format.sh"], timeoutMs: 5000 }],
    ...extra,
  }, undefined, 2)}\n`);
  write(join(folder, "AGENTS.md"), "# Global instructions\n\nPrefer small diffs.\n");
  write(join(folder, "rules", "style.md"), "---\ndescription: Style rules\npaths: [\"**/*.ts\"]\n---\nUse two spaces.\n");
  write(join(folder, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy the service\n---\nRun scripts/run.sh.\n");
  write(join(folder, "skills", "deploy", "scripts", "run.sh"), "#!/bin/sh\necho deploy\n", 0o755);
  write(join(folder, "agents", "reviewer.md"), "---\ndescription: Reviews changes\ntools: [read, search]\n---\nReview carefully.\n");
  write(join(folder, "commands", "ship.md"), "---\ndescription: Ship it\n---\nShip the change.\n");
  write(join(folder, "hooks", "format.sh"), "#!/bin/sh\nexit 0\n", 0o755);
  // Every harness is installed: a fake executable on the fixture PATH.
  for (const harness of TARGET_IDS) {
    write(join(root, "bin", adapterFor(harness).descriptor.executables[0]!), "#!/bin/sh\nexit 0\n", 0o755);
  }
  return {
    home,
    folder,
    statePath: join(folder, "state.sqlite"),
    environment: { HOME: home, PATH: join(root, "bin"), XDG_CACHE_HOME: join(home, ".cache") },
  };
};

const machineLayer = (value: Fixture) =>
  linuxMachineStateLayer({
    environment: Object.entries(value.environment).map(([name, entry]) => ({ name, value: entry })),
    credentialPolicy: { kind: "local-file", path: join(value.home, "credentials") },
  });

const layer = (value: Fixture, machine: Layer.Layer<MachineState> = machineLayer(value)) =>
  SynchronizationLive.pipe(
    Layer.provideMerge(stateRepositoryLayer(value.statePath)),
    Layer.provideMerge(machine),
  );

const environmentOf = (value: Fixture) => (name: string) => value.environment[name];

const sync = (value: Fixture, mode: "plan" | "apply", noBackup = false) =>
  Effect.runPromise(synchronizeLocal(value.statePath, mode, { noBackup, environment: environmentOf(value) }).pipe(
    Effect.provide(layer(value)),
  ));

const syncFailure = (value: Fixture) =>
  Effect.runPromise(synchronizeLocal(value.statePath, "apply", { noBackup: false, environment: environmentOf(value) }).pipe(
    Effect.flip,
    Effect.provide(layer(value)),
  ));

const restore = (value: Fixture, snapshot?: string) =>
  Effect.runPromise(restoreLocal(value.statePath, snapshot, localProjectionFollower).pipe(Effect.provide(layer(value))));

const runtimePath = (value: Fixture, prefix: string) =>
  join(value.folder, ".runtime", readdirSync(join(value.folder, ".runtime")).find((name) => name.startsWith(prefix))!);

const snapshots = (value: Fixture): ReadonlyArray<string> => {
  const backups = join(value.folder, ".backups");
  return existsSync(backups) ? readdirSync(backups).sort() : [];
};

const takeoverRows = (value: Fixture) => {
  const database = new DatabaseSync(value.statePath, { readOnly: true });
  try {
    return database.prepare("SELECT harness, surface, root, snapshot FROM harness_takeovers ORDER BY harness, surface").all();
  } finally {
    database.close();
  }
};

const appliedCount = (value: Fixture): number =>
  Effect.runSync(Effect.gen(function*() {
    const repository = yield* StateRepository;
    return (yield* repository.loadAppliedResources(localProjectionFollower)).length;
  }).pipe(Effect.provide(stateRepositoryLayer(value.statePath))));

const appliedRecord = (value: Fixture, resource: string) =>
  Effect.runSync(Effect.gen(function*() {
    const repository = yield* StateRepository;
    return (yield* repository.loadAppliedResources(localProjectionFollower)).find((record) => record.resource === resource);
  }).pipe(Effect.provide(stateRepositoryLayer(value.statePath))));

/** Change top-level keys of the fixture's `canonfig.jsonc`, keeping the rest. */
const editFolderConfig = (value: Fixture, changes: Readonly<Record<string, ConfigValue>>) => {
  const path = join(value.folder, "canonfig.jsonc");
  const current = JSON.parse(readFileSync(path, "utf8").replace(/^\/\/.*\n/u, ""));
  write(path, JSON.stringify({ ...current, ...changes }));
};

/** Every file beneath a directory, relative, with its bytes. */
const tree = (root: string) => {
  const files = new Map<string, string>();
  const visit = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, `${prefix}${entry.name}/`);
      else files.set(`${prefix}${entry.name}`, readFileSync(path, "utf8"));
    }
  };
  if (existsSync(root)) visit(root, "");
  return files;
};

/** Seed every never-touch path of the selected harnesses with recognizable bytes. */
const seedNeverTouch = async (value: Fixture): Promise<ReadonlyArray<string>> => {
  const loaded = await loadCanonicalFolder(value.folder);
  const context = Effect.runSync(rootContext(environmentOf(value)).pipe(Effect.provide(machineLayer(value))));
  const paths = loaded.model.harnesses.flatMap((harness) => adapterFor(harness).layout(context, loaded.model).neverTouch);
  const seeded = [...new Set(paths)].filter((path) => !paths.some((other) => other !== path && path.startsWith(`${other}/`)));
  for (const path of seeded) write(path, `never touch ${path}\n`);
  return seeded;
};

const claudeJson = {
  oauthAccount: { accountUuid: "11111111-2222", emailAddress: "user@example.invalid" },
  projects: { "/work/app": { allowedTools: ["Bash"] } },
  mcpServers: { legacy: { command: "legacy-mcp" } },
};

describe("local projection", () => {
  it("keeps the old registry usable while a renamed hook's consumer is drifted", async () => {
    const value = fixture(["amp"]);
    write(join(value.folder, "hooks", "format.sh"), '#!/bin/sh\nprintf executed > "$CANONFIG_ROOT/hook-ran"\n', 0o755);
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    const plugin = join(value.home, ".config", "amp", "plugins", "canonfig.ts");
    const original = readFileSync(plugin, "utf8");
    const registry = runtimePath(value, "hooks.");
    const runner = runtimePath(value, "hook-runner.");
    const before = readFileSync(registry, "utf8");
    write(plugin, `${original}\n// Local change\n`);
    editFolderConfig(value, { hooks: [{ id: "new-format", event: "after_tool", run: ["hooks/format.sh"], timeoutMs: 5000 }] });
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "FollowerDrift" });
    expect(readFileSync(registry, "utf8")).toBe(before);
    expect(existsSync(runner)).toBe(true);
    execFileSync(process.execPath, [runner, "--hook", "format", "--target", "amp", "--event", "after_tool"], {
      input: "{}", cwd: value.folder,
    });
    expect(readFileSync(join(value.folder, "hook-ran"), "utf8")).toBe("executed");
    write(plugin, original);
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    expect(readFileSync(plugin, "utf8")).toContain('runCanonfig("new-format"');
    expect(existsSync(registry)).toBe(false);
    expect(existsSync(runner)).toBe(false);
  });

  it("refuses a repeated restore of released config keys without overwriting user edits", async () => {
    const value = fixture(["codex"]);
    const config = join(value.home, ".codex", "config.toml");
    write(config, 'model = "original"\napproval_policy = "never"\n');
    await sync(value, "apply");
    editFolderConfig(value, { settings: { codex: { model: "managed" } } });
    await sync(value, "apply");
    const snapshot = snapshots(value).at(-1)!;
    editFolderConfig(value, { settings: { codex: { model: "managed", approval_policy: "on-request" } } });
    await sync(value, "apply");
    expect((await restore(value, snapshot)).outcome).toMatchObject({ outcome: "Converged" });
    const edited = readFileSync(config, "utf8").replace('"original"', '"user-choice"');
    write(config, edited);
    const failure = await Effect.runPromise(restoreLocal(value.statePath, snapshot, localProjectionFollower).pipe(
      Effect.flip, Effect.provide(layer(value)),
    ));
    expect(failure._tag).toBe("ProjectionHumanActionError");
    expect(failure.message).toContain("no longer owns");
    expect(readFileSync(config, "utf8")).toBe(edited);
    expect(appliedRecord(value, "harness:codex:config")?.ownedKeys).toEqual(["approval_policy", "mcp_servers"]);
  });

  it("protects drift when a revision replaces every owned config key", async () => {
    const value = fixture(["codex"], { mcp: {}, settings: { codex: { model: "managed" } } });
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    const config = join(value.home, ".codex", "config.toml");
    const original = readFileSync(config, "utf8");
    const edited = original.replace('"managed"', '"local-choice"');
    write(config, edited);
    editFolderConfig(value, { settings: { codex: { approval_policy: "on-request" } } });
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "FollowerDrift" });
    expect(readFileSync(config, "utf8")).toBe(edited);
    expect(appliedRecord(value, "harness:codex:config")?.ownedKeys).toEqual(["model"]);
    write(config, original);
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    expect(readFileSync(config, "utf8")).toContain('approval_policy = "on-request"');
    expect(readFileSync(config, "utf8")).not.toContain("model =");
    expect(appliedRecord(value, "harness:codex:config")?.ownedKeys).toEqual(["approval_policy"]);
  });

  it("keeps hook runtime until a drifted active plugin can be rewritten", async () => {
    const value = fixture(["amp"]);
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    const plugin = join(value.home, ".config", "amp", "plugins", "canonfig.ts");
    const original = readFileSync(plugin, "utf8");
    const edited = `${original}\n// Local edit\n`;
    write(plugin, edited);
    editFolderConfig(value, { hooks: [] });
    const runtime = join(value.folder, ".runtime");
    const before = tree(runtime);
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "FollowerDrift" });
    expect(readFileSync(plugin, "utf8")).toBe(edited);
    expect(tree(runtime)).toEqual(before);
    write(plugin, original);
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    expect(readFileSync(plugin, "utf8")).not.toContain('runCanonfig("format"');
    expect(tree(runtime)).toEqual(new Map());
  });

  it("keeps restored shared skills across the next sync", async () => {
    const value = fixture(["codex"]);
    rmSync(join(value.folder, "skills"), { recursive: true });
    const original = join(value.home, ".agents", "skills", "personal", "SKILL.md");
    write(original, "Personal skill before takeover\n");
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    write(join(value.folder, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy\n---\nDeploy safely.\n");
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    const snapshot = snapshots(value).at(-1)!;
    const restored = await restore(value, snapshot);
    expect(restored.outcome).toMatchObject({ outcome: "Converged" });
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    expect(readFileSync(original, "utf8")).toBe("Personal skill before takeover\n");
    expect(existsSync(join(value.home, ".agents", "skills", "deploy"))).toBe(false);
    expect(appliedRecord(value, "harness:agents:skills")).toBeUndefined();
  });

  it("retains runtime files referenced by an excluded harness after hooks are removed", async () => {
    const value = fixture(["amp"]);
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    const plugin = join(value.home, ".config", "amp", "plugins", "canonfig.ts");
    const runner = runtimePath(value, "hook-runner.");
    const registry = runtimePath(value, "hooks.");
    const before = [plugin, runner, registry].map((path) => readFileSync(path, "utf8"));
    write(join(value.folder, "local", "local.jsonc"), JSON.stringify({ excludeHarnesses: ["amp"] }));
    editFolderConfig(value, { hooks: [] });
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    expect([plugin, runner, registry].map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });

  it("installs hook runtime before a plugin when a later harness needs human action", async () => {
    const value = fixture(["amp", "claude-code"]);
    write(join(value.home, ".claude.json"), "{ invalid JSON\n");
    const result = await sync(value, "apply", true);
    expect(result.outcome).toMatchObject({ outcome: "HumanActionRequired" });
    expect(existsSync(join(value.home, ".config", "amp", "plugins", "canonfig.ts"))).toBe(true);
    expect(readFileSync(runtimePath(value, "hook-runner."), "utf8")).toContain("spawnSync");
    expect(JSON.parse(readFileSync(runtimePath(value, "hooks."), "utf8")))
      .toMatchObject({ version: 1, hooks: [{ id: "format", event: "after_tool" }] });
  });

  it("refuses to redirect an owned Amp config when another alternative appears", async () => {
    const value = fixture(["amp"]);
    const original = join(value.home, ".config", "amp", "settings.jsonc");
    const alternate = join(value.home, ".config", "amp", "settings.json");
    write(original, "{}\n");
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    const managed = readFileSync(original, "utf8");
    write(alternate, "{}\n");
    const failure = await syncFailure(value);
    expect(failure._tag).toBe("ProjectionHumanActionError");
    expect(failure.message).toContain("settings.jsonc");
    expect(readFileSync(original, "utf8")).toBe(managed);
    expect(readFileSync(alternate, "utf8")).toBe("{}\n");
  });

  it("rejects Amp plugin surfaces outside home before taking over any files", async () => {
    const value = fixture(["amp"]);
    const external = join(dirname(value.home), "external-config");
    value.environment.XDG_CONFIG_HOME = external;
    const failure = await syncFailure(value);
    expect(failure._tag).toBe("ProjectionHumanActionError");
    expect(failure.message).toContain("outside the home directory");
    expect(snapshots(value)).toEqual([]);
    expect(existsSync(external)).toBe(false);
    expect(existsSync(join(value.home, ".config", "amp", "AGENTS.md"))).toBe(false);
  });

  it("projects every harness, keeps never-touch state byte-identical, and restores the takeover snapshot", async () => {
    const value = fixture(TARGET_IDS);
    const neverTouch = await seedNeverTouch(value);
    expect(neverTouch.length).toBeGreaterThan(30);
    write(join(value.home, ".claude.json"), `${JSON.stringify(claudeJson, undefined, 2)}\n`);
    write(join(value.home, ".claude", "CLAUDE.md"), "old instructions\n");
    write(join(value.home, ".claude", "skills", "old-skill", "SKILL.md"), "---\nname: old-skill\ndescription: old\n---\nOld.\n");
    write(join(value.home, ".codex", "config.toml"), "# my codex settings\nmodel = \"o3\"\n\n[mcp_servers.old]\ncommand = \"old\"\n");
    const before = Object.fromEntries(neverTouch.map((path) => [path, readFileSync(path, "utf8")]));
    const claudeBefore = tree(join(value.home, ".claude"));
    const codexConfigBefore = readFileSync(join(value.home, ".codex", "config.toml"), "utf8");

    const plan = await sync(value, "plan");
    expect(plan.takeovers.map((entry) => entry.harness).sort()).toEqual([...TARGET_IDS, "agents"].sort());
    expect(plan.takeovers.every((entry) => entry.backup === "takeover snapshot")).toBe(true);
    expect(snapshots(value)).toEqual([]);

    const applied = await sync(value, "apply");
    expect(applied.outcome).toMatchObject({ outcome: "Converged" });
    expect(snapshots(value)).toHaveLength(1);
    expect(readFileSync(join(value.home, ".claude", "CLAUDE.md"), "utf8")).toContain("Prefer small diffs.");
    expect(existsSync(join(value.home, ".claude", "skills", "old-skill"))).toBe(false);
    expect(existsSync(join(value.home, ".agents", "skills", "deploy", "SKILL.md"))).toBe(true);
    expect(statSync(join(value.home, ".agents", "skills", "deploy", "scripts", "run.sh")).mode & 0o100).toBe(0o100);
    const projectedClaude = JSON.parse(readFileSync(join(value.home, ".claude.json"), "utf8"));
    expect(Object.keys(projectedClaude.mcpServers).sort()).toEqual(["docs", "git"]);
    expect(projectedClaude.oauthAccount).toEqual(claudeJson.oauthAccount);
    expect(projectedClaude.projects).toEqual(claudeJson.projects);
    const codexConfig = parseToml(readFileSync(join(value.home, ".codex", "config.toml"), "utf8"));
    expect(codexConfig.model).toBe("o3");
    expect(Object.keys(codexConfig.mcp_servers ?? {}).sort()).toEqual(["docs", "git"]);
    expect(readFileSync(runtimePath(value, "hook-runner."), "utf8")).toContain("spawnSync");
    for (const path of neverTouch) expect(readFileSync(path, "utf8"), path).toBe(before[path]);

    const again = await sync(value, "apply");
    expect(again.outcome).toMatchObject({ outcome: "Converged" });
    expect(again.takeovers).toEqual([]);
    expect(snapshots(value)).toHaveLength(1);

    const restored = await restore(value);
    expect(restored.outcome).toMatchObject({ outcome: "Converged" });
    // Files Canonfig created are removed again; a settings file it created
    // keeps only the keys Canonfig did not own (none here).
    const claudeAfter = tree(join(value.home, ".claude"));
    const settings = claudeAfter.get("settings.json");
    claudeAfter.delete("settings.json");
    expect(claudeAfter).toEqual(claudeBefore);
    expect(settings === undefined || JSON.parse(settings).hooks === undefined).toBe(true);
    expect(readFileSync(join(value.home, ".codex", "config.toml"), "utf8")).toBe(codexConfigBefore);
    expect(JSON.parse(readFileSync(join(value.home, ".claude.json"), "utf8"))).toEqual(claudeJson);
    expect(existsSync(join(value.home, ".agents", "skills", "deploy"))).toBe(false);
    for (const path of neverTouch) expect(readFileSync(path, "utf8"), path).toBe(before[path]);
    expect(takeoverRows(value)).toEqual([]);
    const local = JSON.parse(readFileSync(join(value.folder, "local", "local.jsonc"), "utf8"));
    expect([...local.excludeHarnesses].sort()).toEqual([...TARGET_IDS].sort());

    const afterRestore = await sync(value, "plan");
    expect(afterRestore.takeovers).toEqual([]);
    // Only the Canonfig-owned hook runner remains planned; no harness is touched.
    expect(afterRestore.plan.actions.every((action) => action.resource.startsWith("runtime:"))).toBe(true);
  }, 120_000);

  it("keeps only the owned keys of ~/.claude.json in the takeover snapshot", async () => {
    const value = fixture(["claude-code"]);
    write(join(value.home, ".claude.json"), `${JSON.stringify(claudeJson, undefined, 2)}\n`);
    await sync(value, "apply");
    const [id] = snapshots(value);
    const snapshot = join(value.folder, ".backups", id!);
    const manifest = JSON.parse(readFileSync(join(snapshot, "manifest.json"), "utf8"));
    const claudeEntries = manifest.entries.filter((entry: { target: string }) => entry.target === join(value.home, ".claude.json"));
    expect(claudeEntries.map((entry: { kind: string; key: string }) => [entry.kind, entry.key])).toEqual([["config", "mcpServers"]]);
    expect(JSON.parse(readFileSync(join(snapshot, "claude-code", "keys.json"), "utf8"))).toEqual({
      [join(value.home, ".claude.json")]: { mcpServers: claudeJson.mcpServers },
    });
    const copied = tree(snapshot);
    expect([...copied.keys()].some((path) => path.endsWith(".claude.json"))).toBe(false);
    expect([...copied.values()].some((content) => content.includes("accountUuid"))).toBe(false);
    expect(statSync(snapshot).mode & 0o777).toBe(0o700);
    expect(statSync(join(snapshot, "manifest.json")).mode & 0o777).toBe(0o600);
  }, 60_000);

  it("keeps the first takeover snapshot and the four most recent", async () => {
    const order: ReadonlyArray<TargetId> = ["claude-code", "codex", "opencode", "qwen", "kilo", "cursor"];
    const value = fixture([]);
    for (let index = 1; index <= order.length; index += 1) {
      write(join(value.folder, "canonfig.jsonc"), JSON.stringify({ version: 1, harnesses: order.slice(0, index) }));
      const result = await sync(value, "apply");
      expect(result.outcome).toMatchObject({ outcome: "Converged" });
    }
    const kept = snapshots(value);
    expect(kept).toHaveLength(5);
    const harnessesOf = (id: string) => JSON.parse(readFileSync(join(value.folder, ".backups", id, "manifest.json"), "utf8"))
      .entries.map((entry: { harness: string }) => entry.harness);
    expect(harnessesOf(kept[0]!)).toContain("claude-code");
    expect(harnessesOf(kept[1]!)).not.toContain("codex");
    expect(harnessesOf(kept[4]!)).toContain("cursor");
  }, 120_000);

  it("rolls back every surface and deletes the snapshot when a run fails", async () => {
    const value = fixture(["claude-code", "qwen"], { settings: { qwen: { "general.vimMode": true } } });
    write(join(value.home, ".claude", "CLAUDE.md"), "old instructions\n");
    write(join(value.home, ".qwen", "settings.json"), "{ \"general\": \"not an object\" }\n");
    const claudeBefore = tree(join(value.home, ".claude"));
    const result = await sync(value, "apply");
    expect(result.outcome).toMatchObject({ outcome: "Failed" });
    expect(tree(join(value.home, ".claude"))).toEqual(claudeBefore);
    expect(existsSync(join(value.home, ".agents", "skills"))).toBe(false);
    expect(existsSync(join(value.home, ".claude.json"))).toBe(false);
    expect(readFileSync(join(value.home, ".qwen", "settings.json"), "utf8")).toBe("{ \"general\": \"not an object\" }\n");
    expect(snapshots(value)).toEqual([]);
    expect(takeoverRows(value)).toEqual([]);
    expect(appliedCount(value)).toBe(0);
  }, 60_000);

  it("keeps the original takeover snapshot when rollback cannot restore a written surface", async () => {
    const value = fixture(["claude-code", "qwen"], { settings: { qwen: { "general.vimMode": true } } });
    const instructions = join(value.home, ".claude", "CLAUDE.md");
    write(instructions, "original instructions\n");
    write(join(value.home, ".qwen", "settings.json"), "{ \"general\": \"not an object\" }\n");
    let writes = 0;
    const failingRollback = Layer.effect(MachineState, Effect.map(MachineState, (service) => ({
      ...service,
      atomicWrite: (input: Parameters<typeof service.atomicWrite>[0]) => {
        if (input.path.absolute === instructions && ++writes > 1) {
          return Effect.fail(new MachineFilesystemError({
            operation: "restore instructions", path: instructions, message: "fixture rollback write refused",
          }));
        }
        return service.atomicWrite(input);
      },
    }))).pipe(Layer.provide(machineLayer(value)));
    const result = await Effect.runPromise(synchronizeLocal(value.statePath, "apply", {
      noBackup: false, environment: environmentOf(value),
    }).pipe(Effect.provide(layer(value, failingRollback))));
    expect(result.outcome).toMatchObject({ outcome: "Failed", rollbackIncomplete: true });
    expect(readFileSync(instructions, "utf8")).toContain("Prefer small diffs.");
    expect(snapshots(value)).toHaveLength(1);
    const snapshot = snapshots(value)[0]!;
    expect(readFileSync(join(value.folder, ".backups", snapshot, "claude-code", ".claude", "CLAUDE.md"), "utf8"))
      .toBe("original instructions\n");
    expect(takeoverRows(value).some((row) => row.harness === "claude-code" && row.snapshot === snapshot)).toBe(true);
    expect((await restore(value, snapshot)).outcome).toMatchObject({ outcome: "Converged" });
    expect(readFileSync(instructions, "utf8")).toBe("original instructions\n");
  }, 60_000);

  it("recovers an interrupted run through recover", async () => {
    const value = fixture(["claude-code"]);
    const blocked = join(value.home, ".claude", "CLAUDE.md");
    const { promise: started, resolve: notify } = Promise.withResolvers<void>();
    const holding = Layer.effect(MachineState, Effect.map(MachineState, (service) => ({
      ...service,
      atomicWrite: (input: Parameters<typeof service.atomicWrite>[0]) => {
        if (input.path.absolute !== blocked) return service.atomicWrite(input);
        notify();
        return Effect.never;
      },
    }))).pipe(Layer.provide(machineLayer(value)));
    const fiber = Effect.runFork(synchronizeLocal(value.statePath, "apply", { noBackup: false, environment: environmentOf(value) }).pipe(
      Effect.provide(layer(value, holding)),
    ));
    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));
    const database = new DatabaseSync(value.statePath, { readOnly: true });
    const row = database.prepare("SELECT status FROM synchronization_runs").get();
    database.close();
    expect(row?.status).toBe("Interrupted");
    expect(snapshots(value)).toHaveLength(1);

    const blockedRun = await syncFailure(value);
    expect(blockedRun._tag).toBe("ActiveRunExistsError");

    const recovered = await Effect.runPromise(recoverLocal(value.statePath).pipe(Effect.provide(layer(value))));
    expect(recovered.outcome).toMatchObject({ outcome: "Converged" });
    expect(readFileSync(blocked, "utf8")).toContain("Prefer small diffs.");
    expect(snapshots(value)).toHaveLength(1);
    expect(takeoverRows(value).length).toBeGreaterThan(0);
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });
  }, 60_000);

  it("reports a foreign skill added after takeover as drift and keeps it", async () => {
    const value = fixture(["claude-code"]);
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    const foreign = join(value.home, ".claude", "skills", "foreign", "SKILL.md");
    write(foreign, "---\nname: foreign\ndescription: mine\n---\nMine.\n");
    const result = await sync(value, "apply");
    expect(result.outcome).toMatchObject({ outcome: "FollowerDrift" });
    expect(JSON.stringify(result.outcome)).toContain(join(value.home, ".claude", "skills"));
    expect(readFileSync(foreign, "utf8")).toContain("Mine.");
    const refused = await Effect.runPromise(restoreLocal(value.statePath, undefined, localProjectionFollower).pipe(Effect.flip, Effect.provide(layer(value))));
    expect(refused._tag).toBe("ProjectionHumanActionError");
    expect(readFileSync(foreign, "utf8")).toContain("Mine.");
  }, 60_000);

  it("stops with Human Action Required when CODEX_HOME moves after takeover", async () => {
    const value = fixture(["codex"]);
    const first = { ...value, environment: { ...value.environment, CODEX_HOME: join(value.home, ".codex-a") } };
    expect((await sync(first, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    expect(existsSync(join(value.home, ".codex-a", "AGENTS.md"))).toBe(true);
    const moved = { ...value, environment: { ...value.environment, CODEX_HOME: join(value.home, ".codex-b") } };
    const failure = await syncFailure(moved);
    expect(failure._tag).toBe("ProjectionHumanActionError");
    expect(String(failure.message)).toContain(".codex-a");
    expect(existsSync(join(value.home, ".codex-b"))).toBe(false);
  }, 60_000);

  it("takes over without a snapshot under --no-backup or local backups: false", async () => {
    const value = fixture(["claude-code"]);
    const plan = await sync(value, "plan", true);
    expect(plan.takeovers.map((entry) => entry.backup)).toEqual(["no backup", "no backup"].slice(0, plan.takeovers.length));
    expect((await sync(value, "apply", true)).outcome).toMatchObject({ outcome: "Converged" });
    expect(snapshots(value)).toEqual([]);
    expect(takeoverRows(value).every((row) => row.snapshot === null)).toBe(true);

    const local = fixture(["codex"]);
    write(join(local.folder, "local", "local.jsonc"), "{ \"backups\": false }\n");
    expect((await sync(local, "plan")).takeovers.every((entry) => entry.backup === "no backup")).toBe(true);
    expect((await sync(local, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    expect(snapshots(local)).toEqual([]);
  }, 60_000);

  it("restores only the config keys a snapshot captured and keeps later takeovers owned", async () => {
    const value = fixture(["codex"], { settings: { codex: { model: "gpt-5" } } });
    const configPath = join(value.home, ".codex", "config.toml");
    write(configPath, "model = \"o3\"\napproval_policy = \"never\"\n\n[mcp_servers.old]\ncommand = \"old\"\n");
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    const [first] = snapshots(value);
    // A later run takes over one more key of the same file, with its own snapshot.
    editFolderConfig(value, { settings: { codex: { model: "gpt-5", approval_policy: "on-request" } } });
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    const [, second] = snapshots(value);
    expect(second).toBeDefined();

    const restored = await restore(value, first);
    expect(restored.outcome).toMatchObject({ outcome: "Converged" });
    const config = parseToml(readFileSync(configPath, "utf8"));
    expect(config.model).toBe("o3");
    expect(config.mcp_servers).toEqual({ old: { command: "old" } });
    expect(config.approval_policy).toBe("on-request");
    expect(appliedRecord(value, "harness:codex:config")?.ownedKeys).toEqual(["approval_policy"]);
    expect(takeoverRows(value).filter((row) => String(row.surface).startsWith("config")).map((row) => row.surface))
      .toEqual(["config#approval_policy"]);

    const beforeSync = readFileSync(configPath, "utf8");
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    expect(readFileSync(configPath, "utf8")).toBe(beforeSync);
    expect(appliedRecord(value, "harness:codex:config")?.ownedKeys).toEqual(["approval_policy"]);

    // The kept record matches the file, so the later snapshot restores too.
    expect((await restore(value, second)).outcome).toMatchObject({ outcome: "Converged" });
    expect(readFileSync(configPath, "utf8")).toContain("approval_policy = \"never\"");
    expect(appliedRecord(value, "harness:codex:config")).toBeUndefined();
    expect(takeoverRows(value)).toEqual([]);
  }, 60_000);

  it("keeps takeovers only for surfaces a run applied before it stopped", async () => {
    const value = fixture(["claude-code"]);
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    const instructions = join(value.home, ".claude", "CLAUDE.md");
    const projected = readFileSync(instructions, "utf8");
    write(instructions, "my local edit\n");
    // The run stops at the drifted CLAUDE.md: amp (and the shared skills)
    // sort before it and are applied, qwen sorts after it and is skipped.
    write(join(value.home, ".config", "amp", "AGENTS.md"), "old amp\n");
    write(join(value.home, ".qwen", "QWEN.md"), "old qwen\n");
    editFolderConfig(value, { harnesses: ["amp", "claude-code", "qwen"] });
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "FollowerDrift" });
    const rowsAfterStop = takeoverRows(value).map((row) => String(row.harness));
    const stoppedSnapshot = join(value.folder, ".backups", snapshots(value).at(-1)!);
    const stoppedEntries = JSON.parse(readFileSync(join(stoppedSnapshot, "manifest.json"), "utf8")).entries;

    write(instructions, projected);
    const retried = await sync(value, "apply");
    expect(retried.outcome).toMatchObject({ outcome: "Converged" });
    expect(retried.takeovers.map((entry) => entry.harness)).toEqual(["qwen"]);
    expect(readFileSync(join(value.home, ".qwen", "QWEN.md"), "utf8")).toContain("Prefer small diffs.");
    const retrySnapshot = join(value.folder, ".backups", snapshots(value).at(-1)!);
    expect(readFileSync(join(retrySnapshot, "qwen", ".qwen", "QWEN.md"), "utf8")).toBe("old qwen\n");
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });

    expect(rowsAfterStop).toContain("amp");
    expect(rowsAfterStop).not.toContain("qwen");
    expect([...new Set(stoppedEntries.map((entry: { harness: string }) => entry.harness))].sort()).toEqual(["agents", "amp"]);
    expect(existsSync(join(stoppedSnapshot, "qwen"))).toBe(false);
    expect(readFileSync(join(stoppedSnapshot, "amp", ".config", "amp", "AGENTS.md"), "utf8")).toBe("old amp\n");
  }, 120_000);

  it("deletes the snapshot of a stopped run that applied none of its takeovers", async () => {
    const value = fixture(["claude-code"]);
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    write(join(value.home, ".claude", "CLAUDE.md"), "my local edit\n");
    editFolderConfig(value, { harnesses: ["claude-code", "opencode"] });
    const stopped = await sync(value, "apply");
    expect(stopped.outcome).toMatchObject({ outcome: "FollowerDrift" });
    expect(stopped.snapshot).toBeUndefined();
    expect(snapshots(value)).toHaveLength(1);
    expect(takeoverRows(value).map((row) => row.harness)).not.toContain("opencode");
  }, 60_000);

  it.each([
    ["before its write lands", false],
    ["after its write lands, as a killed process leaves it", true],
  ] as const)("releases takeovers an abandoned first run never applied, stopped at CLAUDE.md %s", async (_, landed) => {
    const value = fixture(["amp", "claude-code", "qwen"]);
    const instructions = join(value.home, ".claude", "CLAUDE.md");
    write(join(value.home, ".config", "amp", "AGENTS.md"), "old amp\n");
    write(instructions, "old instructions\n");
    write(join(value.home, ".qwen", "QWEN.md"), "old qwen\n");
    // The run is interrupted at CLAUDE.md: amp (and the shared skills) sort
    // before it and are applied, qwen sorts after it and never starts. With
    // `landed` the write goes through and the rollback the interruption runs
    // fails, so the file keeps Canonfig's content and its action stays
    // journaled running, as after a kill. Otherwise the first write is held
    // and the rollback restores the file.
    const { promise: started, resolve: notify } = Promise.withResolvers<void>();
    let writes = 0;
    const holding = Layer.effect(MachineState, Effect.map(MachineState, (service) => ({
      ...service,
      atomicWrite: (input: Parameters<typeof service.atomicWrite>[0]) => {
        if (input.path.absolute !== instructions) return service.atomicWrite(input);
        writes += 1;
        if (writes === 1) {
          const hold = Effect.sync(notify).pipe(Effect.andThen(Effect.never));
          return landed ? service.atomicWrite(input).pipe(Effect.andThen(hold)) : hold;
        }
        return landed
          ? Effect.fail(new MachineFilesystemError({ operation: "write", path: input.path.absolute, message: "the process was killed" }))
          : service.atomicWrite(input);
      },
    }))).pipe(Layer.provide(machineLayer(value)));
    const fiber = Effect.runFork(synchronizeLocal(value.statePath, "apply", { noBackup: false, environment: environmentOf(value) }).pipe(
      Effect.provide(layer(value, holding)),
    ));
    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));
    const database = new DatabaseSync(value.statePath, { readOnly: true });
    const run = database.prepare("SELECT status FROM synchronization_runs").get();
    const lastAction = database.prepare("SELECT state FROM action_journal ORDER BY sequence DESC LIMIT 1").get();
    database.close();
    expect(run?.status).toBe("Interrupted");
    expect(lastAction?.state).toBe(landed ? "running" : "failed");
    const interruptedInstructions = readFileSync(instructions, "utf8");
    if (landed) expect(interruptedInstructions).toContain("Prefer small diffs.");
    else expect(interruptedInstructions).toBe("old instructions\n");
    const [interruptedSnapshot] = snapshots(value);

    await Effect.runPromise(abandonLocal(value.statePath).pipe(Effect.provide(layer(value))));
    const rowsAfterAbandon = takeoverRows(value);
    const kept = join(value.folder, ".backups", interruptedSnapshot!);
    const keptTree = tree(kept);

    const retried = await sync(value, "apply");
    expect(retried.outcome).toMatchObject({ outcome: "Converged" });
    expect(retried.takeovers.map((entry) => entry.harness)).toEqual(expect.arrayContaining(["claude-code", "qwen"]));
    expect(readFileSync(instructions, "utf8")).toContain("Prefer small diffs.");
    expect(readFileSync(join(value.home, ".qwen", "QWEN.md"), "utf8")).toContain("Prefer small diffs.");
    const retrySnapshot = join(value.folder, ".backups", snapshots(value).at(-1)!);
    expect(retrySnapshot).not.toBe(kept);
    expect(readFileSync(join(retrySnapshot, "qwen", ".qwen", "QWEN.md"), "utf8")).toBe("old qwen\n");
    expect(readFileSync(join(retrySnapshot, "claude-code", ".claude", "CLAUDE.md"), "utf8")).toBe(interruptedInstructions);
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });

    expect(rowsAfterAbandon.map((row) => row.harness)).toContain("amp");
    expect(rowsAfterAbandon.map((row) => row.harness)).not.toContain("qwen");
    expect(rowsAfterAbandon.some((row) => row.harness === "claude-code" && row.surface === "instructions")).toBe(false);
    expect([...keptTree.keys()].some((path) => path.startsWith("qwen/"))).toBe(false);
    expect(keptTree.get("amp/.config/amp/AGENTS.md")).toBe("old amp\n");
    // CLAUDE.md's action started, so the abandoned run's snapshot keeps the
    // only copy of its original content, even after the retry took it over.
    expect(keptTree.get("claude-code/.claude/CLAUDE.md")).toBe("old instructions\n");
    expect(readFileSync(join(kept, "claude-code", ".claude", "CLAUDE.md"), "utf8")).toBe("old instructions\n");
  }, 120_000);
});

describe("takeover snapshots", () => {
  const runId = (name: string) => Schema.decodeUnknownSync(RunId)(`run-${name}`);
  const instructionsUnit = (value: Fixture): TakeoverUnit => ({
    harness: "claude-code", surface: "instructions", root: join(value.home, ".claude"), kind: "file", target: join(value.home, ".claude", "CLAUDE.md"),
  });

  it("rejects an external takeover target without copying it", async () => {
    const value = fixture(["claude-code"]);
    const target = join(dirname(value.home), "external.md");
    write(target, "keep this outside home\n");
    const failure = await Effect.runPromise(writeTakeoverSnapshot(
      join(value.folder, ".backups"), value.home, runId("external"),
      [{ ...instructionsUnit(value), target }],
    ).pipe(Effect.flip, Effect.provide(machineLayer(value))));
    expect(failure._tag).toBe("TakeoverSnapshotError");
    expect(failure.message).toContain("inside the home directory");
    expect(snapshots(value)).toEqual([]);
    expect(readFileSync(target, "utf8")).toBe("keep this outside home\n");
  });

  it("leaves nothing in .backups when capturing a takeover fails", async () => {
    const value = fixture(["claude-code"]);
    const backups = join(value.folder, ".backups");
    write(join(value.home, ".claude", "CLAUDE.md"), "old instructions\n");
    // A config target that is a directory fails after CLAUDE.md is copied.
    mkdirSync(join(value.home, ".claude.json"), { recursive: true });
    const failure = await Effect.runPromise(writeTakeoverSnapshot(backups, value.home, runId("failed"), [
      instructionsUnit(value),
      { harness: "claude-code", surface: "mcp#mcpServers", root: value.home, kind: "config", target: join(value.home, ".claude.json"), format: "json", key: "mcpServers" },
    ]).pipe(Effect.flip, Effect.provide(machineLayer(value))));
    expect(failure._tag).toBe("TakeoverSnapshotError");
    expect(readdirSync(backups)).toEqual([]);
  }, 60_000);

  it("counts only snapshots with a valid manifest when listing, restoring and pruning", async () => {
    const value = fixture(["claude-code"]);
    write(join(value.home, ".claude", "CLAUDE.md"), "original\n");
    const backups = join(value.folder, ".backups");
    // Leftovers a failed or killed capture could leave: timestamped
    // directories without a manifest, sorting before and after every real
    // snapshot, and an unfinished temporary one.
    for (const name of ["2000-01-01T00-00-00-000Z", "2999-01-01T00-00-00-000Z"]) mkdirSync(join(backups, name, "claude-code"), { recursive: true });
    const ids: Array<string> = [];
    for (let index = 0; index < 6; index += 1) {
      ids.push(await Effect.runPromise(writeTakeoverSnapshot(backups, value.home, runId(`snapshot-${index}`), [instructionsUnit(value)]).pipe(
        Effect.provide(machineLayer(value)),
      )));
    }
    mkdirSync(join(backups, `.tmp-${ids[0]}`));

    expect(await Effect.runPromise(listSnapshots(backups))).toEqual(ids);
    expect((await Effect.runPromise(readSnapshot(backups, undefined))).id).toBe(ids.at(-1));
    const invalid = await Effect.runPromise(readSnapshot(backups, "2999-01-01T00-00-00-000Z").pipe(Effect.flip));
    expect(invalid._tag).toBe("SnapshotNotFoundError");

    expect(await Effect.runPromise(pruneSnapshots(backups))).toEqual([ids[1]]);
    expect(await Effect.runPromise(listSnapshots(backups))).toEqual([ids[0], ...ids.slice(2)]);
    expect(readFileSync(join(backups, ids[0]!, "claude-code", ".claude", "CLAUDE.md"), "utf8")).toBe("original\n");
    expect(existsSync(join(backups, `.tmp-${ids[0]}`))).toBe(false);
  }, 60_000);

  it("captures and restores a config key whose prior value is null", async () => {
    const value = fixture(["claude-code"]);
    const claudeJsonPath = join(value.home, ".claude.json");
    write(claudeJsonPath, `${JSON.stringify({ mcpServers: null, theme: "dark" }, undefined, 2)}\n`);
    expect((await sync(value, "apply")).outcome).toMatchObject({ outcome: "Converged" });
    const [id] = snapshots(value);
    expect(JSON.parse(readFileSync(join(value.folder, ".backups", id!, "claude-code", "keys.json"), "utf8"))).toEqual({
      [claudeJsonPath]: { mcpServers: null },
    });
    expect(Object.keys(JSON.parse(readFileSync(claudeJsonPath, "utf8")).mcpServers).sort()).toEqual(["docs", "git"]);

    expect((await restore(value)).outcome).toMatchObject({ outcome: "Converged" });
    expect(JSON.parse(readFileSync(claudeJsonPath, "utf8"))).toEqual({ mcpServers: null, theme: "dark" });
  }, 60_000);
});
