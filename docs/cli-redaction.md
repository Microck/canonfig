# CLI credential redaction

CLI results and usage messages redact recognizable credential fields, environment
bindings, authorization headers, URL user information, query assignments, and
long-form command arguments. Both `--password=value` and `--password value` are
covered, including nested command arrays and discovery excerpts.

Explicit symbolic references such as `credentialReference` remain visible. Input
data is not mutated. Human and JSON renderers share the same redaction boundary.

This is not a shell parser or a guarantee that arbitrary text contains no secrets.
Do not inspect raw authentication files or print unbounded subprocess output.
Filter disabled integrations before collecting their configuration. An exposure
that already happened still requires credential rotation through its owner;
redacting later output does not revoke the exposed credential.

The installation audit's C09 finding motivated these regression tests. This patch
hardens Canonfig output; it does not claim to prevent an external agent from
printing a file directly outside Canonfig.
