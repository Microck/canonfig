import { userInfo, version as nodeVersion } from "node:os";
import { dirname, join } from "node:path";

import { Effect, Schema } from "effect";

import { SourceNotInitializedError } from "../enrollment/enrollment.errors.ts";
import { Enrollment } from "../enrollment/enrollment.service.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { canonicalJson, sha256Hex, type JsonValue } from "../profile/profile-codec.ts";
import { scanDiscovery } from "../profile/discovery.ts";
import { SetupError } from "./setup.errors.ts";
import {
  findSetupDependencyCycle,
  isSetupApproved,
  nextEligibleSetupStage,
  setupItemVerdicts,
  setupPlanDigest,
} from "./setup.plan.ts";
import {
  decodeSetupJournal,
  encodeSetupJournal,
  maxSetupDiscoveryFileBytes,
  maxSetupDiscoveryFiles,
  maxSetupJournalBytes,
  maxSetupProcessBytes,
  maxSetupTools,
  setupProcessTimeoutMilliseconds,
  setupToolMethodsFor,
  type SetupInventory,
  type SetupJournal,
  type SetupPlanItem,
  type SetupProvenance,
  type SetupRole,
} from "./setup.types.ts";

/** The journal lives next to the state database, like the schedule fires. */
export const setupJournalPath = (statePath: string): string =>
  join(dirname(statePath), "setup.json");

const fail = (
  operation: string,
  message: string,
  category: SetupError["category"],
  recovery?: string,
): SetupError => new SetupError({ operation, message, category, recovery });

/** Establish the requested role before running role-specific inspection. */
export const establishSetupRole = (value: string): Effect.Effect<SetupRole, SetupError> =>
  Schema.decodeUnknown(SetupRole)(value).pipe(
    Effect.mapError(() =>
      fail(
        "setup role",
        `unknown setup role: ${value}`,
        "usage",
        "Run setup with --role source or --role follower.",
      )
    ),
  );

const readJournal = (
  machine: MachineState["Service"],
  journalPath: string,
): Effect.Effect<SetupJournal | undefined, SetupError> =>
  Effect.gen(function*() {
    const path = yield* machine.normalizePath({ path: journalPath }).pipe(
      Effect.mapError((cause) =>
        fail("setup journal", `the setup journal path is invalid: ${cause.message}`, "state")),
    );
    const bytes = yield* machine.readFile({ path, maximumBytes: maxSetupJournalBytes }).pipe(
      Effect.catchTag("MachineFilesystemError", (cause) =>
        /\b(?:ENOENT|ENOTDIR)\b/u.test(cause.message)
          ? Effect.succeed(undefined)
          : Effect.fail(fail("setup journal", `the setup journal could not be read: ${cause.message}`, "state"))),
      Effect.catchTag("FileSizeLimitError", (cause) =>
        Effect.fail(fail(
          "setup journal",
          `the setup journal at ${cause.path} exceeds its size bound; back it up and remove it before re-running setup`,
          "state",
        ))),
    );
    if (bytes === undefined) return undefined;
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => fail("setup journal", "the setup journal is not valid UTF-8", "state"),
    });
    return yield* Effect.try({
      try: () => decodeSetupJournal(JSON.parse(text)),
      catch: () =>
        fail(
          "setup journal",
          "the setup journal does not match its contract; back it up and remove it before re-running setup",
          "state",
        ),
    });
  });

const writeJournal = (
  machine: MachineState["Service"],
  journalPath: string,
  journal: SetupJournal,
): Effect.Effect<void, SetupError> =>
  Effect.gen(function*() {
    const path = yield* machine.normalizePath({ path: journalPath }).pipe(
      Effect.mapError((cause) =>
        fail("setup journal", `the setup journal path is invalid: ${cause.message}`, "state")),
    );
    const encoded = yield* Effect.try({
      try: () => encodeSetupJournal({ ...journal, updatedAt: new Date().toISOString() }),
      catch: (cause) => fail("setup journal", `the setup journal could not be encoded: ${String(cause)}`, "state"),
    });
    const content = new TextEncoder().encode(`${canonicalJson(encoded as JsonValue)}\n`);
    if (content.length > maxSetupJournalBytes) {
      return yield* fail(
        "setup journal",
        "the setup journal exceeds its size bound; exclusions and evidence grew past what setup can persist",
        "state",
      );
    }
    yield* machine.atomicWrite({ path, content, mode: 0o600 }).pipe(
      Effect.mapError((cause) =>
        fail("setup journal", `the setup journal could not be written: ${cause.message}`, "state")),
    );
  });

