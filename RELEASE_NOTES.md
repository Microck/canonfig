# Canonfig v4.0.1

4.0.1 fixes safety, enrollment, CLI output and diagnostic issues reported after
4.0.0. Node.js 24 or newer is required. The state schema and signed-revision
format are unchanged; Sources and followers remain on the 4.0.x compatibility
line. Finish or recover unfinished runs with their original build before
updating, and keep a backup of the installation and state. Migration from 3.2.x
still requires a separate setup, not an in-place upgrade.

## Filesystem safety and native configuration

- Preserve directory permissions and file modes through synchronization,
  rollback and native configuration updates. Failed writes no longer leave
  parent directories or obsolete rollback data behind.
- Treat symlinked managed-directory ancestors and non-regular merge targets as
  actionable conflicts instead of traversing or replacing them. Unrelated
  safe resources can still proceed.
- Limit native harness cleanup to owned files. Deleted Codex/Grok TOML can be
  recreated or cleaned safely; dangling links and locally edited files retain
  their protections.

## Enrollment, publication and shared secrets

- Reject duplicate enrollment identities without consuming the reusable
  invitation or taking over an active follower.
- Reject revision metadata that cannot fit the transport budget before storing
  it. Source servers refuse a configured metadata ceiling below that admission
  budget. File blob bytes remain separate from metadata.
- Refuse local writes over Source-owned secret names. Manifest ownership checks,
  writes and retired-credential cleanup now share a cross-process lock, avoiding
  stale concurrent overwrites. Existing name collisions include recovery steps.
- Use the same credential-policy selection for regular and secret commands.
  Local-file bootstrap is described accurately without permitting shared-secret
  storage through an insecure backend.

## CLI and diagnostics

- Report inaccessible, corrupt or busy state as actionable errors, without
  deleting the existing state. Optional debug diagnostics remain redacted and
  inside a single result envelope.
- Emit one final apply result after automatic secret synchronization, with a
  matching exit status. Secrets commands use the canonical JSON schema.
- Handle JSON, version and help flags consistently across command groups and
  command logs. Usage errors identify missing arguments and unknown options;
  installer errors retain their specific explanation.
- Redact recognized credentials throughout human output, including repeated
  values, symbolic-prefix literals, URL userinfo and escaped JSON. Redacted
  scalar JSON stays parseable. Public harness binding names remain readable
  without masking unrelated executable paths.
- Handle child stdin closing early without crashing or losing exit diagnostics.
- Keep Windows command logging private when Node inherits PowerShell 7 module
  paths before launching Windows PowerShell.
- Make doctor honor actual installer bindings, removals and supported methods,
  including uv; yarn is no longer treated as a supported installer.
- Emit native MCP environment-reference syntax and reject unsupported mappings
  in strict mode, including unsupported Kilo project references.

## Verification

The integration candidate passed 1,147 selected tests, with 22 platform-specific
skips, plus real CLI checks. Linux, macOS, Windows x64 and Windows ARM64 CI passed
on the exact merged integration tree. The release candidate is validated again
by the release workflow before publication. These results do not claim live
model/provider authentication or completion of the remaining issue backlog.
