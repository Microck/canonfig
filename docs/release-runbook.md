# Release runbook

This runbook releases the public `@microck/canonfig` package and matching
GitHub release. Never rewrite a published tag or reuse a published version.

## 1. Configure publishing once

Configure npm trusted publishing for `@microck/canonfig` with:

- provider: GitHub Actions;
- owner: `Microck`;
- repository: `canonfig`;
- workflow filename: `release.yml`;
- allowed action: `npm publish`.

The workflow runs on a GitHub-hosted runner with `id-token: write`, so npm can
use short-lived OpenID Connect credentials and generate provenance. During a
migration only, the workflow can fall back to the repository secret
`NPM_TOKEN`; prefer trusted publishing and remove the token after verification.

## 2. Select the version

Use semantic versioning:

- patch for backward-compatible fixes;
- minor for backward-compatible features;
- major for breaking command, schema, state, or platform changes.

Confirm the target does not already exist on npm, as a Git tag, or as a GitHub
release.

## 3. Prepare the release pull request

1. Start from the latest green `main`.
2. Update the root package, workspace package, lockfile, CLI version constant,
   release validator, tests, install skills, and pinned install examples.
3. Update README and website documentation for every user-visible change.
4. Update `RELEASE_NOTES.md` for the selected version.
5. Search the repository for the previous version and explain any intentional
   remaining reference.
6. Use a `chore(release): prepare vX.Y.Z` pull request and squash it when
   merging.

## 4. Validate

Run from a clean checkout with Node.js 24:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run release:validate
npm run build
git diff --check
```

The pull request must also pass Linux, macOS, Windows, packed CLI, native
credential-store, and acceptance jobs. Resolve all CodeRabbit P0, P1, and P2
findings before merge.

## 5. Publish

After the release preparation pull request is merged, open GitHub Actions and
run the `Publish release` workflow from `main`. Enter the exact package version,
for example `2.2.0`.

The workflow performs the release in this order:

1. verify that the package version matches the input and that npm and Git do not
   already contain it;
2. install locked dependencies and rerun the complete validation matrix;
3. publish `@microck/canonfig` publicly with provenance;
4. create the matching `vX.Y.Z` tag and GitHub release from
   `RELEASE_NOTES.md` only after npm accepts the package;
5. install the published package and verify `canonfig --version`.

Do not create the tag or GitHub release before npm publication succeeds.

## 6. Verify

```bash
npm view @microck/canonfig@X.Y.Z version
npm install --global @microck/canonfig@X.Y.Z
canonfig --version
canonfig --help
canonfig doctor --no-input --timeout-ms 5000
```

Confirm the npm version and provenance, GitHub tag, release notes,
documentation deployment, and `main` CI. The release tag must resolve to the
validated release commit.

## Failure handling

Do not move or delete a published tag. If npm publication succeeded but the
package is defective, deprecate the exact version with a recovery message and
prepare a new patch release. If publication failed before npm accepted the
version, fix the release pull request or publishing configuration and retry the
same unpublished version.
