import { Schema } from "effect";

import { isNpmRegistryPackageName } from "./npm-package-spec.ts";

export const RecipeMethod = Schema.Literals([
  "npm",
  "pnpm",
  "bun",
  "brew",
  "homebrew",
  "apt",
  "winget",
  "uv",
  "cargo",
  "source",
]);
export type RecipeMethod = Schema.Schema.Type<typeof RecipeMethod>;

/**
 * Recipe methods that can express a version as a single deterministic
 * package-manager argument. Source revisions use a separate safe-reference
 * grammar because the current executor cannot check out or build them.
 */
export type VersionedRecipeMethod = RecipeMethod;

const npmVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const homebrewVersion = /^[0-9A-Za-z][0-9A-Za-z.+_~+-]*$/u;
const wingetVersion = /^[0-9A-Za-z][0-9A-Za-z.+_~-]*$/u;
const uvVersion = /^[0-9A-Za-z][0-9A-Za-z!+._-]*$/u;
const cargoVersion = npmVersion;
const aptVersion = /^[0-9A-Za-z][0-9A-Za-z.+:~_+-]*$/u;
const sourceRevision = /^[0-9A-Za-z][0-9A-Za-z._~/-]*$/u;

const unsafePackageArgument = /[\p{Cc}\s%=&|<>`"'$()[\]{}]/u;
const unsafeVersionCharacter = /[\p{Cc}\s%/@?#=\\;&|<>`"'$()[\]{}]/u;

const isSafeScalar = (
  value: string,
  unsafe: RegExp,
): boolean =>
  value.length > 0
  && value === value.trim()
  && !value.startsWith("-")
  && !value.startsWith("+")
  && !unsafe.test(value);

const isSafePackageArgument = (value: string): boolean =>
  isSafeScalar(value, unsafePackageArgument);

const versionPatternFor = (
  method: string,
): RegExp | undefined => {
  switch (method) {
    case "npm":
    case "pnpm":
    case "bun":
      return npmVersion;
    case "brew":
    case "homebrew":
      return homebrewVersion;
    case "winget":
      return wingetVersion;
    case "uv":
      return uvVersion;
    case "cargo":
      return cargoVersion;
    case "apt":
      return aptVersion;
    case "source":
      return sourceRevision;
    default:
      return undefined;
  }
};

/**
 * Return a stable, boundary-friendly explanation when a recipe cannot be
 * represented by the deterministic installer.
 */
export const recipeValidationError = (input: {
  readonly method: string;
  readonly package: string;
  readonly version?: string | undefined;
}): string | undefined => {
  const { method, package: packageName, version } = input;
  if (!Schema.is(RecipeMethod)(method)) {
    return `unknown installer method ${method}`;
  }
  if (
    (method === "npm" || method === "pnpm" || method === "bun")
    && !isNpmRegistryPackageName(packageName)
  ) {
    return `npm-family package must be an exact registry name: ${packageName}`;
  }
  if (method !== "source" && !isSafePackageArgument(packageName)) {
    return `package argument is unsafe: ${packageName}`;
  }
  if (version === undefined) return undefined;
  const pattern = versionPatternFor(method);
  if (
    pattern === undefined
    || !isSafeScalar(version, unsafeVersionCharacter)
    || !pattern.test(version)
  ) {
    return `installer ${method} cannot honor requested version ${version}`;
  }
  return undefined;
};

export const isSafeRecipe = (input: {
  readonly method: string;
  readonly package: string;
  readonly version?: string | undefined;
}): boolean => recipeValidationError(input) === undefined;

export const isSafeSourceRevision = (value: string): boolean =>
  isSafeScalar(value, unsafeVersionCharacter) && sourceRevision.test(value);
