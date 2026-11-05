import { join } from "node:path";
import { Effect, Schema } from "effect";
import { CliCommandFailure, SourceCommands } from "../../cli/source-commands.ts";
import { commandFailureExitCode } from "../../cli/command-output.ts";
import type { CliFailureCategory } from "../../cli/exit-codes.ts";
import { ProfileRevisionId } from "../../domain/brand.ts";
import { validateMachineProfile } from "../../domain/profile.ts";
import { MachineState } from "../../machine/machine-state.service.ts";
import { asJson } from "../../profile/profile-codec.ts";
import { folderProfile } from "../../profile/publication.ts";
import { publicationCredentialIssue } from "../../profile/publication-credentials.ts";
import { InvalidPublicationInputError } from "../../profile/profile-catalog.errors.ts";
import { decodeFolderConfig } from "../../projection/folder.ts";
import { readAuthoringItems, writeAuthoringItems, editAuthoringConfig, type AuthoringChange } from "../../projection/authoring.ts";
import { adapterFor } from "../../projection/adapters/index.ts";
import { TARGET_IDS } from "../../projection/model.ts";
import { emptyModel } from "../../projection/detect.ts";
import { rootContext, supportedCategories } from "../../projection/plan.ts";
import { CanonfigError } from "../../skills/errors.ts";
import { listSkills, trackSkill, checkSkills, updateSkills } from "../../skills/manager.ts";
import { GuiProfileConfigWrite, GuiProfileWrite, GuiPublicationRequest, GuiRevisionSelection, GuiSkillSelection, GuiSkillTrack, profileEndpoints } from "../contract/profile.ts";
import { GuiOperations } from "../operations.ts";
import { GuiQueries } from "../queries.ts";
import { EmptyBody, commandFailure, maximumAuthoringBodyBytes, mutationRoute, queryRoute, type GuiRoute } from "../routing.ts";

const changesFrom = (changes: typeof GuiProfileWrite.Type.changes): AuthoringChange[] => changes.map((change) => ({ ...change, files: change.files.map((file) => ({ path: file.path, executable: file.executable, content: Buffer.from(file.base64, "base64") })) }));

