# Canonfig architecture

Canonfig is a one-way configuration synchronizer for AI-assisted development machines. A Source Machine publishes an immutable Machine Profile. Each Follower Machine plans, applies, and verifies that profile while preserving declared local configuration and any modified skill that Canonfig previously installed.

The Configuration Agent is part of the product contract, but it is not the source of truth. Deterministic code owns discovery evidence, policy, execution, verification, and history. The agent resolves work only when Canonfig cannot select one safe action from declared facts.

> [!IMPORTANT]
> This document defines the accepted architecture.

## Product invariants

1. A Canonfig installation has one Source Machine. Followers never publish upstream state.
2. Every sync targets one immutable, authenticated Profile Revision.
3. Canonfig always produces and records a plan before it changes a follower.
4. Transfer behavior and apply behavior are separate. Transfers are content-addressed and incremental; each Profile Resource declares its own Apply Policy.
5. A modified follower skill is Follower Drift. Canonfig preserves it and reports the conflict instead of overwriting it.
6. Credentials are referenced and verified, not copied from the Source Machine.
7. Deterministic Installation Recipes run before any Agent Task is considered.
8. An Agent Task has explicit allowed paths, commands, network origins, time limits, and completion checks.
9. Scheduled sync uses the same command path as an interactive sync. There is no second reconciliation implementation.
10. Linux, macOS, and Windows adapters must pass the same conformance suite.

## System shape

```text
                         Source Machine

         ~/.canonfig/ (Canonical Folder)
                 |
                 v
       +--------------------+
       |   ProfileCatalog   |----> Profile Change Proposal
       +--------------------+                |
                 |                           v
                 +----------------> immutable Profile Revision
                                             |
                                  HTTPS + follower credential
                                             |
                                             v
                         Follower Machine

       +-------------+     +-----------------------+
       | CLI/Schedule|---->|    Synchronization    |
       +-------------+     +-----------------------+
                                   | plan/run/recover/status
                 +-----------------+-----------------+
                 |                 |                 |
                 v                 v                 v
       +----------------+  +---------------+  +----------------+
       | MachineState   |  | StateRepository|  | AgentResolution|
       +----------------+  +---------------+  +----------------+
                 |                 |                 |
                 v                 v                 v
       filesystem/tools       local SQLite      configured AI CLI
       platform adapters      and run journal   + controlled executor
```

The CLI and native schedulers are thin adapters. They decode input, call a deep module, render the typed outcome, and set the process exit code.

## Deep modules

### ProfileCatalog

`ProfileCatalog` owns source discovery, profile validation, proposals, publication, revision history, content addressing, and source signatures.

Its public interface is intentionally small:

```ts
interface ProfileCatalog {
  readonly scan: (input: ScanInput) => Effect.Effect<ProfileChangeProposal, ScanError>
  readonly publish: (input: PublishInput) => Effect.Effect<ProfileRevision, PublishError>
  readonly getRevision: (id: ProfileRevisionId) => Effect.Effect<ProfileRevision, RevisionError>
}
```

`scan` never edits a published revision. It produces a Profile Change Proposal with evidence for each discovery. Publication parses the authoring files, checks every resource, resolves content digests, signs the canonical Profile Revision payload, and then makes the revision visible.

### Synchronization

`Synchronization` is the main follower interface. It hides transport, state observation, planning, ordering, application, agent escalation, verification, and recovery.

```ts
interface Synchronization {
  readonly plan: (input: PlanInput) => Effect.Effect<SynchronizationPlan, PlanError>
  readonly run: (input: RunInput) => Effect.Effect<SynchronizationOutcome, RunError>
  readonly recover: (input: RecoverInput) => Effect.Effect<SynchronizationOutcome, RecoveryError>
  readonly status: () => Effect.Effect<FollowerStatus, StatusError>
}
```

The caller does not fetch a profile, open SQLite, inspect the machine, or invoke the agent. Those are implementation details behind the module.

