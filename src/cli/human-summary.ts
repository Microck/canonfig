import { Schema } from "effect";

import { CliExitCode } from "./exit-codes.ts";
import type { CliPayload } from "./source-commands.ts";

/**
 * Human-mode rendering. `--json` carries the complete, stable record; this
 * output answers "what happened, what is wrong, what next" in a few lines.
 * Known payloads get a purpose-built summary, and every summary also outlines
 * fields it does not recognize, so a field added later is never silently
 * hidden from a person who did not ask for JSON.
 */

type PayloadRecord = { readonly [key: string]: CliPayload | undefined };

const isList = (value: CliPayload | undefined): value is ReadonlyArray<CliPayload> =>
  Array.isArray(value);

/** The object member of the CliPayload union, or undefined for every other member. */
const objectOf = (value: CliPayload | undefined): PayloadRecord | undefined => {
  if (
    value === undefined
    || value === null
    || isList(value)
    || Schema.is(Schema.String)(value)
    || Schema.is(Schema.Number)(value)
    || Schema.is(Schema.Boolean)(value)
  ) return undefined;
  return value;
};

const textOf = (value: CliPayload | undefined): string | undefined =>
  Schema.is(Schema.String)(value)
    ? value
    : Schema.is(Schema.Number)(value) || Schema.is(Schema.Boolean)(value)
    ? String(value)
    : undefined;

const recordsOf = (value: CliPayload | undefined): ReadonlyArray<PayloadRecord> =>
  isList(value)
    ? value.flatMap((entry) => {
      const object = objectOf(entry);
      return object === undefined ? [] : [object];
    })
    : [];

/** Machine fields that only make sense to a program; `--json` keeps them. */
const machineOnlyKeys: ReadonlyArray<string> = ["canonicalBytes", "encoded", "signature"];

const maximumListItems = 25;
const maximumDepth = 4;
const maximumTextLength = 240;

interface Outline {
  readonly lines: Array<string>;
  elided: boolean;
}

const clip = (text: string, outline: Outline): string => {
  if (text.length <= maximumTextLength) return text;
  outline.elided = true;
  return `${text.slice(0, maximumTextLength)}…`;
};

const scalarText = (value: CliPayload | undefined): string | undefined =>
  value === null ? "none" : textOf(value);

const pushText = (outline: Outline, pad: string, label: string, text: string): void => {
  const [first = "", ...continuation] = text.split("\n");
  outline.lines.push(`${pad}${label}${clip(first, outline)}`);
  for (const line of continuation) outline.lines.push(`${pad}  ${clip(line, outline)}`);
};

const outlineValue = (
  outline: Outline,
  pad: string,
  label: string,
  value: CliPayload | undefined,
  depth: number,
): void => {
  const scalar = scalarText(value);
  if (scalar !== undefined) {
    pushText(outline, pad, label, scalar);
    return;
  }
  if (isList(value)) {
    if (value.length === 0) {
      outline.lines.push(`${pad}${label}none`);
      return;
    }
    const scalars = value.map(scalarText);
    if (scalars.every((entry) => entry !== undefined)) {
      const joined = scalars.join(", ");
      if (joined.length <= 100 && !joined.includes("\n")) {
        outline.lines.push(`${pad}${label}${joined}`);
        return;
      }
    }
    if (label.length > 0) outline.lines.push(`${pad}${label.replace(/: $/u, "")} (${value.length}):`);
    const itemPad = label.length > 0 ? `${pad}  ` : pad;
    if (depth >= maximumDepth) {
      outline.elided = true;
      outline.lines.push(`${itemPad}…`);
      return;
    }
    for (const entry of value.slice(0, maximumListItems)) {
      const start = outline.lines.length;
      outlineValue(outline, `${itemPad}  `, "", entry, depth + 1);
      const first = outline.lines[start];
      if (first !== undefined) outline.lines[start] = `${itemPad}- ${first.slice(itemPad.length + 2)}`;
    }
    if (value.length > maximumListItems) {
      outline.elided = true;
      outline.lines.push(`${itemPad}… and ${value.length - maximumListItems} more`);
    }
    return;
  }
  const object = objectOf(value);
  if (object === undefined) return;
  const entries = Object.entries(object).filter(([key, entry]) =>
    entry !== undefined && !machineOnlyKeys.includes(key)
  );
  if (label.length > 0) outline.lines.push(`${pad}${label.replace(/: $/u, ":")}`);
  if (depth >= maximumDepth) {
    outline.elided = true;
    outline.lines.push(`${pad}  …`);
    return;
  }
  const inner = label.length > 0 ? `${pad}  ` : pad;
  for (const [key, entry] of entries) outlineValue(outline, inner, `${key}: `, entry, depth + 1);
};

