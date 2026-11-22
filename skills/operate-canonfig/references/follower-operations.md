# Follower operations

## What a follower holds

A follower follows the one Machine Profile its Source publishes. Each sync
fetches the latest authorized revision, mirrors its items into this machine's
`~/.canonfig/` (`canonfig.jsonc`, `AGENTS.md`, `rules/`, `skills/`, `agents/`,
`commands/`, `hooks/`), and projects the mirror plus `~/.canonfig/local/` into
the listed harnesses that are installed and not excluded here. Edit the
Source's folder to change published items; add machine-only items under
`local/`.

## Plan and apply

Plan without mutating targets:

```bash
canonfig sync --plan
```

Review the revision, mirror items, downloaded and reused blobs, every harness
surface the run takes over with `takeover snapshot` or `no backup`, harnesses
reported as not installed, tools, no-ops, Agent Tasks, human actions,
conflicts, verification methods, and any "schedule available" line.

Apply only after review:

```bash
canonfig sync --apply
canonfig status --json
```

Use `--no-input` only for a scheduler or another caller that cannot prompt.
Use `--no-backup` only with explicit approval: it takes over without a
snapshot. Content transfer is not applied state; only independent verification
establishes `Converged`.

One run is one transaction for filesystem and config changes: if a
deterministic action fails, every file, directory, and config the run already
changed is restored, including resources that do not depend on the failed one,
and the run ends `Failed` (exit 7). Tool installs are not rolled back, and a
Human Action Required resource does not roll back the rest.

## Harnesses, backups, and restore

```bash
canonfig harnesses
canonfig harnesses exclude cursor
canonfig harnesses include cursor
```

`harnesses` lists every harness: installed or not, listed, excluded here, the
root pinned at takeover, and its latest takeover snapshot. `exclude` and
`include` edit only `excludeHarnesses` in `~/.canonfig/local/local.jsonc`; the
Source's list is not changed. A harness installed later is taken over on the
next run, with a snapshot.

Takeover snapshots live in `~/.canonfig/.backups/<UTC timestamp>/`, with a
`manifest.json`. Canonfig keeps the first snapshot and the 4 most recent. For a
shared file such as `~/.claude.json`, the snapshot holds only the keys Canonfig
owns. To hand a harness back:

```bash
canonfig restore
canonfig restore <snapshot>
```

Restore writes the snapshot back as a journaled run, releases those surfaces,
and excludes their harnesses here so the next sync leaves them alone. It
refuses before writing anything when a surface changed since Canonfig last
applied it (`restore of snapshot <id> refused, nothing was changed`); keep or
move the local changes, sync until it converges, then restore again.

A harness whose root now resolves somewhere other than the root pinned at
takeover stops with Human Action Required (`<harness> was taken over at <root>
but now resolves to <root>, ...`): restore the environment, such as
`CODEX_HOME`, or run `canonfig restore` and sync again.

## Machine-local items

`~/.canonfig/local/` holds `rules/`, `skills/`, `agents/`, `commands/` as
files, and `local.jsonc` with `mcp`, `settings`, local ownership policies, and
`backups`. It is never published and never replaced. Only categories the
Source's `local.allow` names are projected; others are reported as not
admitted. A local item named like a published one is Human Action Required
(`local <kind> <name> has the same name as a published one; rename or remove one of them`).

`excludeSkills` names skill directories this machine keeps local in every
harness, including shared and Hermes skills. It requires Source
`local.appendLocal` to include `skills`. Excluded harness copies are not
written, checked for drift, or deleted; a previously managed harness copy is
released only after a successful sync. The Source-managed copy in a follower's
`~/.canonfig/` mirror still syncs and can report drift. Removing an exclusion
does not silently adopt local content; resolve ownership before syncing.

`preserveMcp: true` in `local/local.jsonc` keeps native MCP maps outside
projection, even when the Source adds servers. Other settings still sync, and
agent files still name the Source's servers. Preserving a map does not verify
those servers or make it match the Source. Report the tradeoff and resolve it
with the operator before promising MCP unification; never remove the policy
silently to force convergence.

## Client trust after apply

`Converged` means the files are in place and verified, not that a client
accepted them. Canonfig never copies trust decisions between machines. After
apply, tell the operator to:

- restart Claude Code, open `/hooks` and review hooks when it reports hooks
  changed outside the app, and trust each project folder when asked;
- in Codex, trust each project directory, and open `/hooks` to trust hooks from
  `~/.codex/hooks.json`, which stay in a review state until trusted;
- for Antigravity MCP configuration, start `agy` in the project and invoke
  a managed MCP tool to check that the server loaded.

`clientLoaded` stays `not-verified`. Report it as not verified.

## Diagnose outcomes

Run bounded probes:

```bash
canonfig doctor --no-input --timeout-ms 5000 --json
canonfig harnesses
canonfig schedule status
canonfig agent policy
canonfig agent harness
```

`doctor` runs ten probes: `runtime`, `state`, `credentials`, `source`,
`scheduler`, `package-managers`, `agent-adapter`, `harnesses`, `mcp` and
`tailscale`. The `harnesses` probe warns `listed but not installed: <ids>` and
reports pinned roots and snapshots. The `mcp` probe checks enabled stdio,
Streamable HTTP and HTTP+SSE servers. It leaves remote OAuth sign-in to the
harness. Doctor sends the report to the Source, which shows it under Health
in that machine's details.
`status` reports only this follower, so its own `canonfig status` remains its
completion evidence.

### Human Action Required

Present the recorded reason, exact instructions, and affected resource. Typical
causes are login, a locked or unavailable local credential store (the message
names the store and the command to run), a harness config file that does not
parse (file, line, and column are named; only that resource blocks), a changed
harness root, a `local/` name collision, denied capability, ambiguous
deterministic work, elevation, restart, or reboot. Complete the human step,
then re-plan:

```bash
canonfig doctor --no-input
canonfig sync --plan
```

Keep tokens off the command line and keep trust verification active.

### Follower Drift

Drift covers mirror files in `~/.canonfig/` and projected harness outputs.
Canonfig compares desired, observed, and last-applied digests, keeps the
follower copy, reports it, and exits 4. An edited mirror file holds the
projections built from it at their last applied state. An entry that appears
in an owned harness directory after takeover is drift too, and a scheduled run
never deletes it. When a follower-modified file drifts, preserve it and report
the conflict (resource, target, and the digests) instead of forcing
convergence. The operator chooses one of:

- keep the Source version: move the local copy aside, then `canonfig sync --apply`;
- keep the change for everyone: make it in the Source's folder and publish a
  new revision there;
- keep the change on this follower only: copy it into `~/.canonfig/local/`
  under another name (when `local.allow` admits that category), then restore
  the mirror copy.

Unattended agents do not make this choice.

## Recover interruption

Inspect before recovery:

```bash
canonfig status
canonfig recover
```

For noninteractive recovery:

```bash
canonfig recover --no-input --json
```

Recovery resumes the recorded plan from the journal and rollback snapshots. It
does not accept a run ID, switch revisions, guarantee rollback of third-party
installers, or invent work when no recoverable run exists. It stops with exit 3
and changes nothing when a target was edited after the interruption. While
another Canonfig process holds the run lock, `sync --apply`, `recover`,
`abandon`, and `restore` stop with exit 4 and name its PID.

If recovery fails, preserve SQLite state and the action journal, resolve the
reported cause, and retry while the original revision remains available. When
Canonfig reports the run cannot be recovered, close it without rollback, then
apply again:

```bash
canonfig abandon
canonfig sync --apply
```

## Rotate, replace, or unenroll

- Same name after revocation on the Source: a new invitation rotates the
  credential and keeps agent policy, harness bindings, and schedule choice.
- `canonfig follower enroll --stdin --name <new> --replace`: enrolls a new
  identity, revokes the old one, and lists in `resets` what it reset (agent
  policy, harness and secret bindings, schedule choice). Requires explicit
  approval.
- `canonfig follower unenroll`: revokes this identity on the Source and deletes
  the local enrollment (pins), credential, and received shared secrets.
  Applied files and the native schedule stay; run `canonfig schedule remove`
  separately if wanted. When the reply says the Source was unreachable, run
  `canonfig source revoke <id>` on the Source. A locked credential store exits
  3 and keeps the record for a retry.

None of these touch `~/.canonfig/local/` or the takeover snapshots.