### Enrollment

`Enrollment` owns Source Machine identity, one-time enrollment invitations, Follower Identity issuance, group membership, credential rotation, and revocation.

An enrollment link contains an HTTPS endpoint, a pinned source certificate fingerprint, and a short-lived one-time token. After enrollment, each follower uses its own revocable credential. A source-signed revision remains independently verifiable after download.

### MachineState

`MachineState` is an internal seam with three real platform adapters: Linux, macOS, and Windows. It owns filesystem operations, executable discovery, process execution, credential storage, package-manager probes, user directories, and native scheduler integration.

Platform adapters return domain values. They do not expose raw command output or OS-specific paths to Synchronization.

### AgentResolution

`AgentResolution` accepts an Agent Task and returns a typed proposal or completion record. AI harness adapters sit behind this seam. The first release may ship one adapter, but tests use a recording adapter through the same interface.

The agent cannot directly change the published profile. Discovery or repair suggestions become Profile Change Proposals on the Source Machine. Follower-side Agent Tasks may change only resources and commands authorized by the active plan.

### StateRepository

`StateRepository` owns local SQLite state and transactions. It stores:

- source and follower identities
- published revision metadata and content references
- follower enrollment and group membership
- harness takeovers with their pinned roots and local projection revisions
- synchronization runs and their plans
- per-action progress and verification evidence
- Applied Resource Records
- Follower Drift and Human Action Required outcomes
- schedule configuration

The live adapter uses the matching Effect v4 SQLite package. Tests use a temporary real SQLite database, not a mocked repository.

A run is `Preparing`, `Applying`, `Interrupted`, `Finalizing`, `Abandoning`,
or `Complete`. Repository transactions own transitions. Projection records
the preparing run before reserving a surface or capturing its first snapshot.
Only a reserved surface can await capture; applying requires a durable backup
choice. Verified writes establish `Owned` surfaces. Incomplete inverses leave
`Uncertain` ownership and a recoverable run rather than a fresh takeover.

An execution outcome does not close its run. Finalization first finishes
restore exclusions and ownership release, then deletes run artifacts and
records completion and the deployment receipt. Recovery resumes that work
without replaying completed actions. Explicit abandonment records its intent
before cleanup, so an interrupted cleanup cannot resume execution by mistake.
Action replay and repository writes share `transitionAction`: unstarted tail
actions stay `Pending`, semantic blockers stay `Blocked`, and `RolledBack`
is distinct from execution failure. Verification method strings describe proof,
not lifecycle.
Normal execution and recovery also share `reduceActionResult`: each failed,
human-blocked, or drift-blocked result requires its matching payload and
stops aggregation. No stopped result can turn into convergence through an
omitted optional field.

State format 7 creates the current schema directly. Any earlier migration
history is refused before schema or data writes. Move `~/.canonfig/state.sqlite`
aside and set the machine up again. There is no in-place state upgrade or
conversion of older on-disk journal shapes.

## Profile contract

The Source Machine authors its Machine Profile as the Canonical Folder:

```text
~/.canonfig/
  canonfig.jsonc      profile, harnesses, mcp, hooks, settings, tools, credentials, resources, groups, scheduleDefault, backupPolicies, local
  AGENTS.md
  rules/<id>.md
  skills/<name>/SKILL.md
  agents/<id>.md
  commands/<id>.md
  hooks/<script>
  files/...           content of authored resources
  local/              machine-local, never published
```

The folder is the authoring format; the signed Profile Revision is the wire format. `canonfig source publish` compiles the folder into one Profile Resource per item, encodes the canonical Profile Revision, and signs it. Comments and authoring layout never affect the revision digest. The reviewer and signed revision digest commit in the same SQLite transaction as the immutable revision. Followers mirror each authorized item into their own `~/.canonfig/` and project the mirror plus `local/` into their Target Harnesses. Resource ids, the follower mirror, projection, takeover snapshots and restore are described in [global-folder.md](global-folder.md).

