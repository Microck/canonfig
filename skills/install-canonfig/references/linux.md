# Linux installation branch

## Prerequisites

- Use a supported Linux user account with Node.js 24 or newer and npm.
- Confirm Secret Service is available for secure noninteractive credentials.
- Confirm a systemd user session is available before installing a schedule.

## Install the built package

From the repository, build and pack:

```bash
npm ci
npm run build:cli
npm pack
```

Install the resulting local tarball for the current Node installation:

```bash
npm install --global ./canonfig-2.0.0.tgz
canonfig --version
canonfig doctor --no-input --timeout-ms 5000
```

Use the exact tarball produced by `npm pack`. Do not fetch a same-named package
from a registry as a substitute.

## Role and schedule

For a Source Machine, return to `SKILL.md` and initialize source identity. For a
Follower Machine, enroll with the short-lived invitation and inspect the plan.

Linux schedules use a systemd user timer:

```bash
canonfig schedule set daily@00:00
canonfig schedule status
```

If Secret Service or the user scheduler is unavailable, report
Human Action Required or the typed scheduler failure. Do not write plaintext credentials,
install a root service, or claim the schedule is current.
