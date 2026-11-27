# Doctor readiness evidence

`doctor` diagnoses the saved Source endpoint, TLS pin, and credential reference
of an enrolled Follower Machine. Environment hints remain a fallback only before
enrollment; they cannot silently replace its selected authority.

`doctor` runs eleven probes (`doctorProbeNames` in `src/runtime/doctor.ts`):
`runtime`, `state`, `credentials`, `source`, `scheduler`, `package-managers`,
`agent-adapter`, `harnesses`, `mcp`, `mcp-config` and `tailscale`. The `harnesses` probe prints the same report
as `canonfig harnesses`: the folder's list, local exclusions, detected
harnesses, pinned roots and takeover snapshots. It is skipped while
`~/.canonfig/canonfig.jsonc` does not exist, and warns
`listed but not installed: <harnesses>` when a listed harness is missing; the
run still converges without it.

The `mcp-config` probe checks `~/.canonfig/canonfig.jsonc` and
`~/.canonfig/local/local.jsonc` without launching servers. It reports
non-blocking warnings for active `preserveMcp` locks, local overlays that
disable published cross-platform MCP servers or reference paths for another OS,
local overlays that drop `fromSecret` bindings or embed plaintext tokens
(without echoing token values), and enabled stdio MCP commands whose executable
path is missing locally or whose bare command is neither on `PATH` nor backed
by a `tools` recipe or `requires` entry. `canonfig sync --plan` reports the
same diagnostics.

The `mcp` probe checks enabled servers in installed harnesses' native
configuration, including preserved and hand-written entries. It requires
`initialize` to succeed and calls `tools/list` when the server advertises the
tools capability. It checks one harness's servers concurrently before moving
to the next harness. Codex stdio servers get Codex's environment, including
case-insensitive variable names and native command resolution on Windows. A
configured startup timeout is capped at 120 seconds. Other servers get 10
seconds, or `--timeout-ms` when that is longer.

Streamable HTTP and HTTP+SSE checks also verify replies to server pings.
HTTP+SSE sends messages to the endpoint advertised by the event stream on the
same origin. Streamable HTTP allows up to two seconds to close an opened
session and reports cleanup failures in its detail. The report lists each
server and the harnesses that declare it. Servers that require the harness's
OAuth sign-in are reported as unchecked.

After the probes, an enrolled Follower sends its report to the Source and a
Source records its own (`sourceReport` in the output says which, or why
sending failed). The Source keeps each machine's latest report in
one file per machine under `state.sqlite.machine-health/`, so
reports never wait on each other, and shows it under Health in each machine's
details on the Machines page.

On macOS the credentials evidence goes beyond provider presence: the
machine capability runs a disposable add/read-back/delete probe of a non-secret
sentinel in a unique `dev.canonfig.session-probe.<uuid>` namespace under its own
account. The sentinel is passed to `security add-generic-password` as its
`-w <sentinel>` argument; it is a fixed non-secret marker, so argv exposure is
harmless, and real credential values never take this path. The capability
reports `secure-noninteractive/keychain` with evidence `session-probe` only
after the full lifecycle succeeds in the very session that will write
credentials. The probe item is always deleted, including after a partial
failure, and existing credentials are never read, modified, or deleted.

On Linux (Secret Service) and Windows (Credential Manager) the capability only
reports presence, so the `credentials` probe itself stores a fixed non-secret
value under a unique `canonfig-probe:<uuid>` name, reads it back, and deletes
it, through the same calls that store real credentials. Success reports
`session-probe`; any failed step reports the warning `session-probe-failed`
with the recovery as its message and the provider's error in `details.reason`.

On Linux, `canonfig secrets bootstrap` can also save a separate test
credential for a restart-persistence check. After a natural Secret Service
restart or the next login, run `canonfig doctor` in the same keyring session.
Doctor reads and removes that saved test credential and reports the outcome
under `restartPersistence`. If the provider has not restarted or the keyring
cannot be verified, the check remains manual. If Doctor establishes that the
restarted provider lost the credential, the credentials probe reports Human
Action Required even if the current session can store a new credential.

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

Each unattended invocation is stored in SQLite as `Running`, `Completed` or
`Failed`, with an invocation id and its start time.
Only that running invocation can accept its terminal result. Overlapping starts
cannot overwrite each other, and readiness uses the latest start, not whichever
completion arrived last. A `Running` receipt without a terminal result remains
unverified, whether its process is still running or was interrupted.
