import { type FSWatcher, statSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Effect, Option, Schema } from "effect";

import { WatchPass } from "../gui/contract/synchronization.ts";
import type { MachinePlatform } from "../machine/machine-state.types.ts";
import {
  type NativeServiceError,
  type NativeServiceManagerState,
  type NativeServiceMechanism,
  type NativeServiceName,
  NativeServiceVerificationError,
  nativeServiceHost,
  writeAtomically,
} from "../machine/native-service.ts";
import { AUTHORING_ENTRIES } from "../projection/folder.ts";

/*
 * Automatic local sync. `canonfig watch` runs `sync --apply --no-input` on a
 * Source or unenrolled machine each time its Canonical Folder changes, so an
 * edited AGENTS.md or a skill added to `skills/` reaches the harnesses without
 * a manual sync. `watch enable` hands the same command to the native user
 * service manager so it runs at login without a terminal.
 *
 * The watcher only decides when to sync. Each pass is the ordinary journaled
 * apply: drift, held items and Human Action Required are reported the same way
 * a scheduled run reports them, never forced.
 */

/**
 * The folder entries projection reads: the authoring allowlist plus `local/`.
 * Everything else under `~/.canonfig/` (state database, journals, backups,
 * reviews) is Canonfig's own bookkeeping, which a sync itself writes, so
 * watching it would trigger a pass after every pass.
 */
export const WATCHED_ENTRIES: ReadonlySet<string> = new Set([...AUTHORING_ENTRIES, "local"]);

/**
 * How long the folder must stay quiet before a pass. Editors save through
 * temporary files and installers write a skill file by file, so a pass waits
 * for the burst to end instead of projecting each half-written step.
 */
export const watchQuietMilliseconds = 500;

/**
 * A pass refused because another run holds the run lock (a manual sync, the
 * GUI, a scheduled job) may have read the folder before the change, so it is
 * tried once more after this delay. Real drift fails the same way; one retry
 * reports it once more and then waits for the next change.
 */
const conflictRetryMilliseconds = 10_000;


const watchRecordFile = "watch.json";

/** Record the latest pass beside the state database; one record, replaced each pass. */
export const recordWatchPass = (stateDirectory: string, pass: WatchPass): Effect.Effect<void, NativeServiceError> =>
  writeAtomically(join(stateDirectory, watchRecordFile), `${JSON.stringify(pass)}\n`);

/** The latest recorded pass, or undefined before the first one. A damaged record reads as absent. */
const readWatchPass = (stateDirectory: string): Effect.Effect<WatchPass | undefined> =>
  Effect.promise(() =>
    readFile(join(stateDirectory, watchRecordFile), "utf8").then(
      (text) => Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(WatchPass))(text)),
      () => undefined,
    )
  );

/**
 * Run `pass` once at start and again after each quiet change to the watched
 * entries of `folder`, until `signal` aborts. Passes never overlap: a change
 * during a pass schedules the next one. An abort during a pass resolves only
 * once that pass finishes, so stopping never leaves a journaled run half done.
 *
 * Each watched directory gets its own recursive watcher, and the folder itself
 * a shallow one that sees top-level files and directories come and go. A
 * recursive watcher on the whole folder would also register every snapshot
 * under `.backups/`, which can exhaust the Linux inotify watch limit.
 */
export const watchFolder = (
  folder: string,
  pass: () => Promise<WatchPass>,
  report: (pass: WatchPass) => void,
  signal: AbortSignal,
  quietMilliseconds = watchQuietMilliseconds,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const directories = new Map<string, FSWatcher>();
    let top: FSWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight: Promise<WatchPass> | undefined;
    let pending = false;
    let retried = false;
    let stopped = false;

    const onAbort = () => {
      stop();
      void (inflight ?? Promise.resolve()).then(() => resolve(), () => resolve());
    };
    const stop = () => {
      stopped = true;
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      top?.close();
      for (const watcher of directories.values()) watcher.close();
      directories.clear();
    };
    const fail = (error: Error) => {
      if (stopped) return;
      stop();
      reject(error);
    };
    const schedule = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => void fire(), delay);
    };
    const changed = () => {
      retried = false;
      schedule(quietMilliseconds);
    };
    const fire = async () => {
      if (inflight !== undefined) {
        pending = true;
        return;
      }
      pending = false;
      let result: WatchPass;
      try {
        inflight = pass();
        result = await inflight;
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      } finally {
        inflight = undefined;
      }
      if (stopped) return;
      report(result);
      if (pending) schedule(quietMilliseconds);
      else if (result.outcome === "failed" && result.category === "conflict-or-drift" && !retried) {
        retried = true;
        schedule(conflictRetryMilliseconds);
      }
    };
    // (Re)watch one top-level directory. A directory that was replaced (an
    // installer renaming a staged tree into place) needs a new watcher, so an
    // existing one is always closed first.
    const watchDirectory = (name: string) => {
      directories.get(name)?.close();
      directories.delete(name);
      const path = join(folder, name);
      try {
        if (!statSync(path).isDirectory()) return;
      } catch {
        return;
      }
      const watcher = watch(path, { recursive: true }, changed);
      // A directory removed while watched errors on some platforms; the
      // folder watcher sees the removal and rearms, so only that is expected.
      watcher.on("error", (error) => {
        watcher.close();
        if (directories.get(name) === watcher) directories.delete(name);
        try {
          statSync(path);
        } catch {
          return;
        }
        fail(error);
      });
      directories.set(name, watcher);
    };

    if (signal.aborted) {
      resolve();
      return;
    }
    try {
      top = watch(folder, (_event, filename) => {
        // Some platforms omit the name; treat that as a change to everything.
        if (filename === null) {
          for (const name of WATCHED_ENTRIES) watchDirectory(name);
          changed();
          return;
        }
        if (!WATCHED_ENTRIES.has(filename)) return;
        watchDirectory(filename);
        changed();
      });
      top.on("error", fail);
      for (const name of WATCHED_ENTRIES) watchDirectory(name);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    // Catch up on whatever changed while nothing was watching.
    schedule(0);
  });

