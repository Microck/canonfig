# Codexport PRD

Status: implemented as an initial Node.js CLI in this repository.

## Goal

Build a low-friction way to replicate the useful parts of a master machine's
Codex setup to follower machines.

The main target is `~/.codex`. The master is the source of truth. Follower
machines should stay up to date automatically while still being allowed to keep
machine-local additions such as local MCPs, local skills, local trust entries,
and local path overrides.

## Product Principles

- The master owns the canonical Codex configuration.
- Followers are read-only consumers of canonical state.
- Followers can keep local-only overlays unless those overlays explicitly
  conflict with canonical names.
- Sync should feel zero-friction after first setup.
- Secrets and auth are part of the desired user experience, but they should not
  be stored as plaintext in a GitHub repository.
- GitHub can store tool code and non-secret portable config. Tailscale should be
  used for private master-to-follower transfer of secret-bearing bundles.
- Active Codex sessions should not be interrupted by config updates.

## Current Decisions

### Repository Location

The project will live at:

```text
/home/ubuntu/workspaces/codexport
```

### Authority Model

The master is canonical. Follower machines do not push changes back by default.

Follower-specific additions are allowed, but they remain local unless promoted
from the master intentionally.

### Sync Transport

Use a Tailscale-compatible pull model:

```text
Master:
  codexport serve

Follower:
  codexport join
  > Master Tailscale IP/name: master.tailnet.ts.net
```

Followers pull from the master. The master does not need to track and push to every
follower.

Tailscale reachability is sufficient for follower enrollment. The first version
does not require a separate one-time pairing code.

The master should run the master server persistently as a user-level service.
Followers should be able to reconnect and sync whenever the master is online.

On first join, the follower trusts the provided Tailscale address and stores the
master instance fingerprint. Later syncs must verify that fingerprint. If the
fingerprint changes, sync should refuse by default and require an explicit
re-enroll or trust-reset command.

### One-Click Join

The master should be able to generate a durable join artifact for followers.

Preferred UX:

```text
codexport master link
```

Outputs a permanent join link or command that a follower can run without
manually typing the master address:

```text
npx codexport follower join "codexport://join?host=master.tailnet.ts.net&port=17342&fingerprint=..."
```

If custom URL handling is too complex for the first implementation, the
fallback is a one-time copy-paste command:

```text
npx codexport follower join --master http://master.tailnet.ts.net:17342 --fingerprint ...
```

The join link should not include plaintext Codex secrets. It should include only
connection and trust bootstrap information:

- master host or Tailscale IP/name
- port
- master fingerprint
- optional protocol/version metadata

Because this is a permanent link, rotating the master fingerprint or changing
the master address should invalidate or require regenerating the link.

### Platform Support

Linux and Windows 10/11 are first-class targets.

The design must avoid Linux-only assumptions in canonical state. Platform
differences should be handled through explicit path variables, platform-specific
service installers, and local overlays.

Initial platform requirements:

- Linux: support systemd user services when available.
- Windows 10/11: support a user-level scheduled task or equivalent per-user
  background launcher.
- Both platforms: support a non-service fallback where `codexport sync` can
  be run manually.
- Both platforms: preserve local-only overlays and refuse accidental conflicts
  with canonical names.

### Automatic Updates

Followers should sync automatically through a follower-only Codex `SessionStart`
hook:

- The hook runs a short best-effort sync before a new Codex session starts.
- If the master is reachable and the content hash changed, the follower applies
  the update before the session continues.
- If the master is unavailable, the hook exits cleanly and Codex starts with the
  most recently applied config.

This means followers are guaranteed to refresh at the Codex session boundary,
but they do not continuously sync while idle. Manual `codexport sync` remains
available when an immediate refresh is needed outside session startup.

### Config Layering

The tool should generate the final `~/.codex/config.toml` from layers:

```text
canonical config from the master
local follower overlay
generated final ~/.codex/config.toml
```

The generated file should be backed up before replacement.

Local overlays are never synced back unless explicitly promoted.

### MCPs

Master MCP definitions are canonical and synced by default.

Because MCP definitions may contain machine-specific paths and secrets, the tool
should make them portable through:

- path variables such as home and workspace root
- secret transfer over the Tailscale bundle
- local overlays for follower-specific additions

Canonical MCP names are reserved. Local MCPs may add new names. A same-name
local MCP should fail by default unless an explicit override is configured.

### Skills