`scheduleDefault` is an optional suggested schedule. A Machine Profile does not apply a schedule: the native synchronization job belongs to the Follower Machine, which accepts the profile's suggestion with `canonfig schedule set --default` or chooses its own calendar with `canonfig schedule set`. Sync never installs, re-enables, or recreates a job; when no decision exists it only reports that a schedule is available. Repairing that job happens after a converged run rather than as part of one, so a follower whose native scheduler does not work still converges. `tools.<id>` entries in `canonfig.jsonc` declare executables, installation recipes, login requirements, bounded agent installation and verification.

`backupPolicies` separately declares portable backup and restore-drill jobs. Applying the signed Canonical Folder mirror reconciles only the `canonfig-backup-*` namespace, never `canonfig-sync`. Local overrides, password aliases and credential-capture consent remain on each machine. Portable backup, export and import share the version-2 manifest and PAX tar codec; offline recovery can also carry encrypted Source identity or shared secrets. See [ADR 0004](adr/0004-backup.md).

### Profile Resource kinds

| Kind | Desired outcome | Apply Policy |
|---|---|---|
| `skill` | Canonical skill tree | `replace-if-unmodified` |
| `tool` | Installed executable and configuration | `ensure` |
| `credential` | A usable local credential reference | `require-local` |

Instructions, rules, agents, commands and hook scripts travel as `file` resources and `canonfig.jsonc` entries as JSON `config` resources. These are wire encodings of folder items: they are never authored, and a follower refuses any resource that is not a Canonical Folder item. Projection plans internal `file`, `directory` and `config` resources at the targets each harness adapter computes.

A Machine Profile's `scheduleDefault` accepts only daily and weekly calendars
in the follower's own timezone, because those are the only shapes every
follower backend renders. A follower sets a backend-specific calendar or a
named timezone locally instead.

A `tool` declares `agentInstall` paths and origins to permit a bounded
Configuration Agent to install it. Those bounds are authored, never inferred
from the target, and a tool with no usable recipe and no `agentInstall` is
Human Action Required rather than an Agent Task, because a task with no
writable path and no origin cannot install anything.

Each Applied Resource Record has one explicit ownership mode: `WholeFile`,
`Symlink`, `SourceSection`, `DirectoryEntries`, `ConfigKeys`, or `QualifiedTool`.
The mode requires its own evidence: regular-file permissions, a link target,
directory entries, config keys and format, or qualified installer provenance.
Execution and recovery use the same verified-state constructor. A config
handover records only the keys still owned after the write, with their digest;
releasing every key remains an explicit empty key set. Retirement interprets
every mode, while qualified tools release provenance without uninstalling
software. Incomplete or contradictory persisted ownership is a recovery error,
not permission to skip retirement or assume file modes.

Apply Policies mean:

- `replace`: atomically replace the target after recording rollback material.
- `merge`: update declared keys through a format-specific codec. A key Canonfig owned that the profile no longer declares is removed; keys the harness owns are preserved.
- `replace-if-unmodified`: replace only when current content equals the Applied Resource Record or already equals desired content. An absent target is reinstalled, because absence is not a local edit; a target that exists but cannot be verified is left alone and reported. On a directory the whole tree is listed, so an entry Canonfig never wrote is a local edit.
- `ensure`: reach and verify a declared capability without removing unrelated software.
- `require-local`: verify a local credential and return Human Action Required when it is absent.

Exact numeric modes are part of file convergence even when content is
unchanged. Follower observation uses no-follow final-component semantics and
records the actual object kind. A symlink, directory, reparse point, or
special object at a regular-file target is drift; Canonfig never reads through
it to decide content or permission convergence. The same no-follow contract
applies during post-apply verification.

Resource dependencies form a directed acyclic graph. Canonfig observes independent resources with bounded concurrency and applies actions in dependency order. Mutating actions for one target are serialized.

