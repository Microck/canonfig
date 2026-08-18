import { Effect, Schema } from "effect";

import {
  BlobId,
  ProfileRevisionId,
  ResourceId,
  Timestamp,
  ToolId,
  type ContentDigest,
  type SourceSignature,
} from "../domain/brand.ts";
import {
  normalizeMachineProfile,
  type MachineProfile,
  type ProfileGroup,
  type ProfileResourceInput,
  type ProfileRevision,
  type PublishedResource,
  type ScheduleDefault,
  validateMachineProfile,
} from "../domain/profile.ts";
import { encodeMachineProfile, digestMachineProfile } from "../domain/profile.ts";
import type { Platform } from "../domain/resource.ts";
import { RevisionImmutableError } from "../state/state-repository.errors.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import type { DiscoveryScanResult } from "./discovery.ts";
import {
  InvalidPublicationInputError,
  InvalidPublicationResourcesError,
  InvalidPublicationSignatureError,
  PublicationSigningError,
  PublicationReviewRequiredError,
  type ProfileCatalogPublishError,
  UnresolvedPublicationProposalError,
} from "./profile-catalog.errors.ts";
import { canonicalJson, digestOf, sha256Hex } from "./profile-codec.ts";
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
   * Resources authored in the canonical profile are not discovery proposals.
   * Keep them on the publication input so publication does not silently
   * reduce a complete profile to discovered tools and skills.
   */
  readonly resources?: ReadonlyArray<ProfileResourceInput> | undefined;
  readonly scheduleDefault?: ScheduleDefault | undefined;
}

export interface PublishProfileInput {
  readonly proposal: DiscoveryScanResult;
  readonly profile: PublicationProfileMetadata;
  readonly review: PublicationReview;
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

const asJson = <Value>(value: Value): Schema.Schema.Type<typeof Schema.MutableJson> =>
  Schema.decodeUnknownSync(Schema.MutableJson)(
    JSON.parse(JSON.stringify(value)),
  );

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
  verify: {
    method: "command",
    command: [...tool.verify.command],
  },
});

const skillFilesDigest = (
  files: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
    readonly executable?: boolean | undefined;
  }>,
): ContentDigest =>
  sha256Hex(
    [...files]
      .sort((left, right) => compareText(left.path, right.path))
      .map((file) =>
        `${file.path}\0${sha256Hex(file.content)}\0${
          file.executable === true ? "x" : "-"
        }`
      )
      .join("\n"),
  );

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
  // An explicitly authored resource is authoritative when it shares an id
  // with a discovered proposal. The map also makes the merge deterministic
  // before normalizeMachineProfile applies its canonical id ordering.
  const resources = new Map<string, ProfileResourceInput>(
    acceptedDiscoveryResources.map((resource) => [resource.id, resource]),
  );
  for (const resource of input.profile.resources ?? []) {
    resources.set(resource.id, resource);
  }
  return normalizeMachineProfile({
    id: input.profile.id,
    version: 2,
    name: input.profile.name,
    groups: input.profile.groups ?? [],
    resources: [...resources.values()],
    scheduleDefault: input.profile.scheduleDefault ?? {
      type: "daily",
      at: "00:00",
      timezone: "local",
    },
  });
};

const publishedResources = (
  profile: MachineProfile,
): ReadonlyArray<PublishedResource> =>
  profile.resources.map((resource) => {
    const blob = Schema.decodeUnknownSync(BlobId)(digestOf(asJson(resource.spec)));
    const base = {
      id: Schema.decodeUnknownSync(ResourceId)(resource.id),
      kind: resource.kind,
      policy: resource.policy ?? "ensure",
      target: resource.target,
      dependsOn: (resource.dependsOn ?? []).map((dependency) =>
        Schema.decodeUnknownSync(ResourceId)(dependency)
      ),
      blobs: [blob],
    };
    return resource.groups === undefined
      ? base
      : { ...base, groups: resource.groups };
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

      const profile = yield* Effect.try({
        try: () => machineProfileFor(input),
        catch: (cause) => new InvalidPublicationInputError({
          reason: `invalid publication metadata: ${String(cause)}`,
        }),
      });
      const errors = validateMachineProfile(profile);
      if (errors.length > 0) {
        return yield* Effect.fail(new InvalidPublicationResourcesError(errors));
      }

      const encoded = yield* Effect.try({
        try: () => ({
          canonicalBytes: encodeMachineProfile(profile),
          digest: digestMachineProfile(profile),
        }),
        catch: (cause) => new InvalidPublicationInputError({
          reason: `profile cannot be canonically encoded: ${String(cause)}`,
        }),
      });
      const { canonicalBytes, digest } = encoded;
      const id = Schema.decodeUnknownSync(ProfileRevisionId)(
        `${profile.id}:${digest}`,
      );
      const existing = yield* repository.findRevision(id);
      if (existing !== undefined) {
        if (
          existing.profileId !== profile.id
          || existing.digest !== digest
          || existing.canonicalBytes !== canonicalBytes
        ) {
          return yield* new RevisionImmutableError({
            revision: id,
            message: "content-addressed revision identity names different content",
          });
        }
        return existing;
      }

      const latest = yield* repository.getLatestRevision(profile.id);
      const sequence = (latest?.sequence ?? 0) + 1;
      const unsigned: UnsignedRevision = {
        id,
        profileId: profile.id,
        sequence,
        canonicalBytes,
        digest,
        publishedAt: input.publishedAt,
        resources: publishedResources(profile),
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
      yield* repository.publishRevision({ revision });
      return revision;
    });

  return { publish };
};
