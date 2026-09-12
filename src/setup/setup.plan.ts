import { Schema } from "effect";

import { canonicalJson, sha256Hex } from "../profile/profile-codec.ts";

import type {
  SetupInventory,
  SetupItemRecord,
  SetupItemStatus,
  SetupJournal,
  SetupPlanItem,
  SetupRole,
  SetupStage,
} from "./setup.types.ts";
const asJson = <Value>(value: Value) =>
  Schema.decodeUnknownSync(Schema.MutableJson)(JSON.parse(JSON.stringify(value)));


/**
 * The plan digest covers intent, decisions, exclusions, bounded inventory,
 * and exact executable items. Runtime evidence and qualified provenance are
 * outputs of applying that plan; including them would invalidate approval.
 */
export const setupPlanDigest = (input: {
  readonly role: SetupRole;
  readonly intent: string;
  readonly exclusions: ReadonlyArray<string>;
  readonly inventory: SetupInventory;
  readonly items: ReadonlyArray<SetupPlanItem>;
}): string =>
  sha256Hex(canonicalJson(asJson({
    role: input.role,
    intent: input.intent,
    exclusions: input.exclusions,
    inventory: input.inventory,
    items: input.items,
  })));

/** Item ids that form a dependency cycle, or undefined when the plan is acyclic. */
export const findSetupDependencyCycle = (
  items: ReadonlyArray<SetupPlanItem>,
): ReadonlyArray<string> | undefined => {
  const byId = new Map(items.map((item) => [item.id, item]));
  const visiting: Array<string> = [];
  const visited = new Set<string>();
  const visit = (id: string): ReadonlyArray<string> | undefined => {
    if (visited.has(id)) return undefined;
    const cycleStart = visiting.indexOf(id);
    if (cycleStart !== -1) return visiting.slice(cycleStart);
    const item = byId.get(id);
    if (item === undefined) return undefined;
    visiting.push(id);
    for (const dependency of item.dependsOn) {
      const cycle = visit(dependency);
      if (cycle !== undefined) return cycle;
    }
    visiting.pop();
    visited.add(id);
    return undefined;
  };
  for (const item of items) {
    const cycle = visit(item.id);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
};

const recordStatus = (
  records: ReadonlyArray<SetupItemRecord>,
  id: string,
): SetupItemStatus | undefined =>
  records.find((record) => record.id === id)?.status;

/**
 * The effective status of every plan item after dependency propagation: an
 * item whose dependency did not complete is `skipped`, so unrelated approved
 * work can continue while the blocked branch waits.
 */
export const setupItemVerdicts = (
  items: ReadonlyArray<SetupPlanItem>,
  records: ReadonlyArray<SetupItemRecord>,
): ReadonlyMap<string, SetupItemStatus> => {
  const verdicts = new Map<string, SetupItemStatus>();
  const byId = new Map(items.map((item) => [item.id, item]));
  const resolve = (id: string, chain: ReadonlyArray<string>): SetupItemStatus => {
    const known = verdicts.get(id);
    if (known !== undefined) return known;
    if (chain.includes(id)) return "skipped";
    const item = byId.get(id);
    if (item === undefined) return "skipped";
    for (const dependency of item.dependsOn) {
      if (resolve(dependency, [...chain, id]) !== "completed") {
        verdicts.set(id, "skipped");
        return "skipped";
      }
    }
    const verdict = recordStatus(records, id) ?? "pending";
    verdicts.set(id, verdict);
    return verdict;
  };
  for (const item of items) resolve(item.id, []);
  return verdicts;
};

/** Whether the journal holds an approval for exactly this plan digest. */
export const isSetupApproved = (journal: SetupJournal): boolean =>
  journal.approvals.some((approval) => approval.digest === journal.planDigest);

/**
 * The next eligible setup stage, or `complete` when every required item is
 * recorded complete. Re-running setup resumes here without repeating
 * unchanged discovery or approvals.
 */
export const nextEligibleSetupStage = (
  journal: SetupJournal | undefined,
): SetupStage | "complete" => {
  if (journal === undefined) return "role";
  const completed = new Set(journal.stages.map((stage) => stage.stage));
  for (const stage of ["role", "preflight", "inventory", "plan"] as const) {
    if (!completed.has(stage)) return stage;
  }
  if (!isSetupApproved(journal)) return "approve";
  const verdicts = setupItemVerdicts(journal.items, journal.records);
  const byId = new Map(journal.items.map((item) => [item.id, item]));
  for (const [id, verdict] of verdicts) {
    const item = byId.get(id);
    if (item === undefined) continue;
    if (!item.optional && verdict !== "completed") return "apply";
  }
  return completed.has("apply") ? "complete" : "apply";
};
