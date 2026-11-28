# Follower Machine setup

A **Follower Machine** mirrors its Source Machine's latest signed Profile
Revision into `~/.canonfig/`, combines it with machine-only items in
`~/.canonfig/local/`, and projects into installed harnesses that are not
excluded here. A machine is a Source or a Follower, never both.

## 1. Preflight and version parity

Confirm `canonfig --version` on the Source before installing or enrolling here:
Source and Followers must run the same `major.minor` version (a mismatch exits
2).

Run `canonfig doctor --no-input --timeout-ms 5000 --json` and check the
`credentials` probe:

- Linux: Secret Service via `DBUS_SESSION_BUS_ADDRESS` or
  `$XDG_RUNTIME_DIR/bus` (`dbus-run-session` creates an empty private keyring
  and is not a fix).
- macOS over SSH: unlock with
  `security unlock-keychain ~/Library/Keychains/login.keychain-db` (for that
  session only).
- Windows: Credential Manager.

If the credential store is locked or unavailable, stop and report the exact
Human Action Required instructions rather than downgrading storage.

If `~/.canonfig/` already holds authoring files (`canonfig.jsonc`, `AGENTS.md`,
`rules/`, `skills/`, `agents/`, `commands/`, `hooks/`), enrollment refuses
until the user approves moving what they want to keep into `~/.canonfig/local/`
or removing them. Also check for pre-existing unmanaged skill directories in
harness skill folders before first sync so they do not collide with projected
skills.

Before creating any `local/local.jsonc` overlay, keep `{ "fromSecret": ... }`
or `{ "fromEnv": ... }` references instead of plaintext tokens, use native OS
paths for this machine, and check that no duplicate manual reverse-tunnel unit
already occupies the Source loopback port.

## 2. Connect and enroll

For a remote Source with a loopback invitation, start Canonfig's managed tunnel
first using the Source's SSH host public key read from the Source itself:

```bash
canonfig tunnel start --invitation ./canonfig-invite --ssh-host source.example --ssh-user operator --ssh-host-key-file ./source-host-key.pub
```

For a direct tailnet invitation, no tunnel is needed.

Ask how the user will supply the invitation locally (protected file or
ephemeral terminal variable; never paste invitations in chat or pass them as
command arguments). Enroll via stdin, then remove the temporary file:

```bash
cat ./canonfig-invite | canonfig follower enroll --stdin --name laptop
```

If an invitation is expired, replayed, exposed, or fails pin verification, stop
and request a fresh invitation from the Source. Never reset pins or bypass
verification. If the invitation grants `canonfig:secrets`, explain automatic
secret transfer and get explicit approval before the first apply.

## 3. Review harnesses, plan, and apply

Inspect `canonfig harnesses`. Exclude any harness that should stay untouched on
this computer with `canonfig harnesses exclude <harness>`.

Plan first and review the revision, mirror items, Takeover Snapshots, tools,
and any Human Action Required items:

```bash
canonfig sync --plan
```

After explicit approval of the displayed plan:

```bash
canonfig sync --apply
canonfig status --json
```

Keep Takeover Snapshots enabled unless `--no-backup` is explicitly approved.
`Converged` means files are in place and verified, not that each client loaded
them (`clientLoaded` stays `not-verified`). Give the user the client trust
steps:

- Claude Code: restart and review `/hooks` if notified, and trust project
  folders.
- Codex: trust project folders and open `/hooks` to trust `~/.codex/hooks.json`.
- Antigravity: start `agy` in a project and invoke a managed MCP tool to verify
  it loaded.

## 4. Optional schedule

Automatic sync is always opt-in. After first Convergence, ask whether to stay
manual, adopt the Source's `scheduleDefault` (`canonfig schedule set
--default`), or set a custom daily/weekly calendar with timezone
(`canonfig schedule set daily@09:00 --timezone <IANA-zone>`). Verify with
`canonfig schedule status`.

## Completion check

Report the follower name, applied revision, projected and excluded harnesses,
Takeover Snapshot path, Convergence status, client trust steps, and schedule
status. Remind the user to make shared edits on the Source and machine-only
additions in `~/.canonfig/local/`.
