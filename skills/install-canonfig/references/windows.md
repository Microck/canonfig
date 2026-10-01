# Windows installation branch

## Prerequisites

- Use Windows 10 or 11 with Node.js 24 or newer and npm in PowerShell.
- Confirm Credential Manager is available to the user that will run Canonfig.
- Confirm per-user Task Scheduler access before installing a schedule.

## Install the package

Install the exact public package version.

Use a new installation only. For an existing 3.2.x account, follow the
[fresh-install guide](../../../website/content/docs/how-to/upgrade.mdx)
instead of replacing its package or state.

```powershell
npm install --global @microck/canonfig@4.0.0
canonfig --version
canonfig doctor --no-input --timeout-ms 5000
```

The npm package is scoped as `@microck/canonfig`; the installed executable
remains `canonfig`.

## Role and schedule

For a Source Machine, return to `SKILL.md` and initialize source identity. For a
Follower Machine, pipe the unchanged invitation file into
`follower enroll --stdin`, remove the file, and inspect the plan. Never pass the
invitation as an argument or keep it in command history.

The Source service is a Task Scheduler logon task (`Canonfig\canonfig-source`),
and follower schedules use a per-user Task Scheduler task:

```powershell
canonfig source service install
canonfig schedule set daily@09:00
canonfig schedule status
```

Both run from the user's logon while the user stays logged on; logged-out
operation is not supported. Task Scheduler carries no environment variables:
when `CANONFIG_LOCAL_CREDENTIAL_ROOT` is set only in the shell,
`source service install` refuses and asks for
`setx CANONFIG_LOCAL_CREDENTIAL_ROOT "<path>"` and a new terminal.

Use Windows paths when configuring harness allowlists. If Credential Manager or
Task Scheduler is unavailable, preserve the Human Action Required or typed
scheduler failure. Do not place an invitation in command history, write
plaintext credentials, install a machine-level task, or claim convergence.