export const profileRoutes = Effect.gen(function*() {
  const source = yield* SourceCommands;
  const queries = yield* GuiQueries;
  const machine = yield* MachineState;
  const operations = yield* GuiOperations;
  const target = Effect.gen(function*() {
    const session = yield* queries.session();
    if (session.role !== "source") return yield* Effect.fail(new CliCommandFailure({ category: "usage-or-configuration", message: "Profile authoring requires a Source Machine. A follower's Canonical Folder is its Source's mirror." }));
    return { folder: session.folderPath, statePath: join(session.folderPath, "state.sqlite"), scope: "canonical" as const };
  });
  const snapshot = Effect.fn("GuiProfile.snapshot")(function*() {
    const location = yield* target;
    const items = yield* readAuthoringItems(location).pipe(Effect.provideService(MachineState, machine), Effect.mapError(commandFailure));
    const configItem = items.find((item) => item.path === "canonfig.jsonc");
    const config = yield* Effect.try({ try: () => configItem?.files[0] === undefined ? {} : decodeFolderConfig("canonfig.jsonc", new TextDecoder("utf-8", { fatal: true }).decode(configItem.files[0].content)), catch: (error) => new CliCommandFailure({ category: "usage-or-configuration", message: String(error) }) });
    const context = yield* rootContext((name) => process.env[name]).pipe(Effect.provideService(MachineState, machine), Effect.mapError(commandFailure));
    const model = emptyModel(location.folder);
    const supportedSurfaces = Object.fromEntries(TARGET_IDS.map((harness) => { const adapter = adapterFor(harness); return [harness, supportedCategories(adapter, adapter.layout(context, model))]; }));
    return asJson({ config, supportedSurfaces, items: items.map((item) => ({ path: item.path, digest: item.digest, files: item.files.map((file) => ({ path: file.path, base64: Buffer.from(file.content).toString("base64"), executable: file.executable })) })) });
  });
  const skillCall = <A>(run: (location: { root: string; config: string }) => Promise<A>) => target.pipe(
    Effect.flatMap((location) => Effect.tryPromise({
      try: () => run({ root: location.folder, config: "skills-sources.json" }),
      catch: (error) => {
        const code = error instanceof CanonfigError ? error.code : undefined;
        const categories = { 0: "internal", 1: "internal", 2: "usage-or-configuration", 3: "human-action-required", 4: "conflict-or-drift", 5: "authentication-or-revocation", 6: "transport", 7: "verification-or-apply-failure" } satisfies Record<number, CliFailureCategory>;
        const exit = code === "SKILL_FETCH_FAILED" ? 6 : code === "SKILL_RECOVERY_REQUIRED" ? 3 : code === "SKILL_VERIFY_FAILED" ? 7 : commandFailureExitCode(code);
        return new CliCommandFailure({ category: categories[exit], message: error instanceof Error ? error.message : String(error) });
      },
    })),
    Effect.map(asJson),
  );
  const routes: GuiRoute[] = [
    queryRoute(profileEndpoints.items, snapshot),
    mutationRoute("PUT", profileEndpoints.items, GuiProfileWrite, (input) => target.pipe(Effect.flatMap((location) => writeAuthoringItems(location, changesFrom(input.changes)).pipe(Effect.provideService(MachineState, machine), Effect.mapError(commandFailure))), Effect.as({ saved: true })), 200, { maximumBodyBytes: maximumAuthoringBodyBytes }),
    mutationRoute("PUT", profileEndpoints.config, GuiProfileConfigWrite, (input) => target.pipe(Effect.flatMap((location) => editAuthoringConfig(location, input.expectedDigest, input.edits.map((edit) => ({ path: edit.path, value: edit.value })), changesFrom(input.changes)).pipe(Effect.provideService(MachineState, machine), Effect.mapError(commandFailure))), Effect.as({ saved: true })), 200, { maximumBodyBytes: maximumAuthoringBodyBytes }),
    mutationRoute("POST", profileEndpoints.scan, EmptyBody, () => target.pipe(Effect.andThen(source.scan({ write: false })), Effect.map(asJson))),
    mutationRoute("POST", profileEndpoints.validate, EmptyBody, () => Effect.gen(function*() {
      const location = yield* target;
      const profile = yield* Effect.tryPromise({ try: () => folderProfile(location.folder), catch: (error) => commandFailure(new InvalidPublicationInputError({ reason: String(error) })) });
      const errors = validateMachineProfile(profile).map((error) => JSON.stringify(error));
      const credentialIssue = publicationCredentialIssue(profile.resources);
      if (credentialIssue !== undefined) errors.push(credentialIssue);
      return { valid: errors.length === 0, errors, profile: asJson(profile) };
    })),
    mutationRoute("POST", profileEndpoints.publications, GuiPublicationRequest, (input) => Effect.gen(function*() {
      yield* target;
      // There is no in-progress publication journal. After commit, read this ticket's exact persisted revision.
      let revisionId: typeof ProfileRevisionId.Type | undefined;
      const publish = source.publish(input).pipe(
        Effect.map(asJson),
        Effect.tap((revision) => Schema.decodeUnknownEffect(Schema.Struct({ id: ProfileRevisionId }))(revision).pipe(
          Effect.mapError((error) => new CliCommandFailure({ category: "internal", message: error.message })),
          Effect.tap(({ id }) => Effect.sync(() => { revisionId = id; })),
        )),
      );
      return yield* operations.start(publish, () => revisionId === undefined ? Effect.succeed(null) : source.inspectProfile(revisionId).pipe(Effect.map(asJson)));
    }), 202),
    queryRoute(profileEndpoints.revisions, () => target.pipe(Effect.andThen(source.listProfiles()), Effect.map(asJson))),
    mutationRoute("POST", profileEndpoints.revision, GuiRevisionSelection, (input) => target.pipe(Effect.andThen(Schema.decodeUnknownEffect(ProfileRevisionId)(input.revision).pipe(Effect.mapError((error) => new CliCommandFailure({ category: "usage-or-configuration", message: error.message })))), Effect.flatMap(source.inspectProfile), Effect.map(asJson))),
    queryRoute(profileEndpoints.skills, () => skillCall(listSkills)),
    mutationRoute("POST", profileEndpoints.track, GuiSkillTrack, (input) => skillCall((location) => trackSkill(location, { ...input, path: `skills/${input.name}` }))),
    mutationRoute("POST", profileEndpoints.check, GuiSkillSelection, (input) => skillCall(async (location) => {
      const checks = await checkSkills(location, [input.name]);
      if (checks.some((check) => check.status === "local-edits")) throw new CanonfigError("SKILL_LOCAL_EDITED", `Local edits detected in ${input.name}. Reconcile the local files before updating. ${JSON.stringify(checks)}`);
      return checks;
    })),
    mutationRoute("POST", profileEndpoints.update, GuiSkillSelection, (input) => skillCall((location) => updateSkills(location, [input.name]))),
  ];
  return routes;
});
