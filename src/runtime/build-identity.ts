/**
 * Identity of the running build.
 *
 * A package version names a release, not a build: two checkouts can report
 * the same version while compiling different sources. `npm run build:cli`
 * computes a SHA-256 over every build input (see tools/release/build-receipt.ts)
 * and the minifier substitutes it for the __CANONFIG_BUILD_IDENTITY__ global
 * below, so the compiled CLI can say exactly which sources it was built from
 * without the receipt file, which stays out of the published package.
 *
 * A checkout run straight from source (tsx, the test suite) has no compiled
 * identity and says so with "unbuilt" rather than inventing one.
 */
// Source execution leaves this ambient global undeclared, so reading it
// throws a ReferenceError there; the release minifier replaces the bare
// identifier with the embedded JSON string in every compiled module.
declare const __CANONFIG_BUILD_IDENTITY__: string | undefined;
const substituted = ((): string | undefined => {
  try {
    return __CANONFIG_BUILD_IDENTITY__;
  } catch (cause) {
    if (cause instanceof ReferenceError) return undefined;
    throw cause;
  }
})();

// SAFETY: parsing that text cannot produce another shape.
const embedded = substituted === undefined
  ? { sourceDigest: "unbuilt", commit: null }
  : (JSON.parse(substituted) as { sourceDigest: string; commit: string | null });

export const packageVersion = "4.0.0";

export const minimumSupportedNodeMajor = 24;

export const nodeRuntimeIsSupported = (version: string): boolean => {
  const match = /^(\d+)\./u.exec(version);
  return match !== null && Number(match[1]) >= minimumSupportedNodeMajor;
};

export interface BuildIdentity {
  readonly packageVersion: string;
  /** Aggregate digest of the build inputs, or "unbuilt" for a source checkout. */
  readonly sourceDigest: string;
  /** Git commit the build was made from, when Git was available at build time. */
  readonly commit: string | null;
}

export const buildIdentity: BuildIdentity = {
  packageVersion,
  sourceDigest: embedded.sourceDigest,
  commit: embedded.commit,
};

/** Short operator-facing label, for messages that name a build. */
export const describeBuild = (build: BuildIdentity): string =>
  `canonfig ${build.packageVersion} (source ${build.sourceDigest.slice(0, 12)})`;
