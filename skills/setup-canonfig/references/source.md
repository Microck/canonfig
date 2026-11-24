# Source Machine setup

A **Source Machine** owns `~/.canonfig/`, signs immutable **Profile Revisions**,
and serves them to **Follower Machines**. A machine is a Source or a Follower,
never both.

## 1. Preflight and bootstrap plan

Run `canonfig doctor --no-input --timeout-ms 5000 --json`. Confirm the native
credential store is usable (Secret Service on Linux, Keychain on macOS,
Credential Manager on Windows) because Source signing and TLS keys live there.

Plan without harness or import flags first so Canonfig lists what it detects:

```bash
canonfig setup plan --role source --intent "prepare source"
```

Show the user:

- The detected harnesses and proposed `profile` (`id` and `name`, required for
  publication and immutable once published).
- Every `imports.offered` item (`<harness>/<category>/<name>` or
  `agents/skills/<name>`) and any credential-looking values that become
  `{ "fromEnv": "NAME" }` references.
- Every `import collision` or `import skipped` line.

Ask which harnesses to include and which items to import (resolve collisions
explicitly; items not imported stay in the Takeover Snapshot on first sync).
Re-plan with their choices, show the plan digest, get approval, and apply:

```bash
canonfig setup plan --role source --harness claude-code --harness codex --import claude-code
canonfig setup approve --approver operator
canonfig setup apply
canonfig setup status --json
```

Use `--import-all` or `--no-import` when chosen.

## 2. Review folder and project locally

Only `canonfig.jsonc`, `AGENTS.md`, `rules/`, `skills/`, `agents/`,
`commands/`, `hooks/`, and `files/` are published; state, backups, and
`local/` stay on this machine. Check `canonfig --help` or the
[folder reference](https://canonfig.micr.dev/docs/reference/canonfig-folder/)
for schema details.

Keep these rules while authoring:

- Keep MCP secrets as `{ "fromEnv": "NAME" }` references (publication rejects
  literal credentials).
- Review every hook script and stdio MCP command because they run on every
  Follower.
- Run `canonfig source scan` (read-only) to discover `tools` entries, review
  each proposal and its exact pinned `version`, then run
  `canonfig source scan --write` if approved.

Plan and apply on the Source first so the user sees every takeover surface:

```bash
canonfig sync --plan
canonfig sync --apply
```

## 3. Publish, serve, and invite

Publication signs `~/.canonfig/` as a permanent revision. Ask for explicit
approval before running:

```bash
canonfig source publish --reviewer operator
canonfig profile list
```

Keep the Source serving as a native user service so Followers can sync:

- Loopback (for SSH tunnel followers): `canonfig source service install`
- Direct tailnet (when `canonfig doctor --json` reports Tailscale ready and
  the operator approves): `canonfig source service install --tailnet`

Verify with `canonfig source service status`.

Create a short-lived, single-use invitation (never print its contents in chat
and delete the temporary file once consumed). Use the loopback endpoint for
SSH-tunnel followers, or the MagicDNS HTTPS endpoint printed by
`source service install --tailnet` for direct-tailnet followers:

```bash
canonfig source invite --endpoint https://127.0.0.1:17342 --output ./canonfig-invite --expires 15m
```

Add `--group <name>` only for declared `groups.<name>` memberships. Granting
`--group canonfig:secrets` shares secrets stored via stdin
(`printf '%s' "$VALUE" | canonfig secrets set <name>`) and requires separate
explicit approval.

## Completion check

Report the Source identity, profile/revision ID, projected harnesses, Takeover
Snapshot path, and service status (`running` / `serving`). Remind the user
that `~/.canonfig/` is their single authoring folder and `canonfig source
publish` ships reviewed edits to Followers.