const credentialInventory = (
  machine: MachineState["Service"],
): Effect.Effect<SetupInventory["credentialStorage"], SetupError> =>
  machine.credentialCapability().pipe(
    Effect.mapError((cause) =>
      fail("setup preflight", `credential storage could not be inspected: ${cause.message}`, "state")),
    Effect.map((capability) => {
      switch (capability.kind) {
        case "secure-noninteractive":
          return { kind: capability.kind, provider: capability.provider, verification: capability.verification };
        case "local-file":
          return { kind: capability.kind };
        case "unavailable":
          return { kind: capability.kind, recovery: capability.recovery };
      }
    }),
  );

/**
 * Operation-specific preflight, including Source signing/TLS key storage.
 * A fresh headless Source reports the precise missing prerequisites here,
 * before setup attempts initialization.
 */
export const runSetupPreflight = (
  role: SetupRole,
): Effect.Effect<
  Pick<SetupInventory, "platform" | "home" | "credentialStorage">,
  SetupError,
  MachineState
> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const directories = yield* machine.userDirectories().pipe(
      Effect.mapError((cause) =>
        fail("setup preflight", `machine directories could not be read: ${cause.message}`, "state")),
    );
    const credentialStorage = yield* credentialInventory(machine);
    if (role === "source" && credentialStorage.kind === "unavailable") {
      return yield* fail(
        "setup preflight",
        "this machine cannot be a Source: key storage is unavailable "
        + `(${credentialStorage.recovery ?? "no recovery reported"}). Canonfig stores the Source signing key, `
        + "the TLS key, and the TLS certificate before initialization, so setup stops here.",
        "prerequisite",
        credentialStorage.recovery,
      );
    }
    return {
      platform: directories.home.platform,
      home: directories.home.absolute,
      credentialStorage,
    };
  });

const probeOsRelease = (
  machine: MachineState["Service"],
  platform: SetupInventory["platform"],
): Effect.Effect<string, SetupError> => {
  if (platform === "windows") return Effect.succeed("windows");
  return Effect.gen(function*() {
    const uname = yield* machine.findExecutable({ name: "uname" }).pipe(
      Effect.mapError((cause) =>
        fail("setup inventory", `the OS release probe is unavailable: ${cause.message}`, "state")),
    );
    const result = yield* machine.runProcess({
      executable: uname.path,
      arguments: ["-srm"],
      timeoutMilliseconds: setupProcessTimeoutMilliseconds,
      maximumOutputBytes: maxSetupProcessBytes,
    }).pipe(
      Effect.mapError((cause) =>
        fail("setup inventory", `the OS release probe failed: ${cause.message}`, "state")),
    );
    if (result.exitCode !== 0 || result.standardOutput.length === 0) {
      return yield* fail("setup inventory", "the OS release probe reported nothing", "state");
    }
    return new TextDecoder().decode(result.standardOutput).trim();
  });
};

const probeTools = (
  machine: MachineState["Service"],
  platform: SetupInventory["platform"],
): Effect.Effect<SetupInventory["tools"], SetupError> =>
  Effect.gen(function*() {
    const tools: Array<SetupInventory["tools"][number]> = [];
    for (const method of setupToolMethodsFor(platform)) {
      if (tools.length >= maxSetupTools) break;
      const found = yield* machine.findExecutable({ name: method }).pipe(
        Effect.map((executable) => executable.path.absolute),
        Effect.catchAll(() => Effect.succeed(undefined)),
      );
      if (found !== undefined) tools.push({ method, executable: found, verified: false });
    }
    return tools;
  });

const probeTransport = (
  enrollment: Enrollment["Service"],
): Effect.Effect<SetupInventory["transport"], SetupError> =>
  enrollment.source().pipe(
    Effect.map((material) => ({
      policy: "loopback" as const,
      initialized: true as const,
      tlsFingerprint: material.tlsFingerprint,
    })),
    Effect.catchTag("SourceNotInitializedError", () =>
      Effect.succeed({ policy: "loopback" as const, initialized: false as const })),
    Effect.catchAll((cause) =>
      cause instanceof SourceNotInitializedError
        ? Effect.succeed({ policy: "loopback" as const, initialized: false as const })
        : Effect.fail(fail(
          "setup inventory",
          `source enrollment state could not be read: ${(cause as Error).message}`,
          "state",
        ))),
  );

