# Canonfig v4.1.0

This feature release adds portable harness archives and configurable upstream
skill tracking. Node.js 24 or newer is required.

## Harness archives

`canonfig harness export` packages canonical configuration alone, one or multiple
selected harnesses, or selected harnesses plus canonical configuration. ZIP and
TAR.GZ archives preserve binary files, executable bits and Unicode names, and
include an inventory with content hashes. Dry runs, strict validation, bounded
input sizes and no-clobber output make export explicit and inspectable.

Exports do not read environment credentials, upload files or mutate source/native
configuration. Authored literal secrets are not automatically scrubbed. External
dependencies remain external; this is not a complete machine backup.

## Tracked skill updates

`canonfig skills track`, `list`, `check` and `update` track an existing installed
skill against an explicit Git source, ref and subdirectory. Roots, configuration
paths and named selections are configurable. Tracking requires a matching tree;
updates preview by default and require `--apply` to write.

Local additions, edits or deletions block the selected update rather than being
overwritten. Staging, revalidation, locking, rollback and an interruption journal
protect updates. Public HTTPS and local Git sources are supported; private/SSH
sources, automatic merges and automatic crash recovery are not claimed. The
commands do not execute skills or change follower/profile publication policy.

## Dependency maintenance

Update the documentation site to Next.js 16.4.2 and test tooling to Vitest 4.1.12
to resolve the advisories found during release preparation. Production and full
dependency audits are clean on the updated lockfile.

## Upgrade boundaries

The state schema and signed-revision format are unchanged. The existing
major.minor handshake still rejects mixed 4.0/4.1 fleets: pause synchronization,
upgrade the Source and every follower to 4.1.0, restart the Source with its prior
settings, and verify before resuming. Finish or recover unfinished runs using
their original build and retain backups. In-place migration from 3.2.x remains
unsupported; follow the separate fresh-install guide.

## Verification

Release is gated on repository checks, native Linux/macOS/Windows x64 and ARM64
acceptance, packed CLI validation, unchanged package-size budgets and review.
Publication must be followed by a fresh public npm install and provenance/tag
verification. Preparing these notes does not assert that publication succeeded.
