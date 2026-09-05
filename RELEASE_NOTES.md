# Canonfig v3.0.1

Canonfig 3.0.1 requires Node.js 24 or newer.

This release changes no behavior. The package contents are identical to v3.0.0
apart from the version string.

## Supply chain

- The package is published through npm trusted publishing, so it carries a
  provenance attestation linking the tarball to the workflow run and commit that
  built it. Verify it with `npm audit signatures` after installing, or read the
  provenance on the npm package page.
- v3.0.0 was published from a local machine after the trusted publisher
  configuration failed, so it has no attestation. Prefer 3.0.1 when you want a
  verifiable build. v3.0.0 remains installable and is functionally identical.

Full changelog: https://github.com/Microck/canonfig/compare/v3.0.0...v3.0.1
