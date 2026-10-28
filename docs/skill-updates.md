# Update installed skills from upstream

`canonfig skills` tracks where an installed skill came from and updates that
skill's complete directory from a chosen Git branch, tag or commit. This is not
a Canonfig self-updater, an automatic skill marketplace, or Follower Machine
synchronization. It never runs a skill, installation script, Git hook or checkout
filter, and never invokes another skill-manager CLI.

## Register, preview and update

Start with an existing skill that exactly matches a known upstream revision:

```sh
canonfig skills track --name review --path .canonfig/skills/review --source https://github.com/example/skills.git --ref main --subdir skills/review
canonfig skills list
canonfig skills check --name review
canonfig skills update --name review
canonfig skills update --name review --apply
```

The example source URL is a placeholder; select the actual repository and
subdirectory that supplied your skill. Registration verifies all files, not
only `SKILL.md`. It refuses to invent a baseline for a locally modified copy.
Use its original commit/ref to register an unchanged older installation, then
change the tracked ref in the configuration if you want to follow a branch.
Do not discard local edits to make tracking succeed.

`check` and `update` without `--apply` are read-only with respect to installed
skills and source configuration. They fetch temporary Git objects and report
added, modified and deleted filenames. `--dry-run` makes the preview explicit.
`--apply` and `--dry-run` are mutually exclusive. No `--force` option exists.
`--name` is repeatable; omitting it selects every tracked skill. Unknown names
are errors, not silent no-ops. `--json` emits the standard CLI envelope, with
filenames and commit IDs, never skill contents or remote error output.

## Configuration and scope

The default source configuration is `.canonfig/skills-sources.json`, relative
to `--root` (default: the current working directory). It is deliberately
separate from harness-generated-file ownership and signed Machine Profiles.

Use `--config settings/skill-sources.json` for another root-relative file.
Installed paths are also root-relative, so canonical `.canonfig/skills`,
project `.agents/skills`, or another explicit directory can be tracked. For
user-scoped skills, explicitly set `--root` to your home directory and select a
configuration and installed path beneath it. There is no implicit scan of home
directories or credential stores. Do not track generated projections when their
canonical source is available: update the source, then run `harness plan/apply`.
For Source/Follower synchronization, update and review on the Source Machine,
then publish a new profile; do not independently update follower-owned copies.

The version-1 configuration contains a `skills` array. Each entry has:

- `name`: unique selection identifier.
- `path`: installed skill directory under the selected root.
- `source`: HTTPS Git repository URL or explicit local Git repository path.
- `ref`: branch, tag or commit to follow; no implicit `main` assumption.
- `subdir`: exact upstream skill directory (`.` for repository root).
- `commit`: immutable commit resolved by the last successful tracking/update.
- `digest`: hash of the installed baseline's paths, contents and executable bits.

Edit `source`, `ref` or `subdir` deliberately to change an upstream selection.
Keep `commit` and `digest` as the recorded baseline; do not fabricate them to
suppress local-edit protection. Back up this configuration alongside the skill.
A pinned commit remains pinned. Updates compare the entire selected directory,
including binary assets, references and deletions. Missing or renamed upstream
skills fail rather than selecting a different same-named directory. Malformed
configuration fails closed and is never silently replaced with an empty lock.

Only public HTTPS Git sources and local Git repositories are supported in this
version. Credential helpers, ambient Git configuration and interactive login
are disabled. Explicit HTTP(S)/ALL_PROXY and NO_PROXY environment settings
are passed through for network routing; their values are never printed.
Private/SSH sources, package registries, automatic migration of
other managers' lockfiles, and three-way merging are not implemented. Git must
be installed. Each Git subprocess has a 120-second timeout. Each selected skill
is limited to 10,000 files and 64 MiB. Symlinks, submodules, path traversal and
case-colliding filenames are refused. On Windows, executable-bit comparisons
are omitted because the filesystem does not expose the POSIX bit contract.

## Local changes and recovery

Any local difference from the recorded baseline, including an added/deleted
file, blocks the entire selected update. Canonfig does not stash or overwrite
it. Review the preview, reconcile or back up your changes, and track a matching
revision when appropriate. An upstream ref changing without a skill-content
change does not rewrite the installation or baseline.

