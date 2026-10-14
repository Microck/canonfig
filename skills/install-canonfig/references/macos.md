# macOS installation branch

## Prerequisites

- Use a supported macOS user account with Node.js 24 or newer and npm.
- Confirm Keychain is available to the user that will run Canonfig.
- Confirm the user launchd domain is available before installing a schedule.

## Install the package

Install the exact public package version.

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

## Keychain over SSH

An SSH session starts with the login Keychain locked, so Keychain reads and
writes fail ("security exited with code 36"). Unlocking it inside that SSH
session works for the rest of that session only:

```bash
security unlock-keychain ~/Library/Keychains/login.keychain-db
canonfig doctor --no-input
```

The operator types the login password; never ask for it in chat. The unlock
does not carry over to new SSH sessions, the desktop session, or scheduled
runs. Scheduled runs need the logged-in desktop session (launchd domain
`gui/<uid>`).

## Role and schedule

For a Source Machine, return to `SKILL.md` and initialize source identity. For a
Follower Machine, enroll with the short-lived invitation and inspect the plan.

The Source service is a LaunchAgent (`dev.canonfig.source`, logs in
`~/.canonfig/source-service.log`), and follower schedules use a
launchd user agent. Run both from the logged-in desktop session, not over SSH:

```bash
canonfig source service install
canonfig schedule set daily@09:00
canonfig schedule status
```

They run while the user is logged in to the desktop; a Mac nobody is logged in
to does not serve or sync. With Homebrew Node the job uses the stable
`<brew prefix>/opt/<formula>/bin/node` link, so a Node upgrade does not break it.

If Keychain or the user launchd domain is unavailable, preserve the resulting
Human Action Required or scheduler failure. Do not create plaintext credential
files, install a system daemon, or claim convergence.