Master skills are canonical and synced by default.

Follower-local skills are allowed under non-conflicting names. Same-name local
skills should fail by default unless an explicit override is configured.

### Include By Default

Portable or canonical Codex material:

- `AGENTS.md`
- `RTK.md`
- `config.toml` canonical sections
- `hooks.json`
- selected `hooks/`
- `prompts/`
- `rules/`
- `skills/`
- `skill-libraries/`
- MCP definitions
- tool manifest, likely `mise.toml`

### Exclude By Default

Runtime debris and machine-local state:

- logs
- caches
- tmp directories
- shell snapshots
- compact handoffs
- SQLite runtime state
- sessions
- history
- local trust entries unless intentionally canonical
- follower-local overlays

Sessions, history, and SQLite runtime state are out of scope for v1. The first
version should sync config, auth, MCPs, skills, hooks, prompts, rules, and other
portable Codex material, but not live conversation/runtime databases.

### Secret Handling

The user wants auth and important state to sync for a one-click experience.

The current design should not store plaintext secrets in GitHub. Instead:

- The master can include secret-bearing files in a private export bundle served
  over Tailscale.
- Followers fetch and apply that bundle during `join` or automatic sync.
- GitHub stores code and non-secret portable config, not plaintext token blobs.

Secret-bearing examples from current `~/.codex` include:

- `auth.json`
- `.credentials.json`
- `multi-auth/**`
- MCP environment values and command args that contain tokens/passwords

Secret-bearing sync should still exclude sessions, history, logs, and SQLite
runtime state in v1.

## Proposed CLI Shape

This is a planning sketch, not an approved interface.

```text
codexport master init
codexport master serve
codexport master link
codexport follower join
codexport sync
codexport apply
codexport hook install
codexport status
codexport master rebuild
```

## Distribution

The tool should be publishable as an npm package and runnable with `npx`:

```text
npx codexport
```

That means the runtime target is Node.js. Bun may be used for local development
and testing, but followers should not need Bun preinstalled just to run the
tool.

Recommended package shape:

- TypeScript source.
- Node-compatible CLI entrypoint declared through `package.json` `bin`.
- Published npm package with compiled JavaScript in `dist/`.
- `npx codexport follower join` as the lowest-friction first-run path.
- Optional later installer that writes the master service and follower hook.

The tool may still install or configure Bun as part of the synced development
toolchain if the master's `mise.toml` requests it.

The published package should require Node.js 20 or newer.

## Implementation Language

Codexport should be implemented in TypeScript targeting Node.js 20 or newer.

Reasons:

- `npx codexport ...` is a core product requirement, so Node.js is the natural
  runtime.
- TypeScript provides useful type safety for config layering, bundle manifests,
  join-link parsing, platform branching, and path rewriting.
- Node.js has first-class enough support for Linux and Windows filesystem,
  process, HTTP, and path APIs.
- The npm ecosystem covers the needed libraries for CLI parsing, TOML parsing,
  file watching, archive handling, and tests.
- Requiring Bun on follower machines would work against the one-click goal.

Recommended implementation stack:

- TypeScript source.
- Node.js 20+ runtime.
- `package.json` `bin` entrypoint named `codexport`.
- `commander` or `cac` for CLI parsing.
- `smol-toml` or `@iarna/toml` for TOML parsing and writing.
- `chokidar` for master-side file watching.
- Vitest for tests.
- `tsup` or `tsx` plus `tsc` for builds.

Rejected for v1:

- Bun as required runtime: good local dev tool, but not appropriate as a
  follower prerequisite.
- Go or Rust as the main implementation: good for single binaries, but weaker
  for the required npm/npx distribution path and higher release complexity.
- Native platform helpers: defer until a specific Windows or Linux operation
  cannot be implemented reliably from Node.js.

Expected roles:

- `master init`: create the master canonical state.
- `master serve`: serve canonical bundle over Tailscale-reachable HTTP.
- `master link`: print a durable follower join link or copy-paste command.
- `follower join`: enroll a follower by asking for the master Tailscale IP/name.
- `sync`: fetch and stage/apply updates.
- `apply`: apply already available canonical state plus local overlays.
- `hook install`: install follower-only Codex SessionStart sync hook.
- `status`: report role, master address, last revision, pending update, and local
  conflicts.
- `master rebuild`: force rebuild the master bundle for repair/debugging.

## Services

