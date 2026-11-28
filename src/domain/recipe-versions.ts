import { Schema, SchemaIssue } from "effect";

import { isNpmRegistryPackageName } from "./npm-package-spec.ts";
import { isSecretField } from "../secrets/credential-policy.ts";

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
  "binary",
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
  "binary",
]);
export type AutomaticRecipeMethod = Schema.Schema.Type<typeof AutomaticRecipeMethod>;

const sha256Integrity = /^sha256-[A-Za-z0-9+/]{43}=$/u;
const binaryArchive = Schema.Struct({
  format: Schema.Literals(["tar.gz", "zip"]),
  executableIntegrity: Schema.String.check(Schema.isPattern(sha256Integrity)),
});

export type BinaryArchive = Schema.Schema.Type<typeof binaryArchive>;

/** Canonical source metadata retained for reviewed package recipes. */
export const RecipeSourceMetadata = Schema.Struct({
  source: Schema.NonEmptyString,
  integrity: Schema.optional(Schema.NonEmptyString),
  archive: Schema.optional(binaryArchive),
});
export type RecipeSourceMetadata = Schema.Schema.Type<typeof RecipeSourceMetadata>;
export type RecipeSource = string | RecipeSourceMetadata;

/**
 * A reviewed Python package index. The full URL is retained because private
 * repositories commonly scope their simple API below an origin.
 */
export const RecipeIndexPolicy = Schema.Struct({
  url: Schema.NonEmptyString,
  reviewedBy: Schema.NonEmptyString,
  reviewedAt: Schema.NonEmptyString,
});
export type RecipeIndexPolicy = Schema.Schema.Type<typeof RecipeIndexPolicy>;

export const defaultPythonIndex = "https://pypi.org/simple";

/**
 * How a recipe's pinned `version` treats a tool that is already installed.
 * `at-least` (the default) keeps an installed version at or above the pin and
 * installs the pin only when the tool is missing or older, so a CLI that
 * updated itself is never downgraded. `exact` reinstalls the pin over any
 * other version. Binary and source recipes are always exact: their pin names
 * reviewed bytes or a revision, not a version an installer can order.
 */
export const RecipeVersionPolicy = Schema.Literals(["at-least", "exact"]);
export type RecipeVersionPolicy = Schema.Schema.Type<typeof RecipeVersionPolicy>;

/** The policy a recipe applies, with the default and the exact-only methods resolved. */
export const effectiveVersionPolicy = (recipe: {
  readonly method: string;
  readonly versionPolicy?: RecipeVersionPolicy | undefined;
}): RecipeVersionPolicy =>
  recipe.method === "binary" || recipe.method === "source" ? "exact" : recipe.versionPolicy ?? "at-least";

const hasUnsafeIndexUrlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x20
      || (code >= 0x7f && code <= 0x9f)
      || "\"'<>".includes(character);
  });

/** Canonicalize a reviewed full simple-index URL without widening its scope. */
export const canonicalRecipeIndexUrl = (
  value: string,
): string | undefined => {
  if (
    value.trim() !== value
    || value.includes("#")
    || value.includes("\\")
    || hasUnsafeIndexUrlCharacter(value)
  ) return undefined;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.hash.length > 0
      || parsed.pathname === "/"
      || !/(?:^|\/)simple\/?$/u.test(parsed.pathname)
    ) return undefined;
    for (const name of parsed.searchParams.keys()) {
      if (isSecretField(name)) return undefined;
    }
    parsed.pathname = parsed.pathname.replace(/\/$/u, "");
    return parsed.href;
  } catch {
    return undefined;
  }
};

export interface RecipeSourceDetails {
  readonly source?: string | undefined;
  readonly integrity?: string | undefined;
  readonly archive?: BinaryArchive | undefined;
}

export const isBinaryArchiveMemberPath = (path: string): boolean =>
  // oxlint-disable-next-line eslint/no-control-regex -- Archive member names cannot contain control characters.
  !/[\\:\x00-\x1f\x7f]/u.test(path)
  && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

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

export const isSafePackageArgument = (value: string): boolean =>
  isSafeScalar(value, unsafePackageArgument);