Publication rejects distinct resource IDs that claim the same normalized filesystem
target or unsafe parent/child targets. Skill file paths participate
in that check, as do normalized aliases such as `./` and Windows separators.
Validation uses the follower platform's path and case rules and rejects names
that are reserved or ambiguous on that platform.

## Tool discovery and installation

Discovery (`canonfig source scan`) reads the folder's instructions, skills, hook scripts, and MCP commands, plus any extra files `setup plan --file` names. It runs no processes. Markdown prose alone is not executable evidence. Canonfig records the file, line, command shape, and resolved executable or package when available. Discovery proposes only `tools` entries; `source scan --write` adds the accepted ones to `canonfig.jsonc`, keeping its comments. Every other item is authored as a folder file or `canonfig.jsonc` entry.

Each `tools.<id>` entry in `canonfig.jsonc` contains:

```jsonc
"ripgrep": {
  "executable": "rg",
  "recipes": [
    { "platform": "linux", "method": "apt", "package": "ripgrep", "version": "declared-version", "upstream": "https://github.com/BurntSushi/ripgrep" },
    { "platform": "macos", "method": "brew", "package": "ripgrep", "version": "declared-version" },
    { "platform": "windows", "method": "winget", "package": "BurntSushi.ripgrep.MSVC", "version": "declared-version" }
  ],
  "verify": { "method": "command", "command": ["rg", "--version"], "expectContains": "declared-version" },
  "login": { "required": false }
}
```

An Installation Recipe must be platform-specific and version-aware. Canonfig never assumes that a package has the same name or installation method across operating systems.

Recipe versions are validated at authoring, planning, and execution boundaries
with the grammar of the selected method. Every automatic package-manager
recipe requires a deterministic version. npm-family recipes (npm, pnpm, and
bun) require an exact registry package name and exact three-part semver,
including only valid prerelease and build metadata; tags, ranges, aliases,
URLs, Git/GitHub references, local/workspace/link forms, encoded separators,
and option-like values are rejected. Homebrew, winget, uv, cargo, and apt use
their corresponding safe version grammars. An immutable reviewed artifact may
carry its exact version in its canonical source metadata when the package
manager supports that artifact form. A method that cannot represent a
requested version fails closed before its installer is spawned. Publication
refuses an automatic recipe without an exact version, so an unversioned recipe
never reaches a follower.

Recipe methods are closed to the supported set: npm, pnpm, bun, brew, homebrew,
winget, uv, cargo, apt, and source. Unknown methods are rejected during
authoring, planning, persisted-plan decoding, and execution; Canonfig does not
coerce unrecognized aliases.

Reviewed package recipes retain optional `source` and `integrity` metadata from
discovery through the signed profile, transport, plan, and execution boundary.
An HTTPS npm-family tarball source must be the canonical registry tarball for
the declared package and exact version, and package-manager installs without an
artifact source are pinned to `https://registry.npmjs.org`. Credentials,
redirected or non-HTTPS sources, mutable Git forms, and package/source
mismatches are rejected before an installer is looked up. Automatic
npm-family artifact installation requires a reviewed `sha256` or `sha512`
SRI `integrity` value. The bounded transport streams exact bytes without
following redirects, verifies the digest before atomically caching them under a
digest-coupled cache entry, and invokes the package manager only with that
verified local tarball path. A remote source without supported integrity is
Human Action Required rather than an automatic install.
The source spelling is exact and case-sensitive: mixed-case schemes or hosts,
default ports, dot segments, encoded path aliases, credentials, queries, and
fragments are rejected rather than normalized. Before spawn, Canonfig parses
the verified gzip/tar archive within entry, manifest, and decompression bounds.
Only a single `package/package.json` with no peer or package-manager
indirection, and with dependencies physically embedded and covered by the
same top-level digest, is accepted. npm and pnpm then receive explicit offline
installation flags; bun artifacts remain Human Action Required because its
local tarball command has no guaranteed offline mode.

