import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

import { Effect, Schema } from "effect";

import {
  ProfileRevisionId,
  ResourceId,
  Timestamp,
  ToolId,
  type ContentDigest,
  type SourceSignature,
} from "../domain/brand.ts";
import {
  normalizeMachineProfile,
  ProfileContractError,
  type MachineProfile,
  type ManagedFileInput,
  type ProfileGroup,
  type ProfileResourceInput,
  type ProfileRevision,
  type PublishedResource,
  type ScheduleDefault,
  validateMachineProfile,
} from "../domain/profile.ts";
import type { Platform } from "../domain/resource.ts";
import { RevisionImmutableError } from "../state/state-repository.errors.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import { compileProfileCandidate } from "./compiler.ts";
import type { DiscoveryScanResult } from "./discovery.ts";
import {
  EmptyPublicationError,
  InvalidPublicationInputError,
  InvalidPublicationResourcesError,
  InvalidPublicationSignatureError,
  PublicationSigningError,
  PublicationSourceError,
  PublicationReviewRequiredError,
  type ProfileCatalogPublishError,
  UnresolvedPublicationProposalError,
} from "./profile-catalog.errors.ts";
import {
  asJson,
  canonicalJson,
  digestOf,
  directoryVerificationDigest,
  sha256Hex,
} from "./profile-codec.ts";
import type {
  DiscoveredSkill,
  DiscoveredTool,
  InstallationRecipe,
} from "./tool-catalog.ts";

export type PublicationReview =
  | {
    readonly decision: "accepted";
    readonly reviewer: string;
    readonly reviewedAt: string;
    readonly proposalDigest: ContentDigest;
  }
  | {
    readonly decision: "pending" | "rejected";
    readonly reviewer?: string | undefined;
    readonly reviewedAt?: string | undefined;
  };

export interface PublicationProfileMetadata {
  readonly id: MachineProfile["id"];
  readonly name: string;
  readonly groups?: ReadonlyArray<ProfileGroup> | undefined;
  /**
   * Directory containing the authored profile. Relative file `source` values
   * are resolved here, never against the process working directory, and must
   * stay inside it.
   */
  readonly directory?: string | undefined;
  readonly resources?: ReadonlyArray<ProfileResourceInput> | undefined;
  readonly scheduleDefault?: ScheduleDefault | undefined;
}

export interface PublishProfileInput {
  readonly proposal: DiscoveryScanResult;
  readonly profile: PublicationProfileMetadata;
  readonly review: PublicationReview;
  readonly publishedAt: string;
  /** Sign a revision with no resources. Without it, an empty publication fails. */
  readonly allowEmpty?: boolean | undefined;
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


/** Stable digest reviewers accept; it binds acceptance to the exact proposal. */
export const digestDiscoveryProposal = (
  proposal: DiscoveryScanResult,
): ContentDigest => digestOf(asJson(proposal));

export const acceptPublicationProposal = (
  proposal: DiscoveryScanResult,
  reviewer: string,
  reviewedAt: string,
): PublicationReview => ({
  decision: "accepted",
  reviewer,
  reviewedAt,
  proposalDigest: digestDiscoveryProposal(proposal),
});

const packageForRecipe = (recipe: InstallationRecipe): string => {
  switch (recipe.method) {
    case "npm":
    case "uv":
      return recipe.package;
    case "homebrew":
      return recipe.formula;
    case "winget":
      return recipe.id;
    case "cargo":
      return recipe.crate;
    case "source":
      return recipe.repository;
  }
};

const platformsForRecipe = (
  recipe: InstallationRecipe,
): ReadonlyArray<Platform> => {
  switch (recipe.method) {
    case "homebrew":
      return ["macos"];
    case "winget":
      return ["windows"];
    case "npm":
    case "uv":
    case "cargo":
    case "source":
      return ["linux", "macos", "windows"];
  }
};

const resourceForTool = (tool: DiscoveredTool): ProfileResourceInput => ({
  id: Schema.decodeUnknownSync(ResourceId)(tool.id),
  kind: "tool",
  policy: "ensure",
  target: tool.executable,
  dependsOn: [],
  spec: {
    kind: "tool",
    toolId: Schema.decodeUnknownSync(ToolId)(tool.id),
    recipes: tool.recipes
      .flatMap((recipe) =>
        platformsForRecipe(recipe).map((platform) => ({
          platform,
          method: recipe.method,
          package: packageForRecipe(recipe),
          version: recipe.version,
          indexPolicy: recipe.indexPolicy,
          source: recipe.integrity === undefined
            ? recipe.source
            : {
              source: recipe.source,
              integrity: recipe.integrity,
            },
          buildPolicy: recipe.buildPolicy,
        }))
      )
      .sort((left, right) =>
        compareText(
          `${left.platform}\0${left.method}\0${left.package}\0${left.version}\0${JSON.stringify(left.source)}`,
          `${right.platform}\0${right.method}\0${right.package}\0${right.version}\0${JSON.stringify(right.source)}`,
        )
      ),
    login: { required: false },
  },
  verify: tool.verify.method === "command"
    ? { method: "command", command: [...tool.verify.command] }
    : { method: "executable-present", executable: tool.verify.executable },
});

const skillFilesDigest = (
  files: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
    readonly executable?: boolean | undefined;
  }>,
): ContentDigest =>
  directoryVerificationDigest(files.map((file) => ({
    path: file.path,
    digest: sha256Hex(file.content),
    executable: file.executable,
  })));

