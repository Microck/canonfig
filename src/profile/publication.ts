import { assertProfileMetadataBudget } from "./metadata-budget.ts";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";

import { Effect, Schema } from "effect";

import {
  BlobId,
  ProfileRevisionId,
  Timestamp,
  type SourceSignature,
} from "../domain/brand.ts";
import {
  normalizeMachineProfile,
  ProfileContractError,
  type MachineProfile,
  type ProfileGroup,
  type ProfileResourceInput,
  type ProfileRevision,
  type PublishedResource,
  type ScheduleDefault,
  validateMachineProfile,
} from "../domain/profile.ts";
import { ConfigValue } from "../domain/resource.ts";
import { sourceBytesIssue, sourceTextIssue } from "../domain/text-composition.ts";
import {
  CanonicalFolderError,
  hookScript,
  itemResourceId,
  listFolderFiles,
  loadAuthoredFolder,
} from "../projection/folder.ts";
import { emptyModel } from "../projection/detect.ts";
import { TARGET_IDS } from "../projection/model.ts";
import { surfaceSelectionIssue } from "../projection/plan.ts";
import { RevisionImmutableError } from "../state/state-repository.errors.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import {
  compileProfileCandidate,
  type ResolvedSourceFile,
  type ResolvedSourceFiles,
} from "./compiler.ts";
import { publicationCredentialIssue } from "./publication-credentials.ts";
import {
  InvalidPublicationInputError,
  InvalidPublicationResourcesError,
  InvalidPublicationSignatureError,
  PublicationSigningError,
  PublicationSourceError,
  type ProfileCatalogPublishError,
} from "./profile-catalog.errors.ts";
import { asJson, canonicalJson } from "./profile-codec.ts";

/**
 * Publication: `canonfig source publish` compiles the Canonical Folder into
 * one Profile Resource per item and signs the result as the next Profile
 * Revision. Only the authoring allowlist is read, every file must resolve
 * inside the folder, MCP and hook secrets stay environment references, and a
 * credential-looking literal stops publication before anything is signed.
 */

export interface PublishFolderInput {
  /** The Canonical Folder, `~/.canonfig/`. */
  readonly folder: string;
  /** Who reviewed the folder content being published. */
  readonly reviewer: string;
  readonly publishedAt: string;
}

/**
 * Signing owns credential access behind this boundary. Callers supply only a
 * key identifier plus sign/verify operations, never private key material.
 */
