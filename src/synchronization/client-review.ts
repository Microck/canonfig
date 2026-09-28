import type { AppliedResourceRecord, PlannedAction } from "../domain/synchronization.ts";

/**
 * A step a client still needs from its user after Canonfig changed one of
 * its files.
 *
 * "Converged" means the files are written, not that the client uses them:
 * Codex runs a new or changed hook only after the user reviews it, and Gemini
 * CLI connects no MCP server, user-level ones included, in a folder it does
 * not trust. Canonfig cannot see or grant either, so it names the step and
 * `clientLoaded` stays not-verified until the user has checked each client.
 */
export interface ClientReviewStep {
  readonly client: "codex" | "gemini";
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

const geminiFolderTrust = {
  client: "gemini",
  step: "Gemini CLI connects no MCP server in a folder it does not trust: start gemini in each project folder, choose Trust folder (or change it later with /permissions), then check the servers with /mcp.",
  summary: "trust each project folder in Gemini CLI, then check /mcp",
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
      : directory === ".gemini" && file === "settings.json" && (keys === undefined || under(keys, "mcpServers"))
      ? geminiFolderTrust
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