const resourceForSkill = (skill: DiscoveredSkill): ProfileResourceInput => {
  const files = skill.files ?? [];
  return {
    id: Schema.decodeUnknownSync(ResourceId)(skill.id),
    kind: "skill",
    policy: "replace-if-unmodified",
    target: skill.target ?? `skills/${skill.id}`,
    dependsOn: [],
    spec: {
      kind: "skill",
      name: skill.id,
      files: files.map((file) => ({
        path: file.path,
        content: file.content,
        executable: file.executable ?? false,
      })),
    },
    verify: {
      method: "digest",
      digest: skillFilesDigest(files),
    },
  };
};

const skillEvidenceId = (invocation: string | undefined): string | undefined => {
  const match = /^skills\/([A-Za-z0-9._-]+)\/SKILL\.md$/iu.exec(invocation ?? "");
  return match?.[1]?.toLowerCase();
};

const unresolvedReasons = (
  proposal: DiscoveryScanResult,
): ReadonlyArray<string> => {
  const reasons: Array<string> = [];
  for (const task of proposal.agentTasks) {
    reasons.push(`agent-task:${task.id}`);
  }
  for (const resource of proposal.resources) {
    // Skills are reviewable discovery proposals and can be omitted without
    // preventing unrelated reviewed tools from publishing.
    if (resource.kind === "skill") continue;
    if (resource.reviewStatus !== "accepted") {
      reasons.push(`resource-needs-review:${resource.kind}:${resource.id}`);
    }
    for (const evidence of resource.evidence) {
      if (
        evidence.reviewStatus !== "accepted"
        || evidence.confidence === "review"
        || evidence.kind === "prose"
      ) {
        reasons.push(
          `evidence-needs-review:${evidence.sourcePath}:${evidence.kind}`,
        );
      }
    }
  }
  for (const evidence of proposal.evidence) {
    if (skillEvidenceId(evidence.invocation[0]) !== undefined) continue;
    if (
      evidence.reviewStatus !== "accepted"
      || evidence.confidence === "review"
      || evidence.kind === "prose"
    ) {
      reasons.push(
        `evidence-needs-review:${evidence.sourcePath}:${evidence.kind}`,
      );
    }
  }
  return [...new Set(reasons)].sort(compareText);
};

const validateReview = (
  input: PublishProfileInput,
): Effect.Effect<void, ProfileCatalogPublishError> => {
  const review = input.review;
  if (review.decision !== "accepted") {
    return Effect.fail(
      new PublicationReviewRequiredError({ decision: review.decision }),
    );
  }
  if (review.reviewer.trim().length === 0) {
    return Effect.fail(
      new InvalidPublicationInputError({ reason: "reviewer is required" }),
    );
  }
  try {
    Schema.decodeUnknownSync(Timestamp)(review.reviewedAt);
    Schema.decodeUnknownSync(Timestamp)(input.publishedAt);
  } catch (cause) {
    return Effect.fail(new InvalidPublicationInputError({
      reason: `invalid publication timestamp: ${String(cause)}`,
    }));
  }
  if (review.proposalDigest !== digestDiscoveryProposal(input.proposal)) {
    return Effect.fail(new InvalidPublicationInputError({
      reason: "accepted proposal digest does not match publication proposal",
    }));
  }
  return Effect.void;
};

