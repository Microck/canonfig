# Canonical Folder internals

This document describes how Canonfig turns `~/.canonfig/` into a signed
Profile Revision on the Source Machine and into harness files on every
machine. The decision record is
[ADR 0003](adr/0003-global-canonfig-folder.md); user-facing reference lives at
https://canonfig.micr.dev/docs/reference/canonfig-folder/ and
https://canonfig.micr.dev/docs/reference/harnesses/.

## Folder layout and allowlist

`src/projection/folder.ts` reads only the authoring allowlist:

| Path | Content |
| --- | --- |
| `canonfig.jsonc` | `version: 1`, `profile`, `harnesses`, `surfaces`, `mcp`, `hooks`, `settings`, `tools`, `credentials`, `resources`, `groups`, `scheduleDefault`, `local` |
| `AGENTS.md` | shared instructions |
| `rules/<id>.md` | rules |
| `skills/<name>/` | skill trees with `SKILL.md` |
| `plugins/<id>/` | reviewed native packages with `plugin.jsonc` and harness-specific variants |
| `agents/<id>.md` | subagent definitions |
| `commands/<id>.md` | slash commands |
| `hooks/` | scripts that a hook in `canonfig.jsonc` runs |
| `files/` | content of the authored resources in `canonfig.jsonc` `resources` |
| `local/` | machine-local items, never published |

Everything else (`state.sqlite`, `setup.json`, `.runtime/`,
`.backups/`, `canonfig.log`, `installers/`, `skills-sources.json`) is
machine-local. The loader never reads it. Every file must resolve inside the
folder, and authored trees hold regular files and directories only;
violations fail with `CanonicalFolderError`.

`profile` is required to publish and unused by projection. `local.allow`
names the categories that `local/` may add to: `rules`, `skills`, `plugins`,
`agents`, `commands`, `mcp`, `settings` (`LOCAL_CATEGORIES`).

## Compile to resources

`folderProfile` in `src/profile/publication.ts` compiles the folder into a
Machine Profile with one resource per item:

| Resource id | Kind | From |
| --- | --- | --- |
| `instructions` | file | `AGENTS.md` |
| `rules:<id>`, `agents:<id>`, `commands:<id>` | file | `<category>/<id>.md` |
| `skills:<name>` | skill | `skills/<name>/` |
| `plugins:<id>` | file | `plugins/<id>/plugin.jsonc`; depends on its payload and declared tools |
| `plugin-files:<id>:<path>` | file | native payload bytes and executable intent, grouped with the manifest |
| `hooks:<id>` | config | `canonfig.jsonc#hooks.<id>`, with its position in the `hooks` array |
| `hook-scripts:<path>` | file | a script under `hooks/`, path segments joined with `:` |
| `mcp:<name>` | config | `canonfig.jsonc#mcp.<name>`; depends on the `tools/<id>` it `requires` |
| `settings:<harness>` | config | `canonfig.jsonc#settings.<harness>` |
| `harnesses` | config | `canonfig.jsonc#harnesses` |
| `local-policy` | config | `canonfig.jsonc#local` |
| `tools:<id>` | tool | `canonfig.jsonc#tools.<id>` |
| `credentials:<id>` | credential | `canonfig.jsonc#credentials.<id>` (reference only) |

The `file` and `config` kinds here are wire encodings of folder items. Nobody
authors them directly. Compilation refuses a folder without `profile`, a hook
script no hook runs, a hook naming a missing script, an MCP server requiring
an undeclared tool, and a group naming an item the folder does not declare.
A grouped item reaches only followers in one of its groups; a hook script
follows the hooks that run it.

## Shield and Native Plugins

[ADR 0004](adr/0004-shield-and-native-plugins.md) defines the folder extension.
`local/local.jsonc` stores this machine's `shield: { enabled, hard }` and
`excludePlugins` policy. A Source redirects to authored entries; an enrolled
Follower redirects only to `local/`, subject to `local.allow` and Local Overlays.

Before projection, apply-mode sync admits recognized foreign entries through
the existing authoring transaction. It copies and validates before removing
native entries, rejects linked ancestors and content collisions, and preserves
edits to already-managed items as drift. Native packages are scanned before
skills so their hooks and dependencies remain intact. Admission clears native
review. Projection and publication require a digest matching all payload bytes,
executable intent and variant declarations. A Follower's `excludePlugins` removes
only its projected package, not the signed mirror.