Updates fetch and stage every changed skill before replacing any installation.
Existing regular-file read/write permissions are retained; newly added files
and directories are owner-only where POSIX permissions are available.
A source-configuration lock prevents concurrent Canonfig writers. The installed
baseline and source configuration are checked again before commit. Synchronous
failures roll back replaced directories; failure to safely roll back preserves
backups and stops for manual recovery.

A crash can leave a sibling `.canonfig-backup-<id>` directory, a staged directory,
a `<config>.pending` journal and/or a `<config>.lock`. Do not delete them blindly.
The journal records previous configuration, expected updated digests and
backup/staging paths relative to the selected root. Stop any active updater and
inspect the installed trees and configuration together. A journal can remain
after a completed commit if its cleanup failed: verify the updated digests and
configuration before clearing that journal. For a partial update, preserve any
newer local edits and restore previous skill directories and configuration
together. Only after recovery is verified should the stale journal/lock be
removed. Best-effort staging/backup cleanup can leave marked directories without
changing the transaction result; journal-removal failures are reported rather
than hidden. Canonfig refuses another write while a journal
exists; this version does not automatically replay interrupted transactions.

## Research and design

Issue #105 asks for an upstream skill updater, confirmed as updating installed
skills while preserving local edits. Agent Skills are directory packages, not
just a `SKILL.md` file. The [Agent Skills specification](https://agentskills.io/specification)
therefore informs full-tree transfer and binary support. The
[Vercel skills source](https://github.com/vercel-labs/skills/tree/a80e4c9d12d607631249d4d7d059f835d4b2f13a/src)
illustrates separate project/global provenance, exact subpaths and ref-aware
updates. Canonfig does not import or rewrite those lock formats: its own explicit
source records add fail-closed local-baseline checks and no-script Git-object
fetching, without changing the existing Machine Profile contract.

## Automatic upstream updates

This is separate from the Follower synchronization schedule. Opt into a Source
Machine (or standalone local) worker for already tracked skill sources:

```sh
canonfig skills auto --root /path/to/source
canonfig skills auto --root /path/to/source --name review --apply --interval 86400
canonfig skills auto --root /path/to/source --name review --apply --once --no-input
```

Without `--apply`, `auto` previews one pass and exits; it never schedules writes.
With `--apply` it runs immediately, then waits after each completed pass (default
24 hours, whole seconds from 60 through 604800). Passes do not overlap. `--once`
runs only one pass for an explicitly configured cron/systemd/launchd/Task
Scheduler job. Canonfig does not install or modify a native job for this command;
use an absolute runtime/entrypoint, `--root`, and a PATH containing Git. Do not
reuse the Follower's existing `canonfig schedule` job for upstream updates.

Only the sources selected at worker startup are followed. New registrations do
not join a running worker. Editing a selected repository, ref, path or subdirectory
stops it for review; restart after deliberately approving the new selection.
The same source identity check runs inside the updater's configuration lock.
Updater-owned commit/digest changes are allowed between passes. A commit-pinned
source remains pinned. One-shot scheduler invocations select the configuration
current at their own startup, so keep that file under the operator's control.

The existing full-tree local-edit checks, staging, rollback and recovery journal
remain in force. Any conflict, fetch failure or recovery condition exits nonzero;
there is no force flag or automatic retry loop over unsafe state. Inspect the
reported problem before restarting or allowing an external scheduler to retry.
Stop with Ctrl+C/SIGTERM; a killed in-progress transaction may require the same
journal recovery described above. JSON mode emits one CLI envelope per completed
pass (a JSON stream), not one indefinitely growing array. If no pass runs (for
example, no skills are tracked or the signal is already aborted), it emits one
`skills.auto` envelope with a message, exit code 0 and no `data` field.

Automatic upstream updates never publish a Machine Profile, apply harness
projections, enroll a Follower, or run skill scripts. Review resulting changes
on the Source Machine and publish separately. Do not point this worker at
Follower-owned or generated skill copies.