const newOutline = (): Outline => ({ lines: [], elided: false });

/** Outline the fields of `value` that a summary did not already present. */
const outlineRest = (
  outline: Outline,
  value: PayloadRecord,
  presented: ReadonlyArray<string>,
  pad = "",
): void => {
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || presented.includes(key) || machineOnlyKeys.includes(key)) continue;
    outlineValue(outline, pad, `${key}: `, entry, 1);
  }
};

const column = (text: string | undefined, width: number): string =>
  (text ?? "").padEnd(width);

// ── doctor ────────────────────────────────────────────────────────────────

const summarizeDoctor = (data: PayloadRecord, outline: Outline): boolean => {
  if (data.schema !== "canonfig.doctor/v1" || !isList(data.probes)) return false;
  const probes = recordsOf(data.probes);
  outline.lines.push(`overall: ${textOf(data.status) ?? "unknown"}`);
  for (const probe of probes) {
    const status = textOf(probe.status);
    outline.lines.push(
      `  ${column(status, 8)} ${column(textOf(probe.name), 17)} ${textOf(probe.message) ?? ""}`.trimEnd(),
    );
    if (status !== "pass" && objectOf(probe.details) !== undefined) {
      outlineValue(outline, "           ", "", probe.details, 2);
    }
    outlineRest(outline, probe, ["status", "name", "message", "details"], "           ");
  }
  outlineRest(outline, data, ["schema", "status", "probes", "noInput", "timeoutMilliseconds"]);
  return true;
};

// ── status ────────────────────────────────────────────────────────────────

const lifecycleOrder = ["discovered", "enrolled", "selected", "reachable", "converged"];
const receiptOrder = ["published", "applied", "independentlyVerified", "clientLoaded", "scheduled"];

const summarizeStatus = (data: PayloadRecord, outline: Outline): boolean => {
  const role = objectOf(data.machineRole);
  if (role === undefined && objectOf(data.lifecycle) === undefined) return false;
  const roleName = textOf(role?.role) ?? "unknown";
  const follower = objectOf(data.follower);
  if (roleName === "follower") {
    const name = textOf(follower?.name);
    const id = textOf(follower?.id) ?? textOf(role?.follower);
    outline.lines.push(`role: follower${name === undefined ? "" : ` ${name}`}${id === undefined ? "" : ` (${id})`}`);
  } else {
    outline.lines.push(`role: ${roleName}`);
  }
  if (role !== undefined) {
    const sourceFingerprint = textOf(role.sourceFingerprint);
    const tlsFingerprint = textOf(role.tlsFingerprint);
    if (sourceFingerprint !== undefined) outline.lines.push(`source signing fingerprint: ${sourceFingerprint}`);
    if (tlsFingerprint !== undefined) outline.lines.push(`source TLS fingerprint: ${tlsFingerprint}`);
  }
  const lifecycle = objectOf(data.lifecycle);
  const enrolled = objectOf(lifecycle?.enrolled)?.reached === true;
  if (lifecycle !== undefined && roleName === "source" && !enrolled) {
    outline.lines.push(
      "follower lifecycle: not applicable on the Source Machine",
      "  (run 'canonfig status --follower <id>' for one follower's enrollment; each follower reports its own convergence)",
    );
  } else if (lifecycle !== undefined) {
    outline.lines.push("lifecycle:");
    const keys = [
      ...lifecycleOrder.filter((key) => key in lifecycle),
      ...Object.keys(lifecycle).filter((key) => !lifecycleOrder.includes(key)),
    ];
    for (const key of keys) {
      const stage = objectOf(lifecycle[key]);
      if (stage === undefined) continue;
      outline.lines.push(`  [${stage.reached === true ? "x" : " "}] ${column(key, 11)} ${textOf(stage.detail) ?? ""}`.trimEnd());
      outlineRest(outline, stage, ["reached", "detail"], "      ");
    }
  }
  const receipt = objectOf(data.completionReceipt);
  if (receipt !== undefined) {
    const revision = textOf(receipt.revision);
    outline.lines.push(`completion receipt${revision === undefined ? "" : ` for ${revision}`}:`);
    for (const key of receiptOrder) {
      const entry = objectOf(receipt[key]);
      if (entry === undefined) continue;
      outline.lines.push(`  ${column(key, 21)} ${column(textOf(entry.status), 13)} ${textOf(entry.detail) ?? ""}`.trimEnd());
      outlineRest(outline, entry, ["status", "detail"], "      ");
    }
    const secondRun = textOf(receipt.secondRunNoOp);
    if (secondRun !== undefined) outline.lines.push(`  second run no-op: ${secondRun}`);
    const build = objectOf(receipt.build);
    if (build !== undefined) {
      outline.lines.push(
        `  build: ${textOf(build.packageVersion) ?? "unknown"} (${textOf(build.identity) ?? "unknown"}, state format ${textOf(build.stateFormat) ?? "unknown"})`,
      );
    }
    const qualifications = receipt.mcpQualifications;
    if (isList(qualifications) && qualifications.length > 0) {
      outlineValue(outline, "  ", "MCP qualifications: ", qualifications, 2);
    }
    outlineRest(
      outline,
      receipt,
      [...receiptOrder, "revision", "secondRunNoOp", "build", "mcpQualifications"],
      "  ",
    );
  }
  const tunnel = objectOf(data.tunnel);
  if (tunnel !== undefined) {
    outline.lines.push(`tunnel: ${textOf(tunnel.lifecycle) ?? "unknown"}${textOf(tunnel.detail) === undefined ? "" : ` (${textOf(tunnel.detail)})`}`);
    outlineRest(outline, tunnel, ["lifecycle", "detail"], "  ");
  }
  if ("localOverlay" in data) outlineValue(outline, "", "local overlays: ", data.localOverlay, 1);
  outlineRest(
    outline,
    data,
    [
      "machineRole", "follower", "lifecycle", "completionReceipt", "tunnel",
      "localOverlay", "sourceIdentity",
    ],
  );
  return true;
};

