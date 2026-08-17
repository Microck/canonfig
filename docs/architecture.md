# Canonfig v2 architecture

Canonfig is a one-way configuration synchronizer for AI-assisted development machines. A Source Machine publishes an immutable Machine Profile. Each Follower Machine plans, applies, and verifies that profile while preserving declared local configuration and any modified skill that Canonfig previously installed.

The Configuration Agent is part of the product contract, but it is not the source of truth. Deterministic code owns discovery evidence, policy, execution, verification, and history. The agent resolves work only when Canonfig cannot select one safe action from declared facts.

> [!IMPORTANT]
> This document defines the accepted v2 architecture. See the [implementation map](./implementation-map.md) for its dependency order and verification.

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
11. Canonfig v2 does not read, migrate, or preserve legacy v1 state.

## System shape

```text
                         Source Machine

   files + AGENTS.md + tool configs
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
- durable Local Overlay ownership entries
- synchronization runs and their plans
- per-action progress and verification evidence
- Applied Resource Records
- Follower Drift and Human Action Required outcomes
- schedule configuration

The live adapter uses the matching Effect v4 SQLite package. Tests use a temporary real SQLite database, not a mocked repository.

## Profile contract

The Source Machine owns JSONC authoring files under its Canonfig source directory:

```text
~/.canonfig/source/
  profile.jsonc
  tools.jsonc
