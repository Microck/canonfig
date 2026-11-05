import { hostname } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { ConfigValue } from "../domain/resource.ts";
import type { SetupImportRequest } from "../cli/setup-commands.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { canonicalJson, sha256Hex, type JsonValue } from "../profile/profile-codec.ts";
import { detectHarnesses } from "../projection/detect.ts";
import { CanonicalFolderError, readFolderConfig } from "../projection/folder.ts";
import {
  existingFolderItems,
  ImportChangedError,
  readImportContent,
  scanImports,
  selectImports,
  type ImportCandidate,
  type ImportChoice,
  type ImportContent,
  type ImportScan,
  type ImportSelection,
  type ImportSource,
} from "../projection/import.ts";
import { TARGET_IDS, type TargetId } from "../projection/model.ts";
import { rootContext, sharedSkillsOwner } from "../projection/plan.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import { editConfigText, getConfigPath, parseConfigDocument } from "../synchronization/config-codec.ts";
import { SetupError } from "./setup.errors.ts";
import type { SetupImportReview, SetupPlanItem, SetupStageRecord } from "./setup.types.ts";

/**
 * The `harnesses` stage of a full Source setup: choose the harnesses
 * `~/.canonfig/canonfig.jsonc` lists, scaffold the folder, and import what
 * the selected harnesses already hold before Canonfig takes them over.
 *
 * Planning reads harness files (never their never-touch paths) and nothing is
 * written until the approved plan applies. Approval covers the harness list
 * and every chosen import item by digest; apply re-reads each item and stops
 * when one changed since planning.
 */

type Environment = (name: string) => string | undefined;

const fail = (operation: string, message: string, category: SetupError["category"], recovery?: string) =>
  new SetupError({ operation, message, category, recovery });

const asJson = <Value>(value: Value): JsonValue =>
  Schema.decodeUnknownSync(Schema.MutableJson)(JSON.parse(JSON.stringify(value)));

const isTarget = (value: string): value is TargetId => TARGET_IDS.some((id) => id === value);

const folderFailure = (error: Error) =>
  fail(
    "setup harnesses",
    error instanceof CanonicalFolderError ? `${error.path}: ${error.message}` : String(error),
    "usage",
    "Fix the Canonical Folder file named above, then plan again.",
  );

const contextFor = (environment: Environment) =>
  rootContext(environment).pipe(
    Effect.mapError((cause) => fail("setup harnesses", `machine directories could not be read: ${cause.message}`, "state")),
  );

export interface SourceFolderPlan {
  readonly harnesses: ReadonlyArray<TargetId>;
  readonly items: ReadonlyArray<SetupPlanItem>;
  readonly exclusions: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
  readonly imports: SetupImportReview;
  readonly stage: Omit<SetupStageRecord, "completedAt">;
}

export interface SourceFolderInput {
  readonly folder: string;
  readonly environment: Environment;
  /** `--harness` values; undefined keeps the folder's list, or the detected harnesses on a new folder. */
  readonly harnesses: ReadonlyArray<string> | undefined;
  readonly imports: SetupImportRequest;
}

/** Validate `--harness` values, in TARGET_IDS order. */
const requestedHarnesses = (values: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const unknown = values.filter((value) => !isTarget(value));
    if (unknown.length > 0) {
      return yield* fail(
        "setup harnesses",
        `unknown harness: ${unknown.join(", ")}`,
        "usage",
        `Name harnesses with --harness <id>; ids are ${TARGET_IDS.join(", ")}.`,
      );
    }
    return TARGET_IDS.filter((id) => values.includes(id));
  });

/** `--import` values split into harness names and single item ids. */
const importSelection = (request: SetupImportRequest): ImportSelection => {
  switch (request.kind) {
    case "none":
    case "offer":
      // An offer lists what `--import-all` would do, so collisions are visible before choosing.
      return { kind: request.kind === "none" ? "none" : "all" };
    case "all":
      return { kind: "all" };
    case "some": {
      const sources = request.requested.filter((value): value is ImportSource =>
        value === sharedSkillsOwner || isTarget(value));
      const named = new Set<string>(sources);
      return { kind: "some", sources, items: request.requested.filter((value) => !named.has(value)) };
    }
  }
};

