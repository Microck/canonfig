import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Effect, Fiber } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { installedSystemdCommand } from "../src/machine/installed-scheduler-command.ts";
import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { stableRuntimeExecutable } from "../src/schedule/schedule-command.ts";
import type { WatchPass } from "../src/gui/contract/synchronization.ts";
import { runCancellablePromise } from "../src/runtime/cancellable-promise.ts";
import { recordWatchPass, watchFolder, watchService } from "../src/runtime/watch.ts";

const roots: Array<string> = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const temporary = async () => {
  const root = await mkdtemp(join(tmpdir(), "canonfig-watch-"));
  roots.push(root);
  return root;
};

/** A pass that counts itself and lets the test await the next one. */
const countingPass = () => {
  let count = 0;
  let waiting: Array<() => void> = [];
  const pass = async (): Promise<WatchPass> => {
    count += 1;
    for (const resolve of waiting.splice(0)) resolve();
    return { at: new Date().toISOString(), outcome: "applied", message: "applied" };
  };
  const next = () => new Promise<void>((resolve) => waiting.push(resolve));
  return { pass, next, count: () => count, reset: () => { waiting = []; } };
};

// Long enough for the 50 ms quiet window and a pass to settle on a loaded host.
const settle = () => delay(400);

describe.skipIf(process.platform === "win32")("watchFolder", () => {
  it("applies at start, after each quiet change to the watched entries, and never for Canonfig's own files", async () => {
    const folder = await temporary();
    await writeFile(join(folder, "AGENTS.md"), "v1\n");
    const passes = countingPass();
    const abort = new AbortController();
    const reported: Array<WatchPass> = [];
    let first = passes.next();
    const running = watchFolder(folder, passes.pass, (pass) => reported.push(pass), abort.signal, 50);

    await first;
    expect(passes.count()).toBe(1);

    // An edit to the instructions applies once.
    first = passes.next();
    await writeFile(join(folder, "AGENTS.md"), "v2\n");
    await first;
    expect(passes.count()).toBe(2);

    // A skill directory created after start is watched once it appears, and
    // a burst of files in it is one pass, not one per file.
    first = passes.next();
    await mkdir(join(folder, "skills", "fresh"), { recursive: true });
    await writeFile(join(folder, "skills", "fresh", "SKILL.md"), "---\nname: fresh\n---\n");
    await writeFile(join(folder, "skills", "fresh", "notes.md"), "more\n");
    await first;
    await settle();
    expect(passes.count()).toBe(3);

    // A file inside the new directory, written after the directory's watcher
    // was armed, is seen too.
    first = passes.next();
    await writeFile(join(folder, "skills", "fresh", "SKILL.md"), "---\nname: fresh\n---\nchanged\n");
    await first;
    expect(passes.count()).toBe(4);

    // The state database, backups and other top-level bookkeeping are written
    // by every sync; reacting to them would loop.
    await writeFile(join(folder, "state.sqlite"), "state");
    await mkdir(join(folder, ".backups", "snapshot"), { recursive: true });
    await writeFile(join(folder, ".backups", "snapshot", "file"), "copy");
    await settle();
    expect(passes.count()).toBe(4);

    abort.abort();
    await running;
    expect(reported).toHaveLength(4);
  });

  it("runs one pass after a change made during a pass, never two at once", async () => {
    const folder = await temporary();
    await mkdir(join(folder, "rules"));
    let active = 0;
    let overlapped = false;
    let count = 0;
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const pass = async (): Promise<WatchPass> => {
      active += 1;
      overlapped ||= active > 1;
      count += 1;
      started?.();
      // The second pass (the first change) stays open until the test releases it.
      if (count === 2) await new Promise<void>((resolve) => { release = resolve; });
      active -= 1;
      return { at: new Date().toISOString(), outcome: "applied", message: "applied" };
    };
    const abort = new AbortController();
    const waitStart = () => new Promise<void>((resolve) => { started = resolve; });
    let begun = waitStart();
    const running = watchFolder(folder, pass, () => undefined, abort.signal, 50);
    await begun;

    begun = waitStart();
    await writeFile(join(folder, "rules", "a.md"), "a\n");
    await begun;
    // Change the folder while the second pass is still running.
    await writeFile(join(folder, "rules", "b.md"), "b\n");
    await settle();
    begun = waitStart();
    release?.();
    await begun;
    expect(count).toBe(3);
    expect(overlapped).toBe(false);

    abort.abort();
    await running;
  });

  it("finishes a running pass before it stops, so no journaled run is cut short", async () => {
    const folder = await temporary();
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    let finished = false;
    const pass = async (): Promise<WatchPass> => {
      started?.();
      await new Promise<void>((resolve) => { release = resolve; });
      finished = true;
      return { at: new Date().toISOString(), outcome: "applied", message: "applied" };
    };
    const abort = new AbortController();
    let stopped = false;
    const running = watchFolder(folder, pass, () => undefined, abort.signal, 50).then(() => { stopped = true; });
    await begun;
    abort.abort();
    await settle();
    expect(stopped).toBe(false);
    release?.();
    await running;
    expect(finished).toBe(true);
  });

  it("holds an interrupted command until its running pass finishes", async () => {
    const folder = await temporary();
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    let finished = false;
    const pass = async (): Promise<WatchPass> => {
      started?.();
      await new Promise<void>((resolve) => { release = resolve; });
      finished = true;
      return { at: new Date().toISOString(), outcome: "applied", message: "applied" };
    };
    // The boundary `canonfig watch` runs the watcher through: interruption
    // (SIGINT, SIGTERM) aborts it and waits, as the runtime's layers close after.
    const fiber = Effect.runFork(runCancellablePromise((signal) => watchFolder(folder, pass, () => undefined, signal, 50)));
    await begun;
    let interrupted = false;
    const interrupting = Effect.runPromise(Fiber.interrupt(fiber)).then(() => { interrupted = true; });
    await settle();
    expect(interrupted).toBe(false);
    release?.();
    await interrupting;
    expect(finished).toBe(true);
  });

  it("stops the watcher when a pass throws", async () => {
    const folder = await temporary();
    const abort = new AbortController();
    const stop = new Error("this machine now follows a Source");
    await expect(watchFolder(folder, async () => { throw stop; }, () => undefined, abort.signal, 50)).rejects.toBe(stop);
  });
});