const versionPatternFor = (
  method: string,
): RegExp | undefined => {
  switch (method) {
    case "npm":
    case "pnpm":
    case "bun":
    case "binary":
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

export interface RecipeValidationInput {
  readonly method: string;
  readonly platform?: string | undefined;
  readonly package: string;
  readonly version?: string | undefined;
  readonly source?: RecipeSource | undefined;
  readonly integrity?: string | undefined;
  readonly indexPolicy?: RecipeIndexPolicy | undefined;
  readonly versionPolicy?: RecipeVersionPolicy | undefined;
  readonly architecture?: string | undefined;
  readonly entrypoint?: string | undefined;
}

export interface RecipeValidationIssue {
  readonly path: ReadonlyArray<string>;
  readonly reason: string;
  readonly issue: SchemaIssue.InvalidValue;
}

const recipeIssue = (path: ReadonlyArray<string>, reason: string): RecipeValidationIssue => ({
  path,
  reason,
  issue: new SchemaIssue.InvalidValue({ expected: reason }),
});

/** Keep each rule's explanation and field together at schema boundaries. */
export const recipeValidationIssue = (
  input: RecipeValidationInput,
): RecipeValidationIssue | undefined => {
  const { method, package: packageName, version } = input;
  if (!Schema.is(RecipeMethod)(method)) {
    return recipeIssue(["method"], "unknown installer method");
  }
  if (method === "binary") {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(packageName) || packageName.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(packageName)) return recipeIssue(["package"], "binary package must be a single non-reserved executable name");
    if (input.platform === "windows" && packageName.includes(".") && !packageName.toLowerCase().endsWith(".exe")) {
      return recipeIssue(["package"], "Windows binary names containing a dot must end in .exe; declare the full executable name so verification can find it");
    }
    if (version === undefined) return recipeIssue(["version"], "binary recipes require an exact version");
    if (input.architecture !== undefined && !["x64", "arm64"].includes(input.architecture)) return recipeIssue(["architecture"], "binary architecture must be x64 or arm64");
    if (sourceValue(input.source)?.archive === undefined && input.entrypoint !== undefined && input.entrypoint !== packageName) return recipeIssue(["entrypoint"], "binary entrypoint must equal the executable package name, not a path");
  }
  if (
    (method === "npm" || method === "pnpm" || method === "bun")
    && !isNpmRegistryPackageName(packageName)
  ) {
    return recipeIssue(["package"], "npm-family package must be an exact registry name");
  }
  if (method === "source" && version === undefined) {
    return recipeIssue(["version"], "source recipes require an immutable revision");
  }
  if ((method === "binary" || method === "source") && input.versionPolicy === "at-least") {
    return recipeIssue(["versionPolicy"], `${method} recipes always install their exact version; remove versionPolicy or set it to "exact"`);
  }
  if (method !== "source" && !isSafePackageArgument(packageName)) {
    return recipeIssue(["package"], "package argument is unsafe");
  }
  if (input.indexPolicy !== undefined) {
    if (method !== "uv") {
      return recipeIssue(["indexPolicy"], "recipe index policy is only supported for uv recipes");
    }
    const { url, reviewedBy, reviewedAt } = input.indexPolicy;
    if (reviewedBy.trim().length === 0 || !Number.isFinite(Date.parse(reviewedAt))) {
      return recipeIssue(["indexPolicy"], "recipe index policy requires a reviewer and valid review timestamp");
    }
    if (canonicalRecipeIndexUrl(url) === undefined) {
      return recipeIssue(["indexPolicy", "url"], "recipe index policy must be a credential-free HTTPS simple-index URL");
    }
  }
  const metadata = sourceValue(input.source);
  const integrity = metadata?.integrity ?? input.integrity;
  const sourceVersion = (
    (method === "npm" || method === "pnpm" || method === "bun")
      && version === undefined
  )
    ? npmVersionFromTarballSource(packageName, metadata?.source ?? "")
    : version;
  if (
    (method === "npm" || method === "pnpm" || method === "bun")
    && version === undefined
    && (
      sourceVersion === undefined
      || integrity === undefined
    )
  ) {
    return recipeIssue(["version"], "npm-family registry installs require an exact version or a reviewed tarball with integrity");
  }
  const sourceIssue = recipeSourceValidationIssue({
    ...input,
    version: sourceVersion,
  });
  if (sourceIssue !== undefined) return sourceIssue;
  if (version === undefined && sourceVersion === undefined) return undefined;
  const pattern = versionPatternFor(method);
  if (
    pattern === undefined
    || !isSafeScalar(sourceVersion!, unsafeVersionCharacter)
    || !pattern.test(sourceVersion!)
  ) {
    return recipeIssue(["version"], `installer ${method} cannot honor requested version`);
  }
  return undefined;
};

/** Whether an automatic recipe lacks a version that its installer can honor. */
export const isMissingAutomaticRecipeVersion = (input: {
  readonly method: string;
  readonly package: string;
  readonly version?: string | undefined;
  readonly source?: RecipeSource | undefined;
  readonly integrity?: string | undefined;
}): boolean => {
  if (!Schema.is(AutomaticRecipeMethod)(input.method)) return false;
  if (input.version !== undefined) return false;
  if (!isSafePackageArgument(input.package)) return false;
  if (
    (input.method === "npm" || input.method === "pnpm" || input.method === "bun")
    && !isNpmRegistryPackageName(input.package)
  ) {
    return false;
  }
  const metadata = sourceValue(input.source);
  const integrity = metadata?.integrity ?? input.integrity;
  const remoteSource = metadata?.source.startsWith("http:") === true
    || metadata?.source.startsWith("https:") === true;
  const npmFamily = input.method === "npm"
    || input.method === "pnpm"
    || input.method === "bun";
  if (remoteSource && !npmFamily) return false;
  if (remoteSource && npmFamily && integrity !== undefined) return false;
  return !(
    npmFamily
    && npmVersionFromTarballSource(input.package, metadata?.source ?? "") !== undefined
    && integrity !== undefined
  );
};

const sourceValue = (
  source: RecipeSource | undefined,
): RecipeSourceMetadata | undefined =>
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

export const npmVersionFromTarballSource = (
  packageName: string,
  source: string,
): string | undefined => {
  const packagePart = packageName.startsWith("@")
    ? packageName.slice(packageName.indexOf("/") + 1)
    : packageName;
  const prefix = `https://registry.npmjs.org/${packageName}/-/${packagePart}-`;
  if (!source.startsWith(prefix) || !source.endsWith(".tgz")) return undefined;
  const candidate = source.slice(prefix.length, -".tgz".length);
  return npmVersion.test(candidate) ? candidate : undefined;
};

/**
 * Validate the reviewed source without turning a lockfile locator into a
 * package-manager argument. Non-URL locators remain useful evidence and are
 * installed from the canonical registry; URL sources are only accepted for
 * exact npm registry tarballs.
 */
const recipeSourceValidationIssue = (
  input: RecipeValidationInput,
): RecipeValidationIssue | undefined => {
  const metadata = sourceValue(input.source);
  const integrity = metadata?.integrity ?? input.integrity;
  if (input.method === "binary") {
    if (input.integrity !== undefined && metadata?.integrity !== undefined) return recipeIssue(["integrity"], "recipe source integrity is duplicated");
    if (metadata === undefined) return undefined;
    try {
      const url = new URL(metadata.source);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.href !== metadata.source) {
        return recipeIssue(["source"], "binary source must be a canonical credential-free HTTPS URL without query or fragment");
      }
    } catch {
      return recipeIssue(["source"], "binary source must be an HTTPS artifact URL");
    }
    if (metadata.archive !== undefined) {
      if (!Schema.is(binaryArchive)(metadata.archive)) return recipeIssue(["source", "archive"], "binary archive requires a tar.gz or zip format and SHA-256 executable integrity");
      if (integrity === undefined || !sha256Integrity.test(integrity)) return recipeIssue(["source", "integrity"], "binary archive integrity must be a full SHA-256 SRI digest");
      if (input.entrypoint === undefined || !isBinaryArchiveMemberPath(input.entrypoint)) return recipeIssue(["entrypoint"], "binary archive requires a safe relative entrypoint with forward slashes");
    } else if (integrity !== undefined && !/^(?:sha256-[A-Za-z0-9+/]{43}=|sha512-[A-Za-z0-9+/]{86}==)$/u.test(integrity)) {
      return recipeIssue(["integrity"], "binary integrity must be a full sha256 or sha512 SRI digest");
    }
    return undefined;
  }
  if (metadata?.archive !== undefined) return recipeIssue(["source", "archive"], "archive metadata is only supported for binary recipes");
  if (input.integrity !== undefined && metadata?.integrity !== undefined) {
    return recipeIssue(["integrity"], "recipe source integrity is duplicated");
  }
  if (integrity !== undefined && !isSRI(integrity)) {
    return recipeIssue(["integrity"], "recipe source integrity must be a valid sha256 or sha512 SRI value");
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
      return recipeIssue(["source"], "npm-family recipe integrity requires a canonical HTTPS registry tarball source");
    }
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // Schemes such as lock:, package:, and file paths are evidence locators,
    // not network sources.
    if (/^(?:git\+|git:|ssh:|github:|gitlab:|bitbucket:|file:|link:|workspace:|npm:)/iu.test(metadata.source)) {
      return recipeIssue(["source"], "mutable Git or source dependency metadata is not an approved package artifact");
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
    return recipeIssue(["source"], "recipe source must be an exact HTTPS URL without credentials, redirects, query, or fragment");
  }
  if (
    input.method !== "npm"
    && input.method !== "pnpm"
    && input.method !== "bun"
    && input.method !== "source"
  ) {
    return recipeIssue(["source"], "recipe source URLs are only supported for npm-family registry artifacts or reviewed source recipes");
  }
  if (input.method === "npm" || input.method === "pnpm" || input.method === "bun") {
    const expectedSource = `https://registry.npmjs.org${npmTarballPath(input.package, input.version ?? "")}`;
    if (input.version === undefined || metadata.source !== expectedSource) {
      return recipeIssue(["source"], "npm-family recipe source must be the canonical registry tarball for package and version");
    }
    if (url.origin !== "https://registry.npmjs.org") {
      return recipeIssue(["source"], "npm-family recipe source must use the canonical npm registry origin");
    }
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return recipeIssue(["source"], "npm-family recipe source has an invalid encoded path");
    }
    if (input.version === undefined || path !== npmTarballPath(input.package, input.version)) {
      return recipeIssue(["source"], "npm-family recipe source must match the exact registry tarball for package and version");
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
    archive: metadata?.archive,
  };
};

export const isSafeRecipe = (input: {
  readonly method: string;
  readonly package: string;
  readonly version?: string | undefined;
}): boolean => recipeValidationIssue(input) === undefined;

export const isSafeSourceRevision = (value: string): boolean =>
  isSafeScalar(value, unsafeVersionCharacter) && sourceRevision.test(value);
