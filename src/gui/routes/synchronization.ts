import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Effect, Schema } from "effect";
import { FollowerCommands } from "../../cli/follower-commands.ts";
import { redactText } from "../../cli/redaction.ts";
import { CliCommandFailure, type CliPayload } from "../../cli/source-commands.ts";
import { RunId } from "../../domain/brand.ts";
import { localProjectionFollower } from "../../domain/synchronization.ts";
import { MachineState } from "../../machine/machine-state.service.ts";
import { sha256BytesHex } from "../../profile/profile-codec.ts";
import { MAXIMUM_ARCHIVE_BYTES } from "../../projection/archive.ts";
import { maximumAuthoringBytes, readAuthoringItem, readAuthoringItems, writeAuthoringItems, editAuthoringConfig, type AuthoringItem } from "../../projection/authoring.ts";
import { decodeFolderConfig, decodeLocalConfig, parseOverlay } from "../../projection/folder.ts";
import { emptyModel } from "../../projection/detect.ts";
import { projectionSettingsFiles } from "../../projection/layout-metadata.ts";
import { rootContext } from "../../projection/plan.ts";
import { listSnapshots } from "../../projection/takeover.ts";
import { synchronizeSharedSecrets } from "../../secrets/secret-client.ts";
import { listSecrets, storeSecret, removeSecret, type SecretTransferError } from "../../secrets/secret-store.ts";
import { StateRepository } from "../../state/state-repository.service.ts";
import {
  GuiScheduleRequest, GuiSynchronizationResult, GuiHarnessRequest, GuiOverlayRequest, GuiRestoreRequest,
  GuiLocalWrite, GuiLocalConfigRequest, GuiSecretSet, GuiSecretName, GuiExportRequest, GuiSyncApplyRequest,
  GuiTunnelStartInput, GuiTunnelStopInput,
  GuiArchiveImportInput, GuiArchiveImportApply,
  type GuiLocalItem,
} from "../contract/synchronization.ts";
import { GuiOperations } from "../operations.ts";
import { GuiQueries } from "../queries.ts";
import { EmptyBody, commandFailure, maximumAuthoringBodyBytes, mutationRoute, queryRoute, type GuiRoute } from "../routing.ts";

const invalid = (message: string) => new CliCommandFailure({ category: "usage-or-configuration", message });
const printable = <Value>(value: Value): Schema.Json => Schema.decodeUnknownSync(Schema.Json)(JSON.parse(redactText(JSON.stringify(value))));
const itemResponse = (item: AuthoringItem): GuiLocalItem => ({
  path: item.path, digest: item.digest,
  files: item.files.map(({ path, digest, content, executable }) => ({ path, digest, base64: Buffer.from(content).toString("base64"), executable })),
});
const ExportResult = Schema.Struct({
  output: Schema.String, sha256: Schema.String, manifestSha256: Schema.String, signer: Schema.String,
});
const RunResult = Schema.Struct({
  run: Schema.optionalKey(RunId),
  outcome: Schema.optionalKey(Schema.Struct({ run: RunId })),
});

/** Parser diagnostics may quote request bodies. Never echo private input. */
const privateRequest = (route: GuiRoute, message = "Invalid secret request. Supply a name and a text value in JSON."): GuiRoute => ({
  ...route,
  handle: (request, url) => route.handle(request, url).pipe(Effect.mapError((error) =>
    error.message.startsWith("Invalid request:") || error.message.startsWith("Invalid JSON request:")
      ? invalid(message)
      : error)),
});

