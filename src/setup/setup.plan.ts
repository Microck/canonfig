import { Effect, Schema } from "effect";

import { canonicalJson, sha256Hex } from "../profile/profile-codec.ts";
import { SetupError } from "./setup.errors.ts";
import type {
  SetupDiscoveryInput,
  SetupImportReview,
  SetupInventory,
  SetupItemRecord,
  SetupItemStatus,
  SetupJournal,
  SetupPlanItem,
  SetupRequestScope,
  SetupRole,
  SetupStage,
  SetupProvenance,
} from "./setup.types.ts";

const asJson = <Value>(value: Value) =>
  Schema.decodeUnknownSync(Schema.MutableJson)(JSON.parse(JSON.stringify(value)));

/**
 * The plan digest covers intent, decisions, exclusions, bounded inventory,
 * authoring-file fingerprints, the structured import review and exact executable
 * items. Runtime evidence and qualified provenance are apply outputs, not approval inputs.
 */
export const setupPlanDigest = (input: {
  readonly role: SetupRole;
  readonly scope: SetupRequestScope;
  readonly intent: string;
  readonly exclusions: ReadonlyArray<string>;
  readonly inventory: SetupInventory;
  readonly items: ReadonlyArray<SetupPlanItem>;
  readonly discoveryInputs: ReadonlyArray<SetupDiscoveryInput>;
  readonly imports?: SetupImportReview;
}): string => {
  return sha256Hex(canonicalJson(asJson({
    role: input.role,
    scope: input.scope,
    intent: input.intent,
    exclusions: input.exclusions,
    inventory: input.inventory,
    items: input.items,
    discoveryInputs: input.discoveryInputs,
    imports: input.imports,
  })));
};

export const setupItemDetailDigest = (item: SetupPlanItem): string =>
  sha256Hex(canonicalJson(asJson(item.detail)));

type SetupTransition =
  | { readonly type: "approve"; readonly approver: string }
  | { readonly type: "invalidate" }
  | { readonly type: "finish-apply" }
  | {
    readonly type: "start" | "interrupt" | "complete" | "fail" | "skip";
    readonly id: string;
    readonly detailDigest: string;
    readonly evidence?: string;
    readonly catalog?: SetupProvenance;
  };

/** The sole owner of item, approval and apply-stage lifecycle changes. */
export const transitionSetup = (
  journal: SetupJournal,
  event: SetupTransition,
): Effect.Effect<SetupJournal, SetupError> => Effect.gen(function*() {
  const invalid = (message: string) => new SetupError({
    operation: "setup transition", category: "conflict", message,
    recovery: "Inspect the setup journal and run setup plan again before approving further changes.",
  });
  const timestamp = new Date().toISOString();
  if (event.type === "invalidate") {
    return {
      ...journal, approvals: [],
      stages: journal.stages.filter((stage) => stage.stage !== "approve" && stage.stage !== "apply"),
    };
  }
  if (event.type === "approve") {
    if (isSetupApproved(journal) || event.approver.trim() === "") {
      return yield* invalid("The setup plan cannot accept this approval.");
    }
    return {
      ...journal,
      approvals: [{ digest: journal.planDigest, approver: event.approver, approvedAt: timestamp }],
      stages: [...journal.stages, { stage: "approve", digest: journal.planDigest, completedAt: timestamp }],
    };
  }
  if (!isSetupApproved(journal)) return yield* invalid("Only an approved setup plan can change item lifecycle.");
  if (event.type === "finish-apply") {
    const verdicts = setupItemVerdicts(journal.items, journal.records);
    if (journal.items.some((item) => {
      const status = verdicts.get(item.id);
      return status === "pending" || status === "running" || status === "interrupted"
        || (!item.optional && status !== "completed");
    })) return yield* invalid("The setup plan still has unfinished or interrupted work.");
    return {
      ...journal,
      stages: journal.stages.some((stage) => stage.stage === "apply") ? journal.stages
        : [...journal.stages, { stage: "apply", digest: journal.planDigest, completedAt: timestamp }],
    };
  }
  const item = journal.items.find((candidate) => candidate.id === event.id);
  const prior = journal.records.find((record) => record.id === event.id);
  if (item === undefined || prior === undefined || prior.detailDigest !== event.detailDigest
    || setupItemDetailDigest(item) !== event.detailDigest) {
    return yield* invalid(`Setup item ${event.id} no longer matches its recorded detail digest.`);
  }
  const blocked = item.dependsOn.filter((dependency) =>
    journal.records.find((record) => record.id === dependency)?.status !== "completed");
  const base = { id: item.id, detailDigest: event.detailDigest, updatedAt: timestamp };
  let next: SetupItemRecord;
  switch (event.type) {
    case "start":
      if (!["pending", "skipped", "failed"].includes(prior.status) || blocked.length > 0
        || journal.records.some((record) => record.status === "running" || record.status === "interrupted")) {
        return yield* invalid(`Setup item ${item.id} cannot start from ${prior.status}.`);
      }
      next = { ...base, status: "running", startedAt: timestamp };
      break;
    case "interrupt":
      if (prior.status !== "running" || !event.evidence) {
        return yield* invalid(`Setup item ${item.id} cannot be interrupted from ${prior.status}.`);
      }
      next = { ...base, status: "interrupted", startedAt: prior.startedAt, evidence: event.evidence };
      break;
    case "complete":
    case "fail":
      if (!event.evidence || (event.type === "fail" ? prior.status !== "running"
        : prior.status !== "running" && prior.status !== "interrupted") || blocked.length > 0) {
        return yield* invalid(`Setup item ${item.id} cannot ${event.type} from ${prior.status}.`);
      }
      next = { ...base, status: event.type === "complete" ? "completed" : "failed", evidence: event.evidence };
      break;
    case "skip":
      if (!["pending", "skipped", "failed"].includes(prior.status) || blocked.length === 0 || !event.evidence) {
        return yield* invalid(`Setup item ${item.id} cannot skip from ${prior.status}.`);
      }
      next = { ...base, status: "skipped", dependencies: blocked, evidence: event.evidence };
      break;
  }
  return {
    ...journal,
    records: journal.records.map((record) => record.id === item.id ? next : record),
    evidence: event.evidence === undefined ? journal.evidence : [...journal.evidence, event.evidence],
    catalog: event.catalog === undefined ? journal.catalog
      : [...journal.catalog.filter((entry) => entry.resource !== event.catalog?.resource), event.catalog],
  };
});