/** A systemctl stand-in: records calls and reports the state it is told to. */
const fakeSystemctl = async (root: string, script: string): Promise<string> => {
  const path = join(root, "systemctl");
  await writeFile(path, `#!/bin/sh\necho "$@" >> "${join(root, "systemctl.calls")}"\n${script}\n`);
  await chmod(path, 0o700);
  return path;
};

describe.skipIf(process.platform === "win32")("systemd watch service", () => {
  const setup = async (systemctlScript: string) => {
    const root = await temporary();
    const systemctl = await fakeSystemctl(root, systemctlScript);
    const harnessBin = join(root, "harness-bin");
    const stateDirectory = join(root, ".canonfig");
    await mkdir(stateDirectory, { recursive: true });
    const run = <Success, Failure>(
      program: (service: Effect.Success<ReturnType<typeof watchService>>) => Effect.Effect<Success, Failure>,
    ) =>
      Effect.runPromise(watchService({
        stateDirectory,
        platform: "linux",
        home: root,
        environment: { CANONFIG_SYSTEMCTL: systemctl, PATH: `:${harnessBin}:./bin:${harnessBin}` },
        readinessTimeoutMilliseconds: 500,
      }).pipe(Effect.flatMap(program), Effect.provide(linuxMachineStateLayer())));
    return { root, stateDirectory, harnessBin, run };
  };

  it("installs a unit that runs `canonfig watch`, reports it with the last pass, and removes it", async () => {
    const { root, stateDirectory, harnessBin, run } = await setup(
      "case \"$2\" in show) printf 'LoadState=loaded\\nActiveState=active\\nSubState=running\\nUnitFileState=enabled\\nMainPID=4242\\n';; esac\nexit 0",
    );
    const before = await run((service) => service.status());
    expect(before.state).toBe("not-installed");

    const enabled = await run((service) => service.enable());
    expect(enabled).toMatchObject({ change: "installed", status: { state: "running", serviceName: "canonfig-watch.service" } });
    const unit = await readFile(join(root, ".config", "systemd", "user", "canonfig-watch.service"), "utf8");
    expect(unit).toContain("Description=Canonfig folder watcher");
    // Stop signals only the watcher, which finishes its pass before exiting.
    expect(unit).toContain("KillMode=mixed");
    expect(unit).toMatch(/ExecStart=.*"watch"$/mu);
    const watcherPath = installedSystemdCommand(unit)?.searchPath;
    expect(watcherPath).toEqual([...new Set([
      dirname(stableRuntimeExecutable()), harnessBin, "/usr/local/bin", "/usr/bin", "/bin",
    ])]);
    const calls = await readFile(join(root, "systemctl.calls"), "utf8");
    expect(calls).toContain("--user enable canonfig-watch.service");
    expect(calls).toContain("--user restart canonfig-watch.service");

    // Running and current: enabling again changes nothing.
    expect(await run((service) => service.enable())).toMatchObject({ change: "unchanged" });

    const pass: WatchPass = { at: "2026-11-24T10:00:00.000Z", outcome: "failed", message: "follower drift", category: "conflict-or-drift" };
    await Effect.runPromise(recordWatchPass(stateDirectory, pass));
    expect(await run((service) => service.status())).toMatchObject({ state: "running", lastPass: pass });

    expect(await run((service) => service.disable())).toMatchObject({ change: "removed" });
    expect(await run((service) => service.status())).toMatchObject({ state: "not-installed" });
    expect(await run((service) => service.disable())).toMatchObject({ change: "unchanged" });
  });

  it("fails enable when the manager never runs the watcher", async () => {
    const { run } = await setup(
      "case \"$2\" in show) printf 'LoadState=loaded\\nActiveState=failed\\nSubState=failed\\nUnitFileState=enabled\\nMainPID=0\\n';; esac\nexit 0",
    );
    const failure = await run((service) => Effect.flip(service.enable()));
    expect(failure).toMatchObject({ _tag: "NativeServiceVerificationError", state: "not-running" });
  });
});
