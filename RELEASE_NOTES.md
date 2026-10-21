# Canonfig v4.0.2

4.0.2 corrects enrollment concurrency, resource ownership handovers, scheduler
readiness and Homebrew installer binding paths. Node.js 24 or newer is required.
The state schema and signed-revision format are unchanged; Sources and followers
remain compatible on the 4.0.x line.

## Enrollment survives other Source commands

Pending follower enrollment is no longer canceled when another Source command
constructs its runtime. Recovery of abandoned preparations belongs to the
exclusive serving process. A competing server for the same state database is
refused before it can cancel an in-progress enrollment. Server shutdown and
failed startup release their lease; process-birth identity distinguishes a stale
lease from a recycled PID. A real restart still invalidates unfinished prepares
and permits a safe retry with the invitation. Fixes #148.

## Safe ownership handovers

Renaming an unmodified managed file, moving it into a directory resource, or
renaming a managed directory no longer rejects a valid published profile because
its old ownership record overlaps the replacement. Owned removal precedes the
replacement, including when the new content is identical. Machine-resolved path
aliases and Windows case rules are used consistently, while invalid authored
path syntax remains rejected.

Interrupted handovers and interrupted rollback preserve validated successor
writes. Distinct later local edits still block recovery rather than being erased.
Unrelated files remain untouched. Locally modified resources, partial-content
policies such as merge/append-local, and directory-to-file transitions that would
risk retained content require explicit human review. Fixes #150.

## Scheduler readiness and repair

Status inspects the installed scheduler runtime and entrypoint files instead of
assuming a binding with the same calendar can still launch. Deleted or unreadable
bindings fail readiness. File availability is not proof of unattended execution.
Repair guidance requires a manual action from the current installation and
preserves a usable desired custom executable. If the selected custom executable
is also unavailable, restore it or use the shown calendar-preserving command to
clear that custom choice. Fixes #155.

## Homebrew installer paths

New installer bindings retain a verified Homebrew `opt/<formula>` path for both
the runtime and its JavaScript entrypoint, instead of a versioned Cellar path
that an upgrade removes. An absent or unrelated opt link keeps the canonical
path. Existing binding files are not migrated automatically: rebind using the
current executable and entrypoint, then run the installer check. Fixes #157.

## Publication verification

Public-registry visibility and fresh-install verification run separately from
publication. Delayed registry visibility can be retried without republishing an
accepted version. Verification isolates npm registry configuration and credentials.

## Upgrade safely

Finish or recover an open synchronization run using the build that created it
before upgrading. Back up state and retain the old installation until verified.
After a 4.0.x Source upgrade, restart the existing serving process with its current
host, port and environment; an already-running process keeps the old code.
On an enrolled follower, inspect `canonfig sync --plan` before applying changes.

An in-place migration from 3.2.x remains unsupported and unverified. Preserve that
installation and follow the separate-setup upgrade guide instead.