const collisionText = (folder: string, collision: ImportChoice["collisions"][number]) =>
  collision.folder
    ? `import collision: ${collision.target} already exists in ${folder} with different content (${collision.candidates.join(", ")}); edit or remove it there to import`
    : `import collision: ${collision.target} differs between ${collision.candidates.join(", ")}; choose one with --import <id>`;

/** Scan the harnesses not yet taken over and apply the operator's import choice. */
const reviewImports = (input: SourceFolderInput, selected: ReadonlyArray<TargetId>) =>
  Effect.gen(function*() {
    const nothing: ReadonlyArray<ImportCandidate> = [];
    if (input.imports.kind === "none") {
      return {
        chosen: nothing,
        exclusions: [],
        decisions: ["harness import declined (--no-import); harness files were not read"],
        review: { request: "none", offered: [], present: [] } satisfies SetupImportReview,
      };
    }
    const repository = yield* StateRepository;
    const takenOver = new Set((yield* repository.loadHarnessTakeovers().pipe(
      Effect.mapError((cause) => fail("setup harnesses", `harness takeovers could not be read: ${cause.message}`, "state")),
    )).map((takeover) => takeover.harness));
    const scanned = selected.filter((harness) => !takenOver.has(harness));
    const context = yield* contextFor(input.environment);
    const scan: ImportScan = yield* Effect.tryPromise({
      try: () => scanImports({ context, harnesses: scanned, folder: input.folder }),
      catch: (error) => folderFailure(error instanceof Error ? error : new Error(String(error))),
    });
    const existing = yield* Effect.tryPromise({ try: () => existingFolderItems(input.folder), catch: (error) => folderFailure(error instanceof Error ? error : new Error(String(error))) });
    const choice = selectImports(scan, existing, importSelection(input.imports));
    if (choice.unknown.length > 0) {
      return yield* fail(
        "setup harnesses",
        `nothing to import matches ${choice.unknown.join(", ")}`,
        "usage",
        "Run setup plan --role source without --import to list the offered item ids, then name harnesses or ids.",
      );
    }
    const chosen = input.imports.kind === "offer" ? [] : choice.chosen;
    return {
      chosen,
      exclusions: [
        ...scan.skipped.map((skip) => `import skipped: ${skip.path}: ${skip.reason}`),
        ...choice.collisions.map((collision) => collisionText(input.folder, collision)),
      ],
      decisions: [
        ...selected.filter((harness) => takenOver.has(harness))
          .map((harness) => `harness import not offered for ${harness}: Canonfig already took it over`),
        input.imports.kind === "offer"
          ? `harness import offered: ${scan.candidates.length} item(s), none chosen; choose with --import <harness|id> or --import-all`
          : `harness import: ${chosen.length} item(s) chosen`,
      ],
      review: {
        request: input.imports.kind,
        offered: scan.candidates.map((candidate) => ({
          id: candidate.id,
          target: candidate.target,
          secrets: candidate.secrets.map((secret) => `${secret.field} -> fromEnv ${secret.fromEnv}`),
          notes: candidate.notes,
        })),
        present: choice.present,
      } satisfies SetupImportReview,
    };
  });

/** The Machine Profile a new folder publishes, `{ id, name }`. */
export interface ScaffoldProfile {
  readonly id: string;
  readonly name: string;
}

/**
 * Propose the profile from the machine's hostname: the name is the hostname,
 * the id its slug (lowercase, runs of characters outside the ProfileId
 * alphabet collapsed to `-`, trimmed so it starts with a letter or digit).
 * A hostname with no usable character gives `workstation`.
 */
export const scaffoldProfile = (host: string): ScaffoldProfile => {
  const id = host.toLowerCase().replace(/[^a-z0-9._:-]+/gu, "-").replace(/^[^a-z0-9]+|-+$/gu, "");
  return id.length === 0 ? { id: "workstation", name: "workstation" } : { id, name: host.trim() };
};

/**
 * Plan the `harnesses` stage: the harness list (from `--harness`, else the
 * existing `canonfig.jsonc`, else detection), the folder scaffold (with a
 * profile when the folder has none, so `source publish` works without a hand
 * edit), and the import review.
 */
