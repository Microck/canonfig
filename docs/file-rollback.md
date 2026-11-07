# File rollback

Canonfig must save the original bytes before it changes an owned file. File
size must not determine whether replacement, removal, or recovery can succeed.
The 16 MiB execution limit still applies to text parsing, not to binary
rollback.

## Storage and ordering

- Every regular-file preimage is a private raw file beside its action journal.
  Its name is derived from the immutable action ID and normalized target path.
- The journal records object kinds, target paths, permission snapshots, and SHA-256 digests.
  It contains no encoded file bodies or caller-chosen backup paths.
- The journal also lists each ancestor of a target (or of a managed root)
  that did not exist at capture, as `created-parent`. Writing the target
  creates those directories. Rollback and recovery remove them deepest first,
  only while each holds nothing but Canonfig's own temporary entries, and stop
  at the first one that gained other content. A directory that existed before
  the run is never recorded, so it is never removed. Recovery also removes a
  staging directory an interrupted parent publication left in the nearest
  pre-existing ancestor. Loading rejects a `created-parent` path that is not an
  ancestor of the action's own target.
- A permission snapshot contains a POSIX mode on Linux and macOS. On Windows
  it contains the semantic mode and the native owner, group, and DACL security
  descriptor, including inheritance flags. Windows audit rules are not captured.
  Capture native permissions only for rollback, not during ordinary planning.
- Capture copies each file with bounded memory, checks its digest, and flushes
  it before publishing the journal. The executor records the journal reference
  before starting the target mutation.
- Recovery derives the allowed targets and backup names from the recorded
  action. It copies a regular preimage into a temporary sibling, checks its
  digest before replacement, and restores the captured permissions through the
  same guarded mutation. Windows checks the restored descriptor against the
  captured value. Failure retains the journal and preimages.
- Before restoring anything, recovery compares the current bytes of every
  snapshot target with both the pre-run content and the state the run intended
  to write. A target that matches neither was edited after the interruption:
  recovery stops with Human Action Required, names the file, and keeps both the
  file and its snapshot.
- Temporary siblings and guards use short fixed-length names
  (`.cf-<12hex>.tmp`, `.cf-<12hex>.guard`), so any valid target name up to 255
  bytes works. Recover and abandon remove only Canonfig's own temporary names
  inside managed roots.
- On Windows with long paths disabled, the run preflight (and `sync --plan`)
  rejects a target whose longest native path exceeds MAX_PATH before any run
  is recorded or any parent created. The measured path includes the staging
  directory and `content` file a write adds, the `:canonfig.mode` stream, and
  the guard directory of a managed-root mutation; new directories must also
  leave room for an 8.3 name (247 characters). The message names the limit
  and the `LongPathsEnabled` remedy. The limit is read from
  `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem` and is MAX_PATH when the
  value is missing or unreadable.
- Restore managed directories with writable modes while restoring their children.
  Restore exact directory permissions from the deepest directory up, root last.
- The same atomic-write path handles byte buffers and file sources. Native
  permission handling and managed-directory confinement apply to both.
  If an adapter isolates a directory by moving it, file sources inside that
  directory remain readable at their isolated location.
- An inverse is complete only after both filesystem restoration and the
  ownership-journal transaction succeed. A blocked inverse records whether
  the physical or ownership phase failed. The public rollback flags are
  computed from that state, never maintained separately.
- An incomplete rollback keeps all of the run's journals and preimages,
  including already-restored actions that recovery must inspect. Cleanup
  removes that per-run material only after recovery completes, or explicit
  abandonment. Every takeover reservation and original takeover snapshot also
  stays intact while recovery can replay its actions without taking over those
  surfaces again. Cleanup must not remove another action's or run's files.

Recovery covers process interruption. Flush guarantees remain those of the
platform adapter and filesystem; this does not promise identical power-loss
durability on every operating system.

## Takeover snapshots and the per-run journal

The per-run journal above protects one run: it holds what that run replaced
and is deleted when the run completes or rolls back. A Takeover Snapshot
protects the state before Canonfig ever owned a harness surface, and outlives
runs.

Projection of `~/.canonfig/` writes it before Canonfig first writes a harness
surface, outside the per-run journal: it copies the prior content to
`~/.canonfig/.backups/<UTC time>/` with a `manifest.json` (harness, root,
target, object kind, mode, symlink text, SHA-256, `absent` markers, run id).
Owned config keys keep only their prior values in `<harness>/keys.json`.
Snapshots are written through the protected writer (directories 0700, files
0600, Windows ACLs) before the run is recorded. A run that rolls back deletes
its snapshot; otherwise Canonfig keeps the first snapshot and the 4 most
recent. `sync --no-backup` or `"backups": false` in `local/local.jsonc` takes
over without a snapshot. Later runs rely on the per-run journal only.
`canonfig restore` writes a snapshot back as its own journaled run. See
[global-folder.md](global-folder.md) and `src/projection/takeover.ts`.

## Upgrade boundary

This is the only file-rollback format Canonfig reads. Before installing another
release, finish or recover any unfinished run with the CLI that created it. A
journal in any other format is rejected with a recovery diagnostic and is not
rewritten or deleted by a failed recovery attempt.

## Acceptance

The machine-state contract owns bounded file-source writes, digest checking
before replacement, and native permissions. Synchronization integration tests
own large-file update/removal, rollback after failure, persisted recovery, and
retention or cleanup of the complete snapshot.

## Basis

[Node.js filesystem documentation](https://nodejs.org/api/fs.html) states that
`copyFile` alone offers no atomicity guarantee. Copy into the existing private
temporary sibling and rename only after validation instead of copying over the
target. Use bounded reads and complete writes rather than whole-file buffers.

[SQLite's atomic commit design](https://www.sqlite.org/atomiccommit.html)
explains why original content must be recorded and flushed before mutation,
and why rollback material must remain until restoration or commit finishes.
Canonfig uses its action journal rather than a second transaction engine.

[Windows BackupWrite](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-backupwrite)
restores the native security stream with write-owner and write-DACL access.
Ordinary access-rule setters recalculate inheritance from the current parent,
which is not the original parent during a guarded mutation. Backup restoration
must preserve the captured descriptor instead. Canonfig does not enable account
privileges or request access to audit rules for this operation.

Increasing the memory cap retains whole-file allocations and base64 expansion.
Hard links are not backups of mutable files. Mandatory reflinks would restrict
filesystem support. None is the storage contract for this fix.
