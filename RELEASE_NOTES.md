# Canonfig v5.0.0

This major release changes the Configuration Agent harness options and adds
opt-in patch self-updates. The documentation now lives at
https://canonfig.micr.dev/docs. Node.js 24 or newer is required.

## Breaking: agent harness changes

The `gemini` harness is removed. Gemini CLI has been replaced by Google's
Antigravity CLI, so the adapter targeted a tool that no longer ships.
`canonfig agent harness` now accepts `codex`, `claude` and `custom`.

`codex` and `claude` take an optional `--model <name>`, which Canonfig passes as
the CLI's own `--model` flag; leave it out to use the agent's default. Their
read-only flags stay fixed, so they do not accept free-form arguments.

`custom` runs any agent executable with exactly the arguments given by repeated
`--argument` options, without a shell. Canonfig writes the Agent Task as a
`canonfig.agent-task/v1` JSON document to its standard input and reads a
proposal JSON object (`summary` and `actions`) from its standard output.
Canonfig cannot force a custom agent into a read-only mode; start it in its own
plan or read-only mode through its arguments. Every proposed action is still
checked against the configured allowlists, and output that is not a proposal is
refused. `--model` is rejected for `custom`.

A follower that stored a `gemini` harness is not converted. After the upgrade,
commands that read it, such as `canonfig status`, stop with "the gemini agent
harness was removed in 5.0.0" (exit 2). Run `canonfig agent harness codex`,
`claude` or `custom` with the executable and allowlist options it needs to
replace the stored harness, then continue the upgrade checks.

## Opt-in patch self-updates

`canonfig self-update enable|disable|status|check|apply|auto` installs stable
patch releases in the current major.minor line for user-owned global npm
installations. Commands that change anything preview unless given `--apply`.
Candidates are staged with lifecycle scripts disabled and checked before
activation, and the previous package is kept as a backup. Active Canonfig
commands defer activation; unfinished synchronization runs stop it.
Self-update never crosses a major or minor version, installs no OS service and
does not restart services. Read `docs/self-update.md` before enabling it: stop
existing Canonfig processes and schedules first.

## Documentation site and interface demo

The documentation moved to https://canonfig.micr.dev/docs. Links to the
previous documentation pages redirect to the same page under `/docs`.
https://canonfig.micr.dev now serves an interactive demo of the upcoming
browser interface. It runs on simulated data and is not connected to a
machine; this release does not ship a `canonfig ui` command.

## Upgrade boundaries

State and signed-revision formats are unchanged, so 4.x installations update
in place. The major.minor handshake rejects mixed 4.x/5.0 fleets. Pause
synchronization, upgrade the Source and all followers to 5.0.0, restart the
Source with its prior settings, replace any stored `gemini` harness, and verify
before resuming. Finish unfinished runs with their original build and retain
backups. In-place migration from 3.2.x remains unsupported.

## Verification

Publication is gated on repository validation, packed CLI checks and native
Linux/macOS/Windows x64 and Windows ARM64 acceptance. Verify the published npm
artifact, provenance and matching GitHub tag after publication. Release
preparation alone does not assert that publication succeeded.
