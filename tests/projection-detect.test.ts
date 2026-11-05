import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { detectHarnesses } from "../src/projection/detect.ts";
import { rootContext } from "../src/projection/plan.ts";
import { harnessesLocal, synchronizeLocal } from "../src/projection/sync.ts";
import { stateRepositoryLayer } from "../src/state/state-repository.layer.ts";
import { SynchronizationLive } from "../src/synchronization/synchronization.layer.ts";

/**
 * Harness detection and selection with a real temporary HOME, real SQLite and
 * the real Linux machine layer. Installed harnesses are fake executables in a
 * temporary PATH directory; nothing is run.
 */

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const write = (path: string, content: string, mode?: number) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
};

const install = (directory: string, name: string) => write(join(directory, name), "#!/bin/sh\nexit 0\n", 0o755);

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-detect-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const folder = join(home, ".canonfig");
  const environment = new Map([["HOME", home], ["PATH", bin], ["XDG_CACHE_HOME", join(home, ".cache")]]);
  const machine = linuxMachineStateLayer({
    environment: [...environment].map(([name, value]) => ({ name, value })),
    credentialPolicy: { kind: "local-file", path: join(home, "credentials") },
  });
  const statePath = join(folder, "state.sqlite");
  const layer = SynchronizationLive.pipe(
    Layer.provideMerge(stateRepositoryLayer(statePath)),
    Layer.provideMerge(machine),
  );
  const lookup = (name: string) => environment.get(name);
  return {
    home,
    bin,
    folder,
    detect: () =>
      Effect.runPromise(Effect.gen(function*() {
        return yield* detectHarnesses(yield* rootContext(lookup), folder);
      }).pipe(Effect.provide(machine))),
    sync: () =>
      Effect.runPromise(synchronizeLocal(statePath, "apply", { noBackup: false, environment: lookup }).pipe(Effect.provide(layer))),
    harnesses: (change?: Parameters<typeof harnessesLocal>[2]) =>
      Effect.runPromise(harnessesLocal(statePath, lookup, change).pipe(Effect.provide(layer))),
  };
};

describe("harness detection", () => {
  it("finds executables through install directories and PATH without running them; roots are evidence only", async () => {
    const value = fixture();
    install(value.bin, "claude");
    // ~/.local/bin is searched even when PATH does not name it, as a verifier does.
    install(join(value.home, ".local", "bin"), "codex");
    // Antigravity's root alone is shared with its App and IDE: not an installation.
    mkdirSync(join(value.home, ".gemini"), { recursive: true });
    const detected = await value.detect();
    const byId = new Map(detected.map((entry) => [entry.harness, entry]));
    expect(byId.get("claude-code")).toMatchObject({ installed: true, executable: join(value.bin, "claude") });
    expect(byId.get("codex")).toMatchObject({ installed: true, executable: join(value.home, ".local", "bin", "codex") });
    expect(byId.get("antigravity")).toMatchObject({ installed: false, rootExists: true, root: join(value.home, ".gemini") });
    expect(detected.filter((entry) => entry.installed).map((entry) => entry.harness)).toEqual(["codex", "claude-code"]);
  });

  it("does not take a generic `agent` for Cursor unless ~/.cursor exists", async () => {
    const value = fixture();
    install(value.bin, "agent");
    expect((await value.detect()).find((entry) => entry.harness === "cursor")).toMatchObject({ installed: false, rootExists: false });
    mkdirSync(join(value.home, ".cursor"), { recursive: true });
    expect((await value.detect()).find((entry) => entry.harness === "cursor")).toMatchObject({
      installed: true,
      executable: join(value.bin, "agent"),
      rootExists: true,
    });
  });
});

describe("listed harnesses that are not installed", () => {
  it("are reported while the run converges, and their earlier outputs are held", async () => {
    const value = fixture();
    write(join(value.folder, "canonfig.jsonc"), "{ \"version\": 1, \"harnesses\": [\"codex\", \"claude-code\"] }\n");
    write(join(value.folder, "AGENTS.md"), "Global instructions.\n");
    install(value.bin, "codex");

    const first = await value.sync();
    expect(first.outcome).toMatchObject({ outcome: "Converged" });
    expect(first.notInstalled).toEqual(["claude-code"]);
    expect(first.harnesses.map((entry) => entry.harness)).toEqual(["codex"]);
    expect(existsSync(join(value.home, ".claude"))).toBe(false);
    const report = await value.harnesses();
    expect(report.notInstalled).toEqual(["claude-code"]);
    expect(report.harnesses.find((row) => row.harness === "claude-code")).toMatchObject({ status: "not-installed", listed: true });
    expect(report.harnesses.find((row) => row.harness === "codex")).toMatchObject({
      status: "selected",
      pinnedRoot: join(value.home, ".codex"),
      snapshot: report.latestSnapshot,
    });

    // Installed, taken over, then missing again (a scheduled run with a
    // narrower PATH): the projected file stays as it was applied.
    install(value.bin, "claude");
    expect((await value.sync()).notInstalled).toBeUndefined();
    const projected = readFileSync(join(value.home, ".claude", "CLAUDE.md"), "utf8");
    rmSync(join(value.bin, "claude"));
    const held = await value.sync();
    expect(held.outcome).toMatchObject({ outcome: "Converged" });
    expect(held.notInstalled).toEqual(["claude-code"]);
    expect(readFileSync(join(value.home, ".claude", "CLAUDE.md"), "utf8")).toBe(projected);
  }, 60_000);
});

describe("harness exclusions", () => {
  it("edits only local/local.jsonc, keeping its comments, and warns when including an unlisted harness", async () => {
    const value = fixture();
    write(join(value.folder, "canonfig.jsonc"), "{ \"version\": 1, \"harnesses\": [\"codex\"] }\n");
    write(join(value.folder, "local", "local.jsonc"), "{\n  // this machine only\n  \"backups\": true\n}\n");
    const excluded = await value.harnesses({ action: "exclude", harness: "codex" });
    expect(excluded.excluded).toEqual(["codex"]);
    expect(excluded.harnesses.find((row) => row.harness === "codex")?.status).toBe("excluded");
    const local = readFileSync(join(value.folder, "local", "local.jsonc"), "utf8");
    expect(local).toContain("// this machine only");
    expect(local).toContain("\"backups\": true");

    const included = await value.harnesses({ action: "include", harness: "codex" });
    expect(included.excluded).toEqual([]);
    expect(included.warnings).toBeUndefined();
    const unlisted = await value.harnesses({ action: "include", harness: "qwen" });
    expect(unlisted.warnings).toEqual([expect.stringContaining("qwen is not listed")]);
    expect(readFileSync(join(value.folder, "canonfig.jsonc"), "utf8")).toBe("{ \"version\": 1, \"harnesses\": [\"codex\"] }\n");
  });
});