const watchServiceName: NativeServiceName = {
  stem: "canonfig-watch",
  launchdLabel: "dev.canonfig.watch",
  description: "Canonfig folder watcher",
};

export type WatchServiceState = "not-installed" | "running" | "not-running" | "drifted";

export interface WatchServiceStatus {
  readonly state: WatchServiceState;
  readonly platform: MachinePlatform;
  readonly mechanism: NativeServiceMechanism;
  readonly serviceName: string;
  readonly definitionPath?: string | undefined;
  readonly manager: NativeServiceManagerState;
  /** Manager lifecycle constraints for unattended operation. */
  readonly supportedModes: string;
  readonly logs: string;
  readonly detail: string;
  /** The latest pass any watcher on this machine recorded, foreground or supervised. */
  readonly lastPass?: WatchPass | undefined;
}

export interface WatchServiceOptions {
  readonly stateDirectory: string;
  readonly platform?: MachinePlatform | undefined;
  readonly home?: string | undefined;
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined;
  /** How long `enable` waits for the manager to report the watcher running. */
  readonly readinessTimeoutMilliseconds?: number | undefined;
}

/**
 * The supervised watcher. Unlike the Source service it has nothing to probe
 * from outside, so healthy means the manager runs the current definition; the
 * recorded last pass says what that process has done.
 */
export const watchService = (options: WatchServiceOptions) =>
  Effect.gen(function*() {
    const host = yield* nativeServiceHost({
      platform: options.platform,
      home: options.home,
      environment: options.environment,
      label: "watch service",
      logPath: join(options.stateDirectory, "watch.log"),
    });
    const render = (installing = false) => host.render(watchServiceName, ["watch"], installing);
    const readinessTimeout = options.readinessTimeoutMilliseconds ?? 10_000;

    const status = Effect.fn("WatchService.status")(function*(): Effect.fn.Return<WatchServiceStatus, NativeServiceError> {
      const rendered = yield* render();
      const [manager, modes, lastPass] = yield* Effect.all([
        host.manager.inspect(rendered),
        host.manager.supportedModes,
        readWatchPass(options.stateDirectory),
      ], { concurrency: "unbounded" });
      const logs = host.manager.logs(rendered);
      const base = {
        platform: host.platform,
        mechanism: rendered.mechanism,
        serviceName: rendered.serviceName,
        definitionPath: rendered.definitionPath,
        manager,
        supportedModes: modes.text,
        logs,
        lastPass,
      };
      if (!manager.installed) {
        return { ...base, state: "not-installed", detail: "changes apply when you run `canonfig sync --apply`; run `canonfig watch enable` to apply them automatically" };
      }
      if (!manager.matches) {
        return {
          ...base,
          state: "drifted",
          detail: `the installed ${rendered.mechanism} definition differs from what \`canonfig watch enable\` renders now (another Canonfig installation or a manual edit); run \`canonfig watch enable\` again`,
        };
      }
      if (!manager.active) {
        return { ...base, state: "not-running", detail: `the ${rendered.mechanism} is ${manager.state}; folder changes are not being applied. Logs: ${logs}` };
      }
      return { ...base, state: "running", detail: `folder changes are applied automatically by the ${rendered.mechanism}; it ${modes.text}` };
    });

    const enable = Effect.fn("WatchService.enable")(function*() {
      const before = yield* status();
      if (before.state === "running") return { change: "unchanged" as const, status: before };
      const rendered = yield* render(true);
      yield* host.manager.install(rendered);
      // Only the manager's view changes while the watcher starts, so poll that
      // and build the full report once.
      const deadline = Date.now() + readinessTimeout;
      let manager = yield* host.manager.inspect(rendered);
      while (!(manager.matches && manager.active) && Date.now() < deadline) {
        yield* Effect.sleep(250);
        manager = yield* host.manager.inspect(rendered);
      }
      const after = yield* status();
      if (after.state !== "running") {
        return yield* new NativeServiceVerificationError({
          operation: "start the watch service",
          state: after.state,
          message: `the watch service was installed but is not running after ${readinessTimeout} ms: ${after.detail}. Inspect it with \`canonfig watch status\`, or remove it with \`canonfig watch disable\``,
        });
      }
      return { change: before.manager.installed ? "updated" as const : "installed" as const, status: after };
    });

    const disable = Effect.fn("WatchService.disable")(function*() {
      const rendered = yield* render();
      const removed = yield* host.manager.remove(rendered);
      return { change: removed ? "removed" as const : "unchanged" as const, serviceName: rendered.serviceName };
    });

    return { status, enable, disable };
  });