export const planSourceFolder = (input: SourceFolderInput) =>
  Effect.gen(function*() {
    const flagged = input.harnesses === undefined ? undefined : yield* requestedHarnesses(input.harnesses);
    const context = yield* contextFor(input.environment);
    const detected = (yield* detectHarnesses(context, input.folder))
      .filter((entry) => entry.installed)
      .map((entry) => entry.harness);
    const current = yield* Effect.tryPromise({ try: () => readFolderConfig(input.folder), catch: (error) => folderFailure(error instanceof Error ? error : new Error(String(error))) });
    const listed = current === undefined ? undefined : [...new Set(current.harnesses)];
    const harnesses = flagged ?? listed ?? detected;
    const origin = flagged !== undefined ? "--harness" : listed !== undefined ? "the existing canonfig.jsonc" : "detection";
    const profile = current?.profile === undefined ? scaffoldProfile(hostname()) : undefined;
    const imports = yield* reviewImports(input, harnesses);
    const items: Array<SetupPlanItem> = [{
      id: "canonfig-folder",
      kind: "folder-scaffold",
      scope: "machine",
      optional: false,
      dependsOn: ["ensure-directories"],
      detail: profile === undefined
        ? { folder: input.folder, harnesses, detected }
        : { folder: input.folder, harnesses, detected, profile: asJson(profile) },
    }];
    if (imports.chosen.length > 0) {
      items.push({
        id: "harness-import",
        kind: "harness-import",
        scope: "machine",
        optional: false,
        dependsOn: ["canonfig-folder"],
        detail: { folder: input.folder, items: asJson(imports.chosen) },
      });
    }
    return {
      harnesses,
      items,
      exclusions: imports.exclusions,
      decisions: [
        `harnesses from ${origin}: ${harnesses.join(", ") || "none"}`,
        `installed harnesses detected: ${detected.join(", ") || "none"}`,
        profile === undefined
          ? `profile kept from the existing canonfig.jsonc: ${current?.profile?.id}`
          : `profile proposed from the hostname: ${profile.id} (${profile.name}); edit canonfig.jsonc to rename it`,
        ...imports.decisions,
      ],
      imports: imports.review,
      stage: { stage: "harnesses", digest: sha256Hex(canonicalJson(asJson({ harnesses, detected, profile: profile ?? null, imports: imports.chosen.map((item) => item.digest) }))) },
    } satisfies SourceFolderPlan;
  });

// ── apply ──────────────────────────────────────────────────────────────────

const FolderDetail = Schema.Struct({
  folder: Schema.String,
  harnesses: Schema.Array(Schema.Literals(TARGET_IDS)),
  profile: Schema.optional(Schema.Struct({ id: Schema.String, name: Schema.String })),
});

const ImportSourceSchema = Schema.Union([Schema.Literals(TARGET_IDS), Schema.Literal(sharedSkillsOwner)]);

/** A chosen import item as the journal holds it; decoded because the journal is a plain file. */
const ImportCandidateSchema = Schema.Struct({
  id: Schema.String,
  source: ImportSourceSchema,
  harnesses: Schema.Array(Schema.Literals(TARGET_IDS)),
  category: Schema.Literals(["instructions", "rules", "skills", "agents", "commands", "mcp"]),
  name: Schema.String,
  path: Schema.String,
  // Only the targets an import can produce; anything else would write outside the authoring allowlist.
  target: Schema.String.check(Schema.isPattern(
    /^(?:AGENTS\.md|(?:rules|agents|commands)\/[A-Za-z0-9][A-Za-z0-9_-]*\.md|skills\/[a-z0-9][a-z0-9-]*|canonfig\.jsonc#mcp\.[A-Za-z0-9][A-Za-z0-9_-]*)$/u,
  )),
  digest: Schema.String,
  secrets: Schema.Array(Schema.Struct({ field: Schema.String, fromEnv: Schema.String })),
  notes: Schema.Array(Schema.String),
});

const ImportDetail = Schema.Struct({
  folder: Schema.String,
  items: Schema.Array(ImportCandidateSchema),
});

const applyFailure = (message: string, category: SetupError["category"] = "state", recovery?: string) =>
  fail("setup apply", message, category, recovery);

const decodeDetail = <S extends Schema.Decoder<unknown>>(schema: S, item: SetupPlanItem) =>
  Schema.decodeUnknownEffect(schema)(item.detail).pipe(
    Effect.mapError(() => applyFailure(`plan item ${item.id} is invalid; run setup plan again`)),
  );

/** File content, or undefined when the file does not exist. */
const readOptional = (path: string) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const normalized = yield* machine.normalizePath({ path });
    return yield* machine.readFile({ path: normalized, maximumBytes: 1024 * 1024 }).pipe(
      Effect.map((bytes) => new TextDecoder().decode(bytes)),
      Effect.catchTag("MachineFilesystemError", (error) =>
        /\b(?:ENOENT|ENOTDIR)\b/u.test(error.message) ? Effect.succeed(undefined) : Effect.fail(error)
      ),
    );
  });

