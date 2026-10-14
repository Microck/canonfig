# Platform boundaries

Use equivalent domain outcomes, not copied paths or native definitions.

| Platform | Credentials | Scheduler | Source service | Common deterministic recipes |
| --- | --- | --- | --- | --- |
| Linux | Secret Service | systemd user timer | systemd user unit | apt, npm, uv, cargo, source |
| macOS | Keychain | launchd user agent | LaunchAgent | Homebrew, npm, uv, cargo, source |
| Windows | Credential Manager | per-user Task Scheduler | Task Scheduler logon task | winget, npm, uv, cargo, source |

## Unattended modes

| Platform | While logged in | While logged out or at boot |
| --- | --- | --- |
| Linux | yes | only with lingering (`loginctl enable-linger <user>`) |
| macOS | yes, in the desktop session with the login Keychain unlocked | no |
| Windows | yes, from logon while the user stays logged on | no |

This applies to both the Source service and follower schedules. Canonfig never
enables lingering itself; `doctor`, `status`, and `source service status` warn
when it is off. Enabling it is a human decision.

## Credential stores

- Linux: Secret Service is reached through `DBUS_SESSION_BUS_ADDRESS`, else
  `$XDG_RUNTIME_DIR/bus`. For SSH or background sessions set
  `XDG_RUNTIME_DIR=/run/user/$(id -u)`; without a user manager, lingering
  provides one. The login keyring must be unlocked. `dbus-run-session` is not a
  remedy: its private bus has an empty keyring waiting for a graphical prompt.
- macOS: an SSH session starts with the login Keychain locked (security exit
  36). `security unlock-keychain ~/Library/Keychains/login.keychain-db` unlocks
  it for that SSH session only, never for scheduled runs.
- Windows: Task Scheduler carries no environment variables; a credential root
  set only in the shell must be set with `setx`.

A locked or unavailable store is a local failure: Human Action Required, exit 3,
with the store and the recovery command named. It is not an authentication
failure and needs no re-enrollment.

## Recipes

Keep every Installation Recipe platform-specific and version-aware, with an
exact `version` for automatic installers. Verify its package identity against
evidence and the tool's upstream URL. A shared npm, uv, cargo, or source recipe
is valid only when evidence supports each named platform. Login instructions
describe a non-secret human step and never contain a credential. A bare
verifier name is looked up in the recipe's install directories first, then
PATH; a miss lists every directory searched.

When no recipe is unambiguous, retain a bounded Agent Task. Under
`deterministic-only`, report Human Action Required. Under `agent-propose`, review
the proposal without executing it. Under `agent-apply`, enforce task and harness
bounds and rerun independent verification.

## Harness paths

- On Linux, use POSIX paths and user-owned filesystem roots.
- On macOS, use POSIX paths and Keychain-backed credential references.
- On Windows, use Windows paths and Credential Manager references.

Never copy Source Machine absolute paths into a portable profile. Every network
allowlist entry must be an exact HTTPS origin.

## Schedules

Install a calendar the operator chose, or the profile's suggestion:

```bash
canonfig schedule set daily@09:00
canonfig schedule set weekly:Mon,Thu@12:30 --timezone Europe/Paris
canonfig schedule set --default
canonfig schedule status
```

Sync never installs a profile `scheduleDefault`; it reports "schedule
available" until the operator runs `schedule set --default`. `schedule set`
prints the resolved time zone and next run, starts no catch-up run for a time
already passed today, and warns when the time falls into a daylight-saving gap
within the next 12 months (systemd skips that day; launchd and Task Scheduler
behavior is unspecified). Recommend a time outside the change window.

A job disabled, stopped, or deleted outside Canonfig is respected: sync leaves it
alone, and status reports "automation disabled outside Canonfig". Offer
`canonfig schedule set` to restore it or `canonfig schedule remove` to confirm
manual operation. A native override (systemd drop-in) is reported as
`overridden`. Do not copy native definitions between platforms. If the scheduler
is unavailable, preserve the typed failure or Human Action Required outcome.

## Tunnel

`canonfig tunnel start --invitation ...` records the tunnel, so
`canonfig tunnel start` alone restarts it later, for example after a reboot.
Start the Source first, then the tunnel. A scheduled run restarts a down tunnel
once before fetching; `canonfig tunnel stop` marks it stopped so nothing
restarts it, and `tunnel stop --forget` deletes the record. A transport failure
while the tunnel is down (exit 6) names `canonfig tunnel start`.