export interface ProfileRevisionSigner {
  readonly keyId: string;
  readonly sign: (
    payload: string,
  ) => Effect.Effect<SourceSignature, PublicationSigningError>;
  readonly verify: (
    payload: string,
    signature: SourceSignature,
  ) => Effect.Effect<boolean, PublicationSigningError>;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Mode of every published file: private, executable when the authored file is. */
const fileMode = (executable: boolean): number => executable ? 0o700 : 0o600;

/**
 * Where a JSON item lives in `canonfig.jsonc`. Each such item is a `config`
 * resource whose single key is its place in the file; followers render their
 * own `canonfig.jsonc` from the items they are authorized to see.
 */
const jsonItem = <Authored>(
  id: string,
  key: string,
  authored: Authored,
  dependsOn: ReadonlyArray<string> = [],
): ProfileResourceInput => ({
  id,
  kind: "config",
  policy: "merge",
  target: `canonfig.jsonc#${key}`,
  dependsOn,
  // Decoded authoring values never hold null; the JSON round trip drops
  // absent optional fields.
  spec: { kind: "config", format: "json", keys: [{ path: key, value: Schema.decodeUnknownSync(ConfigValue)(asJson(authored)) }] },
  verify: { method: "digest" },
});

/** A file item the follower mirrors at the same place in its folder. */
const fileItem = (id: string, path: string, executable: boolean): ProfileResourceInput => ({
  id,
  kind: "file",
  policy: "replace-if-unmodified",
  target: path,
  spec: { kind: "file", source: path, executable, mode: fileMode(executable) },
  verify: { method: "digest" },
});

/**
 * The resource id of a file item under `directory`, one segment per path
 * segment: `hooks/lib/run.sh` is `hook-scripts:lib:run.sh`, `files/a/b` is
 * `files:a:b`. Followers map the id back to exactly that path.
 */
const pathItemId = (category: string, directory: string, file: string, path: string): string => {
  const id = `${category}:${file.slice(`${directory}/`.length).split("/").join(":")}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) {
    throw new CanonicalFolderError({
      path,
      message: `${file} needs a name of letters, digits, '.', '_' or '-'`,
    });
  }
  return id;
};

const hookScriptId = (script: string, path: string): string => pathItemId("hook-scripts", "hooks", script, path);

/** `daily@HH:mm` or `weekly:Mon,Thu@HH:mm` as the schedule a revision suggests. */
const scheduleDefaultOf = (calendar: string): ScheduleDefault => {
  const weekly = /^weekly:(?<days>[^@]+)@(?<at>.+)$/u.exec(calendar)?.groups;
  const at = calendar.slice(calendar.indexOf("@") + 1);
  return weekly === undefined
    ? { type: "daily", at, timezone: "local" }
    : { type: "weekly", days: [...new Set(weekly.days!.toLowerCase().split(","))], at, timezone: "local" };
};

/**
 * The Machine Profile a folder publishes: one resource per item, with file
 * sources relative to the folder. Groups and `requires` must name items the
 * folder declares, and every file under `hooks/` must be a script a hook runs.
 */
export const folderProfile = async (folder: string): Promise<MachineProfile> => {
  const authored = await loadAuthoredFolder(folder);
  const config = authored.config;
  const configPath = resolve(folder, "canonfig.jsonc");
  const refuse = (message: string) => new CanonicalFolderError({ path: configPath, message });
  if (config.profile === undefined) {
    throw refuse("needs \"profile\": { \"id\": ..., \"name\": ... } to publish; the id names the Machine Profile followers sync");
  }
  const resources: Array<ProfileResourceInput> = [];
  if (authored.instructions !== undefined) resources.push(fileItem("instructions", "AGENTS.md", false));
  for (const [category, ids] of [
    ["rules", authored.rules.map((rule) => rule.id)],
    ["agents", authored.agents.map((agent) => agent.id)],
    ["commands", authored.commands.map((command) => command.id)],
  ] as const) {
    for (const id of ids) resources.push(fileItem(`${category}:${id}`, `${category}/${id}.md`, false));
  }
  for (const skill of authored.skills) {
    resources.push({
      id: `skills:${skill.name}`,
      kind: "skill",
      policy: "replace-if-unmodified",
      target: `skills/${skill.name}`,
      spec: {
        kind: "skill",
        name: skill.name,
        files: skill.files.map((file) => ({
          path: file.path,
          source: `skills/${skill.name}/${file.path}`,
          executable: file.executable,
          mode: fileMode(file.executable),
        })),
      },
      verify: { method: "digest" },
    });
  }

  // Hooks: the definition is a JSON item, the script it runs a file item.
  const scripts = new Map((await listFolderFiles(folder, "hooks")).map((file) => [`hooks/${file.path}`, file.executable]));
  const scriptUsers = new Map<string, Array<string>>();
  const enabledScripts = new Set<string>();
  for (const [position, hook] of (config.hooks ?? []).entries()) {
    const script = hookScript(hook, configPath);
    const dependsOn: Array<string> = [];
    if (script !== undefined) {
      if (!scripts.has(script)) throw refuse(`hook ${hook.id} runs ${script}, which does not exist`);
      const id = hookScriptId(script, configPath);
      dependsOn.push(id);
      scriptUsers.set(script, [...scriptUsers.get(script) ?? [], `hooks:${hook.id}`]);
      if (hook.enabled !== false) enabledScripts.add(script);
    }
    resources.push(jsonItem(`hooks:${hook.id}`, `hooks.${hook.id}`, { position, hook: asJson(hook) }, dependsOn));
  }
  for (const [script, executable] of [...scripts].sort(([left], [right]) => compareText(left, right))) {
    if (!scriptUsers.has(script)) {
      throw new CanonicalFolderError({
        path: resolve(folder, script),
        message: "is not run by any hook in canonfig.jsonc, so it would never reach a follower; reference it from a hook or remove it",
      });
    }
    // Windows cannot report POSIX execute bits. An enabled hook that names a
    // script directly expresses the author's intent to run it; preserve that
    // intent for Unix followers. Disabled-only scripts keep their observed mode.
    const intendedExecutable = executable || (process.platform === "win32" && enabledScripts.has(script));
    resources.push(fileItem(hookScriptId(script, configPath), script, intendedExecutable));
  }

  // Authored resources: the definition is a JSON item, each file it reads a
  // file item under files/. Like a hook script, a file goes wherever one of
  // its resources goes, and a file no resource reads is refused.
  const files = new Map((await listFolderFiles(folder, "files")).map((file) => [`files/${file.path}`, file.executable]));
  const fileUsers = new Map<string, Array<string>>();
  for (const resource of authored.resources) {
    const used = resource.kind === "file"
      ? [resource.source]
      : resource.kind === "directory"
      ? resource.files.map((file) => `${resource.source}/${file.path}`)
      : [];
    for (const path of used) fileUsers.set(path, [...fileUsers.get(path) ?? [], `resources:${resource.id}`]);
    if (resource.kind === "file" && resource.policy === "append-local") {
      const issue = sourceBytesIssue(await readFile(resolve(folder, resource.source)));
      if (issue !== undefined) throw refuse(`resources.${resource.id} cannot use append-local: ${issue}`);
    }
    resources.push(jsonItem(
      `resources:${resource.id}`,
      `resources.${resource.id}`,
      asJson(config.resources![resource.id]),
      [...new Set(used.map((path) => pathItemId("files", "files", path, configPath)))].sort(compareText),
    ));
  }
  for (const [path, executable] of [...files].sort(([left], [right]) => compareText(left, right))) {
    if (!fileUsers.has(path)) {
      throw new CanonicalFolderError({
        path: resolve(folder, path),
        message: "is not read by any resource in canonfig.jsonc, so it would never reach a follower; reference it from a resource or remove it",
      });
    }
    resources.push(fileItem(pathItemId("files", "files", path, configPath), path, executable));
  }
  if (authored.instructions !== undefined && config.local?.appendLocal?.includes("instructions") === true) {
    const issue = sourceTextIssue(authored.instructions);
    if (issue !== undefined) throw refuse(`AGENTS.md cannot be shared with followers' own text (local.appendLocal): ${issue}`);
  }

