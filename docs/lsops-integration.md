# lsops catalogue integration

Canonfig transports shared CLI **metadata**; lsops 0.5 remains responsible for
listing CLIs to agent harnesses, installing packages and explicitly approved
updates. Canonfig does not convert links into Installation Recipes or run lsops,
package managers, installers, login flows or models.

The bridge has two explicit steps: capture a portable catalogue on the Source
Machine, then reconcile its transported copy on each Follower Machine. Both
commands preview by default. Neither publishes a Machine Profile automatically.

## Source Machine

Use the actual lsops base config path (`lsops config`). Do not pass a project
overlay. Every path below is illustrative and must be chosen for this machine.
The output's parent directory must already exist.

```sh
canonfig lsops capture --config /home/me/.config/lsops/config.json --bundle ./lsops-shared.json
canonfig lsops capture --config /home/me/.config/lsops/config.json --bundle ./lsops-shared.json --apply
```

Capture exports descriptions, why/when text, install URL, package manager and
reviewed script SHA256 for visible curated tools. It excludes local executable
paths, help overrides, visibility flags, project trust and update approvals.
It does not copy authentication or installed-version state. Review descriptions
and install links before sharing; these are user-authored text, not a secret
scanner. Unknown fields and incompatible metadata fail closed.

Add this ordinary file resource to the authored Machine Profile (the source path
is relative to that profile file). Keep the catalogue beside it:

```json
{
  "id": "lsops-catalogue",
  "kind": "file",
  "policy": "replace-if-unmodified",
  "target": "~/.canonfig/lsops-shared.json",
  "spec": { "kind": "file", "source": "lsops-shared.json" },
  "verify": { "method": "digest" }
}
```

Publish and synchronize through the existing reviewed revision, enrollment,
transport and follower scheduling workflow. **Never target the live lsops config
with this file resource**: its target is a staging catalogue, not a replacement
for a follower's entire registry. Capture updates are included in the next
explicit publication, not sent automatically just because the file changed.

## Follower Machine

After the shared file has arrived, preview and apply its metadata to the local
lsops base config:

```sh
canonfig lsops sync --bundle /home/me/.canonfig/lsops-shared.json --config /home/me/.config/lsops/config.json
canonfig lsops sync --bundle /home/me/.canonfig/lsops-shared.json --config /home/me/.config/lsops/config.json --apply
```

The config parent must exist. On macOS and Windows use the actual lsops config
path rather than assuming Linux's XDG location. Paths are explicit to prevent
silently changing the wrong machine or a trusted project overlay.

### Ownership and conflicts

- Follower-only tools, their install links, local paths, help, visibility and
  project trust remain local. No data is automatically sent back to the Source.
- A new shared tool is tracked in `config.json.canonfig-lsops.json` beside the
  destination. Only portable fields introduced by this bridge are owned.
- If a name already exists locally with different metadata, **the entire pass
  stops** before writing. Identical pre-existing records stay independently local;
  they are not silently adopted, so later Source changes can conflict.
- Subsequent Source changes update an owned tool only if its portable fields
  still equal the last applied values. Local metadata edits or local deletion
  produce a conflict, not an overwrite. Local path/visibility edits are retained.
- Removing a Source tool from the captured catalogue removes its unchanged
  bridge-owned portable fields on the next published revision and bridge pass.
  Any local fields remain. Follower-only tools remain. **No executable is
  uninstalled**, and no update approval file is deleted or modified.
- A missing staging file is an error, never a deletion signal. To intentionally
  remove all shared entries, publish a valid empty version-1 catalogue.
- Case-colliding names are refused on every OS rather than silently collapsing
  them on Windows. Metadata is limited to the lsops 0.5 format and supported
  package/script source identities.

Resolve a collision by reviewing and renaming/removing the conflicting local
registration, or by changing the shared selection on the Source. For edited
owned metadata, restore its prior shared fields after reviewing/backing up local
changes, or handle ownership explicitly in the local state with the worker
stopped. There is deliberately no force-overwrite switch.

## Continuous mode and the other direction

Both commands offer an explicit foreground polling worker:

```sh
canonfig lsops capture --config /home/me/.config/lsops/config.json --bundle ./lsops-shared.json --apply --watch --interval 30
canonfig lsops sync --bundle /home/me/.canonfig/lsops-shared.json --config /home/me/.config/lsops/config.json --apply --watch --interval 30
```

A pass without `--watch` is suitable for an operator-managed scheduler. These
commands do not install an OS service. Capture polling does not publish; follower
polling does not fetch revisions. Keep the existing Canonfig sync schedule for
transport, and run this bridge separately after a successful sync or as a local
foreground worker. Conflicts, malformed input and I/O failures stop the worker.
`--json` emits one result per pass; metadata conflicts return exit code 4.

The same capture command works on any machine, so a follower can export local
CLI metadata for review on the Source. This is an explicit proposal/import
workflow, **not two writable authorities**: nothing promotes follower-only tools
or changes the Source profile without the operator choosing to do so. Ordinary
`lsops bundle export` version-1 portable catalogues can also be used as input.

lsops still requires its own install confirmation and local auto-update opt-in.
A transported install link never grants execution permission. Changing a source
identity leaves existing approvals untouched; lsops's own identity check refuses
an outdated approval. Installer scripts retain the reviewed hash, not an
unreviewed refreshed hash.

## Concurrency and interrupted writes

Stop other lsops config writers while applying a bridge pass. The bridge has an
exclusive sibling lock against its own workers and checks for edits before each
atomic replacement; lsops 0.5 does not share that lock, so this is not a global
cross-application transaction. Do not edit config/state while a pass is running.
Symlink files/ancestors are refused. Capture and sync also reject filesystem aliases
and destinations reserved for ownership, recovery, lock files or lsops update approvals. Existing file permissions are preserved;
new private state and journal files use mode 0600 where supported.

Replacement file contents are flushed before atomic renames. On Linux/macOS,
parent-directory entries are also flushed, including the journal directory before
config mutation. Flush failures stop the operation rather than being ignored.
Windows cannot perform POSIX-style directory fsync through Node's read-only
directory handles: it uses flushed writable files plus atomic renames instead.
**Power-loss durability of directory entries is not guaranteed on Windows.**
The JSON result's `durabilityPolicy` identifies the platform policy. Ordinary
process interruption recovery remains supported on all three platforms.

After success, the journal becomes `config.json.canonfig-lsops.json.last-transaction.json`
instead of being deleted. This bounded private recovery receipt preserves the most
recent prior config/state on every platform. It does not block subsequent passes;
it is replaced only after the next successful commit. Capture and sync reserve
this path too. A receipt is not a substitute for filesystem or machine backups.

Before changing config the bridge writes a private pending journal with the exact
previous config/state and intended new state. If interrupted after that point,
subsequent passes refuse to proceed. Stop all writers; inspect the journal and
back up current config/state. Restore its `before` and `stateBefore` contents
(null means the file was absent), then remove the pending journal and any stale
bridge lock only after confirming no worker is running. Preview again. Do not
blindly delete ownership state: doing so makes shared records independent and
prevents safe automatic removal. The journal may contain local config data;
keep it private. This recovery procedure does not undo changes by other writers.
