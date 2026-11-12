import { join } from "node:path";

import { Effect } from "effect";

import { MachineState } from "../machine/machine-state.service.ts";
import type { InstallDestinationHint, MachinePlatform } from "../machine/machine-state.types.ts";
import type { HarnessTakeover } from "../state/state-repository.types.ts";
import { adapterFor } from "./adapters/index.ts";
import { CanonicalFolderError, readHarnessSelection } from "./folder.ts";
import type { HarnessAdapter, RootContext } from "./harness.ts";
import { TARGET_IDS, type CanonicalModel, type TargetId } from "./model.ts";
import { listSnapshots } from "./takeover.ts";

/**
 * Harness detection: which harnesses are installed on this machine, and the
 * report `canonfig harnesses` and doctor print.
 *
 * Installed means one of the adapter's executables resolves through the same
 * search a tool verifier uses (Canonfig's install destinations, including the
 * npm folder of the Node running Canonfig, ~/.local/bin, then PATH), without
 * running it. A scheduled run has a narrower PATH than a
 * shell, so it can see fewer harnesses than setup did; projection holds such
 * a harness instead of retiring it (`plan.ts`). A config root alone is only
 * evidence: `~/.gemini` is shared by the Antigravity CLI, App and IDE.
 */

/**
 * Every installer method whose destination the search covers. Detection has
 * no recipe to name a method, so it searches all of this platform's; apt and
 * the system directories are already on every PATH.
 */
const DETECTION_METHODS = {
  linux: ["uv", "npm", "pnpm", "bun", "cargo", "brew"],
  macos: ["brew", "uv", "npm", "pnpm", "bun", "cargo"],
  windows: ["winget", "uv", "npm", "pnpm", "bun", "cargo"],
} satisfies Record<MachinePlatform, ReadonlyArray<string>>;

/** A model with nothing in it, for asking an adapter where its root is. */
export const emptyModel = (folder: string): CanonicalModel => ({
  folder,
  harnesses: [],
  surfaces: {},
  appendLocal: [],
  resources: [],
  rules: [],
  skills: [],
  agents: [],
  commands: [],
  hooks: [],
  mcp: [],
  settings: {},
});

export interface HarnessDetection {
  readonly harness: TargetId;
  readonly installed: boolean;
  /** The executable that resolved, absolute. */
  readonly executable?: string | undefined;
  readonly root: string;
  readonly rootExists: boolean;
}

const pathExists = (path: string) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    return yield* machine.normalizePath({ path }).pipe(
      Effect.flatMap((normalized) => machine.inspectPath(normalized)),
      Effect.map((object) => object.kind === "directory"),
      Effect.catch(() => Effect.succeed(false)),
    );
  });

const findExecutable = (name: string, methods: ReadonlyArray<InstallDestinationHint>) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    return yield* machine.findExecutable({ name, installMethods: methods }).pipe(
      Effect.map((found) => found.path.absolute),
      Effect.catch(() => Effect.succeed(undefined)),
    );
  });

const detectOne = (adapter: HarnessAdapter, context: RootContext, folder: string) =>
  Effect.gen(function*() {
    const methods = DETECTION_METHODS[context.platform].map((method) => ({ method }));
    const root = adapter.layout(context, emptyModel(folder)).root;
    const rootExists = yield* pathExists(root);
    const generic = new Set(adapter.descriptor.genericExecutables ?? []);
    for (const name of adapter.descriptor.executables) {
      // A generic name on PATH may belong to another tool; it counts only
      // next to the harness's own root.
      if (generic.has(name) && !rootExists) continue;
      const executable = yield* findExecutable(name, methods);
      if (executable !== undefined) {
        return { harness: adapter.descriptor.id, installed: true, executable, root, rootExists };
      }
    }
    return { harness: adapter.descriptor.id, installed: false, root, rootExists };
  });

/** Detect every harness, in TARGET_IDS order. Nothing is run or written. */
export const detectHarnesses = (context: RootContext, folder: string) =>
  Effect.forEach(TARGET_IDS, (harness) => detectOne(adapterFor(harness), context, folder));