export const synchronizationRoutes = Effect.gen(function*() {
  const commands = yield* FollowerCommands;
  const queries = yield* GuiQueries;
  const machine = yield* MachineState;
  const repository = yield* StateRepository;
  const operations = yield* GuiOperations;
  const role = (allowed: ReadonlyArray<"source" | "follower" | "unconfigured">) => queries.session().pipe(
    Effect.flatMap((session) => allowed.includes(session.role)
      ? Effect.succeed(session)
      : Effect.fail(invalid(`This operation requires a ${allowed.join(" or ")} machine.`))),
  );
  const follower = <A>(operation: Effect.Effect<A, CliCommandFailure>) =>
    role(["follower"]).pipe(Effect.andThen(operation), Effect.map(printable));
  const both = <A>(operation: Effect.Effect<A, CliCommandFailure>) =>
    role(["source", "follower"]).pipe(Effect.andThen(operation), Effect.map(printable));
  const localTarget = role(["source", "follower"]).pipe(Effect.map((session) => ({
    folder: session.folderPath, scope: "local" as const, statePath: join(session.folderPath, "state.sqlite"),
  })));
  const localItems = () => localTarget.pipe(
    Effect.flatMap((target) => Effect.gen(function*() {
      const items = yield* readAuthoringItems(target);
      const canonical = yield* readAuthoringItem({ ...target, scope: "canonical" }, "canonfig.jsonc");
      const config = (item: AuthoringItem | undefined) => item?.files[0] === undefined ? {} :
        (item.path === "local.jsonc" ? decodeLocalConfig : decodeFolderConfig)(item.path, new TextDecoder("utf-8", { fatal: true }).decode(item.files[0].content));
      const decoded = yield* Effect.try({
        try: () => ({ config: config(items.find((item) => item.path === "local.jsonc")), canonicalConfig: config(canonical) }),
        catch: (cause) => invalid(String(cause)),
      });
      const context = yield* rootContext((name) => process.env[name]);
      const settingsFiles = projectionSettingsFiles(context, emptyModel(target.folder));
      return { items: items.map(itemResponse), ...decoded, settingsFiles };
    })),
    Effect.provideService(MachineState, machine),
    Effect.mapError(commandFailure),
  );
  const changeOverlay = (action: "set" | "remove", item: string) => {
    // The command service expects the same boundary validation as the CLI parser.
    const parsed = parseOverlay(item);
    return both(parsed.kind === "invalid"
      ? Effect.fail(invalid(parsed.reason))
      : commands.overlays({ change: { action, item } }));
  };

  // Capture identity from this command's result or typed failure details, never a mutable "latest run".
  // Planning has no run journal. Before an apply returns its identity the journal is explicitly unknown.
  // Sync, recovery and restore run for every role (#351); callers that need fewer roles, such as imports, pass `allowed`.
  const start = (operation: Effect.Effect<CliPayload, CliCommandFailure>, allowed: ReadonlyArray<"source" | "follower" | "unconfigured"> = ["source", "follower", "unconfigured"]) => Effect.gen(function*() {
    yield* role(allowed);
    let details: Schema.Json = null;
    let run: typeof RunId.Type | undefined;
    const capture = (value: CliPayload | undefined) => {
      if (value === undefined) return;
      details = printable(value);
      const decoded = Schema.decodeUnknownOption(RunResult)(value);
      if (decoded._tag === "Some") run = decoded.value.run ?? decoded.value.outcome?.run;
    };
    return yield* operations.start(operation.pipe(
      Effect.tap((value) => Effect.sync(() => capture(value))),
      Effect.tapError((error) => Effect.sync(() => capture(error.details))),
      Effect.map(printable),
    ), () => Effect.gen(function*() {
      if (run === undefined) return details;
      const evidence = yield* repository.loadRunEvidence(run).pipe(Effect.mapError(commandFailure));
      return printable({ run, details, evidence: evidence ?? null });
    }));
  });
  const secrets = <A>(operation: Effect.Effect<A, SecretTransferError, MachineState | StateRepository>) => operation.pipe(
    Effect.provideService(MachineState, machine),
    Effect.provideService(StateRepository, repository),
    Effect.mapError(commandFailure),
  );
  const importArchive = (input: typeof GuiArchiveImportInput.Type, dryRun: boolean, expectedSha256?: string) => Effect.gen(function*() {
    const bytes = Buffer.from(input.base64, "base64");
    if (bytes.length > MAXIMUM_ARCHIVE_BYTES) return yield* invalid(`Archive exceeds ${MAXIMUM_ARCHIVE_BYTES} bytes.`);
    if (expectedSha256 !== undefined && sha256BytesHex(bytes) !== expectedSha256) return yield* invalid("Archive changed; verify it again.");
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({ try: () => mkdtemp(join(tmpdir(), "canonfig-gui-archive-")), catch: () => invalid("Could not prepare the archive upload.") }),
      (directory) => Effect.gen(function*() {
        const archive = join(directory, "upload.tar.gz");
        yield* Effect.tryPromise({
          try: () => writeFile(archive, bytes, { mode: 0o600, flag: "wx" }),
          catch: () => invalid("Could not save the archive upload."),
        });
        return yield* commands.importArchive({ archive, dryRun, replace: input.replace, expectKey: input.expectKey }).pipe(Effect.map(printable));
      }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
  });
  const archiveBody = { maximumBodyBytes: 4 * Math.ceil(MAXIMUM_ARCHIVE_BYTES / 3) + 1024 * 1024 };
  return [
    mutationRoute("POST", "/api/sync/plan", EmptyBody, () => start(commands.synchronize({ mode: "plan", noInput: false })), 202),
    mutationRoute("POST", "/api/sync/apply", GuiSyncApplyRequest, ({ planDigest }) => start(commands.synchronize({ mode: "apply", noInput: false, expectedPlanDigest: planDigest })), 202),
    mutationRoute("POST", "/api/sync/reviews", EmptyBody, () => start(commands.synchronize({ mode: "plan", noInput: false, reviewLocal: true })), 202),
    mutationRoute("POST", "/api/recovery", EmptyBody, () => start(commands.recover({ noInput: false })), 202),
    mutationRoute("POST", "/api/recovery/abandon", EmptyBody, () => start(commands.abandon()), 202),
    queryRoute("/api/local/synchronization", () => role(["source", "unconfigured"]).pipe(
      Effect.andThen(repository.loadOpenRunIdentity(localProjectionFollower)),
      Effect.mapError(commandFailure), Effect.map((run) => ({ activeRecovery: run === undefined ? null : { run: run.run } })),
    )),
    queryRoute("/api/schedule", () => follower(commands.scheduleStatus()).pipe(
      Effect.map((status) => ({ ...Schema.decodeUnknownSync(GuiSynchronizationResult)(status), machineTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone })),
    )),
    mutationRoute("PUT", "/api/schedule", GuiScheduleRequest, (input) => follower(commands.setSchedule(input))),
    mutationRoute("DELETE", "/api/schedule", EmptyBody, () => follower(commands.removeSchedule())),
    queryRoute("/api/harnesses", () => both(commands.harnesses({}))),
    mutationRoute("PUT", "/api/harnesses", GuiHarnessRequest, (change) => both(commands.harnesses({ change }))),
    queryRoute("/api/local/overlays", () => localTarget.pipe(
      Effect.flatMap((target) => Effect.gen(function*() {
        const root = yield* Effect.tryPromise({
          try: () => realpath(target.folder),
          catch: (cause) => invalid(String(cause)),
        });
        const anchor = yield* machine.normalizePath({ path: root });
        const readConfig = (relativePath: string, prefixBytes?: number) => Effect.gen(function*() {
          const path = yield* machine.normalizePath({ path: join(root, relativePath) });
          return yield* machine.readFile({ path, anchor, maximumBytes: maximumAuthoringBytes, prefixBytes }).pipe(
            Effect.catchTag("MachineFilesystemError", (error) => error.message.startsWith("ENOENT:")
              ? Effect.succeed(undefined) : Effect.fail(error)),
          );
        });
        // Check only the canonical file's identity and size; the command reads its contents.
        if ((yield* readConfig("canonfig.jsonc", 0)) !== undefined) return yield* commands.overlays({});
        const local = yield* readConfig("local/local.jsonc");
        const config = yield* Effect.try({
          try: () => local === undefined ? undefined :
            decodeLocalConfig("local.jsonc", new TextDecoder("utf-8", { fatal: true }).decode(local)),
          catch: (cause) => invalid(String(cause)),
        });
        // Local choices cannot resolve until a published profile has been mirrored.
        return { configured: false, overlays: [], pending: config?.overlays ?? [] };
      })),
      Effect.mapError(commandFailure), Effect.map(printable),
    )),
    mutationRoute("PUT", "/api/local/overlays", GuiOverlayRequest, ({ item }) => changeOverlay("set", item)),
    mutationRoute("DELETE", "/api/local/overlays", GuiOverlayRequest, ({ item }) => changeOverlay("remove", item)),
    queryRoute("/api/local/items", localItems),
    mutationRoute("PUT", "/api/local/items", GuiLocalWrite, ({ changes }) => localTarget.pipe(
      Effect.flatMap((target) => writeAuthoringItems(target, changes.map((change) => ({
        ...change, files: change.files.map(({ path, base64, executable }) => ({ path, executable, content: Buffer.from(base64, "base64") })),
      })))),
      Effect.provideService(MachineState, machine), Effect.mapError(commandFailure),
      Effect.andThen(localItems),
    ), 200, { maximumBodyBytes: maximumAuthoringBodyBytes }),
    mutationRoute("PUT", "/api/local/preferences", GuiLocalConfigRequest, ({ expectedDigest, edits }) => localTarget.pipe(
      Effect.flatMap((target) => editAuthoringConfig(target, expectedDigest, edits.map(({ path, value }) => ({ path, value })))),
      Effect.provideService(MachineState, machine), Effect.mapError(commandFailure),
      Effect.andThen(localItems),
    )),
    queryRoute("/api/backups", () => role(["source", "follower", "unconfigured"]).pipe(
      Effect.flatMap((session) => listSnapshots(join(session.folderPath, ".backups"))),
      Effect.mapError(commandFailure), Effect.map((snapshots) => ({ snapshots })),
    )),
    mutationRoute("POST", "/api/backups/restore", GuiRestoreRequest, (input) => start(commands.restore(input)), 202),
    queryRoute("/api/secrets", () => both(secrets(listSecrets()).pipe(
      Effect.map((entries) => ({ secrets: entries.map(({ name, origin }) => ({ name, origin })) })),
    ))),
    privateRequest(mutationRoute("PUT", "/api/secrets", GuiSecretSet, ({ name, value }) =>
      both(secrets(storeSecret(name, value, "local")).pipe(Effect.map(({ name, origin }) => ({ name, origin })))))),
    privateRequest(mutationRoute("DELETE", "/api/secrets", GuiSecretName, ({ name }) =>
      both(secrets(removeSecret(name)).pipe(Effect.map((removed) => ({ name, removed })))))),
    mutationRoute("POST", "/api/secrets/sync", EmptyBody, () => follower(secrets(synchronizeSharedSecrets()))),
    queryRoute("/api/tunnel", () => follower(commands.tunnelStatus())),
    mutationRoute("POST", "/api/tunnel/start", GuiTunnelStartInput, (input) => role(["follower"]).pipe(
      Effect.andThen(operations.start(commands.restartTunnel(input).pipe(Effect.map(printable)), () => Effect.succeed(null))),
    ), 202),
    mutationRoute("POST", "/api/tunnel/stop", GuiTunnelStopInput, (input) => follower(commands.stopTunnel(input))),
    mutationRoute("DELETE", "/api/enrollment", EmptyBody, () => follower(commands.unenroll())),
    privateRequest(mutationRoute("POST", "/api/imports/preview", GuiArchiveImportInput, (input) =>
      role(["source", "unconfigured"]).pipe(Effect.andThen(importArchive(input, true))),
    200, archiveBody), "Invalid archive upload or signing fingerprint."),
    privateRequest(mutationRoute("POST", "/api/imports", GuiArchiveImportApply, (input) => start(
      importArchive(input, false, input.sha256), ["source", "unconfigured"],
    ), 202, archiveBody), "Invalid verified archive upload."),
    mutationRoute("POST", "/api/exports", GuiExportRequest, ({ includeHarnesses }) => Effect.gen(function*() {
      yield* role(["source", "follower"]);
      const home = yield* machine.normalizePath({ path: "~" }).pipe(Effect.mapError(commandFailure));
      const output = join(home.absolute, `canonfig-export-${randomUUID()}.tar.gz`);
      return yield* Effect.gen(function*() {
        const exported = yield* commands.exportArchive({ output, includeHarnesses, force: false }).pipe(
          Effect.flatMap((value) => Schema.decodeUnknownEffect(ExportResult)(value)),
          Effect.mapError((error) => error instanceof CliCommandFailure ? error : invalid("Export returned an invalid archive receipt.")),
        );
        // Read through the same anchored, bounded file reader as export. Check the exact published bytes.
        const path = yield* machine.normalizePath({ path: exported.output });
        const archive = yield* machine.readFile({ path, anchor: home, maximumBytes: 256 * 1024 * 1024 });
        if (sha256BytesHex(archive) !== exported.sha256) {
          return yield* invalid("The exported archive changed before download. Export again.");
        }
        return {
          filename: basename(exported.output), mediaType: "application/gzip" as const,
          base64: Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength).toString("base64"),
          sha256: exported.sha256, manifestSha256: exported.manifestSha256, signer: exported.signer,
        };
      }).pipe(
        Effect.mapError(commandFailure),
        // Only this unique GUI-created file is temporary; the journal retains the CLI export receipt.
        Effect.ensuring(Effect.promise(() => rm(output, { force: true }))),
      );
    })),
  ] satisfies ReadonlyArray<GuiRoute>;
});