Every recipe also carries a reviewed `buildPolicy`. The default is
`{ "mode": "scripts-disabled" }`; npm installs use
`--ignore-scripts` and `uv tool install` uses `--no-build`. A package that
requires lifecycle hooks or an sdist must publish
`{ "mode": "required", "reviewedBy", "reviewedAt", "executables", "paths",
"origins", "capabilities", "steps" }`. Those bounds are part of the signed
recipe/action contract and are validated at publication. The current process
executor cannot confine lifecycle descendants, so required-build recipes stop
with Human Action Required rather than silently enabling scripts. Git, local,
and other source dependency specifications are likewise denied unless a
separately bounded execution plan is reviewed and published. Reviewed source
recipes remain safe immutable profile references, but the current executor
never fetches or builds them and always routes them to Human Action Required.
Cargo recipes are always Human Action Required under the default
`scripts-disabled` policy because Cargo can execute `build.rs` and procedural
macros without a disable-scripts mode. A future bounded builder policy must be
introduced separately before Cargo can be automated.

Registry-backed agent installs are pinned to reviewed HTTPS origins shared by
the task and follower harness. npm-family invocations replace explicit registry
options with the canonical npm origin, while deterministic uv invocations use
the reviewed full simple-index policy described below. These paths reject
conflicting extra indexes or find-links, requirement/constraint/override files,
insecure or trusted hosts, proxy or certificate overrides, config-setting
options, separator forms, and inherited package manager configuration or
credential environment. The controlled executor
repeats the origin and environment boundary immediately before spawn.

Deterministic uv recipes carry an optional reviewed `indexPolicy` with a full
credential-free HTTPS simple-index URL plus reviewer and review timestamp. A
missing policy uses the fixed `https://pypi.org/simple` index. The complete
private path is retained when explicitly reviewed; origins are never substituted
for a reviewed simple-index path. Index URLs reject credentials, fragments,
non-HTTPS schemes, and non-simple paths before executable lookup. The uv action
always supplies `--no-config`, the approved full `--default-index`, an exact
version, `--no-python-downloads` (with `UV_PYTHON_DOWNLOADS=never` in the child
environment, so uv never fetches an interpreter), and `--no-build` under the
default build policy.

A bare verifier executable resolves first in the directories where the tool's
recipes install executables on that platform (for example the uv tool bin
directory, the npm global prefix, `~/.cargo/bin`, or the WinGet links
directory), then `~/.local/bin`, then `PATH`, which in a scheduled run is the
job's bounded `PATH`. A missing executable fails verification and lists every
directory searched. A failed installer's error carries the last 20 lines
(at most 1536 characters) of its output, redacted.

For npm/pnpm recipes bound to Node and an explicit package-manager entrypoint,
bare Node-script verifiers use that same approved Node executable. Canonfig
reads only a bounded file header after resolving executable symlinks. Standard
Windows Node shim launch lines become direct Node-plus-script arguments; shell
text is never executed and conflicting or unsupported entrypoints fail closed.
Native binaries and explicit absolute verification commands retain their own
executable. The native process environment, including scheduler `PATH`, is
unchanged.

When no recipe is unambiguous, Canonfig creates an Agent Task containing the upstream URL and discovery evidence. The Configuration Agent may propose a recipe. The controlled executor applies it only under the configured agent policy, and verification must pass before the tool converges.

## Agent execution policy

Each follower selects one policy:

| Policy | Scheduled behavior | Interactive behavior |
|---|---|---|
| `deterministic-only` | Stop with Human Action Required | Show the unresolved task |
| `agent-propose` | Record a proposal and stop | Ask the user before execution |
| `agent-apply` | Execute only pre-authorized capabilities | Execute within the declared policy |

`agent-propose` is the default. Scheduled runs never wait for input.

Every Agent Task declares:

- desired resource and verification contract
- observed evidence and prior failed deterministic actions
- allowed filesystem roots
- canonical executable identities classified as direct leaf operations or
  bounded script-file interpreters