The generated hook registry, installer staging cache and `.shield/` ingestion
receipt are machine-local. No daemon or automatic publication is added. Hard
protection uses a Linux bubblewrap process tree, not immutable flags on a home.
Mixed configuration/authentication files stay writable. Canonfig's projection
runs outside that tree.

## Follower mirror

`src/projection/mirror.ts` maps each published resource back to a folder
item: a file at the same path in the follower's `~/.canonfig/`, an entry of
the `canonfig.jsonc` the follower renders from the items it may see, or a tool
or credential applied directly. A resource that is not a Canonical Folder item
is refused, so a revision cannot make a follower write outside the allowlist.

A machine is a Source or a follower, never both (`src/state/machine-role.ts`).
Enrollment refuses a Source, Source commands refuse an enrolled follower, and
each names the other role's record and the way out. Those checks run before
any side effect; the repository's save of each role record checks again inside
its `BEGIN IMMEDIATE` transaction, so concurrent commands cannot both win. An
enrollment refused only at that save is cancelled on the Source, since the
invitation was already spent. Enrollment also refuses a
folder that already holds authored items (`src/runtime/layers.ts`):

```text
<folder> already holds authored items (<items>), where a follower keeps its Source's mirror; move what this machine should keep into <folder>/local (rules, skills, agents and commands as files, MCP servers and settings in local.jsonc) or remove them, then enroll again
```

A mirror file edited locally is Follower Drift: it is kept and reported, and
the run stops before any harness output is written or retired. Retirements
outside the folder depend on the mirror items, so the planner orders them
after the mirror.

## Projection plan

`src/projection/plan.ts` turns the Canonical Model into internal `file`,
`directory` and `config` resources at adapter-computed targets and plans them
with the same planner a follower uses for a revision. `src/projection/sync.ts`
runs local projection, restore, recover, abandon and harness exclusion edits.

The projected harness set is: listed in `harnesses`, installed, and not in
`local/local.jsonc` `excludeHarnesses`. Removing a harness from the list
retires unmodified outputs; it does not restore the snapshot. `surfaces.<harness>`
narrows what one harness gets: `modelFor` empties the categories it leaves
out before that harness's adapter runs, so outputs for them are never built
and earlier ones retire through the same removal path. The shared
`~/.agents/skills/` directory is written when any harness that reads it gets
`skills`.

## Adapters and owned surfaces

Each adapter in `src/projection/adapters/` returns a `HarnessLayout`
(`src/projection/harness.ts`): a root, owned surfaces, never-touch paths and
whether skills go to the shared `~/.agents/skills/`. An `OwnedSurface` is one
of:

- `file`: the whole file is replaced.
- `directory`: the whole directory is replaced; entries Canonfig never wrote
  are removed at takeover and reported as drift afterward.
- `config`: only the listed key paths are owned in a file the harness shares
  with its own state. `settings.reserved` lists keys a declaration may never
  name.

Never-touch paths (credentials, sessions, history) are never surface targets
and never enter a snapshot. The harness ids are `TARGET_IDS` in
`src/projection/model.ts`.

## Detection

`src/projection/detect.ts` reports a harness installed when one of its
adapter's executables resolves through Canonfig's install destinations,
`~/.local/bin`, then `PATH`, without running it. A config root alone is only
evidence. A scheduled run can see fewer harnesses than setup did; projection
holds such a harness instead of retiring it. The same report backs
`canonfig harnesses` and the doctor `harnesses` probe.

## Import

`src/projection/import.ts` implements the Source setup's one-time import
(`setup plan --import`, `--import-all`, `--no-import`). It reads instructions,
rules, skills, agents, commands and MCP servers from the selected harnesses
and writes them as folder items. It is read-only on the harness and refuses
never-touch paths. Non-skill config and instruction reads reject links. MCP
import reads owned keys and turns credential-looking literals into `fromEnv`
references only within those keys, before digesting them. A source that
changes between scan and import fails with `ImportChangedError`.
Size-budget refusals use the separate `ImportSizeLimitError` type.

Skill discovery reads the adapters' explicit native skill sources, including
locations Canonfig does not own for writes. Skill reads may follow links only
within the user's home, outside protected harness state, mixed/key-scoped
config files and their aliases, and the Canonical Folder. Import copies
regular-file content, not links; broken links, cycles and unsafe targets are
reported as skipped paths. This read policy does not expand the positive
ownership allowlist for writes or backups.
Regular skill files must have exactly one hard link. If a file has another
name, Canonfig cannot verify that it is separate from protected state and
skips the skill. Leave it out, or use an independent copy of non-private
content before scanning again.

