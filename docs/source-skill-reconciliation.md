# Reconcile deleted source skills into a Machine Profile

An authored Machine Profile normally keeps its declared resources until you
edit them. For source-backed skills, an explicit local reconciler can now remove
the resource automatically when its previously observed source directory is
deleted. This edits the authoring file only. It does not publish, sign a Profile
Revision, synchronize Followers, delete any source/follower files, or run an LLM.

```sh
canonfig source reconcile-skills --profile-file ./profile.jsonc
canonfig source reconcile-skills --profile-file ./profile.jsonc --apply
canonfig source reconcile-skills --profile-file ./profile.jsonc --apply --watch
```

The first command previews without writing. The first `--apply` records the
currently present skill directories in a private observation file next to the
profile. Later passes can distinguish a real disappearance from an initially
missing path or typo. `--watch --apply` performs repeated non-overlapping passes
(default every 5 seconds; `--interval` accepts 1..86400 whole seconds). Keep the
foreground process running, or invoke a one-shot `--apply` from an explicitly
configured external scheduler. No native job is installed and the Follower's
existing synchronization job is unchanged. Ctrl+C/SIGTERM stops the worker.

## What is eligible

Only `kind: "skill"` resources with a complete, unambiguous source-backed tree
are reconciled. A `SKILL.md` file must have a `source` path beneath the profile's
directory. Every declared file must map to the same relative path under that
skill directory. Inline content, mixed roots, symlink declarations, resources
outside the profile directory and non-skill resources are not inferred; skipped
resource IDs are reported. Source path components cannot be symlinks.

A resource is removed only after that directory was observed while it existed,
its resource declaration is unchanged, its directory is now absent, and its
parent directory still has the recorded filesystem identity. Missing parents,
changed mounts/directories, permission failures and malformed state stop the
operation. Deleting only `SKILL.md` while leaving its directory is ambiguous and
also stops it. Edited resource declarations and unobserved missing directories
need manual review rather than silent pruning.

When one source directory feeds multiple managed skill resources, all eligible
resources backed by that directory can be removed together. Unrelated resources
and JSONC comments are preserved. The resulting full profile is validated;
dangling dependencies prevent the entire edit instead of being automatically
rewired. No folder scanning imports unrelated skills or invents new resources.

## Safety and recovery

The sidecar is `PROFILE.skills-observed.json`; the writer lock is
`PROFILE.skills-reconcile.lock`. Profile and observation bytes are rechecked
before committing. Reappearing directories and changed parents stop the edit.
A changed profile is backed up to a unique private
`PROFILE.skills-backup-<id>.jsonc` file before atomic replacement; existing profile
permissions are preserved. Observation files and backups are owner-only where
POSIX permissions are available. Keep them private and do not commit them as
shared installation configuration.

A crash may leave the lock or backup. Stop any active reconciler, inspect the
profile and backups, and remove a stale lock only after verifying no writer is
running. A failure after the profile write but before observation refresh is
reported explicitly; the backup is retained. On retry, resource IDs already
removed from the profile are simply no longer observed, so deletion is not
repeated. Invalid observation state is never silently reset.

Review the profile diff and use the normal explicit `source publish` process
when ready. Follower behavior remains governed by the published revision and its
existing drift protections. File deletion on the Source Machine is not by itself
permission to publish or overwrite a Follower's locally edited skill.