const publicationApproval = (input: PublishProfileInput) =>
  input.review.decision === "accepted"
    ? {
      proposalDigest: input.review.proposalDigest,
      reviewer: input.review.reviewer,
      reviewedAt: input.review.reviewedAt,
      recordedAt: input.publishedAt,
    }
    : undefined;

const validateProposal = (
  proposal: DiscoveryScanResult,
): Effect.Effect<void, UnresolvedPublicationProposalError> => {
  const reasons = unresolvedReasons(proposal);
  return reasons.length === 0
    ? Effect.void
    : Effect.fail(new UnresolvedPublicationProposalError({ reasons }));
};

const machineProfileFor = (
  input: PublishProfileInput,
): MachineProfile => {
  const discoveryStatus = new Map(
    input.proposal.resources.map((resource) => [resource.id, resource.reviewStatus]),
  );
  const discoveryAccepted = (id: string, status: string): boolean =>
    status === "accepted" && (discoveryStatus.get(id) ?? "accepted") === "accepted";
  const acceptedDiscoveryResources = [
    ...input.proposal.tools
      .filter((tool) => discoveryAccepted(tool.id, tool.reviewStatus))
      .map(resourceForTool),
    ...input.proposal.skills
      .filter((skill) => discoveryAccepted(skill.id, skill.reviewStatus))
      .map(resourceForSkill),
  ];
  const resources = new Map<string, ProfileResourceInput>(
    acceptedDiscoveryResources.map((resource) => [resource.id, resource]),
  );
  for (const resource of input.profile.resources ?? []) {
    resources.set(resource.id, resource);
  }
  return {
    id: input.profile.id,
    version: 2,
    name: input.profile.name,
    groups: [...(input.profile.groups ?? [])],
    resources: [...resources.values()],
    scheduleDefault: input.profile.scheduleDefault,
  };
};

/** `..` as a whole path segment, in either separator style. */
const parentSegment = /(?:^|[\\/])\.\.(?:[\\/]|$)/u;

/**
 * Resolve an authored `source` strictly inside the profile directory. The
 * containment check runs on the real path, so neither `..` nor a symlink at
 * any depth can make the Source sign content from elsewhere on its disk. A
 * source that is itself a symlink to something inside the directory is still
 * published as that symlink; a link meant to point elsewhere is authored as
 * `symlinkTo`.
 */
const resolveSourcePath = async (
  resource: string,
  directory: string | undefined,
  source: string,
): Promise<string> => {
  const failure = (reason: string) =>
    new PublicationSourceError({ resource, path: source, reason });
  if (isAbsolute(source) || win32.isAbsolute(source)) {
    throw failure("absolute paths are not allowed; write the source relative to the profile file's directory");
  }
  if (parentSegment.test(source)) {
    throw failure("\"..\" segments are not allowed; keep the source inside the profile file's directory");
  }
  if (directory === undefined) {
    throw failure("a relative source needs the authored profile file (--profile-file) it is relative to");
  }
  const root = await realpath(directory);
  const path = resolve(root, source);
  let target: string;
  try {
    target = await realpath(path);
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause ? String(cause.code) : String(cause);
    throw failure(
      `${path} cannot be resolved (${code}); a source must exist inside the profile directory ${root}, and a link to a path that exists only on followers is authored as "symlinkTo"`,
    );
  }
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw failure(
      `${path} resolves to ${target}, outside the profile directory ${root}; copy the content into the profile directory, or author an intentional link as "symlinkTo"`,
    );
  }
  return path;
};

