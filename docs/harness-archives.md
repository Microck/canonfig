# Portable harness archives

`canonfig harness export` packages Canonfig's project-local configuration, one
harness, or several harnesses in a `.zip` or `.tar.gz`. It does not enroll a
Follower Machine, publish a Machine Profile, or upload anything.

```sh
# Canonfig configuration and its declared source files, without native output.
canonfig harness export --source-only --output canonfig-source.zip
# A selected harness, with shared instructions, skills and required sources.
canonfig harness export --target codex --output codex.tar.gz
# Multiple harnesses, plus the canonical configuration for future regeneration.
canonfig harness export --target codex --target claude-code --include-source --output setup.zip
# Inspect the exact inventory without creating an archive.
canonfig harness export --targets codex,claude-code --include-source --output setup.zip --dry-run --json
```

Without target selection, export uses the enabled targets in the canonical
configuration. `--source-only` cannot be combined with target selection.
`--root` selects a project (or descendant); `--strict` retains the compiler's
existing rejection of lossy mappings. Warnings are included in the result.
The output extension selects the format, and its parent directory must exist.
Existing output is never overwritten, even with `--force`. Choose a new name.

## Contents and boundaries

Native output is freshly compiled from `.canonfig`, not copied from the local
native files. This intentionally excludes unowned native keys, private local
edits, account tokens, sessions, caches, user-profile configuration, and
Canonfig's ownership state. It does not back up an entire machine or import an
existing native setup. The project is not applied or otherwise changed.

Archives retain project-relative paths. Shared instructions, skills and authored
sources accompany native output so references remain usable. The source
selection adds the canonical harness configuration itself and the optional
default `skills-sources.json` provenance configuration. Custom skill-source
configuration outside `.canonfig` is not collected automatically. Declared instruction,
rule, skill, agent and command sources are included; hooks that explicitly name
`.canonfig/` paths include their containing support directory. Undeclared files
are not swept into the export. External executables, MCP services, dependencies,
and files outside `.canonfig` must be provided separately. Configuration that
requires a user-profile feature remains subject to its adapter diagnostics.

Export rejects symlinks in authored source paths, non-regular files,
credential-like `.env*`, `auth.json` and `credentials.json` files, runtime state,
and platform-unsafe or case-colliding paths. It preserves binary bytes and
executable bits. These checks are not a secret scanner: literal values or
sensitive prose already present in a declared source may be packaged. Review
the inventory and archive before sharing. Environment references are never
resolved to their values. Extraction does not automatically run scripts, but
hooks and skill scripts are executable content that must be reviewed before use.

`canonfig-export.json` records selection, relative paths, byte counts and SHA-256
digests. It is an inventory, not a signature or trusted Machine Profile revision.
Archives use deterministic ordering and timestamps and are bounded to 20,000
files and 128 MiB of uncompressed content, including the inventory. ZIP uses
stored entries; TAR uses PAX filenames and gzip. Output is private to the user
where the platform supports POSIX modes and published with exclusive creation.

Extract into a fresh directory and inspect the contents before copying them
into an existing project. Native configuration is not an installation of the
harness itself. If canonical configuration was included, subsequent `harness
plan`/`apply` uses the normal ownership/conflict checks; the archive does not
silently claim ownership of preexisting files.

## Design rationale

Issue #106 asks to package one or multiple harnesses. The operator clarified
that Canonfig configuration itself must also be selectable. This feature uses
the existing pure adapter compiler and renderers, rather than serializing a
Machine Profile or zipping hidden home directories. Fresh projection preserves
one canonical authority and avoids leaking unrelated native state. Selection,
preview, compatibility diagnostics and no-clobber publication are explicit CLI
contracts rather than archive-library defaults.