const utf8 = (text: string) => new TextEncoder().encode(text);

const writeFile = (path: string, content: Uint8Array, mode = 0o600) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    yield* machine.atomicWrite({
      path: yield* machine.normalizePath({ path }),
      content,
      mode,
    });
  });

const ensureDirectory = (path: string) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    yield* machine.ensureDirectory({ path: yield* machine.normalizePath({ path }), mode: 0o700 });
  });

const pathExists = (path: string) =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    return yield* machine.normalizePath({ path }).pipe(
      Effect.flatMap((normalized) => machine.inspectPath(normalized)),
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
  });

const configTemplate = (harnesses: ReadonlyArray<TargetId>, profile: ScaffoldProfile | undefined) =>
  [
    "// Canonfig projects this folder into every harness listed here. Edit the list,",
    "// then run `canonfig sync --plan` to review. Schema: docs/adr/0003-global-canonfig-folder.md.",
    JSON.stringify(profile === undefined ? { version: 1, harnesses } : { version: 1, profile, harnesses }, undefined, 2),
    "",
  ].join("\n");

/**
 * Create `canonfig.jsonc` with the approved profile and list (or set them in
 * an existing one, keeping its comments and other keys; a profile the file
 * already holds is kept), an empty `AGENTS.md` and `skills/`. Nothing that
 * exists is replaced.
 */
export const executeFolderScaffold = (item: SetupPlanItem) =>
  Effect.gen(function*() {
    const detail = yield* decodeDetail(FolderDetail, item);
    const configPath = join(detail.folder, "canonfig.jsonc");
    yield* ensureDirectory(detail.folder);
    const current = yield* readOptional(configPath);
    let configAction = "created canonfig.jsonc";
    if (current === undefined) {
      yield* writeFile(configPath, utf8(configTemplate(detail.harnesses, detail.profile)));
    } else {
      const document = parseConfigDocument("json", current);
      const sets: Array<{ path: string; value: ConfigValue }> = [];
      if (JSON.stringify(getConfigPath(document, "harnesses")) !== JSON.stringify(detail.harnesses)) {
        sets.push({ path: "harnesses", value: [...detail.harnesses] });
      }
      if (detail.profile !== undefined && getConfigPath(document, "profile") === undefined) {
        sets.push({ path: "profile", value: { ...detail.profile } });
      }
      if (sets.length === 0) {
        configAction = "kept canonfig.jsonc";
      } else {
        yield* writeFile(configPath, utf8(editConfigText("json", current, { sets })));
        configAction = `set ${sets.map((set) => set.path).join(" and ")} in canonfig.jsonc`;
      }
    }
    const instructions = join(detail.folder, "AGENTS.md");
    if (!(yield* pathExists(instructions))) yield* writeFile(instructions, new Uint8Array());
    yield* ensureDirectory(join(detail.folder, "skills"));
    const profileText = detail.profile === undefined ? "" : ` with profile ${detail.profile.id}`;
    return { evidence: `${configAction} listing ${detail.harnesses.join(", ") || "no harnesses"}${profileText} in ${detail.folder}` };
  }).pipe(Effect.mapError((cause) => cause instanceof SetupError ? cause : applyFailure(`the Canonical Folder could not be scaffolded: ${cause.message}`)));

type CandidateRecord = typeof ImportCandidateSchema.Type;