- allowed network origins
- whether elevation, login, restart, or reboot is forbidden
- wall-clock and output limits
- expected structured completion result

The task and follower harness policies must both authorize the same executable
execution model. Executables classified as launchers (tools that run a nested
command selected by an argument or embedded in program text, such as `xargs`,
`find -exec`, `awk`, `perl`, `make`, `npx`, elevation wrappers, and package or
task runners) cannot be authorized by any configuration because their
descendant command is not derivable from argv. They stop with Human Action
Required before spawn. Inline interpreter programs and unclassified executables
fail the same way. An allowlisted utility never implicitly authorizes
descendants. The same rules apply to proposal actions and independent
verification commands.

The executor captures stdout, stderr, exit status, changed paths, and verification evidence. It redacts known credentials before persistence. An agent statement is never proof of completion by itself.

Controlled subprocesses move through `Starting`, `Running`, `Stopping`,
`Closing`, and `Settled` under one transition owner. The first stop cause wins:
a later timeout or cancellation cannot replace an output-limit or input-write
failure that already started termination. Settlement waits for native close
and owned process-tree termination, then removes the timer and abort listeners.
Cancellation is checked after asynchronous input authorization and again after
the listeners are attached.

## Skill drift rule

For each managed skill file, the Applied Resource Record stores the digest Canonfig last wrote.

```text
observed == desired       -> no change
observed == last applied  -> safe to update or remove
otherwise                 -> Follower Drift; preserve follower content
```

Canonfig does not merge modified canonical skills. The user can move the changes into `~/.canonfig/local/skills/` under a different name, or discard them so the next sync replaces the skill. This keeps the automatic rule deterministic.

Upstream skill replacement has a separate version 2 `.pending` journal beside
`skills-sources.json`. It records staging ownership before any stage tree is
created, then each skill's rename intent, installed state, and rollback result.
The transaction moves through `Preparing`, `Swapping`, `PublishingConfig`,
`ConfigCommitted`, `RollingBack`, and `Finished`. Configuration publication
requires every selected swap to be installed. A committed configuration never
enters rollback. A blocked rollback records the affected skill and keeps its
backup and journal; newer local edits are not removed.

Recovery stays manual when interruption leaves a rename or configuration
publication ambiguous. Invalid journals fail the same decoder as any other
malformed record.
Preserve the journal and backups, compare trees and configuration against their
recorded digests, and finish or restore the interrupted update before removing
the journal and any stale lock.

The Local folder (`~/.canonfig/local/`) holds machine-owned rules, skills, agents and commands as files, and MCP servers and settings in `local/local.jsonc`. Projection adds them within the categories the Source's `local.allow` names. They are never published and never replaced; a local item named like a published one is Human Action Required.

## Synchronization flow

```text
1. Authenticate follower and fetch revision metadata.
2. Verify the source signature and content digests.
3. Download only missing content-addressed blobs.
4. Load Applied Resource Records and the Local folder.
5. Observe every target resource.
6. Build a complete Synchronization Plan and persist it before apply mode can
   mutate the follower.
7. Return the plan when running in plan-only mode. Planning may refresh the
   verified transport cache, but does not persist revisions, journals, or
   resource records and never resolves an `agent-apply` action.
8. Apply deterministic actions in dependency order.
9. Escalate eligible unresolved actions through AgentResolution only after
   the apply run and its pending action journal have been durably recorded.
10. Verify every required resource.
11. Commit Applied Resource Records and the run outcome.
```

Signed revision metadata contains file paths, modes, symlink targets, blob
digests, and exact byte lengths, but never embeds file content. At publication,
every folder file item, named by its `source` path relative to the Canonical
Folder, becomes an immutable per-file blob. A `source` file is hashed by
streaming it from disk, then
streamed again into the Source state database as fixed 1 MiB chunks
(`resource_blob_chunks`, committed with a `resource_blob_manifests` row in one
transaction); a file that changed between the two reads fails publication.
Memory use does not grow with file size. Blobs stored as one `resource_blobs`
row before chunking stay readable. Followers request each authorized
blob through its selected revision in verified bounded byte ranges, which the
Source writes from the stored chunks without joining them. A response
with a missing, conflicting, truncated, or aborted range is discarded before
the cache entry is atomically trusted; denial is returned before any blob length
header is written.

