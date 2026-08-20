# Windows installation branch

## Prerequisites

- Use Windows 10 or 11 with Node.js 24 or newer and npm in PowerShell.
- Confirm Credential Manager is available to the user that will run Canonfig.
- Confirm per-user Task Scheduler access before installing a schedule.

## Install the built package

From PowerShell in the repository, build and pack:

```powershell
npm ci
npm run build:cli
npm pack
```

Install the resulting local tarball:

```powershell
npm install --global .\canonfig-2.0.0.tgz
canonfig --version
canonfig doctor --no-input --timeout-ms 5000
```

Use the exact tarball produced by `npm pack`. Do not replace it with an
unverified registry download.

## Role and schedule

For a Source Machine, return to `SKILL.md` and initialize source identity. For a
Follower Machine, hold the invitation only in the current PowerShell process,
enroll, clear the variable, and inspect the plan.

Windows schedules use a per-user Task Scheduler task:

```powershell
canonfig schedule set daily@00:00
canonfig schedule status
```

Use Windows paths when configuring harness allowlists. If Credential Manager or
Task Scheduler is unavailable, preserve the Human Action Required or typed
scheduler failure. Do not place an invitation in command history, write
plaintext credentials, install a machine-level task, or claim convergence.