  const tools = config.tools ?? {};
  for (const [name, server] of Object.entries(config.mcp ?? {})) {
    const requires = server.requires ?? [];
    const missing = requires.find((reference) => tools[reference.slice("tools/".length)] === undefined);
    if (missing !== undefined) throw refuse(`mcp.${name} requires ${missing}, which "tools" does not declare`);
    resources.push(jsonItem(`mcp:${name}`, `mcp.${name}`, asJson(server), requires.map(itemResourceId)));
  }
  for (const [harness, keys] of Object.entries(config.settings ?? {})) {
    resources.push(jsonItem(`settings:${harness}`, `settings.${harness}`, asJson(keys)));
  }
  resources.push(jsonItem("harnesses", "harnesses", [...new Set(config.harnesses)]));
  if (config.local !== undefined) resources.push(jsonItem("local-policy", "local", asJson(config.local)));
  // Followers project with the same per-harness category limits the Source does,
  // so refuse here what every follower would refuse: an unlisted harness, or a
  // category the harness cannot take. Support does not depend on the machine,
  // so a fixed POSIX context stands in for one.
  for (const [harness, selected] of Object.entries(config.surfaces ?? {})) {
    const target = TARGET_IDS.find((id) => id === harness);
    if (target === undefined || !config.harnesses.includes(target)) throw refuse(`surfaces names ${harness}, which harnesses does not list`);
    const context = { platform: "linux" as const, home: "/home/canonfig", appData: "/home/canonfig/.config", environment: () => undefined, join: posix.join };
    const issue = surfaceSelectionIssue(target, selected, context, emptyModel(folder));
    if (issue !== undefined) throw refuse(issue);
  }
  if (config.surfaces !== undefined) resources.push(jsonItem("surfaces", "surfaces", asJson(config.surfaces)));
  for (const [id, tool] of Object.entries(tools)) {
    resources.push({
      id: `tools:${id}`,
      kind: "tool",
      policy: "ensure",
      target: tool.executable,
      spec: {
        kind: "tool",
        toolId: id,
        recipes: tool.recipes,
        login: tool.login ?? { required: false },
        agentInstall: tool.agentInstall,
      },
      verify: tool.verify ?? { method: "executable-present", executable: tool.executable },
    });
  }
  for (const [id, credential] of Object.entries(config.credentials ?? {})) {
    resources.push({
      id: `credentials:${id}`,
      kind: "credential",
      policy: "require-local",
      target: credential.reference,
      spec: { kind: "credential", reference: credential.reference },
      verify: { method: "credential-present", reference: credential.reference },
    });
  }

