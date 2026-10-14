# Doctor readiness evidence

`doctor` now diagnoses the saved Source endpoint, TLS pin, and credential reference
of an enrolled Follower Machine. Environment hints remain a fallback only before
enrollment; they cannot silently replace its selected authority.

On macOS the credentials evidence no longer stops at provider presence. The
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

A requested but absent, disabled, or drifted native job is a verification failure,
not a pass. A current job proves only its installed definition; the result marks
scheduled execution unverified. An intentionally unscheduled follower remains
skipped. Run a separately approved native scheduled execution before claiming
unattended setup complete.

This diagnosis does not automatically unlock a keychain, weaken permissions,
provision a headless secret service, or configure a GUI session. Those operations
have distinct authorization and lifecycle requirements. No unknown state is
converted into a success merely to make an installation appear complete.
