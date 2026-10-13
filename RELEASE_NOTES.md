# Canonfig v4.0.0

Canonfig 4.0.0 requires Node.js 24 or newer. This release is a fresh-install
baseline, not a supported in-place upgrade from 3.2.x. The signed revision
wire format changed. A 4.0.0 Source refuses 3.2.x followers, and a 4.0.0
follower refuses a 3.2.x Source. Preserve the old installation and its state;
back it up separately before establishing a new Source and enrolling new
followers. Existing signed revisions, credentials, schedules, and enrollment
pins are not migrated by this procedure.

## Changes

- On Windows with long paths disabled, `sync --plan` and the apply preflight
  refuse a target whose path, with Canonfig's staging names, exceeds MAX_PATH,
  naming the limit and the `LongPathsEnabled` remedy. Such a target used to
  pass planning and fail partway through the apply. Rollback and `recover` now
  also remove the parent directories a failed write created (deepest first,
  only while empty); previously they persisted after rollback. A Windows
  symlink refused with EPERM names its prerequisite: Developer Mode or
  `SeCreateSymbolicLinkPrivilege`.
- A uv tool whose executable was deleted while uv still listed it is repaired.
  Canonfig planned a reinstall on every apply, but `uv tool install` reported
  the tool as already installed and exited 0, so verification failed each
  time. Canonfig now passes `--reinstall` (not `--force`, which would also
  overwrite an executable uv does not own). npm, pnpm, and Cargo already
  reinstall a missing executable.
- A full Source `setup plan` no longer reports success when the native
  credential provider is merely present. With Secret Service (or Credential
  Manager) installed but not running or unlocked, the plan passed and
  `source-init` failed at apply. The preflight now stores, reads back, and
  deletes a disposable non-secret item and stops with the prerequisite if
  that fails; the inventory records `session-probe` when it succeeds.
- A changed version pin on an already-installed tool is now enforced. Planning
  asks the recipe's installer which version is installed (`uv tool list`,
  `npm`/`pnpm`/`bun` global listings, `winget list`, `dpkg-query`, Cargo's
  install metadata) and plans `install-tool` with `replaces` when it differs
  from the pin; previously a present executable planned `no-op` and the old
  version stayed. winget reinstalls with `--force` and apt with
  `--allow-downgrades`. After a pinned install the installer must report the
  pin, or the action fails.
- `source digest` and `source publish` hash and store file sources in
  streams, so peak memory no longer grows with file size (a 200 MiB file
  peaked at about 1.47 GB during publish; it now stays near 170 MB). State
  migration `0021_resource_blob_chunks` stores new blobs as 1 MiB chunks;
  blobs stored by earlier versions stay readable. Digests and signatures are
  unchanged. An older binary cannot serve blobs stored as chunks.
- Windows `schedule status` and `doctor` warn that the Task Scheduler task
  runs only while the user is logged on, and name a scheduled run that was
  skipped while nobody was logged on.
- The website dependency graph uses source-map-js 1.2.2, addressing the
  indexed-source-map denial-of-service advisory
  [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
- Native file sources publish raw bytes as immutable per-file SHA-256 blobs
  rather than embedding a whole resource's file content in signed JSON.
  Signed metadata carries each byte digest and length. File, directory, and
  skill resources share the byte pipeline; authorized followers fetch bounded
  byte ranges for larger files and verify the assembled bytes before use.
- Follower requests and Source responses carry a Canonfig version handshake. The
  Source refuses enrollment and revision transport from a different
  major.minor release before spending an invitation or shaping a revision;
  followers report a version mismatch instead of a misleading digest error.
- A per-user Source service can supervise `source serve` through systemd,
  launchd, or Windows Task Scheduler. Scheduled follower sync can restart a
  managed SSH tunnel once when it is down; native credential-store access is
  still required in that unattended session.
- Setup accepts CLI-only and project-only request scopes; enrollment reads
  invitation data from stdin, not from process arguments.
- Publication reports resource validation failures without printing raw
  parser input. Enrollment classifies Source credential failures as Human
  Action Required, and synchronization identifies removed installer bindings
  with a recovery message.
- CLI output redacts known secret values inside URLs and free text, including
  values under unrelated field names.
- Windows ACL reads use the PowerShell Core access-control API when needed.
  Permission operations have a longer timeout; rollback restores captured
  security descriptors through a native helper rather than recalculating
  inheritance from a temporary parent.
- Publication rejects recognizable literal credentials in configuration before
  signing or persistence. Symbolic environment references and named
  shared-secret bindings remain supported; reviewed bytes are not silently
  redacted into a different configuration.
- Setup binds approval to bounded authoring-file fingerprints. Changed,
  missing, unreadable, or oversized inputs require a new plan and approval
  before executing an installation or identity step.
- Recipe validation identifies the failing index, version, package, source,
  or build field without exposing rejected values. Reviewed uv indices
  reject credential-bearing query parameters.
- macOS credential decoding preserves a leading UTF-8 BOM as secret data.
  SSH public-key files accept normal LF and CRLF line endings without
  relaxing single-key validation or identity pinning.
- CLI startup rejects unsupported Node.js runtimes before loading database
  layers or reading enrollment input, with the required version and exit code 3.
- Setup verifies npm recipes in the reviewed installer's actual global prefix,
  including configured prefixes outside PATH and paths containing spaces.
- Discovery retains distinct package versions when their executable entry files
  have identical bytes, so stale copies remain visible for review.
- Windows Desktop and Core PowerShell use the same chunked native Credential
  Manager backend, so accepted 16 KiB secrets also fit when wrapped in their
  credential payload. The CLI size limit and native storage policy are unchanged.
- Linux Source status distinguishes the user manager's boot and logout lifecycle
  from access to signing and TLS credentials. Linger does not unlock an encrypted
  login keyring, and an installed service is not proof of login-free serving.
- The Linux Source service continues spaced failure retries after delayed native
  credential unlock instead of exhausting a boot-time start quota. Failed starts
  remain visible in status and the native journal; identity and storage policy
  are unchanged.
- Managed tunnels accept literal dash-prefixed OpenSSH arguments through
  repeated `--ssh-argument` options and validate IPv6 SSH destinations.
  IPv6 loopback forwarding is bracketed correctly; SSH, TLS and signing pins
  and host-key bypass rejection are unchanged.
- IPv6 Source HTTPS verifies the actual peer certificate's IP SAN directly,
  avoiding Node's IPv6-to-IDNA hostname conversion failure without weakening
  CA validation or the pinned Source identities.

These changes do not establish an in-place migration path or prove fleet
convergence on a live installation.

[Fresh-install guide](website/content/docs/how-to/upgrade.mdx)

---

# Canonfig v3.2.1

Canonfig 3.2.1 requires Node.js 24 or newer.

## Bug Fixes

- Pin Canonfig's shared Effect runtime package to the same release candidate as
  the CLI's direct Effect dependencies. Clean npm installs can no longer resolve
  incompatible Effect copies that make `canonfig doctor` fail during runtime
  layer initialization.

Canonfig 3.2.0 is deprecated. Upgrade to 3.2.1 before running synchronization or
diagnostics.

Full changelog: https://github.com/Microck/canonfig/compare/v3.2.0...v3.2.1
