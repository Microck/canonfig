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
npm audit --audit-level=low
npm audit --omit=dev --audit-level=low
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

Resolve dependency advisories before freezing the release candidate. A lockfile
change requires rebuilding and repeating acceptance on the new candidate;
receipts for the previous artifact do not transfer.

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

## Demo and documentation site

https://canonfig.micr.dev serves the UI demo at `/` and the documentation at
`/docs`. The `Publish site` workflow (`.github/workflows/pages.yml`) runs after
each successful `Publish release` run on `main`. It checks out the released
commit, confirms that tag `vX.Y.Z` points at it, runs
`node scripts/build-pages.mjs`, and deploys the resulting `_site/` directory to
GitHub Pages. To rebuild the current `main` without a release, run the workflow
manually from the Actions tab.

The workflow follows the release run instead of the `release: published`
event. `release.yml` creates the GitHub release with the workflow's
`GITHUB_TOKEN`, and
[events caused by that token start no new workflow runs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).

To build the site locally, install dependencies with `npm ci` and
`npm ci --prefix ui`, then run `node scripts/build-pages.mjs`.

Configure once:

1. In the repository's Settings > Pages, set the source to GitHub Actions.
2. In the same page, set the custom domain to `canonfig.micr.dev` and enable
   Enforce HTTPS once the certificate is issued. The site carries no `CNAME`
   file because
   [a custom Actions workflow takes the domain from these settings and ignores CNAME](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).
   It carries no `.nojekyll` either, because
   [a custom workflow deploys its artifact as built](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site#publishing-with-a-custom-github-actions-workflow)
   and Jekyll never runs.
3. The `micr.dev` zone is hosted on Netlify DNS (nameservers
   `dns1.p04.nsone.net` to `dns4.p04.nsone.net`). Change the existing record
   `canonfig CNAME 2caa8cf503a6fd37.vercel-dns-017.com` (the documentation's
   former Vercel host) to `canonfig CNAME microck.github.io`, so GitHub can
   issue the HTTPS certificate.

## Failure handling

Do not move or delete a published tag. If npm returns `ENEEDAUTH`, confirm the
trusted publisher exists on npmjs.com and exactly matches `Microck`, `canonfig`,
`release.yml`, an empty environment, and the `npm publish` action. Also confirm
the workflow has `id-token: write` and no npm token configuration.

If npm publication succeeded but the package is defective, deprecate the exact
version with a recovery message and prepare a new patch release. If publication
failed before npm accepted the version, fix the release pull request or trusted
publisher configuration and retry the same unpublished version.


## Registry processing delays

npm can accept and attest a publication before its read endpoints expose the new
version. Verification polls for up to ten minutes, then installs the public package
in an isolated temporary directory and checks its reported version.

Publication and verification are separate jobs. If publication and tag creation
succeeded but verification failed, rerun only the failed verification job. Never
rerun publication or reuse the version. Verification can also be run independently
with Node.js 24 and npm on the release runner. Substitute the version being verified:

```bash
node tools/release/verify-published.mjs 6.0.0
```

The verification helper only reads from npm and installs into a disposable local
directory; it never publishes or creates tags. A timeout is not evidence that npm
rejected the publication. Inspect the original publish step before any recovery.
