# macOS installation branch

## Prerequisites

- Use a supported macOS user account with Node.js 24 or newer and npm.
- Confirm Keychain is available to the user that will run Canonfig.
- Confirm the user launchd domain is available before installing a schedule.

## Install the built package

From the repository, build and pack:

```bash
npm ci
npm run build:cli
npm pack
```

Install the resulting local tarball:

```bash
npm install --global ./canonfig-2.0.0.tgz
canonfig --version
canonfig doctor --no-input --timeout-ms 5000
```

Use the exact tarball produced by `npm pack`. Do not replace it with an
unverified registry download.

## Role and schedule

For a Source Machine, return to `SKILL.md` and initialize source identity. For a
Follower Machine, enroll with the short-lived invitation and inspect the plan.

macOS schedules use a launchd user agent:

```bash
canonfig schedule set daily@00:00
canonfig schedule status
```

If Keychain or the user launchd domain is unavailable, preserve the resulting
Human Action Required or scheduler failure. Do not create plaintext credential
files, install a system daemon, or claim convergence.