/** Bounded typed inventory with verified identities. */
export const collectSetupInventory = (
  preflight: Pick<SetupInventory, "platform" | "home" | "credentialStorage">,
): Effect.Effect<
  Omit<SetupInventory, "discoveryFiles" | "discoveryEvidence">,
  SetupError,
  MachineState | Enrollment
> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const enrollment = yield* Enrollment;
    const osRelease = yield* probeOsRelease(machine, preflight.platform);
    const account = yield* Effect.try({
      try: () => {
        const identity = userInfo().username;
        if (identity.length === 0) throw new Error("empty username");
        return identity;
      },
      catch: () => fail("setup inventory", "the current account identity could not be read", "state"),
    });
    const transport = yield* probeTransport(enrollment);
    const tools = yield* probeTools(machine, preflight.platform);
    return {
      schema: "canonfig.setup-inventory/v1" as const,
      platform: preflight.platform,
      home: preflight.home,
      account,
      osRelease,
      nodeRuntime: nodeVersion,
      credentialStorage: preflight.credentialStorage,
      transport,
      tools,
    };
  });

const checkDiscoverySizes = (
  machine: MachineState["Service"],
  files: ReadonlyArray<string>,
): Effect.Effect<
  { readonly accepted: ReadonlyArray<string>; readonly exclusions: ReadonlyArray<string> },
  SetupError
> =>
  Effect.gen(function*() {
    const accepted: Array<string> = [];
    const exclusions: Array<string> = [];
    for (const file of files.slice(0, maxSetupDiscoveryFiles)) {
      const path = yield* machine.normalizePath({ path: file }).pipe(
        Effect.mapError((cause) =>
          fail("setup discovery", `discovery file ${file} is invalid: ${cause.message}`, "state")),
      );
      const size = yield* machine.readFile({ path, maximumBytes: maxSetupDiscoveryFileBytes + 1 }).pipe(
        Effect.map((bytes) => bytes.length),
        Effect.catchTag("FileSizeLimitError", () => Effect.succeed(maxSetupDiscoveryFileBytes + 1)),
        Effect.catchTag("MachineFilesystemError", (cause) =>
          /\b(?:ENOENT|ENOTDIR)\b/u.test(cause.message)
            ? Effect.succeed(-1)
            : Effect.fail(fail("setup discovery", `discovery file ${file} could not be read: ${cause.message}`, "state"))),
      );
      if (size === -1) exclusions.push(`${file}: file not found`);
      else if (size > maxSetupDiscoveryFileBytes) {
        exclusions.push(`${file}: file exceeds the ${maxSetupDiscoveryFileBytes} byte discovery bound`);
      } else accepted.push(file);
    }
    if (files.length > maxSetupDiscoveryFiles) {
      exclusions.push(
        `${files.length - maxSetupDiscoveryFiles} file(s) exceed the ${maxSetupDiscoveryFiles} file discovery bound`,
      );
    }
    return { accepted, exclusions };
  });

/**
 * Run the shipped discovery operation over the bounded file set. Files the
 * operator passes but setup cannot take become exclusions, not failures.
 */
export const runSetupDiscovery = (
  files: ReadonlyArray<string>,
): Effect.Effect<
  { readonly files: number; readonly evidence: number; readonly exclusions: ReadonlyArray<string> },
  SetupError,
  MachineState
> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    if (files.length === 0) return { files: 0, evidence: 0, exclusions: [] };
    const { accepted, exclusions } = yield* checkDiscoverySizes(machine, files);
    if (accepted.length === 0) return { files: 0, evidence: 0, exclusions };
    const result = yield* scanDiscovery({ files: accepted.map((path) => ({ path })) }).pipe(
      Effect.mapError((cause) => fail("setup discovery", `discovery failed: ${cause.message}`, "state")),
    );
    return { files: accepted.length, evidence: result.evidence.length, exclusions };
  });

