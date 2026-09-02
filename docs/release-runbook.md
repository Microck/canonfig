# Release runbook

This runbook releases the public `@microck/canonfig` package and matching
GitHub release. Never rewrite a published tag or reuse a published version.

## 1. Select the version

Use semantic versioning:

- patch for backward-compatible fixes;
- minor for backward-compatible features;
- major for breaking command, schema, state, or platform changes.

Confirm the target does not already exist on npm or as a Git tag.

## 2. Prepare the release branch

1. Start from the latest green `main`.
2. Update the root package, workspace package, lockfile, CLI version constant,
   release validator, tests, install skills, and pinned install examples.
3. Update README and website documentation for every user-visible change.
4. Search the repository for the previous version and explain any intentional
   remaining reference.
5. Use a single `chore(release): prepare vX.Y.Z` commit or squash to one at
   merge.

## 3. Validate

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

## 4. Publish

After the release preparation commit is on `main`:

```bash
npm publish --access public --provenance
git tag -a vX.Y.Z -m "Canonfig vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --title "Canonfig vX.Y.Z" --notes-file RELEASE_NOTES.md
```

Publish npm first. Create the tag and GitHub release only after npm accepts the
package so a release page never points to an unavailable version.

## 5. Verify

```bash
npm view @microck/canonfig@X.Y.Z version
npm install --global @microck/canonfig@X.Y.Z
canonfig --version
canonfig --help
canonfig doctor --no-input --timeout-ms 5000
```

Confirm the npm version, GitHub tag, release notes, documentation deployment,
and `main` CI. Compare the release tag with the preparation commit.

## Failure handling

Do not move or delete a published tag. If npm publication succeeded but the
package is defective, deprecate the exact version with a recovery message and
prepare a new patch release. If publication failed before npm accepted the
version, fix the release branch and retry the same unpublished version.