const resolveManagedFile = async (
  resource: string,
  file: ManagedFileInput,
  directory: string | undefined,
): Promise<ManagedFileInput> => {
  if (file.symlinkTo !== undefined || file.source === undefined) return file;
  const path = await resolveSourcePath(resource, directory, file.source);
  const status = await lstat(path);
  if (status.isSymbolicLink()) {
    return {
      path: file.path,
      executable: false,
      mode: 0,
      symlinkTo: await readlink(path),
    };
  }
  if (!status.isFile()) {
    throw new PublicationSourceError({
      resource,
      path: file.source,
      reason: `${path} is not a regular file or symlink`,
    });
  }
  const content = await readFile(path);
  const mode = file.mode ?? (status.mode & 0o7777);
  return {
    path: file.path,
    content: content.toString("base64"),
    encoding: "base64",
    executable: file.executable ?? ((mode & 0o111) !== 0),
    mode,
  };
};

const resolveResourceSource = async (
  resource: ProfileResourceInput,
  directory: string | undefined,
): Promise<ProfileResourceInput> => {
  if (resource.spec.kind === "file") {
    const resolved = await resolveManagedFile(
      resource.id,
      { path: "", ...resource.spec },
      directory,
    );
    const { path: _, ...spec } = resolved;
    return { ...resource, spec: { kind: "file", ...spec } };
  }
  if (resource.spec.kind !== "directory" && resource.spec.kind !== "skill") {
    return resource;
  }
  const files = await Promise.all(
    resource.spec.files.map((file) => resolveManagedFile(resource.id, file, directory)),
  );
  return { ...resource, spec: { ...resource.spec, files } };
};

/**
 * Replace every authored `source` with the bytes it names, read from inside
 * `directory` (the authored profile file's directory). Publication and
 * `canonfig source digest` share this so both see the same content.
 */
export const resolveResourceSources = (
  resources: ReadonlyArray<ProfileResourceInput>,
  directory: string | undefined,
): Effect.Effect<
  ReadonlyArray<ProfileResourceInput>,
  PublicationSourceError | InvalidPublicationInputError
> =>
  Effect.tryPromise({
    try: () => Promise.all(resources.map((resource) => resolveResourceSource(resource, directory))),
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
  // it out of this legacy payload shape so revisions written before schedule
  // metadata transport remain signature-compatible.
  const { scheduleDefault: _, ...signed } = revision;
  return canonicalJson(asJson(signed));
};

export const makePublication = (
  signer: ProfileRevisionSigner,
  repository: StateRepository["Service"],
) => {
  const publish = (
    input: PublishProfileInput,
  ): Effect.Effect<ProfileRevision, ProfileCatalogPublishError> =>
    Effect.gen(function*() {
      yield* validateReview(input);
      yield* validateProposal(input.proposal);

      const unresolvedProfile = yield* Effect.try({
        try: () => machineProfileFor(input),
        catch: (cause) => new InvalidPublicationInputError({
          reason: `invalid publication metadata: ${String(cause)}`,
        }),
      });
      if (unresolvedProfile.resources.length === 0 && input.allowEmpty !== true) {
        return yield* new EmptyPublicationError({
          scannedPaths: [...input.proposal.scannedPaths],
        });
      }
      const resolvedResources = yield* resolveResourceSources(
        unresolvedProfile.resources,
        input.profile.directory,
      );
      const profile = normalizeMachineProfile({
        ...unresolvedProfile,
        resources: resolvedResources,
      });
      const errors = validateMachineProfile(profile);
      if (errors.length > 0) {
        return yield* Effect.fail(new InvalidPublicationResourcesError(errors));
      }

      const encoded = yield* Effect.try({
        try: () => compileProfileCandidate(profile),
        catch: (cause) =>
          cause instanceof ProfileContractError
            ? new InvalidPublicationResourcesError(cause.errors)
            : new InvalidPublicationInputError({
              reason: `resource bytes could not be encoded: ${String(cause)}`,
            }),
      });
      const canonicalBytes = encoded.canonicalBytes;
      const digest = encoded.digest;

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
        yield* repository.publishRevision({
          revision: latest,
          blobs: encoded.blobs,
          approval: publicationApproval(input),
        });
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
      yield* repository.publishRevision({
        revision,
        blobs: encoded.blobs,
        approval: publicationApproval(input),
      });
      return revision;
    });

  return { publish };
};
