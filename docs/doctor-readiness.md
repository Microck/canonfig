# Doctor readiness evidence

`doctor` now diagnoses the saved Source endpoint, TLS pin, and credential reference
of an enrolled Follower Machine. Environment hints remain a fallback only before
enrollment; they cannot silently replace its selected authority.

A native provider executable is not proof that the current SSH, GUI, or scheduler
session can use its vault. The credentials probe therefore reports a warning and
labels its evidence `provider-presence`, even when the legacy machine capability
is named `secure-noninteractive`. It performs no test writes, creates no keychain
items, and makes no changes to credential access controls. A successful Source
probe independently demonstrates a usable saved read credential in the current
process, not write permission or logged-out/reboot persistence.

A requested but absent, disabled, or drifted native job is a verification failure,
not a pass. A current job proves only its installed definition; the result marks
scheduled execution unverified. An intentionally unscheduled follower remains
skipped. Run a separately approved native scheduled execution before claiming
unattended setup complete.

This diagnosis does not automatically unlock a keychain, weaken permissions,
provision a headless secret service, or configure a GUI session. Those operations
have distinct authorization and lifecycle requirements. No unknown state is
converted into a success merely to make an installation appear complete.
