# Doctor readiness evidence

`doctor` now diagnoses the saved Source endpoint, TLS pin, and credential reference
of an enrolled Follower Machine. Environment hints remain a fallback only before
enrollment; they cannot silently replace its selected authority.

On macOS the credentials evidence no longer stops at provider presence. The
machine capability runs a disposable add/read-back/delete probe of a non-secret
sentinel in a unique `dev.canonfig.session-probe.<uuid>` namespace under its own
account, transported over stdin as hex, and reports
`secure-noninteractive/keychain` with evidence `session-probe` only after the
full lifecycle succeeds in the very session that will write credentials. The
probe item is always deleted, including after a partial failure, and existing
credentials are never read, modified, or deleted. A provider that is merely
installed still reports the warning labelled `provider-presence`.

## The gui/<uid> LaunchAgent session model

SSH and other background sessions cannot use the login Keychain: every write
fails with "User interaction is not allowed", and unlocking the Keychain from a
Terminal session does not transfer that ability. The supported unattended
context on macOS is a per-user LaunchAgent loaded into the logged-in graphical
user domain:

```bash
launchctl bootstrap gui/$(id -u) dev.canonfig.plist
```

A job running in that `gui/<uid>` domain shares the graphical session's
Keychain access, so scheduled enrollment and credential writes succeed without
user interaction and without weakening Keychain controls. `launchctl asuser` is
not a reliable SSH-to-GUI-session trampoline. When the probe fails because the
session cannot use the Keychain, doctor says so and points at the graphical
session or its `gui/<uid>` LaunchAgent instead of suggesting a Keychain unlock.
Logged-out and post-reboot pre-login operation is not verified.

A requested but absent, disabled, or drifted native job is a verification failure,
not a pass. A current job proves only its installed definition; the result marks
scheduled execution unverified. An intentionally unscheduled follower remains
skipped. Run a separately approved native scheduled execution before claiming
unattended setup complete.

This diagnosis does not automatically unlock a keychain, weaken permissions,
provision a headless secret service, or configure a GUI session. Those operations
have distinct authorization and lifecycle requirements. No unknown state is
converted into a success merely to make an installation appear complete.
