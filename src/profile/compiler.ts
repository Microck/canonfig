import { assertProfileMetadataBudget } from "./metadata-budget.ts";
import { Schema } from "effect";

import { BlobId, ContentDigest, ResourceId } from "../domain/brand.ts";
import {
  MachineProfileSchema,
  ProfileContractError,
  VerificationDigestMismatchError,
  validateMachineProfile,
  type MachineProfile,
  type ManagedFileInput,
  type PublishedResource,
  type PublishedResourceSpec,
  type PublishedSkillFile,
} from "../domain/profile.ts";
import { renderConfigDocument } from "../synchronization/config-codec.ts";
import {
  asJson,
  canonicalJson,
  directoryVerificationDigest,
  sha256BytesHex,
  sha256Hex,
} from "./profile-codec.ts";
import { defaultPolicyForKind } from "../domain/resource.ts";

/**
 * A regular file an authored `source` names, hashed by streaming it from
 * disk. The compiler never reads it; publication streams it into storage and
 * checks the bytes still match `blob`.
 */
export interface ResolvedSourceFile {
  readonly path: string;
  readonly blob: typeof BlobId.Type;
  readonly bytes: number;
}

export type ResolvedSourceFiles = ReadonlyMap<string, ResolvedSourceFile>;

export interface CompiledProfileCandidate {
  readonly profile: MachineProfile;
  readonly canonicalBytes: string;
  readonly digest: ContentDigest;
  readonly resources: ReadonlyArray<PublishedResource>;
  readonly blobs: ReadonlyArray<CompiledResourceBlob>;
}

/** A source file, streamed from disk when publication stores it. */
export interface CompiledResourceBlob {
  readonly id: typeof BlobId.Type;
  readonly bytes: number;
  readonly path: string;
}

interface MaterializedProfileResources {
  readonly resources: ReadonlyArray<PublishedResource>;
  readonly blobs: ReadonlyArray<CompiledResourceBlob>;
}

const validated = (profile: MachineProfile): MachineProfile => {
  Schema.decodeUnknownSync(MachineProfileSchema, { onExcessProperty: "error" })(profile);
  const errors = validateMachineProfile(profile);
  if (errors.length > 0) throw new ProfileContractError(errors);
  return profile;
};

const materializeResources = (
  profile: MachineProfile,
  sources: ResolvedSourceFiles,
): MaterializedProfileResources => {
  const stored = new Map<typeof BlobId.Type, CompiledResourceBlob>();
  const materializeFile = (file: ManagedFileInput): PublishedSkillFile => {
    const resolved = sources.get(file.source);
    if (resolved === undefined) {
      throw new Error("resource source must be resolved before compilation");
    }
    if (!stored.has(resolved.blob)) {
      stored.set(resolved.blob, { id: resolved.blob, bytes: resolved.bytes, path: resolved.path });
    }
    return {
      path: file.path,
      blob: resolved.blob,
      bytes: resolved.bytes,
      executable: file.executable ?? false,
      mode: file.mode,
    };
  };
  const resources = profile.resources.map((resource): PublishedResource => {
    let spec: PublishedResourceSpec;
    if (resource.spec.kind === "file") {
      const { path: _, ...file } = materializeFile({ path: "", ...resource.spec });
      spec = { kind: "file", ...file };
    } else if (resource.spec.kind === "skill") {
      spec = { ...resource.spec, files: resource.spec.files.map(materializeFile) };
    } else {
      spec = resource.spec;
    }
    const blobs = spec.kind === "file"
      ? [spec.blob]
      : spec.kind === "skill"
      ? spec.files.map((file) => file.blob)
      : [];
    const base = {
      id: Schema.decodeUnknownSync(ResourceId)(resource.id),
      kind: resource.kind,
      policy: resource.policy ?? defaultPolicyForKind[resource.kind],
      target: resource.target,
      dependsOn: (resource.dependsOn ?? []).map((dependency) =>
        Schema.decodeUnknownSync(ResourceId)(dependency)
      ),
      spec,
      blobs: [...new Set(blobs)],
    };
    return resource.groups === undefined ? base : { ...base, groups: resource.groups };
  });
  return { resources, blobs: [...stored.values()] };
};

/**
 * The digest a follower derives from a published spec when it verifies the
 * resource by `digest` (follower-orchestration `desiredFor` computes the same
 * value). Tools and credentials have no content digest.
 */
const publishedContentDigest = (
  spec: PublishedResourceSpec,
): ContentDigest | undefined => {
  switch (spec.kind) {
    case "file":
      return spec.blob;
    case "skill":
      return directoryVerificationDigest(spec.files.map((file) =>
        ({ path: file.path, digest: file.blob, executable: file.executable })
      ));
    case "config":
      return sha256BytesHex(renderConfigDocument(spec));
    case "tool":
    case "credential":
      return undefined;
  }
};

/**
 * Fill each omitted `verify.digest` from the published content and reject a
 * declared digest that differs, so no revision is signed that its followers
 * could never verify.
 */
const completeVerification = (
  profile: MachineProfile,
  materialized: MaterializedProfileResources,
): MachineProfile => {
  const mismatches: Array<VerificationDigestMismatchError> = [];
  const resources = profile.resources.map((resource, index) => {
    if (resource.verify.method !== "digest") return resource;
    const computedDigest = publishedContentDigest(materialized.resources[index]!.spec!);
    // Validation already rejected digest verification of content-less kinds.
    if (computedDigest === undefined) {
      throw new Error(`resource ${resource.id} has digest verification but no content digest`);
    }
    const declaredDigest = resource.verify.digest;
    if (declaredDigest !== undefined && declaredDigest !== computedDigest) {
      mismatches.push(new VerificationDigestMismatchError({
        id: resource.id,
        declaredDigest,
        computedDigest,
      }));
    }
    return { ...resource, verify: { method: "digest" as const, digest: computedDigest } };
  });
  if (mismatches.length > 0) throw new ProfileContractError(mismatches);
  return { ...profile, resources };
};

/**
 * Compile a folder's Machine Profile into the exact candidate publication
 * signs. No filesystem or process state participates: every `source` is
 * already resolved and hashed.
 */
export const compileProfileCandidate = (
  input: MachineProfile,
  sources: ResolvedSourceFiles,
): CompiledProfileCandidate => {
  const decoded = validated(input);
  const materialized = materializeResources(decoded, sources);
  const profile = completeVerification(decoded, materialized);
  const transportResources = materialized.resources.map((resource, index) => ({
    ...resource, verify: profile.resources[index]!.verify,
  }));
  assertProfileMetadataBudget({ profileId: profile.id, resources: transportResources, scheduleDefault: profile.scheduleDefault });
  const canonicalBytes = canonicalJson(asJson({ ...profile, resources: transportResources }));
  return {
    profile,
    resources: materialized.resources,
    blobs: materialized.blobs,
    canonicalBytes,
    digest: Schema.decodeUnknownSync(ContentDigest)(sha256Hex(canonicalBytes)),
  };
};
