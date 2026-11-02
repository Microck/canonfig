# Canonfig v5.0.1

This patch fixes how Follower Machines check Configuration Agent install paths.
Node.js 24 or newer is required. The Source/follower protocol and state schema
are unchanged on the 5.0.x line, so 5.0.0 and 5.0.1 machines sync with each
other and can be updated one at a time.

## Agent install paths

A profile's `agentInstall.paths` entries that start with `~`, such as
`~/.local/bin`, are now expanded on the follower before the harness bounds
check. Before 5.0.1 these entries never matched the shell-expanded
`--allow-path` values, so the follower refused the agent (#242).

`canonfig agent harness` now stores each `--allow-path` value as an absolute
path, so a quoted `~` or a relative path works. The bounds check compares whole
path segments and ignores case on Windows, so `/opt/bin` no longer covers
`/opt/binaries`.

Harness settings saved with a literal `~` before 5.0.1 are not converted. Rerun
`canonfig agent harness codex`, `claude` or `custom` with the same options to
store absolute paths.

## Upgrade boundaries

Update from 5.0.0 machine by machine; finish any interrupted run with
`canonfig recover` first and restart the Source after replacing its package.
From 4.x, follow the 5.0.0 boundaries: pause synchronization, upgrade the Source
and all followers to 5.0.1 together, replace any stored `gemini` harness, and
verify before resuming. In-place migration from 3.2.x remains unsupported.

## Verification

Publication is gated on repository validation, packed CLI checks and native
Linux/macOS/Windows x64 and Windows ARM64 acceptance. Verify the published npm
artifact, provenance and matching GitHub tag after publication. Release
preparation alone does not assert that publication succeeded.
