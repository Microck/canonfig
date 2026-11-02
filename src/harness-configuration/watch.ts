import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HarnessConfigurationCompiler, createDefaultRegistry } from "./core/compiler.ts";
import { findRepositoryRoot } from "./core/config.ts";
import { CanonfigError } from "./core/errors.ts";
import { assertNoSymlinkPathComponents } from "./core/filesystem.ts";
import { sha256 } from "./core/hash.ts";
import { applyPlan } from "./core/planner.ts";
import { loadState } from "./core/state.ts";
import type { CanonfigState, Plan, TargetId } from "./core/types.ts";
import { isHarnessPlanBlocked } from "./cli-output.ts";

export interface HarnessWatchOptions {
  root: string;
  targets?: readonly TargetId[] | undefined;
  strict: boolean;
  dryRun: boolean;
  interval: number;
}
export interface HarnessWatchPass { plan: Plan; applied: boolean; blocked: boolean }
export interface HarnessWatchOperations {
  plan: HarnessConfigurationCompiler["plan"];
  apply: typeof applyPlan;
  pause: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
const compiler = new HarnessConfigurationCompiler(createDefaultRegistry());
const operations: HarnessWatchOperations = {
  plan: (options) => compiler.plan(options), apply: applyPlan,
  pause: async (milliseconds, signal) => { await delay(milliseconds, undefined, { signal }); },
};
const stateIdentity = (state: CanonfigState) => ({ version: state.version, canonfigVersion: state.canonfigVersion, appliedTargets: state.appliedTargets ?? [], artifacts: state.artifacts });
const fingerprint = (plan: Plan): string => sha256(JSON.stringify({ ...plan, nextState: stateIdentity(plan.nextState) }));

/** Explicit foreground projection. Two matching observations coalesce ordinary
 * saves; no recursive fs.watch, generated-file event feedback or overlapping passes. */
export async function watchHarness(
  options: HarnessWatchOptions,
  report: (pass: HarnessWatchPass) => void,
  signal: AbortSignal,
  run: HarnessWatchOperations = operations,
): Promise<void> {
  if (!Number.isInteger(options.interval) || options.interval < 1 || options.interval > 3600) throw new CanonfigError("HARNESS_INTERVAL_INVALID", "Watch interval must be whole seconds from 1 to 3600");
  const root = await fs.realpath(await findRepositoryRoot(options.root));
  const lockPath = path.join(root, ".canonfig", ".harness-watch.lock");
  await assertNoSymlinkPathComponents(root, lockPath);
  let lock;
  if (!options.dryRun) {
    try { lock = await fs.open(lockPath, "wx", 0o600); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new CanonfigError("HARNESS_WATCH_CONFLICT", "Another watcher or interrupted watch holds .canonfig/.harness-watch.lock; stop it before inspecting a stale lock");
      throw error;
    }
  }
  let previous: string | undefined;
  let reported: string | undefined;
  try {
    while (!signal.aborted) {
      const plan = await run.plan({ root, targets: options.targets, strict: options.strict, force: false });
      if (signal.aborted) return;
      if (isHarnessPlanBlocked(plan)) { report({ plan, applied: false, blocked: true }); return; }
      const current = fingerprint(plan);
      let committed = false;
      if (current === previous) {
        const state = await loadState(root);
        const changed = plan.entries.some((entry) => ["create", "update", "delete"].includes(entry.action))
          || ((Object.keys(state.artifacts).length > 0 || Object.keys(plan.nextState.artifacts).length > 0) && JSON.stringify(stateIdentity(state)) !== JSON.stringify(stateIdentity(plan.nextState)));
        if (changed && !options.dryRun) {
          if (signal.aborted) return;
          await run.apply(plan);
          report({ plan, applied: true, blocked: false });
          // Re-plan after our writes. Do not emit an idle heartbeat each poll.
          committed = true; reported = undefined;
        } else if (reported !== current) {
          report({ plan, applied: false, blocked: false }); reported = current;
        }
      }
      previous = committed ? undefined : current;
      try { await run.pause(options.interval * 1000, signal); }
      catch (error) { if (signal.aborted) return; throw error; }
    }
  } finally {
    if (lock !== undefined) { await lock.close(); await fs.unlink(lockPath); }
  }
}
