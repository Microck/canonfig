# CLI credential redaction

CLI results and usage messages redact recognizable credential fields, environment
bindings, authorization headers, URL user information, query assignments, private
key blocks, and long-form command arguments. Both `--password=value` and
`--password value` are covered, including nested arrays and discovery excerpts.

Explicit symbolic references such as `credentialReference` remain visible. Input
data is not mutated. Human and JSON renderers share the same redaction boundary.
Literal object keys are preserved without invoking inherited setters.

This is not a shell parser or a guarantee that arbitrary text contains no secrets.
Do not inspect raw authentication files or print unbounded subprocess output.
Filter disabled integrations before collecting their configuration. An exposure
that already happened still requires credential rotation through its owner;
redacting later output does not revoke the exposed credential.

## Published configuration

Publication rejects recognizable literal credentials in config keys before
compiling, signing, or persisting revisions, blobs, or approvals. The same
credential-name policy covers nested environment values, named environment
entries, authorization headers, password/token arguments, URL user information,
and credential query parameters. Failures name the resource and config field,
redact the value, and explain how to replace it.

Keep values in native credential storage with `canonfig secrets set`, which reads
the value from stdin. Configs may retain symbolic environment references such as
`${API_TOKEN}`, `Bearer ${API_TOKEN}`, `{env:API_TOKEN}`, or a supported
`{ "fromEnv": "API_TOKEN" }` value. Named `secretBindings` retain only the process
variable and shared-secret name. Publication does not resolve these references
or grant secret-sharing authority. Review the revised configuration before
publishing again. Accepted bytes are never silently rewritten or redacted.

Reviewed uv index URLs must be credential-free. They reject credential-named query
parameters even when the value is empty or an environment reference, because the
installer does not resolve secrets in index URLs. Noncredential query parameters
retain their existing behavior. Recipe diagnostics report the failing field and
trusted rule explanation without copying rejected package, version, or URL values.

The installation audit's C09 finding motivated these regression tests. This patch
hardens Canonfig output; it does not claim to prevent an external agent from
printing a file directly outside Canonfig.