// ── sync ──────────────────────────────────────────────────────────────────

const actionTarget = (detail: PayloadRecord | undefined): string => {
  if (detail === undefined) return "";
  const target = textOf(detail.target) ?? textOf(detail.toolId) ?? "";
  const keys = isList(detail.keys) ? detail.keys.map(textOf).filter((key) => key !== undefined) : [];
  const removes = isList(detail.removes) ? detail.removes.map(textOf).filter((key) => key !== undefined) : [];
  return [
    target,
    keys.length > 0 ? `keys: ${keys.join(", ")}` : undefined,
    removes.length > 0 ? `removes: ${removes.join(", ")}` : undefined,
  ].filter((part) => part !== undefined && part.length > 0).join("  ");
};

/**
 * Consequences a plan discloses per action: retained keys (CF-22), and for a
 * human-action the blocking reason and what to do, which the resource column
 * alone does not say.
 */
const actionNotices = (detail: PayloadRecord | undefined): ReadonlyArray<string> => {
  if (detail === undefined) return [];
  const retains = isList(detail.retains) ? detail.retains.map(textOf).filter((key) => key !== undefined) : [];
  const notices = Object.entries(detail)
    .filter(([key]) => key.endsWith("Notice"))
    .map(([, value]) => textOf(value))
    .filter((notice) => notice !== undefined);
  const blocking = detail.kind === "human-action"
    ? [textOf(detail.reason), textOf(detail.instructions)].filter((text) => text !== undefined)
    : [];
  return [...(retains.length > 0 ? [`retains: ${retains.join(", ")}`] : []), ...notices, ...blocking];
};