```

`profile.jsonc` declares groups, resources, policies, dependencies, and schedule defaults. `tools.jsonc` is an agent-readable catalog of every discovered CLI or tool, including invocation evidence, upstream URL, supported platforms, installation recipes, verification, configuration files, and login requirements.

Publishing converts JSONC into a canonical encoded Profile Revision. Comments and authoring layout never affect the revision digest.

### Profile Resource kinds

| Kind | Desired outcome | Default Apply Policy |
|---|---|---|
| `file` | Exact file or symlink content | `replace` |
| `directory` | A source-owned tree | `mirror-owned` |
| `config` | Format-aware declared keys | `merge` |
| `skill` | Canonical skill tree | `replace-if-unmodified` |
| `tool` | Installed executable and configuration | `ensure` |
| `credential` | A usable local credential reference | `require-local` |
| `schedule` | A native scheduled sync job | `replace` |

Apply Policies mean:

- `replace`: atomically replace the target after recording rollback material.
- `mirror-owned`: add and update desired files, then remove only files previously owned by Canonfig and still unmodified.
- `merge`: update declared keys through a format-specific codec while preserving the Local Overlay.
- `replace-if-unmodified`: replace only when current content equals the Applied Resource Record or already equals desired content.
- `ensure`: reach and verify a declared capability without removing unrelated software.
- `require-local`: verify a local credential and return Human Action Required when it is absent.

Resource dependencies form a directed acyclic graph. Canonfig observes independent resources with bounded concurrency and applies actions in dependency order. Mutating actions for one target are serialized.

Publication rejects distinct resource IDs that claim the same normalized filesystem
target or unsafe parent/child targets. Directory and skill file paths participate
in that check, as do normalized aliases such as `./` and Windows separators.
Within one directory or skill resource, the target itself is the explicitly
represented directory ancestry; every declared file path must otherwise be a
unique, canonical relative leaf with no file/descendant overlap. Validation
uses the follower platform's path and case rules and rejects names that are
reserved or ambiguous on that platform.
Schedules use their own target namespace, so a schedule target is not confused
with a filesystem path.

## Tool discovery and installation

Discovery scans configured agent instruction files, tool configuration, hooks, MCP definitions, executable references, and known package-manager metadata. Markdown prose alone is not executable evidence. Canonfig records the file, line, command shape, and resolved executable or package when available.

Each tool entry contains:

```jsonc
{
  "id": "ripgrep",
  "upstream": "https://github.com/BurntSushi/ripgrep",
  "evidence": [
    { "source": "~/.codex/AGENTS.md", "line": 42, "invocation": "rg" }
  ],
  "recipes": {
    "linux": { "method": "apt", "package": "ripgrep", "version": "declared-version" },
    "macos": { "method": "brew", "formula": "ripgrep", "version": "declared-version" },
    "windows": { "method": "winget", "id": "BurntSushi.ripgrep.MSVC", "version": "declared-version" }
  },
  "verify": { "command": ["rg", "--version"], "expect": "declared-version" },
  "login": { "required": false }
}
```

An Installation Recipe must be platform-specific and version-aware. Canonfig never assumes that a package has the same name or installation method across operating systems.

Recipe versions are validated at authoring, planning, and execution boundaries
with the grammar of the selected method. npm-family recipes (npm, pnpm, and
bun) require an exact registry package name and exact three-part semver,
including only valid prerelease and build metadata; tags, ranges, aliases,
URLs, Git/GitHub references, local/workspace/link forms, encoded separators,
and option-like values are rejected. Homebrew, winget, uv, cargo, and apt use
their corresponding safe version grammars. A method that cannot represent a
requested version fails closed before its installer is spawned.

Recipe methods are closed to the supported set: npm, pnpm, bun, brew, homebrew,
winget, uv, cargo, apt, and source. Unknown methods are rejected during
authoring, planning, persisted-plan decoding, and execution; Canonfig does not
coerce unrecognized aliases.

Every recipe also carries a reviewed `buildPolicy`. The backward-compatible
default is `{ "mode": "scripts-disabled" }`; npm installs use
`--ignore-scripts` and uv installs use `--only-binary=:all:`. A package that
requires lifecycle hooks or an sdist must publish
`{ "mode": "required", "reviewedBy", "reviewedAt", "executables", "paths",
"origins", "capabilities", "steps" }`. Those bounds are part of the signed
recipe/action contract and are validated at publication. The current process
executor cannot confine lifecycle descendants, so required-build recipes stop
with Human Action Required rather than silently enabling scripts. Git, local,
and other source dependency specifications are likewise denied unless a
separately bounded execution plan is reviewed and published.

Registry-backed agent installs are pinned to the one HTTPS origin shared by
the task and follower harness. npm-family, uv, and pip-compatible invocations
replace explicit index or registry options with that canonical origin, while
rejecting conflicting extra indexes or find-links, trusted hosts, proxy or
certificate overrides, config-setting options, separator forms, and inherited
package manager configuration or credential environment. uv and pip also disable
configuration discovery; the controlled executor repeats the origin and
environment boundary immediately before spawn.

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
execution model. Executables classified as launchers — tools that run a nested
command selected by an argument or embedded in program text, such as `xargs`,
`find -exec`, `awk`, `perl`, `make`, `npx`, elevation wrappers, and package or
task runners — cannot be authorized by any configuration because their
descendant command is not derivable from argv. They stop with Human Action
Required before spawn. Inline interpreter programs and unclassified executables
fail the same way. An allowlisted utility never implicitly authorizes
descendants. The same rules apply to proposal actions and independent
verification commands.

The executor captures stdout, stderr, exit status, changed paths, and verification evidence. It redacts known credentials before persistence. An agent statement is never proof of completion by itself.

## Skill drift rule

For each managed skill file, the Applied Resource Record stores the digest Canonfig last wrote.

```text
observed == desired       -> no change
observed == last applied  -> safe to update or remove
otherwise                 -> Follower Drift; preserve follower content
```

Canonfig does not merge modified canonical skills in v2. The user can keep the follower copy, replace it with the source revision, or move the changes into a Local Overlay. This keeps the automatic rule deterministic.

Local Overlays are follower-owned records for `config` resources using the
`merge` policy. Each record stores the authorized resource ID, its normalized
managed target, and normalized config key paths. Overlay commands must resolve
the selected authorized revision and match its target exactly; they cannot
introduce external paths, bypass group authorization, or change source-owned
content. The records live in follower state and are loaded on every plan, so
ownership decisions survive synchronization and process restart.

## Synchronization flow

```text
1. Authenticate follower and fetch revision metadata.
2. Verify the source signature and content digests.
3. Download only missing content-addressed blobs.
4. Load Applied Resource Records and the Local Overlay.
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

