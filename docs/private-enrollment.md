# Private enrollment input

Use `canonfig follower enroll --stdin --name <name> --profile <id> [--replace]`
when a trusted local producer can deliver one invitation through a private pipe.
The value is not placed in process arguments, the process environment, or a
Canonfig temporary file. The existing positional invitation interface remains
available for compatibility.

The producer must close its output after writing the opaque base64url invitation.
Canonfig accepts an optional trailing newline, limits input to 64 KiB, waits at
most ten seconds for EOF, and never echoes input or includes it in an error.
Interactive terminals are rejected because ordinary terminal input can echo the
invitation. A missing name, profile, or unsupported option fails before reading.
`--help` and `--version` never wait for input.

Only delivery changes. Invitation schema validation, expiry/replay rejection,
TLS and signing pins, native credential storage, pending enrollment, and explicit
replacement policy still use the existing enrollment implementation. No source
is contacted and no state layer is constructed for malformed invitation input.
The command logger captures the original `--stdin` invocation before input is
read; the resolved value is never assigned to `process.argv`.

A private pipe does not authenticate its producer and does not grant approval to
enroll or replace an identity. Supply the value only after approving the Source,
Follower Identity, selected profile, and any separately granted secret authority.
Keep invitation payloads out of shell history, tool arguments, and chat.

Audit coverage: N05 (bounded EOF-safe invitation delivery), and prevention for
the invitation-argument portion of C09. This does not revoke previously exposed
credentials or repair an operator-managed SSH tunnel.