A run outcome is one of `Converged`, `HumanActionRequired`, `FollowerDrift`, `Failed`, or `Interrupted`. A run is one transaction for filesystem and configuration changes: if a deterministic action fails, Canonfig rolls back every file, directory, and config mutation of that run in reverse order, including resources independent of the failed one, restores their prior ownership records, and reports `resource <id> could not be applied to <target>: <cause>`. Tool installs are outside that transaction and are not rolled back. A resource that ends in Human Action Required does not roll back the others. External operations that cannot guarantee rollback remain visible and recoverable. Canonfig never reports convergence because some actions succeeded.

## Failure and recovery

Before each mutation, Canonfig writes an action journal entry and any rollback material needed for owned files. File writes use a sibling temporary file, durability sync where supported, and atomic rename. Before the first write to a harness surface, local projection also writes a Takeover Snapshot under `~/.canonfig/.backups/`; see [file-rollback.md](file-rollback.md).

If a later deterministic action fails, the executor rolls back earlier file,
directory, and config mutations from the same run in reverse order. It restores the prior
Applied Resource Record, or removes a newly created record, only after the
filesystem rollback succeeds.

When a removed resource is journaled, its prior ownership metadata remains in the
durable journal even after the live Applied Resource Record is deleted. Recovery
uses that metadata to reconstruct the removal context and never re-persists a
resource that was successfully removed.

Package installation, login, and arbitrary agent commands cannot promise full rollback. Canonfig records their evidence and reruns their idempotent verification during recovery. `canonfig recover` resumes the recorded plan when its Profile Revision is still available. Otherwise it explains why a new plan is required. An `Interrupted` run remains recoverable and blocks a new synchronization run for that follower until recovery completes or an explicit terminal abandonment outcome is recorded; terminal historical runs remain available to status and diagnostic queries.

Profile Revisions and content blobs are immutable. Canonfig does not perform automatic source garbage collection. A later explicit source maintenance command can remove unreachable revisions after policy is defined.

## Scheduling

Followers use native schedulers:

- Linux: systemd user timer
- macOS: launchd user agent
- Windows: Task Scheduler

There is no built-in schedule. A follower accepts an optional profile default with `canonfig schedule set --default` or explicitly selects its own calendar; sync never installs one and never recreates or re-enables a job disabled outside Canonfig. Native jobs invoke `canonfig sync --apply --no-input --scheduled`; the application does not keep a follower daemon running. A schedule is verified only when its effective native state is current and a scheduled invocation has completed.

`canonfig status --json` renders a completion receipt from durable revision,
deployment, action-journal, scheduler, and build evidence. Publication, apply,
explicit client loading, scheduling, and independent verification remain
separate states; a successful generic command check never implies that a
client loaded the resource.

## Effect program design

Canonfig uses matching, exactly pinned Effect v4 packages. Until Effect v4 is stable, all Effect packages must use the same prerelease line. Do not combine the v3 `latest` tag with v4 `rc` packages.

- Boundary data uses `Schema.Struct`, branded scalar schemas, and `Schema.TaggedUnion`.
- Expected failures use `Schema.TaggedErrorClass` and caller-actionable public unions.
- Public methods use `Effect.fn` and one span per operation.
- Configuration uses `Config`; credentials stay `Redacted` until an adapter consumes them.
- Retries use bounded `Schedule` values only for proven idempotent operations.
- Long-lived source serving uses scoped resources and fibers.
- Tests use matching `@effect/vitest`, `it.effect`, temporary SQLite, real temporary filesystems, loopback HTTPS, and test layers. Module mocking and method spying are forbidden.

