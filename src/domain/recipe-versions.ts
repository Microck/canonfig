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

/** Recipe methods that the current deterministic process executor may run. */
export const AutomaticRecipeMethod = Schema.Literals([
  "npm",
  "pnpm",
  "bun",
  "brew",
  "homebrew",
  "apt",
  "winget",
  "uv",
  "cargo",
]);
export type AutomaticRecipeMethod = Schema.Schema.Type<typeof AutomaticRecipeMethod>;

/** Canonical source metadata retained for reviewed package recipes. */
export const RecipeSourceMetadata = Schema.Struct({
  source: Schema.NonEmptyString,
  integrity: Schema.optional(Schema.NonEmptyString),
});
export type RecipeSourceMetadata = Schema.Schema.Type<typeof RecipeSourceMetadata>;
export type RecipeSource = string | RecipeSourceMetadata;

export interface RecipeSourceDetails {
  readonly source?: string | undefined;
  readonly integrity?: string | undefined;
}

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
  readonly source?: RecipeSource | undefined;
  readonly integrity?: string | undefined;
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
  if (method === "source" && version === undefined) {
    return "source recipes require an immutable revision";
  }
  if (method !== "source" && !isSafePackageArgument(packageName)) {
    return `package argument is unsafe: ${packageName}`;
  }
  const sourceReason = recipeSourceValidationError(input);
  if (sourceReason !== undefined) return sourceReason;
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

const sourceValue = (
  source: RecipeSource | undefined,
): { readonly source: string; readonly integrity?: string | undefined } | undefined =>
  source === undefined
    ? undefined
    : Schema.is(Schema.String)(source)
    ? { source }
    : source;

const isSRI = (value: string): boolean =>
  /^(?:sha256|sha512)-[A-Za-z0-9+/]+={0,2}$/u.test(value);

const npmTarballPath = (packageName: string, version: string): string => {
  const packagePart = packageName.startsWith("@")
    ? packageName.slice(packageName.indexOf("/") + 1)
    : packageName;
  return `/${packageName}/-/${packagePart}-${version}.tgz`;
};

/**
 * Validate the reviewed source without turning a lockfile locator into a
 * package-manager argument. Non-URL locators remain useful evidence and are
 * installed from the canonical registry; URL sources are only accepted for
 * exact npm registry tarballs.
 */
export const recipeSourceValidationError = (input: {
  readonly method: string;
  readonly package: string;
  readonly version?: string | undefined;
  readonly source?: RecipeSource | undefined;
  readonly integrity?: string | undefined;
}): string | undefined => {
  const metadata = sourceValue(input.source);
  const integrity = metadata?.integrity ?? input.integrity;
  if (input.integrity !== undefined && metadata?.integrity !== undefined) {
    return "recipe source integrity is duplicated";
  }
  if (integrity !== undefined && !isSRI(integrity)) {
    return "recipe source integrity must be a valid sha256 or sha512 SRI value";
  }
  if (metadata === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(metadata.source);
  } catch {
    // Lockfile paths and evidence locators are not install arguments.
    if (
      (input.method === "npm" || input.method === "pnpm" || input.method === "bun")
      && integrity !== undefined
    ) {
      return "npm-family recipe integrity requires a canonical HTTPS registry tarball source";
    }
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // Schemes such as lock:, package:, and file paths are evidence locators,
    // not network sources.
    if (/^(?:git\+|git:|ssh:|github:|gitlab:|bitbucket:|file:|link:|workspace:|npm:)/iu.test(metadata.source)) {
      return "mutable Git or source dependency metadata is not an approved package artifact";
    }
    return undefined;
  }
  if (
    url.protocol !== "https:"
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
    || url.port.length > 0 && url.port !== "443"
  ) {
    return "recipe source must be an exact HTTPS URL without credentials, redirects, query, or fragment";
  }
  if (
    input.method !== "npm"
    && input.method !== "pnpm"
    && input.method !== "bun"
    && input.method !== "source"
  ) {
    return "recipe source URLs are only supported for npm-family registry artifacts or reviewed source recipes";
  }
  if (input.method === "npm" || input.method === "pnpm" || input.method === "bun") {
    const expectedSource = `https://registry.npmjs.org${npmTarballPath(input.package, input.version ?? "")}`;
    if (input.version === undefined || metadata.source !== expectedSource) {
      return "npm-family recipe source must be the canonical registry tarball for package and version";
    }
    if (url.origin !== "https://registry.npmjs.org") {
      return "npm-family recipe source must use the canonical npm registry origin";
    }
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return "npm-family recipe source has an invalid encoded path";
    }
    if (input.version === undefined || path !== npmTarballPath(input.package, input.version)) {
      return "npm-family recipe source must match the exact registry tarball for package and version";
    }
  }
  return undefined;
};

export const recipeSourceDetails = (
  source: RecipeSource | undefined,
  integrity?: string | undefined,
): RecipeSourceDetails => {
  const metadata = sourceValue(source);
  return {
    source: metadata?.source,
    integrity: metadata?.integrity ?? integrity,
  } satisfies RecipeSourceDetails;
};

export const isSafeRecipe = (input: {
  readonly method: string;
  readonly package: string;
  readonly version?: string | undefined;
}): boolean => recipeValidationError(input) === undefined;

export const isSafeSourceRevision = (value: string): boolean =>
  isSafeScalar(value, unsafeVersionCharacter) && sourceRevision.test(value);
