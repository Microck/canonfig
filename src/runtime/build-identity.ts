/**
 * Identity of the running build.
 *
 * A package version names a release, not a build: two checkouts can report
 * the same version while compiling different sources. `npm run build:cli`
 * computes a SHA-256 over every build input (see tools/release/build-receipt.ts)
 * and the minifier substitutes it for __CANONFIG_BUILD_IDENTITY__ below, so the
 * compiled CLI can say exactly which sources it was built from without the
 * receipt file, which stays out of the published package.
 *
 * A checkout run straight from source (tsx, the test suite) has no compiled
 * identity and says so with "unbuilt" rather than inventing one.
 */
declare const __CANONFIG_BUILD_IDENTITY__: string | undefined;

export const packageVersion = "3.1.5";

export interface BuildIdentity {
  readonly packageVersion: string;
  /** Aggregate digest of the build inputs, or "unbuilt" for a source checkout. */
  readonly sourceDigest: string;
  /** Git commit the build was made from, when Git was available at build time. */
  readonly commit: string | null;
}

const embedded: { readonly sourceDigest: string; readonly commit: string | null } =
  __CANONFIG_BUILD_IDENTITY__ === undefined
    ? { sourceDigest: "unbuilt", commit: null }
    // SAFETY: the minifier substitutes this constant with the JSON text of
    // exactly this shape; anything else failed to go through build:cli.
    : (JSON.parse(__CANONFIG_BUILD_IDENTITY__) as {
      sourceDigest: string;
      commit: string | null;
    });

export const buildIdentity: BuildIdentity = {
  packageVersion,
  sourceDigest: embedded.sourceDigest,
  commit: embedded.commit,
};

/** Short operator-facing label, for messages that name a build. */
export const describeBuild = (build: BuildIdentity): string =>
  `canonfig ${build.packageVersion} (source ${build.sourceDigest.slice(0, 12)})`;
