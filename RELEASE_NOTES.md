# Canonfig v4.2.0

This feature release adds opt-in automation for tracked skills, authored source
profiles and local harness projection. Node.js 24 or newer is required.

## Automatic tracked skill updates

`canonfig skills auto` previews by default. `--apply` runs a foreground update
loop (24 hours by default); `--once` supports an explicit external scheduler.
Selected sources are frozen and revalidated under the update lock. Local drift
and failures stop the updater. It does not install an OS service, publish a
profile, force an overwrite or apply harness configuration.

## Source skill deletion reconciliation

`canonfig source reconcile-skills --profile-file FILE` previews removal of
previously observed source-backed skills that have disappeared. `--apply`
records observations and makes validated, backed-up JSONC edits; `--watch`
repeats the process. Changed resource identities, inaccessible parents and
unsafe dependencies fail closed. Other profile writers must be stopped.
Profile publication and follower synchronization remain explicit separate steps.

## Live local harness projection

`canonfig harness watch` projects supported canonical configuration into enabled
harnesses while running in the foreground. Two matching plans are required
before each serialized apply. It recreates deleted generated outputs, cleans up
retired ownership and avoids idle writes. Drift, invalid saves and apply errors
stop the watcher rather than overwriting local edits. SIGINT/SIGTERM waits for
in-flight cleanup. Continuous dry-run and strict mode are supported.

The watcher does not coordinate other apply/clean processes or external editors;
stop those writers first. It does not install a background service, refresh a
running harness process, transfer credentials or change machine sync transport.

## Dependency maintenance

Pin transitive Zod to 4.6.7 to resolve GHSA-mrhx-c7xc-m3w5 in documentation
and test tooling. The release candidate is rebuilt and revalidated with this
lockfile.

## Upgrade boundaries

State and signed-revision formats are unchanged. The existing major.minor
handshake rejects mixed 4.0/4.1/4.2 fleets. Pause synchronization, upgrade the
Source and all followers to 4.2.0, restart the Source with its prior settings,
and verify before resuming. Finish unfinished runs with their original build
and retain backups. In-place migration from 3.2.x remains unsupported.

## Verification

Publication is gated on repository validation, packed CLI checks and native
Linux/macOS/Windows x64 and Windows ARM64 acceptance. Verify the published npm
artifact, provenance and matching GitHub tag after publication. Release
preparation alone does not assert that publication succeeded.
