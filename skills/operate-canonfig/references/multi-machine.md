# Multi-machine operations and platform boundaries

Read this reference when operating a Source Machine, a Follower Machine,
schedules, tunnels, or platform-specific credential stores.

## Source Machine operations

- **Discover tools:** `canonfig source scan` proposes `tools` entries from
  `~/.canonfig/` without running processes. Review proposals, per-platform
  recipes (avoid Linux-only npm packages on macOS/Windows), and exact pinned
  versions so stale pins do not downgrade newer local CLIs. Add `login`
  instructions for CLIs that require authentication after installation, then
  run `canonfig source scan --write` if approved.
- **Publish:** After `canonfig sync --plan` and explicit approval, run
  `canonfig source publish --reviewer <operator>`. Publication signs an
  immutable revision and refuses credential-looking literals or a changed
  `profile.id`. To roll back Followers, restore earlier folder content and
  publish a new revision.
- **Service:** `canonfig source service install` (or `--tailnet`) and
  `canonfig source service status`. Foreground trial:
  `canonfig source serve --host 127.0.0.1 --port 17342` (stop it before
  installing the service on the same port).
- **Invite and revoke:**
  `canonfig source invite --endpoint <url> --output ./canonfig-invite --expires 15m [--group <name>]`.
  Delete the mode-`0600` envelope after delivery. Revoke one Follower with
  `canonfig source revoke <id>`.
- **Shared secrets (`canonfig:secrets` group):** Pipe byte-for-byte with
  `printf '%s' "$VAL" | canonfig secrets set <name>` (not `echo`, which appends
  a newline). Values are non-empty UTF-8 without NUL, up to 16384 bytes, and
  the pipe closes within 10 seconds.

## Follower Machine operations

- **Tunnel:** `canonfig tunnel start` restarts a recorded tunnel;
  `canonfig tunnel stop` keeps scheduled runs from restarting it;
  `canonfig tunnel stop --forget` removes the record. Start the Source before
  the tunnel, and remove any stale or duplicate manual reverse-tunnel unit
  holding the same loopback port.
- **Schedules:** `canonfig schedule set daily@09:00 --timezone <IANA>`,
  `canonfig schedule set --default`, `canonfig schedule status`,
  `canonfig schedule remove`. Scheduled runs execute
  `canonfig sync --apply --no-input --scheduled` without prompting and keep
  failures visible (exit 3 Human Action Required, exit 4 Follower Drift).
  Respect schedules disabled outside Canonfig rather than recreating them.
- **Agent policy (Followers only):** Inspect with `canonfig agent policy` and
  `canonfig agent harness`. Keep `deterministic-only` by default; `agent-apply`
  requires explicit path, executable, and exact HTTPS origin allowlists.
- **Rotate, replace, or unenroll:** To rotate credentials under the same name
  while keeping local settings, revoke the active Follower on the Source first
  (`canonfig source revoke <id>`), then re-enroll it with a fresh invitation.
  `--replace` revokes the old identity and resets policy, bindings, and
  schedule (get approval first). `canonfig follower unenroll` revokes the
  identity and deletes local pins and received secrets while keeping
  `~/.canonfig/local/` and Takeover Snapshots. If the Source was unreachable,
  also run `canonfig source revoke <id>` on the Source.
- **Fleet reporting:** The Source has no fleet convergence view; verify each
  Follower from its own `canonfig status`.

## Platform boundaries

| Platform | Credential store | Scheduler / Source service | Unattended while logged out |
| --- | --- | --- | --- |
| Linux | Secret Service | systemd user timer / unit | Only with `loginctl enable-linger <user>` (human decision) |
| macOS | Keychain | launchd user agent / LaunchAgent | No (requires logged-in desktop session with unlocked Keychain) |
| Windows | Credential Manager | per-user Task Scheduler | No (runs while user stays logged on) |

Platform gotchas to watch for:

- **Linux:** Secret Service needs `DBUS_SESSION_BUS_ADDRESS` or
  `$XDG_RUNTIME_DIR/bus` with an unlocked login keyring. Avoid
  `dbus-run-session` (creates an empty private keyring).
- **macOS over SSH:** The login Keychain starts locked;
  `security unlock-keychain ~/Library/Keychains/login.keychain-db` unlocks it
  for that SSH session only.
- **Windows:** Task Scheduler inherits no shell env vars; persist required
  overrides with `setx`. When an SSH session cannot reach DPAPI or Credential
  Manager, trigger the scheduled task (`\Canonfig\canonfig-sync`) with
  `canonfig schedule run --timeout-ms 600000 --json` instead of weakening
  storage. A timeout exits 7 without stopping the task (for example during a
  slow NTFS ACL rollback), so inspect `canonfig status` before retrying.
- **Pinned harness roots:** Canonfig pins the harness root resolved at first
  takeover (for example `CODEX_HOME`). A later run resolving a different root
  stops with Human Action Required (exit 3) rather than projecting into a
  second location.
