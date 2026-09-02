# Release runbook

This runbook releases the public `@microck/canonfig` package and matching
GitHub release. Never rewrite a published tag or reuse a published version.

## 1. Configure publishing once

Configure npm trusted publishing for `@microck/canonfig` with:

- provider: GitHub Actions;
- owner: `Microck`;
- repository: `canonfig`;
- workflow filename: `release.yml`;
- allowed action: `npm publish`;
- environment: empty.

Every value is case-sensitive. The workflow runs on a GitHub-hosted runner with
Node.js 24 and `id-token: write`, so npm can exchange the GitHub OpenID Connect
identity for a short-lived publishing credential and attach provenance.

The publish job intentionally does not set `registry-url`, `NODE_AUTH_TOKEN`,
`NPM_TOKEN`, or an npm auth entry. An empty token entry can shadow npm's trusted
publishing flow and produce `ENEEDAUTH` instead of requesting an OIDC token.

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
6. Title the pull request `chore(release): prepare vX.Y.Z` and squash it with
   the same title. The guarded `main` push trigger uses that exact prefix as the
   publication gate.

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

Squash-merge the green release pull request using the required title. A release
preparation normally changes `package.json` and `RELEASE_NOTES.md`, causing the
`Publish release` workflow to start automatically on `main`. The release
workflow file is also a trigger path so an unpublished authentication repair can
retry without editing package contents. Other `main` pushes do not publish
unless their commit message begins with `chore(release): prepare v`.

A manual workflow dispatch with the exact package version is available for an
unpublished retry. Do not retry after npm has accepted that version; complete
any missing GitHub release metadata without republishing.

The workflow performs the release in this order:

1. resolve the package version and verify that the release notes describe it;
2. verify that npm and Git do not already contain the version;
3. install locked dependencies and rerun the complete validation matrix;
4. publish `@microck/canonfig` through npm trusted publishing, which generates
   provenance automatically;
5. create the matching `vX.Y.Z` tag and GitHub release from
   `RELEASE_NOTES.md` only after npm accepts the package;
6. install the published package and verify `canonfig --version`.

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

Do not move or delete a published tag. If npm returns `ENEEDAUTH`, confirm the
trusted publisher exists on npmjs.com and exactly matches `Microck`, `canonfig`,
`release.yml`, an empty environment, and the `npm publish` action. Also confirm
the workflow has `id-token: write` and no npm token configuration.

If npm publication succeeded but the package is defective, deprecate the exact
version with a recovery message and prepare a new patch release. If publication
failed before npm accepted the version, fix the release pull request or trusted
publisher configuration and retry the same unpublished version.
