# Private enrollment input

Use `canonfig follower enroll --stdin --name <name> --profile <id> [--replace]`
to deliver one invitation through a private pipe. The value is not placed in
process arguments, the process environment, or a Canonfig temporary file.
Enrollment accepts no other delivery: an invitation passed as a command
argument is refused, and that envelope must be treated as exposed, discarded,
and replaced by a fresh `source invite`.

The input is exactly the envelope file that `source invite --output` writes:
one base64url line, then the line `CANONFIG-INVITE-EOF`, each ending in a
newline. Pipe the file unchanged, for example
`cat ./canonfig-invite | canonfig follower enroll --stdin ...`. The producer
must close its output after writing. Canonfig limits input to 16 KiB
(16384 bytes, the envelope limit in `src/enrollment/invitation-envelope.ts`),
waits at most ten seconds for EOF, and never echoes input or includes it in an
error. Input over the limit fails with "Private enrollment input exceeds the
16384 byte limit"; a missing EOF marker or trailing garbage fails as incomplete.
Interactive terminals are rejected because ordinary terminal input can echo the
invitation. A missing name, profile, or unsupported option fails before reading.
`--help` and `--version` never wait for input.

`--stdin` decides only how the invitation arrives. Invitation schema validation,
expiry/replay rejection, TLS and signing pins, native credential storage, pending
enrollment, and explicit replacement policy belong to enrollment itself. No source
is contacted and no state layer is constructed for malformed invitation input.
The command logger captures the original `--stdin` invocation before input is
read; the resolved value is never assigned to `process.argv`.

Source initialization is create-only under the state database write lock. A
concurrent initializer cannot replace an initialized signing or TLS identity.
Credential relocation compares the existing identity and references in that same
transaction; a stale operation fails and removes only the new items it created.

Follower enrollment records `Finalizing`, `RetiringPrevious`, `RollbackPending`,
`Active` or `Unenrolling` in SQLite. Replacement keeps the previous identity,
Source identity and credential reference until retirement finishes. Retry the same
enroll command after interruption; an existing managed mirror is not treated as
authored content. Settings writes compare the configuration they read and cannot
recreate an enrollment removed by another command.

If the Source discards a prepared replacement, Canonfig authenticates the previous
credential before restoring its authority. An unreachable previous Source leaves
`RollbackPending`; `status` and `doctor` name that state and the retry command.
Both credentials remain owned and untouched until that check succeeds. Bring the
previous Source online and retry the same enroll command with its invitation.

Credential storage records ownership before writing bytes. Source cancellation,
replacement, revocation and restart recovery retain retirement references until
the credential store confirms deletion. A failed deletion remains retryable;
unlock or repair the credential store and retry the operation or start the Source.
Source inventory reports revoked credentials as unavailable, not as present
because a historical digest row remains.

Invitation states are `Available`, `Prepared`, `Consumed` or `Expired`. Re-prepare
compares the current reservation in the same SQL transaction that retires its
credential and installs its replacement. Expiry is evaluated at operation time.

Migration `0004_enrollment_lifecycle` upgrades released active configurations in
place. Released pending configurations cannot identify a superseded enrollment,
so they are refused with recovery instructions: revoke the identity on its Source,
move the Canonfig state directory aside, and enroll with a fresh invitation.
Retain the credential store until the old identity is revoked.

A private pipe does not authenticate its producer and does not grant approval to
enroll or replace an identity. Supply the value only after approving the Source,
Follower Identity, selected profile, and any separately granted secret authority.
Keep invitation payloads out of shell history, tool arguments, and chat.

Audit coverage: N05 (bounded EOF-safe invitation delivery), and prevention for
the invitation-argument portion of C09. This does not revoke previously exposed
credentials or repair an operator-managed SSH tunnel.