/** Validate relationships once, after decoding the persisted boundary. */
export const validateSetupJournal = (journal: SetupJournal): Effect.Effect<void, SetupError> =>
  Effect.gen(function*() {
    const invalid = (message: string) => new SetupError({
      operation: "setup journal", category: "prerequisite",
      message: `The setup journal is inconsistent: ${message}. Inspect any work that may already have run, back up and remove setup.json, then run setup plan and review it again. Do not remove state.sqlite.`,
      recovery: "Inspect any work that may already have run, back up and remove setup.json, then run setup plan and review it again. Do not remove state.sqlite.",
    });
    const ids = new Set(journal.items.map((item) => item.id));
    if (ids.size !== journal.items.length || journal.records.length !== ids.size
      || new Set(journal.records.map((record) => record.id)).size !== ids.size) {
      return yield* invalid("duplicate or missing item records");
    }
    for (const record of journal.records) {
      const item = journal.items.find((candidate) => candidate.id === record.id);
      if (item === undefined || record.detailDigest !== setupItemDetailDigest(item)) {
        return yield* invalid(`unknown item or stale detail digest for ${record.id}`);
      }
      if (record.status === "skipped" && (record.dependencies.length === 0
        || new Set(record.dependencies).size !== record.dependencies.length
        || record.dependencies.some((id) => !item.dependsOn.includes(id)))) {
        return yield* invalid(`invalid blocked dependencies for ${record.id}`);
      }
      if ("evidence" in record && record.evidence !== undefined && record.evidence.trim() === "") {
        return yield* invalid(`missing evidence for ${record.id}`);
      }
    }
    if (journal.records.filter((record) => record.status === "running" || record.status === "interrupted").length > 1) {
      return yield* invalid("more than one uncertain item");
    }
    if (journal.items.some((item) => new Set(item.dependsOn).size !== item.dependsOn.length
      || item.dependsOn.some((id) => !ids.has(id))) || findSetupDependencyCycle(journal.items) !== undefined) {
      return yield* invalid("invalid item dependency graph");
    }
    if (setupPlanDigest({
      role: journal.role, scope: journal.scope, intent: journal.intent,
      exclusions: journal.exclusions, inventory: journal.inventory, items: journal.items,
      discoveryInputs: journal.discoveryInputs,
      imports: journal.imports,
    }) !== journal.planDigest) return yield* invalid("stale plan digest");
    const stages = new Map(journal.stages.map((stage) => [stage.stage, stage]));
    const planning = journal.role === "source" && journal.scope === "full"
      ? ["role", "preflight", "inventory", "harnesses", "plan"] as const
      : ["role", "preflight", "inventory", "plan"] as const;
    if (stages.size !== journal.stages.length || planning.some((stage) => !stages.has(stage))) {
      return yield* invalid("duplicate or missing planning stages");
    }
    for (const stage of journal.stages) {
      const expected = stage.stage === "role" ? sha256Hex(canonicalJson(journal.role))
        : stage.stage === "preflight" ? sha256Hex(canonicalJson(asJson(journal.inventory.credentialStorage)))
        : stage.stage === "inventory" ? sha256Hex(canonicalJson(asJson(journal.inventory)))
        : stage.stage === "harnesses" ? undefined : journal.planDigest;
      if (expected !== undefined && stage.digest !== expected) return yield* invalid(`stale ${stage.stage} stage digest`);
    }
    if (journal.approvals.length > 1 || journal.approvals.some((approval) =>
      approval.digest !== journal.planDigest || approval.approver.trim() === "")
      || stages.has("approve") !== isSetupApproved(journal)
      || (stages.has("apply") && !isSetupApproved(journal))) {
      return yield* invalid("approval and stage records disagree");
    }
  });

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
  if (journal.records.some((record) => record.status === "running" || record.status === "interrupted")) return "apply";
  const completed = new Set(journal.stages.map((stage) => stage.stage));
  // Only a full Source plan selects harnesses.
  const planning = journal.role === "source" && journal.scope === "full"
    ? ["role", "preflight", "inventory", "harnesses", "plan"] as const
    : ["role", "preflight", "inventory", "plan"] as const;
  for (const stage of planning) {
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