const planItemsFor = (
  role: SetupRole,
  tools: SetupInventory["tools"],
): ReadonlyArray<SetupPlanItem> => {
  const items: Array<SetupPlanItem> = [];
  if (role === "source") {
    items.push({
      id: "source-init",
      kind: "source-init",
      scope: "machine",
      optional: false,
      dependsOn: [],
      detail: {},
    });
  }
  items.push({
    id: "ensure-directories",
    kind: "ensure-directory",
    scope: "machine",
    optional: false,
    dependsOn: [],
    detail: { dir: ".canonfig" },
  });
  const verifiers = tools.map((tool) => `tool-verify:${tool.method}`);
  for (const tool of tools) {
    items.push({
      id: `tool-verify:${tool.method}`,
      kind: "tool-verify",
      scope: `resource:tool:${tool.method}`,
      optional: true,
      dependsOn: [],
      detail: { method: tool.method, executable: tool.executable },
    });
  }
  if (verifiers.length > 0) {
    items.push({
      id: "toolchain-verify",
      kind: "toolchain-verify",
      scope: "machine",
      optional: true,
      dependsOn: verifiers,
      detail: {},
    });
  }
  return items;
};

const reuseCatalog = (
  previous: SetupJournal | undefined,
  tools: SetupInventory["tools"],
  platform: SetupInventory["platform"],
): ReadonlyArray<SetupProvenance> => {
  if (previous === undefined) return [];
  const current = new Set(tools.map((tool) => `${tool.method}${tool.executable}`));
  return previous.catalog.filter((entry) =>
    entry.platform === platform && current.has(`${entry.method}${entry.executable}`));
};

export interface SetupPlanInput {
  readonly roleText: string;
  readonly files: ReadonlyArray<string>;
  readonly intent?: string | undefined;
}

export const planSetup = (
  input: SetupPlanInput,
  journalPath: string,
): Effect.Effect<SetupJournal, SetupError, MachineState | Enrollment> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    // The role is established before any role-specific inspection runs.
    const role = yield* establishSetupRole(input.roleText);
    const preflight = yield* runSetupPreflight(role);
    const partial = yield* collectSetupInventory(preflight);
    const discovery = yield* runSetupDiscovery(input.files);
    const inventory: SetupInventory = {
      ...partial,
      discoveryFiles: discovery.files,
      discoveryEvidence: discovery.evidence,
    };
    const items = planItemsFor(role, inventory.tools);
    const cycle = findSetupDependencyCycle(items);
    if (cycle !== undefined) {
      return yield* fail(
        "setup plan",
        `the setup plan contains a dependency cycle: ${cycle.join(", ")}`,
        "state",
      );
    }
    const previous = yield* readJournal(machine, journalPath);
    if (previous !== undefined && previous.role !== role) {
      return yield* fail(
        "setup plan",
        `a setup journal already exists for role ${previous.role}; remove ${journalPath} to switch roles`,
        "usage",
        `Remove ${journalPath} to start over with --role ${role}.`,
      );
    }
    const catalog = reuseCatalog(previous, inventory.tools, inventory.platform);
    const planDigest = setupPlanDigest({ role, inventory, items, catalog });
    if (previous !== undefined && previous.planDigest === planDigest) {
      // Unchanged discovery and approvals survive a re-plan.
      return previous;
    }
    const timestamp = new Date().toISOString();
    const journal: SetupJournal = {
      schema: "canonfig.setup/v1",
      role,
      planDigest,
      intent: input.intent ?? `establish this machine as ${role}`,
      inventory,
      items: [...items],
      decisions: [
        `role ${role} established before inspection`,
        inventory.transport.initialized
          ? "source enrollment found; transport identity taken from stored enrollment"
          : "no source enrollment found; transport recorded as uninitialized loopback",
        catalog.length > 0
          ? `${catalog.length} qualified tool provenance record(s) reused`
          : "no prior qualified tool provenance to reuse",
      ],
      exclusions: [...discovery.exclusions],
      evidence: [
        `inventory: ${inventory.platform} ${inventory.osRelease}, ${inventory.tools.length} tool(s), `
        + `${discovery.files} discovery file(s), ${discovery.evidence} evidence record(s)`,
      ],
      approvals: [],
      catalog: [...catalog],
      stages: [
        { stage: "role", digest: sha256Hex(canonicalJson(role)), completedAt: timestamp },
        {
          stage: "preflight",
          digest: sha256Hex(canonicalJson(preflight.credentialStorage)),
          completedAt: timestamp,
        },
        {
          stage: "inventory",
          digest: sha256Hex(canonicalJson(inventory)),
          completedAt: timestamp,
        },
        { stage: "plan", digest: planDigest, completedAt: timestamp },
      ],
      records: items.map((item) => ({ id: item.id, status: "pending" as const, updatedAt: timestamp })),
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    yield* writeJournal(machine, journalPath, journal);
    return journal;
  });