A run outcome is one of `Converged`, `HumanActionRequired`, `FollowerDrift`, `Failed`, or `Interrupted`. Partial application is visible and recoverable; Canonfig never reports convergence because some actions succeeded.

## Failure and recovery

Before each mutation, Canonfig writes an action journal entry and any rollback material needed for owned files. File writes use a sibling temporary file, durability sync where supported, and atomic rename.

When a removed resource is journaled, its prior ownership metadata remains in the
durable journal even after the live Applied Resource Record is deleted. Recovery
uses that metadata to reconstruct the removal context and never re-persists a
resource that was successfully removed.

Package installation, login, and arbitrary agent commands cannot promise full rollback. Canonfig records their evidence and reruns their idempotent verification during recovery. `canonfig recover` resumes the recorded plan when its Profile Revision is still available. Otherwise it explains why a new plan is required. An `Interrupted` run remains recoverable and blocks a new synchronization run for that follower until recovery completes or an explicit terminal abandonment outcome is recorded; terminal historical runs remain available to status and diagnostic queries.

Profile Revisions and content blobs are immutable. V2 does not perform automatic source garbage collection. A later explicit source maintenance command can remove unreachable revisions after policy is defined.

## Scheduling

Followers use native schedulers:

- Linux: systemd user timer
- macOS: launchd user agent
- Windows: Task Scheduler

The default schedule is daily at 00:00 in the follower's configured timezone. Weekly and custom calendar schedules are supported. Native jobs invoke `canonfig sync --apply --no-input`; the application does not keep a follower daemon running.

## Effect program design

Canonfig uses matching, exactly pinned Effect v4 packages. Until Effect v4 is stable, all Effect packages must use the same prerelease line. Do not combine the v3 `latest` tag with v4 `rc` packages.

- Boundary data uses `Schema.Struct`, branded scalar schemas, and `Schema.TaggedUnion`.
- Expected failures use `Schema.TaggedErrorClass` and caller-actionable public unions.
- Public methods use `Effect.fn` and one span per operation.
- Configuration uses `Config`; credentials stay `Redacted` until an adapter consumes them.
- Retries use bounded `Schedule` values only for proven idempotent operations.
- Long-lived source serving uses scoped resources and fibers.
- Tests use matching `@effect/vitest`, `it.effect`, temporary SQLite, real temporary filesystems, loopback HTTPS, and test layers. Module mocking and method spying are forbidden.

The live SQLite implementation uses `@effect/sql-sqlite-node`, rather than depending directly on the experimental `node:sqlite` interface.

## CLI contract

```text
canonfig source init
canonfig source scan
canonfig source publish
canonfig source serve
canonfig source invite
canonfig source revoke

canonfig follower enroll <invite>
canonfig sync [--plan | --apply]
canonfig recover
canonfig status [--json]
canonfig overlay list
canonfig overlay set <resource-id> --target <path> --key <config.path>
canonfig overlay remove <resource-id>
canonfig doctor
canonfig schedule set <calendar>
canonfig schedule remove
```

Commands print human-readable output by default and stable JSON with `--json`. Expected outcomes have distinct exit codes so schedulers and agents can distinguish drift, human action, operational failure, and invalid input.

## Repository layout

```text
src/
  domain/                 schemas and pure decisions
  profile/                ProfileCatalog service, layer, errors, and source adapters
  synchronization/        Synchronization service, planner, executor, and recovery
  enrollment/             Enrollment service, HTTPS transport, and identities
  machine/                MachineState seam and Linux/macOS/Windows adapters
  agent/                  AgentResolution service, harness adapters, and executor policy
  state/                  StateRepository service, SQLite layer, and migrations
  schedule/               native scheduler adapters
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

Canonfig v2 does not provide:

- bidirectional synchronization
- Legacy v1 state migration or aliases
- automatic copying of source credentials
- silent conflict resolution for modified skills
- arbitrary whole-home-directory backup
- a hosted fleet control plane
- unattended GUI automation without a documented adapter
- guaranteed rollback for external installers
- automatic profile publication from follower observations
- automatic deletion of historical revisions or blobs

These exclusions keep authority, recovery, and user-visible outcomes explicit.