const summarizeSync = (data: PayloadRecord, outline: Outline): boolean => {
  if (!("mode" in data) && !("plan" in data) && !("outcome" in data)) return false;
  const revision = textOf(data.revision);
  if (revision !== undefined) outline.lines.push(`revision: ${revision}`);
  const downloaded = textOf(data.downloadedBlobs);
  const reused = textOf(data.reusedBlobs);
  if (downloaded !== undefined || reused !== undefined) {
    outline.lines.push(`content: ${downloaded ?? "0"} blob(s) downloaded, ${reused ?? "0"} reused`);
  }
  const plan = objectOf(data.plan);
  const actions = recordsOf(plan?.actions);
  if (plan !== undefined) {
    if (actions.length === 0) {
      outline.lines.push("actions: none; the follower already matches this revision");
    } else {
      outline.lines.push(`actions (${actions.length}):`);
      for (const action of actions.slice(0, maximumListItems)) {
        const detail = objectOf(action.detail);
        outline.lines.push(
          `  ${column(textOf(action.kind), 16)} ${column(textOf(action.resource), 24)} ${actionTarget(detail)}`.trimEnd(),
        );
        for (const notice of actionNotices(detail)) pushText(outline, "      ", "", notice);
      }
      if (actions.length > maximumListItems) {
        outline.elided = true;
        outline.lines.push(`  … and ${actions.length - maximumListItems} more`);
      }
    }
    const tasks = plan.agentTasks;
    if (isList(tasks) && tasks.length > 0) outlineValue(outline, "", "agent tasks: ", tasks, 1);
    outlineRest(
      outline,
      plan,
      ["actions", "agentTasks", "digest", "follower", "requiredBlobs", "revision"],
      "  ",
    );
  }
  const outcome = objectOf(data.outcome);
  if (outcome !== undefined) {
    const reason = textOf(outcome.reason);
    outline.lines.push(`outcome: ${textOf(outcome.outcome) ?? "unknown"}${reason === undefined ? "" : ` — ${reason}`}`);
    const run = textOf(outcome.run);
    if (run !== undefined) outline.lines.push(`run: ${run}`);
    outlineRest(outline, outcome, ["outcome", "reason", "run"], "  ");
  }
  const resolutions = data.agentResolutions;
  if (isList(resolutions) && resolutions.length > 0) {
    outlineValue(outline, "", "agent resolutions: ", resolutions, 1);
  }
  outlineRest(
    outline,
    data,
    ["mode", "revision", "downloadedBlobs", "reusedBlobs", "plan", "outcome", "agentResolutions", "warnings", "clientSteps"],
  );
  // Unshortened: a warning ends with the exact command that resolves it.
  const warnings = isList(data.warnings) ? data.warnings.map(textOf).filter((warning) => warning !== undefined) : [];
  if (warnings.length > 0) {
    outline.lines.push("warnings:");
    for (const warning of warnings) {
      const [first = "", ...rest] = warning.split("\n");
      outline.lines.push(`  - ${first}`, ...rest.map((line) => `    ${line}`));
    }
  }
  const clientSteps = recordsOf(data.clientSteps);
  if (clientSteps.length > 0) {
    outline.lines.push("still to do in each client (Canonfig cannot check this; clientLoaded stays not-verified):");
    for (const step of clientSteps) {
      outline.lines.push(`  - ${textOf(step.client) ?? "client"} ${textOf(step.target) ?? ""}: ${textOf(step.step) ?? ""}`);
    }
  }
  if (data.mode === "plan" && actions.length > 0) {
    outline.lines.push("", "Apply these actions with: canonfig sync --apply");
  }
  return true;
};

// ── source publication and profiles ──────────────────────────────────────

const summarizeRevision = (data: PayloadRecord, outline: Outline): boolean => {
  if (!("profileId" in data) || !("sequence" in data) || !isList(data.resources)) return false;
  outline.lines.push(
    `profile: ${textOf(data.profileId) ?? "unknown"}, sequence ${textOf(data.sequence) ?? "?"}`,
    `revision: ${textOf(data.id) ?? "unknown"}`,
  );
  const publishedAt = textOf(data.publishedAt);
  if (publishedAt !== undefined) outline.lines.push(`published at: ${publishedAt}`);
  const resources = recordsOf(data.resources);
  outline.lines.push(`resources (${resources.length}):`);
  for (const resource of resources.slice(0, maximumListItems)) {
    const target = textOf(resource.target);
    outline.lines.push(
      `  ${column(textOf(resource.kind), 10)} ${column(textOf(resource.id), 28)}${target === undefined ? "" : ` → ${target}`}`.trimEnd(),
    );
  }
  if (resources.length > maximumListItems) {
    outline.elided = true;
    outline.lines.push(`  … and ${resources.length - maximumListItems} more`);
  }
  const groups = data.groups;
  if (isList(groups) && groups.length > 0) outlineValue(outline, "", "groups: ", groups, 1);
  outlineRest(
    outline,
    data,
    ["profileId", "sequence", "id", "digest", "publishedAt", "resources", "groups"],
  );
  return true;
};

