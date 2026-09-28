import { Schema } from "effect";

import { BlobId, ContentDigest, ResourceId } from "../domain/brand.ts";
import {
  MachineProfileAuthoringSchema,
  MachineProfileSchema,
  ProfileContractError,
  VerificationDigestMismatchError,
  decodeMachineProfileJsonc,
  normalizeMachineProfile,
  validateMachineProfile,
  type MachineProfile,
  type MachineProfileAuthoring,
  type ManagedFileInput,
  type ProfileResourceInput,
  type PublishedResource,
  type PublishedResourceSpec,
} from "../domain/profile.ts";
import { renderConfigDocument } from "../synchronization/config-codec.ts";
import {
  asJson,
  canonicalJson,
  directoryVerificationDigest,
  sha256BytesHex,
  sha256Hex,
} from "./profile-codec.ts";
import {
  defaultPolicyForKind,
  Platform,
  type Platform as PlatformName,
  type ResourceKind,
} from "../domain/resource.ts";

export interface ProfileCompilerOptions {
  readonly platforms?: ReadonlyArray<PlatformName> | undefined;
}

export type ProfileCompilerInput = MachineProfileAuthoring | MachineProfile;

export interface CompiledPlatformProfile {
  readonly platform: PlatformName;
  readonly profile: MachineProfile;
  readonly canonicalBytes: string;
  readonly digest: ContentDigest;
}

export interface CompiledProfileCandidate {
  readonly profile: MachineProfile;
  readonly canonicalBytes: string;
  readonly digest: ContentDigest;
  readonly resources: ReadonlyArray<PublishedResource>;
  readonly blobs: ReadonlyArray<CompiledResourceBlob>;
}

export interface CompiledProfile extends CompiledProfileCandidate {
  /** Explicit deterministic views used to inspect platform-specific recipes and paths. */
  readonly projections: ReadonlyArray<CompiledPlatformProfile>;
}

export interface CompiledResourceBlob {
  readonly id: typeof BlobId.Type;
  readonly content: Uint8Array;
}

interface MaterializedProfileResources {
  readonly resources: ReadonlyArray<PublishedResource>;
  readonly blobs: ReadonlyArray<CompiledResourceBlob>;
}
const allPlatforms: ReadonlyArray<PlatformName> = ["linux", "macos", "windows"];

const resourcesForPlatform = (
  resources: ReadonlyArray<ProfileResourceInput>,
  platform: PlatformName,
): ReadonlyArray<ProfileResourceInput> =>
  resources.map((resource) =>
    resource.spec.kind !== "tool"
      ? resource
      : {
        ...resource,
        spec: {
          ...resource.spec,
          recipes: resource.spec.recipes.filter((recipe) =>
            recipe.platform === platform
          ),
        },
      }
  );

const profileForPlatform = (
  profile: MachineProfile,
  platform: PlatformName,
): MachineProfile =>
  normalizeMachineProfile({
    ...profile,
    resources: resourcesForPlatform(profile.resources, platform),
  });

const decodeInput = (input: ProfileCompilerInput): MachineProfile => {
  const authored = Schema.decodeUnknownSync(
    MachineProfileAuthoringSchema,
    { onExcessProperty: "error" },
  )(input);
  const profile = normalizeMachineProfile(authored);
  Schema.decodeUnknownSync(MachineProfileSchema, { onExcessProperty: "error" })(profile);
  const errors = validateMachineProfile(profile);
  if (errors.length > 0) throw new ProfileContractError(errors);
  return profile;
};
const inlineBytes = (file: {
  readonly content?: string | undefined;
  readonly encoding?: "base64" | undefined;
}): Uint8Array => {
  if (file.content === undefined) {
    throw new Error("resource source must be resolved before compilation");
  }
  if (file.encoding !== "base64") return Buffer.from(file.content, "utf8");
  const bytes = Buffer.from(file.content, "base64");
  const normalizedInput = file.content.replace(/=+$/u, "");
  if (bytes.toString("base64").replace(/=+$/u, "") !== normalizedInput) {
    throw new Error("resource file contains invalid base64");
  }
  return bytes;
};