  // A grouped item reaches only followers in one of its groups. A script
  // goes wherever one of the hooks running it goes, a file under files/
  // wherever one of the resources reading it goes.
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const groupsOf = new Map<string, Array<string>>();
  for (const [group, references] of Object.entries(config.groups ?? {})) {
    for (const reference of references) {
      const id = itemResourceId(reference);
      if (!byId.has(id)) throw refuse(`groups.${group} names ${reference}, which the folder does not declare`);
      groupsOf.set(id, [...new Set([...groupsOf.get(id) ?? [], group])].sort(compareText));
    }
  }
  for (const [id, users] of [
    ...[...scriptUsers].map(([script, users]) => [hookScriptId(script, configPath), users] as const),
    ...[...fileUsers].map(([path, users]) => [pathItemId("files", "files", path, configPath), users] as const),
  ]) {
    if (users.some((user) => !groupsOf.has(user))) continue;
    groupsOf.set(id, [...new Set(users.flatMap((user) => groupsOf.get(user)!))].sort(compareText));
  }
  return normalizeMachineProfile({
    id: config.profile.id,
    version: 2,
    name: config.profile.name,
    groups: Object.keys(config.groups ?? {}).sort(compareText).map((name): ProfileGroup => ({ name })),
    resources: resources.map((resource) => {
      const groups = groupsOf.get(resource.id);
      return groups === undefined ? resource : { ...resource, groups };
    }),
    scheduleDefault: config.scheduleDefault === undefined ? undefined : scheduleDefaultOf(config.scheduleDefault),
  });
};

/** `..` as a whole path segment, in either separator style. */
const parentSegment = /(?:^|[\\/])\.\.(?:[\\/]|$)/u;

/**
 * Resolve a `source` strictly inside the folder. The containment check runs
 * on the real path, so neither `..` nor a symlink at any depth can make the
 * Source sign content from elsewhere on its disk.
 */
const resolveSourcePath = async (
  resource: string,
  directory: string,
  source: string,
): Promise<string> => {
  const failure = (reason: string) =>
    new PublicationSourceError({ resource, path: source, reason });
  if (isAbsolute(source) || win32.isAbsolute(source) || parentSegment.test(source)) {
    throw failure("a source must be a relative path inside the Canonical Folder");
  }
  const root = await realpath(directory);
  const path = resolve(root, source);
  let target: string;
  try {
    target = await realpath(path);
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause ? String(cause.code) : String(cause);
    throw failure(`${path} cannot be resolved (${code})`);
  }
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw failure(`${path} resolves to ${target}, outside the Canonical Folder ${root}; copy the content into the folder`);
  }
  return path;
};

/** Hash a regular file by streaming it, so memory stays bounded by the stream buffer. */
const digestSourceFile = async (path: string): Promise<{ readonly blob: string; readonly bytes: number }> => {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    // Without an encoding, a file read stream yields Buffers.
    if (!Buffer.isBuffer(chunk)) throw new TypeError(`${path} read stream yielded text`);
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  return { blob: hash.digest("hex"), bytes };
};