const summarizeDigests = (data: PayloadRecord, outline: Outline): boolean => {
  if (!isList(data.resources)) return false;
  const resources = recordsOf(data.resources);
  outline.lines.push(`profile: ${textOf(data.profile) ?? "unknown"}`);
  outline.lines.push(`content digests (${resources.length}):`);
  let mismatches = 0;
  for (const resource of resources) {
    const declared = textOf(resource.declaredDigest);
    const verdict = resource.matches === false ? "  MISMATCH" : resource.matches === true ? "  matches" : "";
    if (resource.matches === false) mismatches += 1;
    outline.lines.push(
      `  ${column(textOf(resource.kind), 10)} ${column(textOf(resource.id), 28)} ${textOf(resource.digest) ?? ""}${verdict}`.trimEnd(),
    );
    if (resource.matches === false && declared !== undefined) outline.lines.push(`             declared ${declared}`);
    outlineRest(outline, resource, ["id", "kind", "verify", "digest", "declaredDigest", "matches"], "             ");
  }
  outlineRest(outline, data, ["profile", "resources"]);
  if (mismatches > 0) {
    outline.lines.push(
      "",
      `${mismatches} declared digest(s) differ: set verify.digest to the computed value, or omit it and publish computes it.`,
    );
  }
  return true;
};

const summarizeProfileList = (data: PayloadRecord, outline: Outline): boolean => {
  if (!isList(data.revisions)) return false;
  const revisions = recordsOf(data.revisions);
  if (revisions.length === 0) outline.lines.push("revisions: none published");
  else {
    outline.lines.push(`revisions (${revisions.length}):`);
    for (const revision of revisions) {
      outline.lines.push(
        `  ${column(textOf(revision.profileId), 16)} #${column(textOf(revision.sequence), 4)} ${column(textOf(revision.publishedAt), 25)} ${textOf(revision.id) ?? ""}`.trimEnd(),
      );
    }
  }
  outlineRest(outline, data, ["revisions"]);
  return true;
};

const summarizeScan = (data: PayloadRecord, outline: Outline): boolean => {
  if (!isList(data.scannedPaths) || !isList(data.tools)) return false;
  outline.lines.push(
    `scanned ${data.scannedPaths.length} file(s) for tool evidence`,
    "(scan discovers tools only; author file, config, and skill resources in a profile file)",
  );
  const tools = recordsOf(data.tools);
  if (tools.length === 0) outline.lines.push("tools: none found");
  else {
    outline.lines.push(`tools (${tools.length}):`);
    for (const tool of tools) {
      const recipes = recordsOf(tool.recipes).map((recipe) => {
        const version = textOf(recipe.version);
        return `${textOf(recipe.method) ?? "?"} ${textOf(recipe.package) ?? "?"}${version === undefined ? "" : `@${version}`}`;
      });
      outline.lines.push(
        `  ${column(textOf(tool.reviewStatus), 13)} ${column(textOf(tool.id), 24)} ${recipes.length === 0 ? "no deterministic recipe" : recipes.join(", ")}`.trimEnd(),
      );
    }
  }
  const skills = data.skills;
  if (isList(skills) && skills.length > 0) outlineValue(outline, "", "skills: ", skills, 1);
  const tasks = recordsOf(data.agentTasks);
  if (tasks.length > 0) {
    outline.lines.push(`needs review (${tasks.length}):`);
    for (const task of tasks) {
      outline.lines.push(`  ${textOf(task.id) ?? "task"}: ${textOf(task.desiredOutcome) ?? ""}`.trimEnd());
    }
    outline.lines.push(
      "  A proposal with unreviewed evidence cannot be published with --proposal. Author the",
      "  tool resource (with a recipe) in your profile file, or scan only files whose evidence is accepted.",
    );
  }
  outlineRest(outline, data, ["scannedPaths", "tools", "skills", "agentTasks", "evidence", "resources"]);
  return true;
};

// ── setup ─────────────────────────────────────────────────────────────────

