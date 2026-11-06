# Opt-in self-updates

Canonfig can check for and activate **stable patch releases in its current
major.minor line**. A 6.1.x installation never moves to 6.2 or 7.x on its
own. Source/follower major.minor compatibility still requires a coordinated fleet
rollout for those releases. This is independent of skill and configuration sync.

## Supported installations and first enable

Use a user-owned global npm prefix under your own home, with Node.js 24+ and the
official npm CLI installed. System-wide/admin prefixes, project installs,
checkouts, Homebrew-managed packages and other package managers are unsupported.
The updater never elevates permissions. It only updates `@microck/canonfig` from
the official npm registry, not Node, npm or other registered CLIs. Registry
operations override the package scope registry, ignore project/user/global npmrc
configuration, and strip inherited npm configuration/authentication environment
variables and Node injection options. Private registries are not supported.

**Before enabling for the first time, stop every existing Canonfig process and
pause its schedules.** If you enable from the browser interface, leave only that
`canonfig ui` process running. Processes started before opt-in hold no update lease.
Find the actual npm `bin/npm-cli.js` for your Node installation; do not substitute
an npm shell shim. Paths below are examples, not discoveries of your machine.

```sh
canonfig self-update enable --npm-cli /home/me/.local/lib/node_modules/npm/bin/npm-cli.js
canonfig self-update enable --npm-cli /home/me/.local/lib/node_modules/npm/bin/npm-cli.js --apply --confirm-idle
canonfig self-update status
```

`--apply` permits opt-in configuration; `--confirm-idle` acknowledges that existing
processes and schedules were stopped. Enable does not install a background
service. After enabling, ordinary Canonfig commands register leases, including
Sources and foreground watchers. Restart the services you stopped under this
opted-in installation so they participate. Failed processes can leave leases.
Under the coordination gate, the next command or updater removes a reader only
when the OS confirms its PID no longer exists. Live or reused PIDs, inaccessible
processes and malformed leases remain blockers; elapsed time never proves staleness.

## Check, apply and automate

```sh
canonfig self-update check
canonfig self-update apply
canonfig self-update apply --apply
canonfig self-update auto --apply --once
canonfig self-update auto --apply --interval 86400
```

Check and an apply without `--apply` are previews. They require opt-in settings
so the npm executable and installation prefix are already established. Automatic
mode polls in the foreground (24 hours default; 60 seconds to seven days), or
runs once for an **explicitly operator-managed scheduler**. It installs eligible
patches only when idle. Active commands defer a pass. Unfinished synchronization
runs, unknown/unreadable state, invalid settings and update errors stop the
worker. Finish or recover unfinished runs using their original build first.

A continuously running Source or watcher deliberately defers self-updates: stop
it for a maintenance window. This feature does not automatically kill/restart
services or orchestrate fleet maintenance. Stop other package managers and
external installation writers too; they do not participate in Canonfig's locks.

After successful activation the updater exits. Restart it under the new build,
or let your external scheduler invoke `auto --apply --once` again. Existing
scheduled follower bindings may need refreshing with the normal `sync --apply`.
No credentials, enrollment or user configuration are migrated by the updater.
If the Node executable path, the installation path or the major.minor line changes, review and
explicitly disable/re-enable the configuration rather than reusing stale intent.

## Update from the browser

Open the Canonfig version page in `canonfig ui`. The same installation limits,
patch-only policy and recovery rules apply as in the terminal.

1. Stop all other Canonfig processes and pause schedules before first enable.
   Enter the absolute path to npm's `bin/npm-cli.js` and confirm that the other
   processes are idle. The GUI joins update coordination when enable succeeds.
2. Check for an eligible patch, then apply it. The page reports the updater's
   checking, staging, verifying, activating and complete phases, with the selected
   version once known.
3. After a successful update, run `canonfig ui` again in your terminal and open
   its new launch URL. The old server delivers the result before it exits and
   frees its port. It does not restart itself or other services.

You do not need to stop this GUI to enable, disable or apply updates from its
version page. It temporarily releases only its own command lease. Another GUI,
Source, watcher or command still defers apply and prevents disable. Finish or
stop those processes, then retry. Deferred apply leaves the server running and
shows the CLI's detail as a successful deferred result, with exit code 0.

Disable retains backups and receipts. Failed operations show the CLI's exact
message and Human Action Required exit code 3. In particular, an unfinished sync
or pending update still requires recovery; the GUI does not bypass it. Stop the
GUI before using a separate terminal to apply or disable updates.

## Staging, safety and recovery

The updater installs the exact patch in a separate staging prefix with lifecycle
scripts disabled and nested dependencies. npm performs registry integrity checks.
The staged package must identify as `@microck/canonfig` at the selected version,
resolve its declared dependencies inside its package tree, and pass version/help
smokes before activation. No model or authenticated harness call is made.

A coordination gate blocks new participating commands during staging/activation.
Before switching packages, the updater checks again for unfinished runs and
installation changes, writes a flushed pending journal, then moves the old
package to a retained backup and moves the candidate into its place. The existing
npm command shim still targets the same package path. These two renames are **not
one crash-atomic operation**. A crash or failed rename can leave the CLI unavailable
until recovery; old package backups are never automatically removed.

Updater settings, leases, staging trees, backups and receipts live in the private
`.canonfig-self-update` sibling of the installed `canonfig` package directory,
not in a published profile. Preserve them as local operational data. Successful
transactions retain `last-transaction.json`; incomplete ones retain `pending.json`.
Do not copy this state between machines or blindly clear a gate/lease.

For an interrupted update, stop all Canonfig/updater/package-manager processes.
Inspect the pending journal and preserve both old and candidate trees. **Check
whether the recorded backup exists before attempting any restore.** The journal
is created before the first rename:

- If the backup is absent, do not remove or replace the installed package. Verify
  its package.json version matches `previous` in the journal and inspect its files.
  A mismatch or missing installation requires investigation, not a guessed restore.
- If the backup exists, preserve any current candidate separately and restore the
  backup to the recorded canonical package path. Check its package.json version
  against `previous` and inspect the restored files.

Only after that inspection may you remove the pending journal and confirmed-stale
gate/readers with all writers stopped. Then verify the CLI version before
resuming. Ordinary CLI commands deliberately refuse to run while a pending
transaction remains. If unsure, keep the installation stopped and seek a reviewed
manual restore. Do not run npm over an unfinished transaction.
No automatic rollback or stale-gate takeover is claimed. Only reader leases with
confirmed-absent PIDs are reclaimed automatically. POSIX directory entries are
flushed; Windows directory-entry power-loss durability is not claimed.

Disable only while idle, retaining backups and receipts:

```sh
canonfig self-update disable
canonfig self-update disable --apply
```