const materializeResources = (
  profile: MachineProfile,
): MaterializedProfileResources => {
  const stored = new Map<typeof BlobId.Type, Uint8Array>();
  type PublishedManagedFile = Extract<
    PublishedResourceSpec,
    { readonly kind: "directory" }
  >["files"][number];
  const materializeFile = (file: ManagedFileInput): PublishedManagedFile => {
    if (file.symlinkTo !== undefined) {
      return {
        path: file.path,
        executable: false,
        mode: 0,
        symlinkTo: file.symlinkTo,
      };
    }
    const content = inlineBytes(file);
    const id = Schema.decodeUnknownSync(BlobId)(sha256BytesHex(content));
    stored.set(id, content);
    return {
      path: file.path,
      blob: id,
      bytes: content.byteLength,
      executable: file.executable ?? false,
      mode: file.mode,
    };
  };
  const resources = profile.resources.map((resource): PublishedResource => {
    let spec: PublishedResourceSpec;
    if (resource.spec.kind === "file") {
      const { path: _, ...file } = materializeFile({ path: "", ...resource.spec });
      spec = { kind: "file", ...file };
    } else if (resource.spec.kind === "directory" || resource.spec.kind === "skill") {
      spec = { ...resource.spec, files: resource.spec.files.map(materializeFile) };
    } else {
      spec = resource.spec;
    }
    const blobs = spec.kind === "file"
      ? spec.blob === undefined ? [] : [spec.blob]
      : spec.kind === "directory" || spec.kind === "skill"
      ? spec.files.flatMap((file) => file.blob === undefined ? [] : [file.blob])
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
  return {
    resources,
    blobs: [...stored].map(([id, content]) => ({ id, content })),
  };
};

/**
 * The digest a follower derives from a published spec when it verifies the
 * resource by `digest` (follower-orchestration `desiredFor` computes the same
 * value). Tools, credentials, and symlink files have no content digest.
 */
const publishedContentDigest = (
  spec: PublishedResourceSpec,
): ContentDigest | undefined => {
  switch (spec.kind) {
    case "file":
      return spec.symlinkTo === undefined ? spec.blob : undefined;
    case "directory":
    case "skill":
      return directoryVerificationDigest(spec.files.map((file) =>
        file.symlinkTo === undefined
          ? { path: file.path, digest: file.blob!, executable: file.executable }
          : { path: file.path, digest: sha256Hex(file.symlinkTo), executable: false }
      ));
    case "config":
      return sha256BytesHex(renderConfigDocument(spec));
    case "tool":
    case "credential":
      return undefined;
  }
};

/** One resource's content digest beside the digest its profile declares. */
export interface ResourceContentDigest {
  readonly id: ResourceId;
  readonly kind: ResourceKind;
  readonly verifyMethod: ProfileResourceInput["verify"]["method"];
  readonly computedDigest: ContentDigest;
  /** Absent when the profile omits `verify.digest` or verifies another way. */
  readonly declaredDigest?: string | undefined;
}

const contentDigestsFor = (
  profile: MachineProfile,
  materialized: MaterializedProfileResources,
): ReadonlyArray<ResourceContentDigest> =>
  profile.resources.flatMap((resource, index) => {
    const computedDigest = publishedContentDigest(materialized.resources[index]!.spec!);
    if (computedDigest === undefined) return [];
    return [{
      id: Schema.decodeUnknownSync(ResourceId)(resource.id),
      kind: resource.kind,
      verifyMethod: resource.verify.method,
      computedDigest,
      declaredDigest: resource.verify.method === "digest" ? resource.verify.digest : undefined,
    }];
  });

/**
 * Content digests of every resource that has content, computed exactly as
 * publication computes them. `canonfig source digest` prints these. Sources
 * must already be resolved.
 */
export const profileContentDigests = (
  input: ProfileCompilerInput,
): ReadonlyArray<ResourceContentDigest> => {
  const profile = decodeInput(input);
  return contentDigestsFor(profile, materializeResources(profile));
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

/** Compile the exact normalized candidate consumed by publication. */
export const compileProfileCandidate = (
  input: ProfileCompilerInput,
): CompiledProfileCandidate => {
  const decoded = decodeInput(input);
  const materialized = materializeResources(decoded);
  const profile = completeVerification(decoded, materialized);
  const canonicalBytes = canonicalJson(asJson({
    ...profile,
    resources: materialized.resources.map((resource, index) => ({
      ...resource,
      verify: profile.resources[index]!.verify,
    })),
  }));
  return {
    profile,
    resources: materialized.resources,
    blobs: materialized.blobs,
    canonicalBytes,
    digest: Schema.decodeUnknownSync(ContentDigest)(sha256Hex(canonicalBytes)),
  };
};

/**
 * Compile authoring input into the publication candidate plus stable platform
 * projections. No filesystem or process state participates.
 */
export const compileProfile = (
  input: ProfileCompilerInput,
  options: ProfileCompilerOptions = {},
): CompiledProfile => {
  const candidate = compileProfileCandidate(input);
  const selected = options.platforms ?? allPlatforms;
  const platforms = Schema.decodeUnknownSync(Schema.Array(Platform))(selected);
  const uniquePlatforms = [...new Set(platforms)].sort();
  const projections = uniquePlatforms.map((platform) => {
    const profile = profileForPlatform(candidate.profile, platform);
    const projection = compileProfileCandidate(profile);
    return {
      platform,
      profile,
      canonicalBytes: projection.canonicalBytes,
      digest: projection.digest,
    };
  });
  return { ...candidate, projections };
};

/** Parse JSONC authoring input, then compile it through the same candidate path. */
export const compileProfileJsonc = (
  input: string,
  options: ProfileCompilerOptions = {},
): CompiledProfile =>
  compileProfile(decodeMachineProfileJsonc(input), options);