Import assumes trusted local processes and source folders that stay unchanged.
Path and opened-file checks do not prevent a process from swapping a parent
directory between checks. A matching SHA-256 verifies content, not its origin.
See the [import threat model](adr/0003-global-canonfig-folder.md#9-security).

Discovery skips skills above 64 MiB or with a file above 1 MiB. Flat skills
must fit the 1 MiB file limit both before and after conversion. The batch
budget counts their converted payload, not discarded whitespace.

Applying the approved import has a shared 64 MiB content budget. If the
selected items exceed that budget, the import stops before any writes.
Remove large skill resources or select fewer items, then scan, review and
approve again.

## Takeover snapshots

`src/projection/takeover.ts` writes a Takeover Snapshot before Canonfig first
writes a harness surface: `~/.canonfig/.backups/<UTC>/` with `manifest.json`,
one directory per harness holding copied files at their path relative to the
home directory, and `keys.json` with prior values of taken-over config keys
only (any JSON value, `null` included). Directories are 0700 and files 0600.
`canonfig import --replace`, and a restore of the snapshot it took, write the
same snapshot of the Canonical Folder entries they replace, under the owner
`canonfig` (`canonicalFolderOwner`) instead of a harness; restoring one writes
those entries back without a drift check, since authored content has no
applied state.
The snapshot is built under `.backups/.tmp-<UTC>/`, removed if the capture
fails, and renamed to `<UTC>` once its manifest is complete. Only a directory
with a valid manifest counts as a snapshot for listing, restore and
retention. `pruneSnapshots` keeps the first harness snapshot, the first folder
snapshot and the four most recent, and removes temporary directories a killed
capture left behind. `local/local.jsonc` `backups: false` or
`sync --no-backup` skips a harness snapshot; a folder snapshot is always
taken. A run that rolls back deletes its snapshot and takeover rows. A run
that stops early (Human Action Required or
Follower Drift), or an interrupted run closed with `canonfig abandon`, keeps
takeover rows only for surfaces it applied, so the next run takes the others
over again with a fresh snapshot. Its snapshot drops the entries of surfaces
whose action never started (an emptied snapshot is deleted) but keeps those
whose action started: a killed process may have written the surface before
journaling success, and then that snapshot holds the only copy of the
original content.

## Restore

`canonfig restore [<snapshot>]` plans the snapshot's content with
`planRestore` in `src/projection/plan.ts`. A surface changed since Canonfig
last wrote it blocks the restore and nothing changes:

```text
restore of snapshot <id> refused, nothing was changed:
  <problems>
Keep or move the local changes, sync until it converges, then restore again
```

A snapshot holds only what its own run took over. When a later run took over
more keys of the same config file, restoring the earlier snapshot writes back
only the keys it captured. The config resource writes the later keys back
unchanged and lists the captured ones in `releases`, so the run's Applied
Resource Record keeps the later keys (with a digest of just their values) and
only the captured keys' takeover rows are released.

## Local folder merge and collisions

Projection adds `local/` items within the Source's `local.allow`. A category
outside it is never read: anything in it only earns a warning that it is
ignored, so content that would not load there (a skill without `SKILL.md`)
does not stop the sync. A local item named like a published one is Human
Action Required (`src/projection/folder.ts`):

```text
local <category> <name> has the same name as a published one; rename or remove one of them
local setting <harness> <path> overlaps published setting <path>; remove one of them
```

## Pinned roots

The first takeover pins each harness root. A root outside the home directory,
or a different root later, is Human Action Required
(`ProjectionHumanActionError` in `src/projection/plan.ts`):

> \<harness\> was taken over at \<previous\> but now resolves to \<root\>, for
> example because an environment override such as CODEX_HOME changed.
> Canonfig will not project into a second location: restore the environment,
> or run 'canonfig restore' and sync again

## State tables

`src/state/state-schema.ts` defines:

- `harness_takeovers`: one row per taken-over surface (`harness`, `surface`,
  `root`, `snapshot`, `run_id`, `taken_over_at`). Every row of a harness
  carries the root pinned at first takeover; `snapshot` is NULL when the
  takeover ran without one.
- `local_revisions`: the immutable planning revision of one local run
  (projection or restore), without file content. Recovery resumes from it.
- `applied_resources` and `action_journal`: the Applied Resource Records and
  the per-run journal shared with revision runs (see
  [file-rollback.md](file-rollback.md)).
