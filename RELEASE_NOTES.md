# Canonfig v4.0.0

Canonfig 4.0.0 requires Node.js 24 or newer. This release is a fresh-install
baseline, not a supported in-place upgrade from 3.2.x. The signed revision
wire format changed. A 4.0.0 Source refuses 3.2.x followers, and a 4.0.0
follower refuses a 3.2.x Source. Preserve the old installation and its state;
back it up separately before establishing a new Source and enrolling new
followers. Existing signed revisions, credentials, schedules, and enrollment
pins are not migrated by this procedure.

## Changes

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
