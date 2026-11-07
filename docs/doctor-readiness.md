# Doctor readiness evidence

`doctor` diagnoses the saved Source endpoint, TLS pin, and credential reference
of an enrolled Follower Machine. Environment hints remain a fallback only before
enrollment; they cannot silently replace its selected authority.

`doctor` runs eight probes (`doctorProbeNames` in `src/runtime/doctor.ts`):
`runtime`, `state`, `credentials`, `source`, `scheduler`, `package-managers`,
`agent-adapter` and `harnesses`. The `harnesses` probe prints the same report
as `canonfig harnesses`: the folder's list, local exclusions, detected
harnesses, pinned roots and takeover snapshots. It is skipped while
`~/.canonfig/canonfig.jsonc` does not exist, and warns
`listed but not installed: <harnesses>` when a listed harness is missing; the
run still converges without it.

On macOS the credentials evidence goes beyond provider presence: the
machine capability runs a disposable add/read-back/delete probe of a non-secret
sentinel in a unique `dev.canonfig.session-probe.<uuid>` namespace under its own
account. The sentinel is passed to `security add-generic-password` as its
`-w <sentinel>` argument; it is a fixed non-secret marker, so argv exposure is
harmless, and real credential values never take this path. The capability
reports `secure-noninteractive/keychain` with evidence `session-probe` only
after the full lifecycle succeeds in the very session that will write
credentials. The probe item is always deleted, including after a partial
failure, and existing credentials are never read, modified, or deleted. A
provider that is merely installed still reports the warning labelled
`provider-presence`.

## Keychain access per macOS session

The login Keychain is unlocked per security session. The logged-in desktop
(Aqua) session unlocks it at login, and a per-user LaunchAgent loaded into the
`gui/<uid>` domain shares that unlock. That is how the scheduled job runs:

```bash
launchctl print gui/$(id -u)/dev.canonfig.canonfig-sync
```

An SSH session starts with the login Keychain locked, so Keychain writes and
reads fail with "User interaction is not allowed" (exit 36). It is not
impossible to use the Keychain over SSH: unlocking it inside that SSH session
works for the rest of that session.

```bash
security unlock-keychain ~/Library/Keychains/login.keychain-db
canonfig doctor --no-input
```

`security unlock-keychain` prompts for the login password. The unlock does not
carry over to a new SSH session, to the desktop session, or to scheduled runs.
Scheduled synchronization needs a user logged in to the desktop with the login
Keychain unlocked; with nobody logged in, the `gui/<uid>` domain does not exist
and the job does not fire. When the probe fails because the session's Keychain
is locked, doctor says so and gives this recovery text.

A requested but absent, disabled, or calendar-drifted native job is a verification
failure, not a pass. Binding-only drift is advisory only when the installed
runtime and entrypoint files remain available. A deleted runtime or unreadable
entrypoint fails readiness even if the calendar still matches. For POSIX wrappers,
readiness also inspects a bounded shebang interpreter chain; an `env` interpreter
is resolved only in the installed native job's PATH, not the interactive shell's.
Unknown interpreter syntax, Windows command scripts, or missing native PATH evidence
remain unverified and produce a warning, never a readiness pass. Definite missing
files or incompatible native executable images fail readiness. For a normal binding, manually run `canonfig sync --apply` from the current
installation. For a deleted custom executable, use the concrete
`canonfig schedule set <calendar>` command shown by status, without
`--executable`, to preserve the chosen calendar and clear the stale custom path.
`sync --apply` alone reuses a persisted custom executable and cannot repair it.
An unlaunchable job cannot repair itself. A current job proves only its installed definition; the result marks
scheduled execution unverified. An intentionally unscheduled follower remains
skipped. Run a separately approved native scheduled execution before claiming
unattended setup complete.

This diagnosis does not automatically unlock a keychain, weaken permissions,
provision a headless secret service, or configure a GUI session. Those operations
have distinct authorization and lifecycle requirements. No unknown state is
converted into a success merely to make an installation appear complete.

Scheduled-fire evidence is scoped to the observed native installation. POSIX
backends fingerprint unit/plist file identity and content; Windows fingerprints
the exported task including its registration date. The scheduled process records
that identity once at start and retains it on completion/failure. Reinstallation
(including identical POSIX content), definition changes, records without a bound identity,
and processes started before registration do not prove the current job fired.
Historical records remain stored but do not count as current readiness.

Migration `0004_enrollment_lifecycle` stores each unattended invocation in SQLite
as `Running`, `Completed` or `Failed`, with an invocation id and its start time.
Only that running invocation can accept its terminal result. Overlapping starts
cannot overwrite each other, and readiness uses the latest start, not whichever
completion arrived last. A `Running` receipt without a terminal result remains
unverified, whether its process is still running or was interrupted.

Released `schedule-fires.json` files are imported once. Start times and installation
generations group their events into invocations, including terminal events whose
start was trimmed from the ten-event file. SQLite commits the imported invocations
and import acknowledgement in one transaction, then archives the file as
`schedule-fires.json.imported`. A retry after an archive failure cannot import it twice.
Malformed files, missing start times, conflicting terminal events, or changed files
after an acknowledged import are refused with recovery instructions. Move only
those refused files aside and let the native scheduler run again.
