# Linux installation branch

## Prerequisites

- Use a supported Linux user account with Node.js 24 or newer and npm.
- Confirm Secret Service is available for secure noninteractive credentials,
  and that the login keyring is unlocked (a password login unlocks it).
- Confirm a systemd user session is available before installing a schedule or
  the Source service.

## Install the package

Install the exact public package version for the current Node installation.

Use a new installation only. For an existing 3.2.x account, follow the
[fresh-install guide](../../../website/content/docs/how-to/upgrade.mdx)
instead of replacing its package or state.

```bash
npm install --global @microck/canonfig@4.0.0
canonfig --version
canonfig doctor --no-input --timeout-ms 5000
```

The npm package is scoped as `@microck/canonfig`; the installed executable
remains `canonfig`.

## Credential storage without a desktop session

Canonfig reaches Secret Service through `DBUS_SESSION_BUS_ADDRESS`, or through
`$XDG_RUNTIME_DIR/bus` when that variable is unset and the socket exists. An
SSH or background session works when `XDG_RUNTIME_DIR` is set. When both are
unset, set the runtime directory and retry, for example:

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
env -i HOME=$HOME PATH=$PATH XDG_RUNTIME_DIR=/run/user/$(id -u) canonfig secrets bootstrap
```

`dbus-run-session` is not a remedy: the private bus it starts has an empty
keyring that waits for a graphical prompter. When `/run/user/<uid>/bus` does
not exist because no user manager runs, lingering starts one; enabling it is a
human decision (`sudo loginctl enable-linger <user>`). Choose the unencrypted
local-file credential policy only where no Secret Service exists and a
mode-`0600` plaintext file is acceptable, and only with explicit operator
approval.

## Role and schedule

For a Source Machine, return to `SKILL.md` and initialize source identity. For a
Follower Machine, enroll with the short-lived invitation and inspect the plan.

The Source service is a systemd user unit (`canonfig-source.service`), and
follower schedules use a systemd user timer:

```bash
canonfig source service install
canonfig schedule set daily@09:00
canonfig schedule status
```

Both run while the user is logged in. They also run at boot and after logout
only when lingering is on (`loginctl enable-linger <user>`); Canonfig does not
enable it, and `doctor` and `source service status` warn when it is off. Source
service logs: `journalctl --user -u canonfig-source.service`. A missing user
session bus is reported with the same linger remedy (exit 3).

If Secret Service or the user scheduler is unavailable, report
Human Action Required or the typed scheduler failure. Do not write plaintext credentials
without approval, install a root service, or claim the schedule is current.