The live SQLite implementation uses `@effect/sql-sqlite-node`, rather than depending directly on the experimental `node:sqlite` interface. It and `@effect/platform-node-shared` are installed through the npm aliases `@canonfig/effect-sql-sqlite-node` and `@canonfig/effect-platform-node-shared`, pinned to the exact `effect` version.

## Setup controller

`canonfig setup` is a typed, journaled controller rather than an agent adapter.
It establishes `source` or `follower` before role-specific inspection, then
performs a bounded preflight and inventory of OS identity, account, loopback
transport, Node runtime, native installers, and declared discovery files.
Source preflight requires usable signing and TLS key storage before source
initialization.

The plan digest covers intent, exclusions, inventory, and exact per-resource
steps. Approval is valid only for that digest. Apply uses structured executable
and argv fields, verifies installed tools, records qualified provenance, and
persists item evidence. The dependency graph isolates optional integrations;
restart resumes at the next required stage without repeating unchanged
discovery or approval.

## CLI contract

```text
canonfig setup plan --role source --intent "prepare source"
canonfig setup approve --approver operator
canonfig setup apply
canonfig setup status

canonfig source init
canonfig source scan --write
canonfig source publish --reviewer operator
canonfig source serve
canonfig source service install
canonfig source invite --endpoint https://127.0.0.1:17342 --output ./canonfig-invite
canonfig source revoke follower-one

cat ./canonfig-invite | canonfig follower enroll --stdin --name laptop
canonfig follower unenroll
canonfig tunnel start
canonfig tunnel stop --forget
canonfig harnesses
canonfig harnesses exclude cursor
canonfig sync --plan
canonfig sync --apply --no-backup
canonfig restore
canonfig recover --no-input
canonfig status --json
canonfig doctor --no-input
canonfig schedule set daily@00:00
canonfig schedule set --default
canonfig schedule remove
```

Commands print a concise human-readable summary by default (the message, one line per action or probe, and `exit N: <category>` on failure) and the stable `canonfig.cli/v1` JSON envelope with `--json`. Expected outcomes have distinct exit codes so schedulers and agents can distinguish drift, human action, operational failure, and invalid input. The complete command surface is `canonfig --help`.

## Repository layout

```text
src/
  domain/                 schemas and pure decisions
  profile/                ProfileCatalog service, layer, errors, and folder compilation
  projection/             Canonical Folder loading, harness adapters, projection, import, and takeover snapshots
  synchronization/        Synchronization service, planner, executor, and recovery
  enrollment/             Enrollment service, HTTPS transport, and identities
  machine/                MachineState seam and Linux/macOS/Windows adapters
  agent/                  AgentResolution service, harness adapters, and executor policy
  state/                  StateRepository service, SQLite layer, and migrations
  schedule/               native scheduler adapters
  setup/                  typed setup controller, plan journal, and recipe executor
  cli/                    command parsing and output rendering
  runtime/                production layer graph and entrypoint
tests/
  contract/               platform and resource conformance suites
  integration/            SQLite, filesystem, HTTPS, and recovery tests
website/                  Fumadocs application
skills/                   Canonfig agent skills
tools/oxlint/anti-slop/   vendored lint rules
```

Service tags, implementing layers, public errors, and domain types remain separate within each module. Pure helpers stay near their owning module. The repository does not add generic `utils.ts`, pass-through repositories, or one-file-per-function wrappers.

## Deliberate exclusions

Canonfig does not provide:

- bidirectional synchronization
- automatic copying of source credentials
- silent conflict resolution for modified skills
- arbitrary whole-home-directory backup
- a hosted fleet control plane
- unattended GUI automation without a documented adapter
- guaranteed rollback for external installers
- automatic profile publication from follower observations
- automatic deletion of historical revisions or blobs

These exclusions keep authority, recovery, and user-visible outcomes explicit.
