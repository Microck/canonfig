# Canonfig v6.0.0

This major release replaces repo-level harness projects and the hand-written
profile with one global folder, `~/.canonfig/`. Node.js 24 or newer is required.

## Breaking: the global `~/.canonfig/` folder

`~/.canonfig/` holds `canonfig.jsonc`, `AGENTS.md`, `rules/`, `skills/`,
`agents/`, `commands/`, `hooks/` and `files/`. `canonfig sync` writes each
harness listed in `canonfig.jsonc` in that harness's own format. Canonfig
supports 16 harnesses, including Claude Code, Codex, Antigravity, Oh My Pi,
Pi, Amp, OpenCode and Cursor; see the harness reference for the full list. It
manages configuration only and never touches logins, tokens, sessions or
history.

On the Source Machine, `canonfig source publish --reviewer <name>` signs the
folder as a Profile Revision. Followers mirror it and write their harnesses in
one journaled run. Items for one machine only go in `~/.canonfig/local/`.

Before Canonfig first writes a harness file, it copies what was there to
`~/.canonfig/.backups/`. It keeps the first snapshot and the 4 most recent.
`canonfig restore` puts a snapshot back. `canonfig sync --no-backup`, or
`"backups": false` in `~/.canonfig/local/local.jsonc`, turns snapshots off on
that machine.

`canonfig setup` detects installed harnesses and selects them, and offers a
reviewed import of existing instructions, skills and MCP servers. Imported
literal secrets become `fromEnv` references.

New commands: `canonfig harnesses`, `canonfig harnesses include|exclude`,
`canonfig restore`, and a `harnesses` probe in `canonfig doctor`.

Removed: repo-level `canonfig harness` projects, the hand-written profile file
with `--profile-file`, `canonfig profile select`, `follower enroll --profile`,
`source digest`, `source reconcile-skills` and `setup --scope project-only`.

## Pick what each harness gets

`surfaces.<harness>` in `canonfig.jsonc` limits a harness to some categories:
`instructions`, `rules`, `skills`, `agents`, `commands`, `hooks`, `mcp` and
`settings`. A harness that `surfaces` does not name gets every category.
Outputs a harness stops getting are removed like those of an unlisted harness.
Canonfig refuses a `surfaces` entry for a harness that `harnesses` does not
list, and a category the harness cannot take. The shared `~/.agents/skills/`
directory is written when any harness that reads it gets `skills`.

## One role per machine

A machine is a Source or a Follower, never both. On an enrolled follower,
`source init`, `scan`, `publish`, `serve`, `service install`, `invite`,
`revoke` and `setup plan --role source` exit 2 before changing anything and
name the Source the machine follows; run `canonfig follower unenroll` first.
On a Source, `follower enroll` and `setup plan --role follower` exit 2 before
the invitation is used.

## Export and import

`canonfig export` writes the folder and `local/` to a private `.tar.gz`
(mode 0600) with a `manifest.json` listing the size, SHA-256 and mode of every
file. `state.sqlite`, backups, logs and credentials are never included, and a
literal credential in the folder stops the export. On a Source, the export is
signed with the Source signing key. `--include-harnesses` adds the harness
files Canonfig manages, but only while they still hold what Canonfig wrote.

`canonfig import <file>` checks every checksum and the signature, and refuses
links, devices, `..` paths and files outside the allowlist before it writes
anything. `--expect-key <fingerprint>` also refuses unsigned archives and
archives signed by another key. Import writes the folder as one journaled run,
so a failure rolls back and `canonfig recover` works. A folder that already
has content needs `--replace`, which first saves the replaced entries to
`~/.canonfig/.backups/`; `canonfig restore <id>` puts them back. Import is
refused on an enrolled follower and never writes harness files; run
`canonfig sync` afterwards.

## Keep a machine's own content

- append-local: with `local.appendLocal` in `canonfig.jsonc`, Canonfig owns
  only a marked section of each instructions file and only the skill
  directories it writes. The machine's own text and skills stay, and the first
  adoption keeps everything already there. `canonfig sync --plan
  --review-local` writes private reviews of the exact texts before you apply.
- `instructions` in `local.allow` lets `local/AGENTS.md` be appended to the
  published `AGENTS.md` in every harness.
- Local overlays: `canonfig overlay list|set|remove` lets an item in
  `local/` replace the published item of the same name. A key claim,
  `settings/<harness>#<key>`, keeps one settings key on this machine while the
  other keys still follow the Source.
- Authored resources: `resources.<id>` in `canonfig.jsonc` with content under
  `files/` manages a `file`, a `directory` or keys in a `config` file outside
  the harnesses. Resources publish, honor follower groups, get takeover
  snapshots, drift checks and restore, and may not target harness folders,
  `~/.agents`, `~/.canonfig` or protected files such as `~/.codex/auth.json`.

## Interface demo

The demo at https://canonfig.micr.dev adds a per-harness "Gets" menu, skill
upstream tracking and update checks, a Canonfig version page for self-update,
an import step in setup that lists what each item loses on import, and export
buttons. The demo runs on simulated data. This release does not ship a
`canonfig ui` command.

## Upgrade boundaries

There is no in-place upgrade from 5.x. Canonfig 6.0.0 refuses state from an
earlier release before writing anything ("Canonfig state at `<path>` was
created by an earlier Canonfig version", exit 3). On each machine, move
`~/.canonfig/state.sqlite` aside and set the machine up again: run
`canonfig setup plan` on the Source, then enroll each follower with a new
invitation. Every Source and Follower must run the same major.minor release;
a mismatch fails with "source/follower version mismatch" (exit 2), so move
every machine to 6.0.0.

## Verification

Publication is gated on repository validation, packed CLI checks and native
Linux/macOS/Windows x64 and Windows ARM64 acceptance. Verify the published npm
artifact, provenance and matching GitHub tag after publication. Release
preparation alone does not assert that publication succeeded.