export const approveSetup = (
  approver: string,
  journalPath: string,
): Effect.Effect<SetupJournal, SetupError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    if (approver.trim().length === 0) {
      return yield* fail(
        "setup approve",
        "an approver name is required",
        "usage",
        "Run setup approve --approver <name>.",
      );
    }
    const journal = yield* readJournal(machine, journalPath);
    if (journal === undefined) {
      return yield* fail("setup approve", "no setup plan exists", "usage", "Run setup plan first.");
    }
    if (isSetupApproved(journal)) return journal;
    const timestamp = new Date().toISOString();
    const updated: SetupJournal = {
      ...journal,
      approvals: [...journal.approvals, { digest: journal.planDigest, approver, approvedAt: timestamp }],
      stages: [...journal.stages, { stage: "approve", digest: journal.planDigest, completedAt: timestamp }],
    };
    yield* writeJournal(machine, journalPath, updated);
    return updated;
  });

/**
 * Execute one plan item through the typed Canonfig controller. Every command
 * is a structured argv invocation on MachineState: no agent adapters take
 * part, so known recipes complete with the outer agent unavailable.
 */
const executeSetupItem = (
  item: SetupPlanItem,
  journal: SetupJournal,
): Effect.Effect<
  { readonly evidence: string; readonly catalog?: SetupProvenance | undefined },
  SetupError,
  MachineState | Enrollment
> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    switch (item.kind) {
      case "source-init": {
        const enrollment = yield* Enrollment;
        const material = yield* enrollment.initializeSource().pipe(
          Effect.mapError((cause) =>
            fail("setup apply", `source initialization failed: ${cause.message}`, "prerequisite")),
        );
        return { evidence: `source initialized as ${material.identity.keyId}` };
      }
      case "ensure-directory": {
        const directories = yield* machine.userDirectories().pipe(
          Effect.mapError((cause) =>
            fail("setup apply", `machine directories could not be read: ${cause.message}`, "state")),
        );
        const path = yield* machine.normalizePath({ path: ".canonfig", base: directories.home }).pipe(
          Effect.mapError((cause) =>
            fail("setup apply", `the setup directory is invalid: ${cause.message}`, "state")),
        );
        yield* machine.ensureDirectory({ path, mode: 0o700 }).pipe(
          Effect.mapError((cause) =>
            fail("setup apply", `the setup directory could not be ensured: ${cause.message}`, "state")),
        );
        return { evidence: `ensured directory ${path.absolute}` };
      }
      case "tool-verify": {
        const method = String(item.detail["method"] ?? "");
        const executableValue = String(item.detail["executable"] ?? "");
        const executable = yield* machine.normalizePath({ path: executableValue }).pipe(
          Effect.mapError((cause) =>
            fail("setup apply", `tool ${method} has an invalid executable: ${cause.message}`, "state")),
        );
        const found = yield* machine.findExecutable({ name: method }).pipe(
          Effect.map((discovered) => discovered.path.absolute),
          Effect.catchAll(() => Effect.succeed(undefined)),
        );
        if (found !== executable.absolute) {
          return yield* fail(
            "setup apply",
            `tool ${method} moved since planning (${executable.absolute} no longer resolves on PATH)`,
            "state",
          );
        }
        const result = yield* machine.runProcess({
          executable,
          arguments: ["--version"],
          timeoutMilliseconds: setupProcessTimeoutMilliseconds,
          maximumOutputBytes: maxSetupProcessBytes,
        }).pipe(
          Effect.mapError((cause) =>
            fail("setup apply", `tool ${method} could not be verified: ${cause.message}`, "state")),
        );
        if (result.exitCode !== 0) {
          return yield* fail(
            "setup apply",
            `tool ${method} failed its bounded --version check with exit ${String(result.exitCode)}`,
            "prerequisite",
          );
        }
        const version = new TextDecoder().decode(result.standardOutput).split("\n")[0]!.trim().slice(0, 200);
        return {
          evidence: `tool ${method} verified at ${executable.absolute} (${version})`,
          catalog: {
            method,
            platform: executable.platform,
            executable: executable.absolute,
            version,
            verifiedAt: new Date().toISOString(),
          },
        };
      }
      case "toolchain-verify": {
        const verified = journal.records
          .filter((record) => record.id.startsWith("tool-verify:") && record.status === "completed")
          .map((record) => record.id.slice("tool-verify:".length));
        return { evidence: `toolchain verified: ${verified.join(", ") || "no tools"}` };
      }
    }
  });

