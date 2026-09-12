import { Schema } from "effect";

import type { ContentDigest } from "../domain/brand.ts";
import {
  MachineProfileAuthoringSchema,
  decodeMachineProfileJsonc,
  digestMachineProfile,
  encodeMachineProfile,
  normalizeMachineProfile,
  type MachineProfile,
  type MachineProfileAuthoring,
  type ProfileResourceInput,
} from "../domain/profile.ts";
import { Platform, type Platform as PlatformName } from "../domain/resource.ts";

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
}

export interface CompiledProfile extends CompiledProfileCandidate {
  /** Explicit deterministic views used to inspect platform-specific recipes and paths. */
  readonly projections: ReadonlyArray<CompiledPlatformProfile>;
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
  return normalizeMachineProfile(authored);
};

/** Compile the exact normalized candidate consumed by publication. */
export const compileProfileCandidate = (
  input: ProfileCompilerInput,
): CompiledProfileCandidate => {
  const profile = decodeInput(input);
  return {
    profile,
    canonicalBytes: encodeMachineProfile(profile),
    digest: digestMachineProfile(profile),
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
  const { profile } = candidate;
  const selected = options.platforms ?? allPlatforms;
  const platforms = Schema.decodeUnknownSync(Schema.Array(Platform))(selected);
  const uniquePlatforms = [...new Set(platforms)].sort();
  const projections = uniquePlatforms.map((platform) => {
    const projection = profileForPlatform(profile, platform);
    return {
      platform,
      profile: projection,
      canonicalBytes: encodeMachineProfile(projection),
      digest: digestMachineProfile(projection),
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