/** Hash one `source` found inside the folder. Links are never published. */
const resolveSource = async (
  resource: string,
  source: string,
  directory: string,
  sources: Map<string, ResolvedSourceFile>,
): Promise<void> => {
  const path = await resolveSourcePath(resource, directory, source);
  if (!(await lstat(path)).isFile()) {
    throw new PublicationSourceError({
      resource,
      path: source,
      reason: `${path} is not a regular file; links are not published`,
    });
  }
  const digested = await digestSourceFile(path);
  sources.set(source, {
    path,
    blob: Schema.decodeUnknownSync(BlobId)(digested.blob),
    bytes: digested.bytes,
  });
};

/**
 * Hash every `source` read from inside the folder by streaming it. File
 * bytes are never held whole in memory: publication streams them into
 * storage again and rejects a file that changed in between.
 */
const resolveResourceSources = (
  resources: ReadonlyArray<ProfileResourceInput>,
  directory: string,
): Effect.Effect<ResolvedSourceFiles, PublicationSourceError | InvalidPublicationInputError> =>
  Effect.tryPromise({
    try: async () => {
      const sources = new Map<string, ResolvedSourceFile>();
      for (const resource of resources) {
        const files = resource.spec.kind === "file"
          ? [resource.spec.source]
          : resource.spec.kind === "skill" ? resource.spec.files.map((file) => file.source) : [];
        for (const source of files) {
          if (source !== undefined) await resolveSource(resource.id, source, directory, sources);
        }
      }
      return sources;
    },
    catch: (cause) =>
      cause instanceof PublicationSourceError
        ? cause
        : new InvalidPublicationInputError({
          reason: `resource source could not be read: ${String(cause)}`,
        }),
  });

interface UnsignedRevision {
  readonly id: ProfileRevision["id"];
  readonly profileId: ProfileRevision["profileId"];
  readonly sequence: number;
  readonly canonicalBytes: string;
  readonly digest: string;
  readonly publishedAt: string;
  readonly resources: ReadonlyArray<PublishedResource>;
  readonly groups: ReadonlyArray<ProfileGroup>;
  readonly scheduleDefault?: ScheduleDefault | undefined;
  readonly signingKeyId: string;
}

export const revisionSigningPayload = (
  revision: UnsignedRevision,
): string => {
  // The profile's canonical bytes already authenticate scheduleDefault. Keep
  // it out of this payload shape so the signed fields stay the transport's.
  const { scheduleDefault: _, ...signed } = revision;
  return canonicalJson(asJson(signed));
};

