import type { AppliedResourceRecord, PlannedAction } from "../domain/synchronization.ts";

/**
 * A step a client still needs from its user after Canonfig changed one of
 * its files.
 *
 * Codex runs a new or changed hook only after the user reviews it. A
 * projected Antigravity MCP config needs an actual client invocation to
 * establish that its server loaded. Canonfig cannot infer either from the
 * written file, so `clientLoaded` stays not-verified until checked.
 */
export interface ClientReviewStep {
  readonly client: "codex" | "antigravity";
  readonly target: string;
  /** What to do, in full. */
  readonly step: string;
  /** The same step in a few words, for the completion receipt. */
  readonly summary: string;
}

/** One file Canonfig wrote: a merge names its keys, a whole-file write does not. */
export interface ClientFileChange {
  readonly target: string;
  readonly keys?: ReadonlyArray<string> | undefined;
}

const codexHookReview = {
  client: "codex",
  step: "Codex runs a new or changed hook only after you review it: open Codex, run /hooks, and trust each Canonfig hook (t).",
  summary: "review and trust the hooks in Codex (/hooks)",
} as const;

const antigravityMcpReview = {
  client: "antigravity",
  step: "Start Antigravity CLI in the project folder and invoke a managed MCP tool to confirm the changed server loaded; the config file alone cannot establish that.",
  summary: "invoke a managed MCP tool in Antigravity CLI",
} as const;

const under = (keys: ReadonlyArray<string>, root: string): boolean =>
  keys.some((key) => key === root || key.startsWith(`${root}.`));

/** The client steps that writing these files leaves to the user. */
export const clientReviewSteps = (
  changes: ReadonlyArray<ClientFileChange>,
): ReadonlyArray<ClientReviewStep> => {
  const steps = new Map<string, ClientReviewStep>();
  for (const { target, keys } of changes) {
    const segments = target.split(/[\\/]/u);
    const directory = segments.at(-2);
    const file = segments.at(-1);
    // A whole-file write can carry any key; a merge names the keys it owns.
    const review = directory === ".codex"
        && (file === "hooks.json" || (file === "config.toml" && keys !== undefined && under(keys, "hooks")))
      ? codexHookReview
      : directory === ".agents" && file === "mcp_config.json" && (keys === undefined || under(keys, "mcpServers"))
      ? antigravityMcpReview
      : undefined;
    if (review !== undefined) steps.set(`${review.client}\0${target}`, { ...review, target });
  }
  return [...steps.values()];
};

/** The files a plan writes. */
export const plannedFileChanges = (
  actions: ReadonlyArray<PlannedAction>,
): ReadonlyArray<ClientFileChange> =>
  actions.flatMap(({ detail }) =>
    detail.kind === "write-file"
      ? [{ target: detail.target }]
      : detail.kind === "write-config"
      ? [{ target: detail.target, keys: detail.keys }]
      : []
  );

/** The files Canonfig last wrote, from the Applied Resource Records. */
export const appliedFileChanges = (
  records: ReadonlyArray<AppliedResourceRecord>,
): ReadonlyArray<ClientFileChange> =>
  records.flatMap((record) =>
    record.target === undefined
      ? []
      : record.kind === "file"
      ? [{ target: record.target }]
      : record.kind === "config"
      ? [{ target: record.target, keys: record.ownedKeys ?? [] }]
      : []
  );