/**
 * - `selected`: listed, installed and not excluded; sync projects it.
 * - `not-installed`: listed but not installed; reported, held as last applied.
 * - `excluded`: excluded on this machine in `local/local.jsonc`.
 * - `detected`: installed but not listed; ignored.
 * - `absent`: neither.
 */
export type HarnessStatus = "selected" | "not-installed" | "excluded" | "detected" | "absent";

export interface HarnessReportRow extends HarnessDetection {
  readonly name: string;
  readonly status: HarnessStatus;
  readonly listed: boolean;
  readonly excluded: boolean;
  /** The root recorded at takeover; later runs refuse any other. */
  readonly pinnedRoot?: string | undefined;
  /** The latest takeover snapshot holding this harness's prior content. */
  readonly snapshot?: string | undefined;
}

export interface HarnessReport {
  readonly folder: string;
  /** False until `canonfig.jsonc` exists. */
  readonly configured: boolean;
  readonly listed: ReadonlyArray<TargetId>;
  readonly excluded: ReadonlyArray<TargetId>;
  readonly detected: ReadonlyArray<TargetId>;
  readonly notInstalled: ReadonlyArray<TargetId>;
  readonly snapshots: number;
  readonly latestSnapshot?: string | undefined;
  readonly harnesses: ReadonlyArray<HarnessReportRow>;
}

const statusOf = (listed: boolean, excluded: boolean, installed: boolean): HarnessStatus => {
  if (excluded) return "excluded";
  if (listed) return installed ? "selected" : "not-installed";
  return installed ? "detected" : "absent";
};

/** The latest takeover row of a harness, by time taken over. */
const latestTakeover = (takeovers: ReadonlyArray<HarnessTakeover>, harness: string) =>
  takeovers
    .filter((takeover) => takeover.harness === harness)
    .sort((left, right) => left.takenOverAt < right.takenOverAt ? 1 : left.takenOverAt > right.takenOverAt ? -1 : 0)[0];

/**
 * What `canonfig harnesses` and doctor report: detection, the folder's list,
 * this machine's exclusions, pinned roots and takeover snapshots.
 */
export const harnessReport = (input: {
  readonly folder: string;
  readonly context: RootContext;
  readonly takeovers: ReadonlyArray<HarnessTakeover>;
}) =>
  Effect.gen(function*() {
    const selection = yield* Effect.tryPromise({
      try: () => readHarnessSelection(input.folder),
      catch: (error) => error instanceof CanonicalFolderError
        ? error
        : new CanonicalFolderError({ path: input.folder, message: String(error) }),
    });
    const detection = yield* detectHarnesses(input.context, input.folder);
    const snapshots = yield* listSnapshots(join(input.folder, ".backups"));
    const listed = new Set(selection.listed ?? []);
    const excluded = new Set(selection.excluded);
    const rows = detection.map((entry): HarnessReportRow => {
      const takeover = latestTakeover(input.takeovers, entry.harness);
      const snapshot = latestTakeover(input.takeovers.filter((row) => row.backup._tag === "Snapshot"), entry.harness);
      return {
        ...entry,
        name: adapterFor(entry.harness).descriptor.name,
        status: statusOf(listed.has(entry.harness), excluded.has(entry.harness), entry.installed),
        listed: listed.has(entry.harness),
        excluded: excluded.has(entry.harness),
        pinnedRoot: takeover?.root,
        snapshot: snapshot?.backup._tag === "Snapshot" ? snapshot.backup.id : undefined,
      };
    });
    return {
      folder: input.folder,
      configured: selection.listed !== undefined,
      listed: [...listed],
      excluded: [...excluded],
      detected: rows.filter((row) => row.installed).map((row) => row.harness),
      notInstalled: rows.filter((row) => row.status === "not-installed").map((row) => row.harness),
      snapshots: snapshots.length,
      latestSnapshot: snapshots.at(-1),
      harnesses: rows,
    } satisfies HarnessReport;
  });