export const makePublication = (
  signer: ProfileRevisionSigner,
  repository: StateRepository["Service"],
) => {
  const publish = (
    input: PublishFolderInput,
  ): Effect.Effect<ProfileRevision, ProfileCatalogPublishError> =>
    Effect.gen(function*() {
      if (input.reviewer.trim().length === 0) {
        return yield* new InvalidPublicationInputError({ reason: "reviewer is required" });
      }
      yield* Effect.try({
        try: () => Schema.decodeUnknownSync(Timestamp)(input.publishedAt),
        catch: (cause) => new InvalidPublicationInputError({ reason: `invalid publication timestamp: ${String(cause)}` }),
      });
      const profile = yield* Effect.tryPromise({
        try: () => folderProfile(input.folder),
        catch: (cause) => new InvalidPublicationInputError({
          reason: cause instanceof CanonicalFolderError
            ? `${cause.path} ${cause.message}`
            : `the Canonical Folder could not be read: ${String(cause)}`,
        }),
      });
      // One Source publishes one Machine Profile. Followers select it by id,
      // so a second id would leave them on the first.
      const published = (yield* repository.listRevisions()).find((revision) => revision.profileId !== profile.id);
      if (published !== undefined) {
        return yield* new InvalidPublicationInputError({
          reason: `this Source publishes profile ${published.profileId}; set "profile.id" in canonfig.jsonc back to ${published.profileId}`,
        });
      }
      const sources = yield* resolveResourceSources(profile.resources, input.folder);
      const errors = validateMachineProfile(profile);
      if (errors.length > 0) {
        return yield* Effect.fail(new InvalidPublicationResourcesError(errors));
      }
      const credentialIssue = publicationCredentialIssue(profile.resources);
      if (credentialIssue !== undefined) {
        return yield* new InvalidPublicationInputError({ reason: credentialIssue });
      }

      const encoded = yield* Effect.try({
        try: () => compileProfileCandidate(profile, sources),
        catch: (cause) =>
          cause instanceof ProfileContractError
            ? new InvalidPublicationResourcesError(cause.errors)
            : new InvalidPublicationInputError({
              reason: cause instanceof Error ? cause.message : `resource bytes could not be encoded: ${String(cause)}`,
            }),
      });
      const canonicalBytes = encoded.canonicalBytes;
      const digest = encoded.digest;
      const approval = {
        proposalDigest: digest,
        reviewer: input.reviewer,
        reviewedAt: input.publishedAt,
        recordedAt: input.publishedAt,
      };
      const transportResources = encoded.resources.map((resource, index) => ({
        ...resource, verify: encoded.profile.resources[index]!.verify,
      }));
      const validateMetadata = (revision: ProfileRevision) => Effect.try({
        try: () => assertProfileMetadataBudget({
          id: revision.id, profileId: revision.profileId, sequence: revision.sequence,
          publishedAt: revision.publishedAt, resources: transportResources,
          scheduleDefault: revision.scheduleDefault, signingKeyId: signer.keyId,
          sourceSignature: revision.signature,
        }),
        catch: (cause) => new InvalidPublicationInputError({
          reason: cause instanceof Error ? cause.message : "revision metadata exceeds its transport budget",
        }),
      });

      // Publishing the content that is already latest is idempotent. Storing
      // its blobs again repairs a Source that lost blob rows.
      const latest = yield* repository.getLatestRevision(profile.id);
      if (latest !== undefined && latest.digest === digest) {
        if (latest.canonicalBytes !== canonicalBytes) {
          return yield* new RevisionImmutableError({
            revision: latest.id,
            message: "the latest revision digest names different content",
          });
        }
        yield* validateMetadata(latest);
        yield* repository.publishRevision({ revision: latest, blobs: encoded.blobs, approval });
        return latest;
      }

      // Any other content becomes the next sequence, including content an
      // older revision already carries: publishing it again is how an author
      // restores it, and followers always take the highest sequence. The id
      // is content-addressed; when that id is taken by the older revision,
      // the new one appends its sequence.
      const sequence = (latest?.sequence ?? 0) + 1;
      const contentId = Schema.decodeUnknownSync(ProfileRevisionId)(
        `${profile.id}:${digest}`,
      );
      const earlier = yield* repository.findRevision(contentId);
      if (
        earlier !== undefined
        && (
          earlier.profileId !== profile.id
          || earlier.digest !== digest
          || earlier.canonicalBytes !== canonicalBytes
        )
      ) {
        return yield* new RevisionImmutableError({
          revision: contentId,
          message: "content-addressed revision identity names different content",
        });
      }
      const id = earlier === undefined
        ? contentId
        : Schema.decodeUnknownSync(ProfileRevisionId)(`${contentId}:${sequence}`);
      const unsigned: UnsignedRevision = {
        id,
        profileId: profile.id,
        sequence,
        canonicalBytes,
        digest,
        publishedAt: input.publishedAt,
        resources: encoded.resources,
        groups: profile.groups,
        scheduleDefault: profile.scheduleDefault,
        signingKeyId: signer.keyId,
      };
      const payload = revisionSigningPayload(unsigned);
      const signature = yield* signer.sign(payload);
      const verified = yield* signer.verify(payload, signature);
      if (!verified) {
        return yield* new InvalidPublicationSignatureError({
          keyId: signer.keyId,
        });
      }
      const revision: ProfileRevision = {
        id: unsigned.id,
        profileId: unsigned.profileId,
        sequence: unsigned.sequence,
        canonicalBytes: unsigned.canonicalBytes,
        digest: unsigned.digest,
        signature,
        publishedAt: unsigned.publishedAt,
        resources: unsigned.resources,
        groups: unsigned.groups,
        scheduleDefault: unsigned.scheduleDefault,
      };
      yield* validateMetadata(revision);
      yield* repository.publishRevision({ revision, blobs: encoded.blobs, approval });
      return revision;
    });

  return { publish };
};