The tool should install a user-level master background service and follower
Codex hook rather than requiring administrator/root installation for normal
operation.

On Linux, user-level services should use systemd user units when available.

On Windows 10/11, the master service should use a per-user Scheduled Task or an
equivalent user-level background launcher. Windows followers should install only
the Codex SessionStart hook in v1.

Master service:

- Runs `codexport master serve`.
- Binds to `0.0.0.0` by default so followers can connect through the easiest
  Tailscale-routable address.
- Uses port `17342` by default.
- Should enforce a configured allowlist or reject non-Tailscale peers where peer
  detection is available.
- Publishes the current canonical revision and export bundle.
- Computes the canonical revision as a content hash over the selected export
  files, normalized metadata, and relevant generated config.
- Watches selected `~/.codex` paths, debounces changes, rebuilds the bundle
  automatically, and publishes the new revision without requiring manual action.
- Does not require a Codex session to be active.

Follower hook:

- Runs at Codex `SessionStart`.
- Checks the master revision.
- Downloads and validates new revisions when changed.
- Verifies the stored master fingerprint before accepting an update.
- Applies before the new Codex session proceeds.
- Uses a short timeout so Codex startup is not blocked for long when the master is
  offline.
- Does not require a follower background service in v1.

## Local Overlay Layout

Recommended local-only state lives outside `~/.codex`:

```text
~/.codexport/local.toml
~/.codexport/mcps.local.toml
~/.codexport/skills/
~/.codexport/overrides/
```

Default meanings:

- `local.toml`: follower role, master URL, pinned fingerprint, polling interval,
  path variables, and explicit override permissions.
- `mcps.local.toml`: follower-only MCP definitions.
- `skills/`: follower-only skills.
- `overrides/`: explicit same-name overrides for canonical MCPs or skills.

Canonical names win by default. A same-name local MCP or skill fails unless
`local.toml` explicitly allows that override.

## Open Questions

1. Should the master server require a one-time pairing code in addition to
   Tailscale reachability? Decision: no, Tailscale reachability is enough.
2. Should `codexport serve` be temporary per enrollment or a persistent user
   service? Decision: persistent user service.
3. How should active Codex sessions be detected reliably?
4. Which files under `~/.codex` are canonical source files versus generated or
   plugin-managed files?
5. Should local overlays use TOML only, or should skills/MCP overrides be stored
   as directory trees? Decision: TOML for config/MCP overlays, directories for
   local skills and explicit overrides.
6. Should followers use background polling services or only a Codex
   SessionStart hook? Decision: only a follower Codex SessionStart hook in v1.
7. How should Windows path variables map to Codex paths, especially when the
   master is Linux and followers are Windows?
8. What minimum Node.js version should the published npm package require?
   Decision: Node.js 20 or newer.
9. Should master serving use a fixed default port, and if yes, which one?
   Decision: yes, port `17342`.
10. Should followers pin the master fingerprint after first join?
    Decision: yes, refuse changed fingerprints unless explicitly re-enrolled.
11. Should master revisions use a content hash or monotonically increasing
    number? Decision: content hash.
12. Should master export rebuilds require a manual command or happen
    automatically? Decision: master watches selected paths and rebuilds
    automatically; manual rebuild exists only for repair/debugging.
13. Should the master generate a permanent follower join link or require manual
    master address entry? Decision: generate a durable join link, with a
    copy-paste command fallback if custom URL handling is not implemented in the
    first version.
14. Should v1 sync sessions, history, or SQLite runtime state? Decision: no.
15. Should a SessionStart hook replace the follower background service?
    Decision: yes for v1. Followers sync at Codex session startup, with manual
    `codexport sync` available for immediate refreshes.

## Known Risks

- Current `~/.codex/config.toml` contains hardcoded paths and sensitive values.
  A literal copy would be brittle and risky.
- Codex may not support config includes, so generated config is probably needed.
- Syncing hooks is powerful and can affect every future Codex session.
- A hook-only follower design means followers do not refresh while idle unless
  Codex starts or `codexport sync` is run manually.
- Private GitHub is not secret storage. Avoid plaintext secret commits.

## Non-Goals For The First Implementation

- macOS support.
- GitHub-based plaintext secret sync.
- Push-based orchestration from the master to followers.
- Mid-session mutation of active Codex behavior.
- Automatic promotion of follower-local changes.
- Syncing Codex sessions, history, logs, or SQLite runtime state.