/** Refuse to write over anything except the empty `AGENTS.md` the scaffold creates. */
const assertFree = (folder: string, candidate: CandidateRecord) =>
  Effect.gen(function*() {
    if (candidate.category === "mcp") return;
    const path = join(folder, ...candidate.target.split("/"));
    const occupied = candidate.category === "instructions"
      ? ((yield* readOptional(path)) ?? "").trim().length > 0
      : yield* pathExists(path);
    if (occupied) {
      return yield* applyFailure(
        `${path} appeared after the plan was approved; the import of ${candidate.id} would replace it`,
        "prerequisite",
        "Run setup plan again and review the import collisions.",
      );
    }
  });

const writeContent = (folder: string, candidate: CandidateRecord, content: Exclude<ImportContent, { readonly kind: "mcp" }>) =>
  Effect.gen(function*() {
    const path = join(folder, ...candidate.target.split("/"));
    if (content.kind === "text") return yield* writeFile(path, utf8(content.content));
    for (const file of content.files) {
      const segments = file.path.split("/");
      if (segments.some((segment) => segment === ".." || segment === "" || segment === ".")) {
        return yield* applyFailure(`skill file ${file.path} of ${candidate.id} is not a plain relative path`);
      }
      yield* ensureDirectory(join(path, ...segments.slice(0, -1)));
      yield* writeFile(join(path, ...segments), file.content, file.executable ? 0o700 : 0o600);
    }
  });

/** Add imported MCP servers to `canonfig.jsonc` in one comment-preserving edit. */
const writeMcp = (folder: string, servers: ReadonlyArray<readonly [string, ConfigValue]>) =>
  Effect.gen(function*() {
    if (servers.length === 0) return;
    const configPath = join(folder, "canonfig.jsonc");
    const current = yield* readOptional(configPath);
    const document = parseConfigDocument("json", current ?? "");
    const taken = servers.filter(([name]) => getConfigPath(document, `mcp.${name}`) !== undefined).map(([name]) => name);
    if (taken.length > 0) {
      return yield* applyFailure(
        `MCP server ${taken.join(", ")} appeared in ${configPath} after the plan was approved`,
        "prerequisite",
        "Run setup plan again and review the import collisions.",
      );
    }
    yield* writeFile(configPath, utf8(editConfigText("json", current, {
      sets: servers.map(([name, server]) => ({ path: `mcp.${name}`, value: server })),
    })));
  });

/**
 * Import the approved items. Every source is re-read and checked against its
 * approved digest before anything is written, so a changed harness file stops
 * the import as a whole.
 */
export const executeHarnessImport = (item: SetupPlanItem, environment: Environment) =>
  Effect.gen(function*() {
    const detail = yield* decodeDetail(ImportDetail, item);
    const context = yield* contextFor(environment);
    const contents: Array<readonly [CandidateRecord, ImportContent]> = [];
    for (const candidate of detail.items) {
      const content = yield* Effect.tryPromise({
        try: () => readImportContent(candidate, context),
        catch: (error) =>
          error instanceof ImportChangedError
            ? applyFailure(
              `${candidate.id} changed since the plan was approved (${error.message})`,
              "prerequisite",
              "Run setup plan again, review the import, and approve the new plan.",
            )
            : applyFailure(`${candidate.id} could not be read: ${String(error)}`),
      });
      yield* assertFree(detail.folder, candidate);
      contents.push([candidate, content]);
    }
    const servers: Array<readonly [string, ConfigValue]> = [];
    for (const [candidate, content] of contents) {
      if (content.kind === "mcp") servers.push([candidate.name, content.server]);
      else yield* writeContent(detail.folder, candidate, content);
    }
    yield* writeMcp(detail.folder, servers);
    const secrets = detail.items.flatMap((candidate) => candidate.secrets.map((secret) => secret.fromEnv));
    return {
      evidence: `imported ${detail.items.length} item(s) into ${detail.folder}: ${detail.items.map((candidate) => candidate.target).join(", ")}`
        + (secrets.length > 0 ? `; literal credentials replaced with fromEnv references: ${[...new Set(secrets)].join(", ")}` : ""),
    };
  }).pipe(Effect.mapError((cause) => cause instanceof SetupError ? cause : applyFailure(`the harness import failed: ${cause.message}`)));
