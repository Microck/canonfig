# Canonfig v6.0.0

Canonfig now uses one global `~/.canonfig/` folder as the source for the
configuration it projects into supported AI harnesses. Node.js 24 or newer is
required.

## Breaking upgrade

Version 6 changes the configuration and state model. State from earlier
versions is not migrated and requires reinitialization. Pause synchronization,
back up your existing configuration and state, then set up the Source and
followers again before resuming. Source and followers must run the same
major.minor release line: 6.0.x does not sync with 5.0.x.

Repository-level harness projects, hand-written profiles and arbitrary
file/config targets, overlays, append-local, profile selection and the
previous profile-file and proposal flows have been removed. Review the
[upgrade documentation](https://canonfig.micr.dev/docs/) and your existing
automation before replacing the package.

## One canonical folder

`canonfig.jsonc`, `AGENTS.md`, and the `rules/`, `skills/`, `agents/`,
`commands/` and `hooks/` folders define the canonical setup. Setup can detect
installed harnesses and offer a reviewed import. Publishing compiles the
folder into a signed revision; followers synchronize it and project the
configuration into selected harnesses. Machine-local additions remain in
`~/.canonfig/local/`.

## Takeover and recovery

Before first taking over a harness, Canonfig snapshots the surfaces it owns.
The first snapshot and four most recent are retained, and `canonfig restore`
can restore a snapshot. Backups can be disabled per machine. Credentials,
sessions and history are outside the managed configuration.

## Verification

The release workflow validates the candidate on Linux, macOS, Windows x64 and
Windows ARM64, publishes to npm with provenance, creates the matching tag and
GitHub release, and verifies the published package. Publication and
installation on individual machines are separate steps.