const recordItem = (
  machine: MachineState["Service"],
  journalPath: string,
  journal: SetupJournal,
  id: string,
  status: "completed" | "skipped" | "failed",
  evidence?: string,
  catalog?: SetupProvenance | undefined,
): Effect.Effect<SetupJournal, SetupError> => {
  const updated: SetupJournal = {
    ...journal,
    evidence: evidence === undefined ? journal.evidence : [...journal.evidence, evidence],
    catalog: catalog === undefined
      ? journal.catalog
      : [...journal.catalog.filter((entry) => entry.method !== catalog.method), catalog],
    records: journal.records.map((record) =>
      record.id === id ? { ...record, status, evidence, updatedAt: new Date().toISOString() } : record),
  };
  yield* writeJournal(machine, journalPath, updated);
  return updated;
};

export const applySetup = (
  journalPath: string,
): Effect.Effect<SetupJournal, SetupError, MachineState | Enrollment> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    let journal = yield* readJournal(machine, journalPath);
    if (journal === undefined) {
      return yield* fail("setup apply", "no setup plan exists", "usage", "Run setup plan first.");
    }
    if (!isSetupApproved(journal)) {
      return yield* fail(
        "setup apply",
        `plan ${journal.planDigest} is not approved`,
        "prerequisite",
        "Run setup approve --approver <name> first.",
      );
    }
    for (const item of journal.items) {
      const prior = journal.records.find((record) => record.id === item.id);
      if (prior?.status === "completed") continue;
      if (prior?.status === "skipped") {
        const blocked = item.dependsOn.some((dependency) =>
          journal.records.find((candidate) => candidate.id === dependency)?.status !== "completed"
        );
        if (blocked) continue;
      }
      const blocked = item.dependsOn.filter((dependency) =>
        journal.records.find((candidate) => candidate.id === dependency)?.status !== "completed"
      );
      if (blocked.length > 0) {
        journal = yield* recordItem(
          machine,
          journalPath,
          journal,
          item.id,
          "skipped",
          `skipped ${item.id}: dependency ${blocked.join(", ")} did not complete`,
        );
        continue;
      }
      const outcome = yield* executeSetupItem(item, journal).pipe(
        Effect.map((result) => ({ ok: true as const, ...result })),
        Effect.catchAll((cause: SetupError) => Effect.succeed({ ok: false as const, cause })),
      );
      if (outcome.ok) {
        journal = yield* recordItem(
          machine,
          journalPath,
          journal,
          item.id,
          "completed",
          outcome.evidence,
          outcome.catalog,
        );
        continue;
      }
      journal = yield* recordItem(
        machine,
        journalPath,
        journal,
        item.id,
        "failed",
        `${item.id} failed: ${outcome.cause.message}`,
      );
      if (!item.optional) return yield* outcome.cause;
    }
    const timestamp = new Date().toISOString();
    journal = {
      ...journal,
      stages: journal.stages.some((stage) => stage.stage === "apply")
        ? journal.stages
        : [...journal.stages, { stage: "apply", digest: journal.planDigest, completedAt: timestamp }],
    };
    yield* writeJournal(machine, journalPath, journal);
    return journal;
  });

export const setupStatus = (
  journalPath: string,
): Effect.Effect<
  {
    readonly role?: SetupRole | undefined;
    readonly planDigest?: string | undefined;
    readonly stage: string;
    readonly approved: boolean;
    readonly items: ReadonlyArray<{ readonly id: string; readonly status: string }>;
    readonly catalog: ReadonlyArray<SetupProvenance>;
  },
  SetupError,
  MachineState
> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const journal = yield* readJournal(machine, journalPath);
    if (journal === undefined) return { stage: "role", approved: false, items: [], catalog: [] };
    const verdicts = setupItemVerdicts(journal.items, journal.records);
    return {
      role: journal.role,
      planDigest: journal.planDigest,
      stage: nextEligibleSetupStage(journal),
      approved: isSetupApproved(journal),
      items: journal.items.map((item) => ({
        id: item.id,
        status: verdicts.get(item.id) ?? "pending",
      })),
      catalog: [...journal.catalog],
    };
  });