const summarizeSetup = (data: PayloadRecord, outline: Outline): boolean => {
  if (!isList(data.items) || !("role" in data || "stage" in data)) return false;
  const role = textOf(data.role);
  const scope = textOf(data.scope);
  const mode = textOf(data.mode);
  outline.lines.push(
    `setup: ${role ?? "role not chosen"}${scope === undefined ? "" : `, scope ${scope}`}`
      + `${mode === undefined ? "" : `, mode ${mode}`}`,
  );
  const intent = textOf(data.intent);
  if (intent !== undefined) outline.lines.push(`intent: ${intent}`);
  const discoveryPaths = isList(data.discoveryPaths)
    ? data.discoveryPaths.map(textOf).filter((path) => path !== undefined)
    : [];
  if (discoveryPaths.length > 0) {
    outline.lines.push("discovery paths:", ...discoveryPaths.map((path) => `  ${path}`));
  }
  const planDigest = textOf(data.planDigest);
  if (planDigest !== undefined) outline.lines.push(`plan digest: ${planDigest}`);
  const stages = recordsOf(data.stages).map((stage) => textOf(stage.stage)).filter((stage) => stage !== undefined);
  if (stages.length > 0) outline.lines.push(`completed stages: ${stages.join(", ")}`);
  const approvals = recordsOf(data.approvals);
  const approved = data.approved === true || approvals.length > 0;
  for (const approval of approvals) {
    outline.lines.push(`approved by ${textOf(approval.approver) ?? "?"} at ${textOf(approval.approvedAt) ?? "?"}`);
  }
  const statuses = new Map(
    recordsOf(data.records).map((record) => [textOf(record.id), textOf(record.status)]),
  );
  const items = recordsOf(data.items);
  outline.lines.push(`items (${items.length}):`);
  for (const item of items) {
    const id = textOf(item.id);
    const status = textOf(item.status) ?? statuses.get(id) ?? "pending";
    outline.lines.push(
      `  ${column(status, 10)} ${id ?? "item"}${item.optional === true ? " (optional)" : ""}`,
    );
  }
  const exclusions = data.exclusions;
  if (isList(exclusions)) outlineValue(outline, "", "exclusions: ", exclusions, 1);
  const decisions = data.decisions;
  if (isList(decisions) && decisions.length > 0) outlineValue(outline, "", "decisions: ", decisions, 1);
  outlineRest(
    outline,
    data,
    [
      "schema", "role", "scope", "mode", "intent", "discoveryPaths", "planDigest", "stages", "approvals", "approved",
      "records", "items", "exclusions", "decisions", "inventory", "evidence", "catalog",
      "createdAt", "updatedAt", "stage",
    ],
  );
  const stage = textOf(data.stage);
  const pending = items.some((item) =>
    (textOf(item.status) ?? statuses.get(textOf(item.id)) ?? "pending") === "pending"
  );
  if (stage !== undefined) outline.lines.push(`next stage: ${stage}`);
  if (role !== undefined && !approved) {
    outline.lines.push("", "Review the plan, then approve it with: canonfig setup approve --approver <name>");
  } else if (role !== undefined && pending) {
    outline.lines.push("", "Apply the approved plan with: canonfig setup apply");
  }
  return true;
};

const summaries: ReadonlyArray<readonly [(command: string) => boolean, (data: PayloadRecord, outline: Outline) => boolean]> = [
  [(command) => command === "doctor", summarizeDoctor],
  [(command) => command === "status", summarizeStatus],
  [(command) => command.startsWith("sync."), summarizeSync],
  [(command) => command === "source.publish" || command === "profile.show", summarizeRevision],
  [(command) => command === "profile.list", summarizeProfileList],
  [(command) => command === "source.digest", summarizeDigests],
  [(command) => command === "source.scan", summarizeScan],
  [(command) => command.startsWith("setup."), summarizeSetup],
];

const failureLabels = {
  [CliExitCode.internal]: "internal defect",
  [CliExitCode.usageOrConfiguration]: "usage or configuration",
  [CliExitCode.humanActionRequired]: "Human Action Required",
  [CliExitCode.conflictOrDrift]: "conflict or Follower Drift",
  [CliExitCode.authenticationOrRevocation]: "authentication or revocation",
  [CliExitCode.transport]: "transport",
  [CliExitCode.verificationOrApplyFailure]: "verification or apply failure",
} satisfies Record<Exclude<CliExitCode, typeof CliExitCode.success>, string>;

/**
 * Renders an already redacted result for a person. The message always leads,
 * a failure always ends with its exit code and category, and elided detail
 * points at `--json` rather than disappearing silently.
 */
export const renderHumanSummary = (
  command: string,
  message: string,
  exitCode: CliExitCode,
  data: CliPayload | undefined,
): string => {
  const outline = newOutline();
  if (data !== undefined) {
    const summarize = summaries.find(([matches]) => matches(command))?.[1];
    const object = objectOf(data);
    const summarized = object !== undefined && summarize !== undefined && summarize(object, outline);
    if (!summarized) outlineValue(outline, "", "", data, 0);
  }
  const lines = [message, ...outline.lines];
  if (exitCode !== CliExitCode.success) {
    lines.push(`exit ${exitCode}: ${failureLabels[exitCode] ?? "failure"}`);
  }
  if (outline.elided) lines.push("(details shortened; add --json for the complete record)");
  return `${lines.join("\n")}\n`;
};
