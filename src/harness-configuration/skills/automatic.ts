import { setTimeout as delay } from "node:timers/promises";
import { CanonfigError } from "../core/errors.ts";
import { checkSkills, listSkills, updateSkills, skillUpdateOperations, type SkillCheck, type SkillLocation, type TrackedSkill } from "./manager.ts";

export interface AutomaticSkillOptions {
  readonly apply: boolean;
  readonly once: boolean;
  readonly intervalSeconds: number;
  readonly signal?: AbortSignal | undefined;
  readonly onPass: (checks: readonly SkillCheck[], pass: number) => void;
}

/** Pure identity: update-owned commit/digest may advance, but a running worker
 * never follows a newly edited repository, ref, path or subdirectory. */
export function sameSkillSource(left: TrackedSkill, right: TrackedSkill): boolean {
  return left.name === right.name && left.path === right.path && left.source === right.source
    && left.ref === right.ref && left.subdir === right.subdir;
}

export function assertAutomaticSelection(current: readonly TrackedSkill[], selected: readonly TrackedSkill[]): void {
  for (const approved of selected) {
    const found = current.find((skill) => skill.name === approved.name);
    if (!found || !sameSkillSource(found, approved)) {
      throw new CanonfigError("SKILL_CONFIG_EDITED", "An automatically updated skill source was changed or removed; stop and review the configuration before restarting");
    }
  }
}

export interface AutomaticSkillOperations {
  readonly list: typeof listSkills;
  readonly check: typeof checkSkills;
  readonly update: typeof updateSkills;
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}
const operations: AutomaticSkillOperations = {
  list: listSkills, check: checkSkills, update: updateSkills,
  sleep: async (milliseconds, signal) => { await delay(milliseconds, undefined, { signal }); },
};

/** Explicit foreground worker, or one pass for an operator-owned scheduler.
 * Uses the existing transactional updater; never publishes or applies harnesses.
 * Failures stop the worker rather than retrying a conflict/recovery condition. */
export async function automaticSkillUpdates(
  location: SkillLocation, names: readonly string[], options: AutomaticSkillOptions,
  run: AutomaticSkillOperations = operations,
): Promise<number> {
  if (!Number.isSafeInteger(options.intervalSeconds) || options.intervalSeconds < 60 || options.intervalSeconds > 604800) {
    throw new CanonfigError("SKILL_OPTION_INVALID", "--interval must be whole seconds between 60 and 604800 (7 days)");
  }
  const configured = await run.list(location);
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const name of wanted) if (!configured.skills.some((skill) => skill.name.toLowerCase() === name)) {
    throw new CanonfigError("SKILL_NAME_NOT_FOUND", `Skill is not tracked: ${name}`);
  }
  const selected = configured.skills.filter((skill) => !wanted.size || wanted.has(skill.name.toLowerCase()));
  if (!selected.length || options.signal?.aborted) return 0;
  const selectedNames = selected.map((skill) => skill.name);
  let passes = 0;
  while (!options.signal?.aborted) {
    const checks = options.apply
      ? await run.update(location, selectedNames, skillUpdateOperations, (config) => assertAutomaticSelection(config.skills, selected))
      : await run.check(location, selectedNames);
    options.onPass(checks, ++passes);
    // Preview is always one read-only pass, even without --once.
    if (!options.apply || options.once) return passes;
    try { await run.sleep(options.intervalSeconds * 1000, options.signal); }
    catch (error) { if (options.signal?.aborted) return passes; throw error; }
  }
  return passes;
}
