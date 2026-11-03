import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Fiber, Layer } from "effect";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";

import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import { adapterFor } from "../../src/projection/adapters/index.ts";
import { loadCanonicalFolder } from "../../src/projection/folder.ts";
import { TARGET_IDS, type TargetId } from "../../src/projection/model.ts";
import { rootContext } from "../../src/projection/plan.ts";
import { recoverLocal, restoreLocal, synchronizeLocal } from "../../src/projection/sync.ts";
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
  Effect.runPromise(restoreLocal(value.statePath, snapshot).pipe(Effect.provide(layer(value))));

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
    expect(existsSync(join(value.folder, ".runtime", "hook-runner.mjs"))).toBe(true);
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
    const refused = await Effect.runPromise(restoreLocal(value.statePath, undefined).pipe(Effect.flip, Effect.provide(layer(value))));
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
});
